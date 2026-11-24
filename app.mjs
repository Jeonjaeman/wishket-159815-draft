// app.mjs — 모듈 진입점. 로컬 pdf.js(vendor)로 실제 PDF를 그리고, 실제 텍스트 레이어 선택을 하이라이트로 만든다.
// 네트워크 요청·브라우저 저장소·서버 없음. 상태는 core.mjs 메모리 스토어에만 있다.
import {
  createReviewStore, selectionRectsToPdf, pdfRectToCssBox, nextZoom, ZOOM_LEVELS,
  EXAMPLE_PHRASE, PRESET_COMMENTS,
} from './core.mjs';

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), error: $('error'), canvas: $('pdf-canvas'), textLayer: $('text-layer'),
  hlLayer: $('highlight-layer'), pageWrap: $('page-wrap'), scroll: $('pdf-scroll'), thumbs: $('thumbs'),
  pageLabel: $('page-label'), zoomLabel: $('zoom-label'), filter: $('filter'),
  list: $('comment-list'), empty: $('comment-empty'), count: $('comment-count'),
  newStory: $('new-story'), target: $('new-story-target'), scoreRow: $('score-row'),
  scoreState: $('score-state'), complete: $('btn-complete'),
};
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const say = (msg) => { els.status.textContent = msg; };
const fail = (msg) => { els.error.textContent = msg; els.error.hidden = false; say('오류: ' + msg); };
const clearError = () => { els.error.hidden = true; els.error.textContent = ''; };

const store = createReviewStore();
const view = { doc: null, pageNo: 1, zoom: 100, viewport: null, textLayer: null, renderTask: null, pdfjs: null, pageCache: new Map() };

// ---------- PDF 렌더 ----------
async function getPage(n) {
  if (!view.pageCache.has(n)) view.pageCache.set(n, await view.doc.getPage(n));
  return view.pageCache.get(n);
}

function fitScale(page) {
  const avail = Math.max(240, els.scroll.clientWidth - 34);
  const base = page.getViewport({ scale: 1 });
  return Math.min(1.4, avail / base.width);
}

async function renderPage(n) {
  const page = await getPage(n);
  view.pageNo = n;
  const scale = fitScale(page) * (view.zoom / 100);
  const viewport = page.getViewport({ scale });
  view.viewport = viewport;
  if (view.renderTask) view.renderTask.cancel();
  view.textLayer?.cancel();

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  els.canvas.width = Math.floor(viewport.width * dpr);
  els.canvas.height = Math.floor(viewport.height * dpr);
  els.canvas.style.width = `${viewport.width}px`;
  els.canvas.style.height = `${viewport.height}px`;
  els.pageWrap.style.width = `${viewport.width}px`;
  els.pageWrap.style.height = `${viewport.height}px`;
  els.pageWrap.style.setProperty('--scale-factor', String(viewport.scale));
  // This derived variable must be resolved at the page, not inherited already
  // computed from :root's scale=1 (which misaligns real text on small screens).
  els.pageWrap.style.setProperty('--total-scale-factor', String(viewport.scale));

  const ctx = els.canvas.getContext('2d');
  view.renderTask = page.render({ canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
  try { await view.renderTask.promise; } catch (e) { if (e?.name === 'RenderingCancelledException') return; throw e; }
  view.renderTask = null;

  els.textLayer.replaceChildren();
  // The only supported document is our own sample, typeset in this bundled font.
  // Use its exact glyph advances instead of generic sans-serif substitution,
  // otherwise a mixed Korean/Latin line's substring selection drifts horizontally.
  await document.fonts.load('22px "IBM Plex Sans KR"');
  const textContent = await page.getTextContent();
  for (const style of Object.values(textContent.styles)) style.fontFamily = '"IBM Plex Sans KR"';
  view.textLayer = new view.pdfjs.TextLayer({ textContentSource: textContent, container: els.textLayer, viewport });
  await view.textLayer.render();
  const end = document.createElement('div'); end.className = 'endOfContent'; els.textLayer.append(end);

  els.pageLabel.textContent = `${n} / ${view.doc.numPages}`;
  els.zoomLabel.textContent = `${view.zoom}%`;
  renderHighlights();
  renderThumbState();
}

async function renderThumbs() {
  els.thumbs.replaceChildren();
  for (let n = 1; n <= view.doc.numPages; n++) {
    const page = await getPage(n);
    const vp = page.getViewport({ scale: 54 / page.getViewport({ scale: 1 }).width });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height); c.setAttribute('aria-hidden', 'true');
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'thumb'; b.dataset.page = String(n);
    b.append(c, Object.assign(document.createElement('span'), { textContent: String(n) }));
    b.addEventListener('click', () => goToPage(n));
    els.thumbs.append(b);
  }
  renderThumbState();
}

function renderThumbState() {
  for (const b of els.thumbs.querySelectorAll('.thumb')) {
    const n = Number(b.dataset.page), k = store.highlightCount(n);
    b.querySelector('span').textContent = k ? `${n} · ${k}개` : String(n);
    b.setAttribute('aria-label', `${n}쪽${k ? `, 하이라이트 ${k}개` : ''}`);
    if (n === view.pageNo) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
}

async function goToPage(n) {
  if (n < 1 || n > view.doc.numPages) { say('더 이상 이동할 쪽이 없습니다.'); return; }
  if (n !== view.pageNo) { await renderPage(n); say(`${n}쪽으로 이동했습니다.`); }
}

async function setZoom(z) {
  if (!ZOOM_LEVELS.includes(z) || z === view.zoom) return;
  view.zoom = z;
  await renderPage(view.pageNo);
  say(`확대율 ${z}%. 하이라이트는 PDF 좌표에서 다시 계산되었습니다.`);
}

// ---------- 하이라이트 ----------
function renderHighlights() {
  els.hlLayer.replaceChildren();
  const { selectedHighlightId } = store.state;
  for (const h of store.visibleHighlights(view.pageNo)) {
    const g = document.createElement('div');
    g.className = 'hl' + (h.id === selectedHighlightId ? ' is-selected' : '');
    g.dataset.id = h.id;
    let first = null;
    for (const r of h.rects) {
      const box = pdfRectToCssBox(r, view.viewport);
      first ??= box;
      const d = document.createElement('div');
      d.className = 'hl-rect';
      Object.assign(d.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
      g.append(d);
    }
    const linked = store.state.comments.find((c) => c.highlightId === h.id);
    const m = document.createElement('button');
    m.type = 'button'; m.className = 'hl-marker';
    m.style.left = `${Math.max(0, first.left + first.width - 22)}px`; m.style.top = `${first.top}px`;
    m.setAttribute('aria-label', `${h.author.name} 하이라이트 "${h.text.slice(0, 30)}" — ${linked ? '연결된 댓글로 이동' : '댓글 없음, 새 이야기로 이동'}`);
    m.innerHTML = `<b aria-hidden="true">${h.author.initial}</b>`;
    m.addEventListener('click', () => focusHighlight(h.id));
    g.append(m);
    els.hlLayer.append(g);
  }
}

function focusHighlight(id) {
  store.selectHighlight(id);
  const c = store.state.comments.find((x) => x.highlightId === id);
  if (c) {
    const card = els.list.querySelector(`[data-id="${c.id}"]`);
    card?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'nearest' });
    card?.focus();
    say('연결된 댓글로 이동했습니다.');
  } else {
    els.newStory.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'nearest' });
    els.newStory.focus();
    say('이 하이라이트에는 아직 댓글이 없습니다. 새 이야기 패널에서 예시 댓글을 남길 수 있습니다.');
  }
}

function currentSelectionInTextLayer() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!els.textLayer.contains(range.commonAncestorContainer) && !range.intersectsNode(els.textLayer)) return null;
  return { sel, range };
}

function highlightSelection() {
  clearError();
  const picked = currentSelectionInTextLayer();
  if (!picked) { fail('PDF 글자가 선택되지 않았습니다. 본문을 드래그하거나 "예시 문장 선택"을 먼저 누르세요.'); return; }
  const text = picked.sel.toString().replace(/\s+/g, ' ').trim();
  const rects = selectionRectsToPdf(picked.range.getClientRects(), els.canvas.getBoundingClientRect(), view.viewport);
  if (!rects.length || !text) { fail('선택 영역이 현재 쪽 안에 없거나 글자가 비어 있습니다. 이미지 영역 하이라이트는 시연 범위 밖입니다.'); return; }
  try {
    const h = store.addHighlight({ page: view.pageNo, rects, text });
    picked.sel.removeAllRanges();
    els.target.textContent = `선택한 하이라이트에 연결 ("${h.text.slice(0, 20)}…")`;
    say(`하이라이트를 만들었습니다 (${view.pageNo}쪽, 사각형 ${rects.length}개, PDF 좌표 저장). 새 이야기 패널에서 댓글을 연결할 수 있습니다.`);
  } catch (e) { fail(e.message); }
}

function selectExampleSentence() {
  clearError();
  const divs = view.textLayer?.textDivs || [];
  let span = divs.find((d) => d.textContent.includes(EXAMPLE_PHRASE));
  let phrase = EXAMPLE_PHRASE;
  if (!span) { span = divs.find((d) => d.textContent.trim().length > 6); phrase = span?.textContent.trim() || ''; }
  if (!span?.firstChild) { fail('이 쪽의 텍스트 레이어에서 예시 문장을 찾지 못했습니다.'); return; }
  const node = span.firstChild, idx = node.textContent.indexOf(phrase);
  const range = document.createRange();
  range.setStart(node, Math.max(0, idx)); range.setEnd(node, Math.max(0, idx) + phrase.length);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  say(`실제 텍스트 레이어에서 "${phrase}"을(를) 선택했습니다. 아직 하이라이트는 아닙니다. "선택 문장 하이라이트"로 확정하세요.`);
  $('btn-highlight').focus();
}

// ---------- 댓글 ----------
function renderComments() {
  const { comments, activeCommentId, selectedHighlightId } = store.state;
  els.count.textContent = String(comments.length);
  els.empty.hidden = comments.length > 0;
  els.list.replaceChildren(...comments.map((c) => {
    const li = document.createElement('li');
    li.className = 'comment' + (c.id === activeCommentId ? ' is-active' : '');
    li.dataset.id = c.id; li.tabIndex = -1;
    li.setAttribute('aria-current', c.id === activeCommentId ? 'true' : 'false');
    const where = c.page ? `${c.page}쪽` : '신청서 전체';
    li.innerHTML = `
      <div class="comment-head"><span class="avatar" aria-hidden="true">${c.author.initial}</span><span>${c.author.name}</span><span>· ${where}</span><span>· 방금(시연)</span></div>
      ${c.quote ? `<q class="quote">${escapeHtml(c.quote)}</q>` : '<span class="quote">하이라이트 없이 신청서 전체에 단 댓글</span>'}
      <p class="comment-body">${escapeHtml(c.body)}</p>
      <div class="comment-actions">
        ${c.highlightId ? '<button type="button" class="btn-link" data-act="goto">해당 쪽·위치로 이동</button>' : ''}
        ${c.replies.length ? '<span class="muted">답글은 1단계만 (이미 1개)</span>' : '<button type="button" class="btn-link" data-act="reply">예시 답글 달기</button>'}
      </div>
      <ol class="replies" aria-label="답글">${c.replies.map((r) => `<li class="reply"><span class="avatar alt" aria-hidden="true">${r.author.initial}</span> ${r.author.name} · ${escapeHtml(r.body)} <span class="muted">(같은 브라우저의 로컬 예시, 실제 공동 작업 아님)</span></li>`).join('')}</ol>`;
    li.addEventListener('click', (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (act === 'reply') { addReply(c.id); return; }
      activateComment(c.id, act === 'goto');
    });
    li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target === li) activateComment(c.id, true); });
    return li;
  }));
  const h = store.state.highlights.find((x) => x.id === selectedHighlightId);
  els.target.textContent = h ? `선택한 하이라이트에 연결 ("${h.text.slice(0, 20)}…")` : '신청서 전체에 연결';
}

async function activateComment(id, navigate) {
  store.setActiveComment(id);
  const c = store.state.comments.find((x) => x.id === id);
  const h = store.state.highlights.find((x) => x.id === c?.highlightId);
  if (!h) { say('신청서 전체에 단 댓글입니다. 연결된 위치가 없습니다.'); return; }
  if (navigate || h.page !== view.pageNo) await goToPage(h.page);
  if (store.state.filter === 'hidden') { store.setFilter('all'); els.filter.value = 'all'; say('숨겨 둔 하이라이트를 다시 표시합니다. 메모리는 지워지지 않았습니다.'); }
  renderHighlights();
  const g = els.hlLayer.querySelector(`[data-id="${h.id}"] .hl-rect`);
  g?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' });
  say(`${h.page}쪽의 하이라이트 "${h.text.slice(0, 20)}"로 이동했습니다.`);
}

function addComment() {
  clearError();
  const presetIndex = Number(document.querySelector('input[name="preset"]:checked')?.value);
  try {
    const c = store.addComment({ highlightId: store.state.selectedHighlightId, presetIndex });
    say(c.highlightId ? '하이라이트에 연결된 예시 댓글을 남겼습니다.' : '신청서 전체에 예시 댓글을 남겼습니다.');
    els.list.querySelector(`[data-id="${c.id}"]`)?.focus();
  } catch (e) { fail(e.message); }
}

function addReply(commentId) {
  clearError();
  try { store.addReply(commentId); say('예시 답글을 추가했습니다. 답글은 1단계까지만 가능합니다.'); } catch (e) { fail(e.message); }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// ---------- 점수 ----------
function renderScore() {
  const { score, completed } = store.state;
  if (!els.scoreRow.children.length) {
    for (let v = 1; v <= 10; v++) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'score-btn'; b.textContent = String(v); b.dataset.score = String(v);
      b.setAttribute('aria-label', `${v}점`);
      b.addEventListener('click', () => { clearError(); try { store.setScore(v); say(`${v}점을 선택했습니다 (내 화면에만 저장).`); } catch (e) { fail(e.message); } });
      els.scoreRow.append(b);
    }
  }
  for (const b of els.scoreRow.children) b.setAttribute('aria-pressed', String(Number(b.dataset.score) === score));
  els.scoreState.textContent = score == null ? '선택 안 함' : completed ? `내 점수 ${score}/10 · 검토 완료(로컬 상태)` : `내 점수 ${score}/10 · 아직 완료 전`;
  els.complete.disabled = score == null;
  els.complete.textContent = completed ? '검토 완료됨(시연 · 로컬)' : '검토 완료(시연)';
}

// ---------- 초기화 ----------
function bind() {
  $('btn-highlight').addEventListener('click', highlightSelection);
  $('btn-example').addEventListener('click', selectExampleSentence);
  $('btn-prev').addEventListener('click', () => goToPage(view.pageNo - 1));
  $('btn-next').addEventListener('click', () => goToPage(view.pageNo + 1));
  $('btn-zoom-in').addEventListener('click', () => setZoom(nextZoom(view.zoom, 1)));
  $('btn-zoom-out').addEventListener('click', () => setZoom(nextZoom(view.zoom, -1)));
  els.filter.addEventListener('change', () => { store.setFilter(els.filter.value); say(els.filter.value === 'hidden' ? '하이라이트를 숨겼습니다. 메모리에는 그대로 남아 있습니다.' : '하이라이트를 표시합니다.'); });
  $('btn-comment').addEventListener('click', addComment);
  $('btn-detach').addEventListener('click', () => { store.selectHighlight(null); say('다음 댓글은 신청서 전체에 달립니다.'); });
  els.complete.addEventListener('click', () => { clearError(); try { store.completeReview(); say('검토 완료로 표시했습니다. 로컬 상태만 바뀌며 서버 전송은 없습니다.'); } catch (e) { fail(e.message); } });
  store.subscribe(() => { renderComments(); renderScore(); if (view.viewport) renderHighlights(); renderThumbState(); });

  let w = els.scroll.clientWidth, t = 0;
  new ResizeObserver(() => {
    if (els.scroll.clientWidth === w) return;
    w = els.scroll.clientWidth; clearTimeout(t);
    t = setTimeout(() => renderPage(view.pageNo).catch((e) => fail(e.message)), 150);
  }).observe(els.scroll);
}

async function main() {
  window.addEventListener('unhandledrejection', (ev) => fail(ev.reason?.message || String(ev.reason)));
  bind(); renderScore(); renderComments();
  try {
    view.pdfjs = await import('./vendor/pdf.mjs');
    view.pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.mjs';
    view.doc = await view.pdfjs.getDocument({ url: './assets/sample-application.pdf' }).promise;
    await renderPage(1);
    await renderThumbs();
    say(`PDF ${view.doc.numPages}쪽을 불러왔습니다. 글자를 드래그해 선택한 뒤 "선택 문장 하이라이트"를 누르세요. 예시 댓글 문구 ${PRESET_COMMENTS.length}개가 준비되어 있습니다.`);
  } catch (e) {
    fail(`PDF를 불러오지 못했습니다: ${e.message}. 로컬 서버(예: python -m http.server 8794)에서 index.html을 열었는지 확인하세요.`);
  }
}
main();
