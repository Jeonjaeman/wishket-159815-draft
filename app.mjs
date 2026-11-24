// app.mjs — 모듈 진입점. 로컬 pdf.js(vendor)로 실제 PDF를 그리고, 실제 텍스트 레이어 선택을 하이라이트로 만든다.
// 네트워크 요청·브라우저 저장소·서버 없음. 상태는 core.mjs 메모리 스토어에만 있다.
import {
  createReviewStore, selectionRectsToPdf, pdfRectToCssBox, nextZoom, ZOOM_LEVELS,
  EXAMPLE_PHRASE, PRESET_COMMENTS, TOPICS, MAX_COMMENT_LENGTH,
} from './core.mjs';

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), error: $('error'), canvas: $('pdf-canvas'), textLayer: $('text-layer'),
  hlLayer: $('highlight-layer'), pageWrap: $('page-wrap'), scroll: $('pdf-scroll'), thumbs: $('thumbs'),
  pageLabel: $('page-label'), zoomLabel: $('zoom-label'), filter: $('filter'),
  list: $('comment-list'), empty: $('comment-empty'),
  newStory: $('new-story'), target: $('new-story-target'), scoreRow: $('score-row'),
  scoreState: $('score-state'), complete: $('btn-complete'), body: $('comment-body'), bodyCount: $('body-count'),
  countAll: $('count-all'), countPage: $('count-page'), tabPageNo: $('tab-page-no'), fit: $('btn-fit'), toolMore: $('tool-more'),
};
const GUTTER = 56; // 쪽 오른쪽 표식 여백(px). 텍스트 열 밖에 표식을 두기 위해 스크롤 영역 안에 예약한다.
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const say = (msg) => { els.status.textContent = msg; };
const fail = (msg) => { els.error.textContent = msg; els.error.hidden = false; say('오류: ' + msg); };
const clearError = () => { els.error.hidden = true; els.error.textContent = ''; };

const store = createReviewStore();
const view = { doc: null, pageNo: 1, zoom: 100, fit: false, viewport: null, textLayer: null, renderTask: null, pdfjs: null, pageCache: new Map(), lastRange: null, editing: null, endOfContent: null };

// ---------- PDF 렌더 ----------
async function getPage(n) {
  if (!view.pageCache.has(n)) view.pageCache.set(n, await view.doc.getPage(n));
  return view.pageCache.get(n);
}

function fitScale(page) {
  const avail = Math.max(240, els.scroll.clientWidth - 34 - GUTTER);
  const base = page.getViewport({ scale: 1 });
  const fit = Math.min(1.4, avail / base.width);
  // 좁은 화면에서 쪽을 통째로 줄이면 본문이 7px 수준이 된다. 기본은 1:1 이상으로 두고
  // PDF 영역 안에서만 가로 스크롤한다. "너비 맞춤"을 켜면 화면 너비에 맞춘다.
  return view.fit ? fit : Math.max(1, fit);
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
  view.endOfContent = end;

  els.pageLabel.textContent = `${n} / ${view.doc.numPages}`;
  els.zoomLabel.textContent = `${view.zoom}%`;
  renderHighlights();
  renderThumbState();
  renderComments(); // '이 쪽(Np)만' 탭의 라벨·수는 쪽에 따라 바뀐다
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

// ---------- 선택(upstream pdf.js TextLayerBuilder의 전역 selection 처리를 단일 뷰어용으로 옮김) ----------
// 드래그가 글자 줄 밖(여백)에서 시작·끝나면 브라우저가 다음 줄이나 빈 선택으로 확장한다.
// pdf.js는 .selecting 동안 .endOfContent를 앵커 span 바로 뒤로 옮겨 레이어 전체를 덮게 해(user-select:none) 이를 막는다.
function bindSelection() {
  const layer = els.textLayer;
  const reset = () => {
    const end = view.endOfContent; if (!end) return;
    layer.append(end); end.style.width = ''; end.style.height = ''; end.style.userSelect = '';
    layer.classList.remove('selecting');
  };
  layer.addEventListener('mousedown', () => layer.classList.add('selecting'));
  // 여백에서 시작한 마우스 드래그: 브라우저는 앵커를 레이어 컨테이너의 끝 오프셋에 두어 선택이 뒤집히거나 비게 된다.
  // 실제 span 텍스트 노드의 가장 가까운 글자 위치를 찾아 그 Range로 선택을 시작·확장한다(마우스만, 터치·키보드는 네이티브).
  let dragging = false;
  layer.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType !== 'mouse' || ev.button !== 0 || ev.shiftKey || ev.detail > 1) return;
    const pos = nearestTextPosition(ev.clientX, ev.clientY);
    if (!pos) return;
    ev.preventDefault(); dragging = true; view.dragging = true;
    document.getSelection().setBaseAndExtent(pos.node, pos.offset, pos.node, pos.offset);
    layer.classList.add('selecting');
  });
  layer.addEventListener('mousedown', (ev) => { if (dragging) ev.preventDefault(); });
  document.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const pos = nearestTextPosition(ev.clientX, ev.clientY);
    if (pos) document.getSelection().extend(pos.node, pos.offset);
  });
  const stopDrag = () => { dragging = false; view.dragging = false; };
  document.addEventListener('pointerup', stopDrag); document.addEventListener('pointercancel', stopDrag);
  let isPointerDown = false, prevRange = null;
  document.addEventListener('pointerdown', () => { isPointerDown = true; });
  document.addEventListener('pointerup', () => { isPointerDown = false; reset(); });
  window.addEventListener('blur', () => { isPointerDown = false; reset(); });
  document.addEventListener('keyup', () => { if (!isPointerDown) reset(); });
  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) { reset(); return; }
    const range = selection.getRangeAt(0);
    if (!range.intersectsNode(layer)) { reset(); return; }
    layer.classList.add('selecting');
    // 버튼 클릭 등으로 선택이 사라져도 마지막 실제 Range를 하이라이트 확정에 쓴다(가짜 DOM 아님).
    if (!range.collapsed && selection.toString().trim()) view.lastRange = range.cloneRange();
    if (view.dragging) return; // 마우스 드래그는 위에서 텍스트 노드 경계로 직접 관리한다
    if (getComputedStyle(layer).getPropertyValue('-moz-user-select') === 'none') return; // Firefox는 upstream과 같이 제외
    const modifyStart = prevRange && (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 || range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
    let anchor = modifyStart ? range.startContainer : range.endContainer;
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    if (!modifyStart && range.endOffset === 0) {
      do {
        while (!anchor.previousSibling) anchor = anchor.parentNode;
        anchor = anchor.previousSibling;
      } while (!anchor.childNodes.length);
    }
    const end = view.endOfContent;
    if (end && anchor !== end && anchor.parentElement?.closest('.textLayer') === layer) {
      end.style.width = `${layer.clientWidth}px`; end.style.height = `${layer.clientHeight}px`; end.style.userSelect = 'text';
      anchor.parentElement.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
    }
    prevRange = range.cloneRange();
  });
}

/** 화면 좌표 → 텍스트 레이어의 실제 텍스트 노드 위치. 글자 위면 caret API, 여백이면 같은 줄(없으면 가장 가까운 줄)의 끝 글자. */
function nearestTextPosition(x, y) {
  const spans = (view.textLayer?.textDivs || []).filter((d) => d.firstChild?.nodeType === Node.TEXT_NODE && d.textContent.trim());
  if (!spans.length) return null;
  const caret = (cx, cy) => {
    let r = document.caretRangeFromPoint?.(cx, cy) || null;
    if (!r && document.caretPositionFromPoint) { const c = document.caretPositionFromPoint(cx, cy); if (c) r = { startContainer: c.offsetNode, startOffset: c.offset }; }
    return r && r.startContainer?.nodeType === Node.TEXT_NODE && spans.includes(r.startContainer.parentNode) ? { node: r.startContainer, offset: r.startOffset } : null;
  };
  const hit = caret(x, y);
  if (hit) return hit;
  const boxes = spans.map((s) => ({ s, b: s.getBoundingClientRect() }));
  const vdist = ({ b }) => (y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0);
  const minV = Math.min(...boxes.map(vdist));
  const line = boxes.filter((e) => vdist(e) <= minV + 2).sort((a, b) => a.b.left - b.b.left);
  const first = line[0], last = line[line.length - 1];
  if (x <= first.b.left) return { node: first.s.firstChild, offset: 0 };
  if (x >= last.b.right) return { node: last.s.firstChild, offset: last.s.firstChild.length };
  const inside = line.find((e) => x >= e.b.left && x <= e.b.right) || line.reduce((p, e) => (Math.abs(e.b.left - x) < Math.abs(p.b.left - x) ? e : p));
  const cy = inside.b.top + inside.b.height / 2;
  return caret(Math.min(Math.max(x, inside.b.left + 1), inside.b.right - 1), cy) || { node: inside.s.firstChild, offset: x < (inside.b.left + inside.b.right) / 2 ? 0 : inside.s.firstChild.length };
}

// ---------- 하이라이트 ----------
function renderHighlights() {
  els.hlLayer.replaceChildren();
  const { selectedHighlightId } = store.state;
  const usedTops = [];
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
    // 표식은 쪽 오른쪽 여백(gutter)에 두어 어떤 확대율에서도 본문 글자를 덮지 않는다. 같은 줄이면 아래로 비킨다.
    let top = Math.max(0, first.top + first.height / 2 - 11);
    while (usedTops.some((t) => Math.abs(t - top) < 24)) top += 24;
    usedTops.push(top);
    const markerLeft = view.viewport.width + 8;
    // 연결선은 쪽(종이) 밖 거터에서만 그린다: 쪽 오른쪽 끝 → 표식. 본문 글자 위에 선을 긋지 않는다(취소선처럼 보이는 문제 방지).
    const link = document.createElement('div');
    link.className = 'hl-link'; link.setAttribute('aria-hidden', 'true');
    Object.assign(link.style, { left: `${view.viewport.width}px`, top: `${top + 11}px`, width: `${Math.max(0, markerLeft - view.viewport.width)}px` });
    const m = document.createElement('button');
    m.type = 'button'; m.className = 'hl-marker';
    m.style.left = `${markerLeft}px`; m.style.top = `${top}px`;
    m.setAttribute('aria-label', `${h.author.name} 하이라이트 "${h.text.slice(0, 30)}" — ${linked ? '연결된 댓글로 이동' : '댓글 없음, 새 이야기로 이동'}`);
    m.innerHTML = `<b aria-hidden="true">${h.author.initial}</b>`;
    m.addEventListener('click', () => focusHighlight(h.id));
    g.append(link, m);
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
  let range = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
  if (range && !range.intersectsNode(els.textLayer)) range = null;
  // 버튼을 누르는 사이 선택이 풀렸으면 selectionchange에서 보관한 마지막 실제 Range를 쓴다.
  if (!range && view.lastRange && !view.lastRange.collapsed && els.textLayer.contains(view.lastRange.commonAncestorContainer)) range = view.lastRange;
  if (!range) return null;
  return { sel, range, text: range.toString() };
}

function highlightSelection() {
  clearError();
  const picked = currentSelectionInTextLayer();
  if (!picked) { fail('PDF 글자가 선택되지 않았습니다. 본문을 드래그하거나 "예시 문장 선택"을 먼저 누르세요.'); return; }
  const text = picked.text.replace(/\s+/g, ' ').trim();
  const rects = selectionRectsToPdf(picked.range.getClientRects(), els.canvas.getBoundingClientRect(), view.viewport);
  if (!rects.length || !text) { fail('선택 영역이 현재 쪽 안에 없거나 글자가 비어 있습니다. 이미지 영역 하이라이트는 시연 범위 밖입니다.'); return; }
  try {
    const h = store.addHighlight({ page: view.pageNo, rects, text });
    picked.sel?.removeAllRanges(); view.lastRange = null;
    els.target.textContent = `선택한 하이라이트에 연결 ("${h.text.slice(0, 20)}…")`;
    say(`하이라이트를 만들었습니다 (${view.pageNo}쪽, 사각형 ${rects.length}개, PDF 좌표 저장). 새 이야기 패널에서 댓글을 연결할 수 있습니다.`);
    els.body.focus();
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
const tagChips = (tags) => tags.map((id) => { const t = TOPICS.find((x) => x.id === id); return `<span class="chip">${t.num} ${t.label}</span>`; }).join('');
const topicChecks = (name, picked) => `<span class="check-row" role="group" aria-label="이야기 꼭지 선택">${TOPICS.map((t) => `<label class="check"><input type="checkbox" name="${name}" value="${t.id}"${picked.includes(t.id) ? ' checked' : ''}> ${t.num}</label>`).join('')}</span>`;
let formSeq = 0;
/** 카드 안 인라인 편집·답글 폼. 본문은 textarea.value로만 다루고 표시는 textContent로만 한다(스크립트 문자열도 글자). */
function inlineForm({ body = '', tags = null, label, onSave, onCancel }) {
  const f = document.createElement('div'); f.className = 'inline-form'; formSeq += 1;
  f.innerHTML = `<label class="sr-only" for="f-${formSeq}">${label}</label><textarea id="f-${formSeq}" class="textarea" rows="3" maxlength="${MAX_COMMENT_LENGTH}"></textarea>
    ${tags ? topicChecks('edit-topic', tags) : ''}
    <div class="row"><button type="button" class="btn btn-primary" data-form="save">저장</button><button type="button" class="btn" data-form="cancel">취소</button></div>`;
  const ta = f.querySelector('textarea'); ta.value = body;
  f.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const act = ev.target.closest('[data-form]')?.dataset.form; if (!act) return;
    if (act === 'cancel') { onCancel(); return; }
    const picked = [...f.querySelectorAll('input[name="edit-topic"]:checked')].map((i) => i.value);
    clearError();
    try { onSave(ta.value, picked); } catch (e) { fail(e.message); ta.focus(); }
  });
  queueMicrotask(() => ta.focus());
  return f;
}
const closeForm = () => { view.editing = null; renderComments(); };

function renderComments() {
  const { activeCommentId, selectedHighlightId, tab } = store.state;
  const counts = store.commentCount(view.pageNo), comments = store.visibleComments(view.pageNo);
  els.countAll.textContent = String(counts.all); els.countPage.textContent = String(counts.page); els.tabPageNo.textContent = String(view.pageNo);
  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === tab));
  els.empty.hidden = comments.length > 0;
  els.empty.textContent = tab === 'page' && counts.all ? `${view.pageNo}쪽에 연결된 이야기가 없습니다. 전체 탭에 ${counts.all}개가 있습니다.` : '아직 댓글이 없습니다. 하이라이트를 만들고 아래에서 이야기를 남겨 보세요.';
  const ed = view.editing;
  els.list.replaceChildren(...comments.map((c) => {
    const li = document.createElement('li');
    li.className = 'comment' + (c.id === activeCommentId ? ' is-active' : '');
    li.dataset.id = c.id; li.tabIndex = -1;
    li.setAttribute('aria-current', c.id === activeCommentId ? 'true' : 'false');
    const where = c.page ? `${c.page}쪽` : '신청서 전체';
    li.innerHTML = `
      <div class="comment-head"><span class="avatar" aria-hidden="true">${c.author.initial}</span><span>${c.author.name}</span><span>· ${where}</span><span>· 방금(시연)${c.editedAt ? ' · 수정됨' : ''}</span><span class="head-tags">${tagChips(c.tags)}</span></div>
      ${c.quote ? `<q class="quote">${escapeHtml(c.quote)}</q>` : '<span class="quote">하이라이트 없이 신청서 전체에 단 댓글</span>'}
      <p class="comment-body"></p>
      <div class="comment-actions">
        ${c.highlightId ? '<button type="button" class="btn-link" data-act="goto">해당 쪽·위치로 이동</button>' : ''}
        <button type="button" class="btn-link" data-act="edit">수정</button>
        <button type="button" class="btn-link" data-act="reply">답글 달기</button>
      </div>
      <ol class="replies" aria-label="답글"></ol>`;
    li.querySelector('.comment-body').textContent = c.body;
    const replies = li.querySelector('.replies');
    for (const r of c.replies) {
      const ri = document.createElement('li'); ri.className = 'reply';
      ri.innerHTML = `<span class="avatar alt" aria-hidden="true">${r.author.initial}</span> <span class="muted">${r.author.name}${r.editedAt ? ' · 수정됨' : ''}</span> <span class="reply-body"></span> <button type="button" class="btn-link" data-act="edit-reply" data-reply="${r.id}">수정</button>`;
      ri.querySelector('.reply-body').textContent = r.body;
      if (ed?.commentId === c.id && ed.replyId === r.id) ri.replaceChildren(inlineForm({ body: r.body, label: '답글 수정', onCancel: closeForm, onSave: (b) => { store.updateReply(c.id, r.id, b); closeForm(); say('답글을 수정했습니다.'); } }));
      replies.append(ri);
    }
    if (ed?.commentId === c.id && ed.mode === 'edit') {
      li.querySelector('.comment-body').replaceWith(inlineForm({ body: c.body, tags: c.tags, label: '댓글 수정', onCancel: closeForm, onSave: (b, tags) => { store.updateComment(c.id, { body: b, tags }); closeForm(); say('댓글을 수정했습니다. 하이라이트 연결은 그대로입니다.'); } }));
    } else if (ed?.commentId === c.id && ed.mode === 'reply') {
      const ri = document.createElement('li'); ri.className = 'reply';
      ri.append(inlineForm({ label: '답글 내용', onCancel: closeForm, onSave: (b) => { store.addReply(c.id, b); closeForm(); say('답글을 남겼습니다. 답글은 1단계까지만 가능합니다.'); } }));
      replies.append(ri);
    }
    li.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-act]'), act = btn?.dataset.act;
      if (act === 'reply') { view.editing = { commentId: c.id, mode: 'reply' }; renderComments(); return; }
      if (act === 'edit') { view.editing = { commentId: c.id, mode: 'edit' }; renderComments(); return; }
      if (act === 'edit-reply') { view.editing = { commentId: c.id, replyId: btn.dataset.reply }; renderComments(); return; }
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
  const tags = [...document.querySelectorAll('#topic-checks input:checked')].map((i) => i.value);
  try {
    const c = store.addComment({ highlightId: store.state.selectedHighlightId, body: els.body.value, tags });
    els.body.value = ''; updateBodyCount();
    for (const i of document.querySelectorAll('#topic-checks input')) i.checked = false;
    say(c.highlightId ? '하이라이트에 연결된 이야기를 남겼습니다.' : '신청서 전체에 이야기를 남겼습니다.');
    els.list.querySelector(`[data-id="${c.id}"]`)?.focus();
  } catch (e) { fail(e.message); els.body.focus(); }
}
const updateBodyCount = () => { els.bodyCount.textContent = String([...els.body.value].length); };

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
  els.fit.addEventListener('click', async () => {
    view.fit = !view.fit; els.fit.setAttribute('aria-pressed', String(view.fit));
    await renderPage(view.pageNo); say(view.fit ? '쪽 너비를 화면에 맞췄습니다.' : '1:1 이상 크기로 돌아왔습니다. PDF 영역 안에서 가로로 움직일 수 있습니다.');
  });
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => { store.setTab(t.dataset.tab); say(t.dataset.tab === 'page' ? `${view.pageNo}쪽에 연결된 이야기만 봅니다.` : '모든 이야기를 봅니다.'); });
  els.body.addEventListener('input', updateBodyCount);
  for (const b of document.querySelectorAll('.preset')) b.addEventListener('click', () => { els.body.value = PRESET_COMMENTS[Number(b.dataset.preset)]; updateBodyCount(); els.body.focus(); });
  // 모바일(≤600px)에서는 하이라이트 도구를 접어 두고 쪽 이동·확대만 보인다. 넓은 화면에서는 항상 펼친다.
  const narrow = matchMedia('(max-width: 600px)');
  const syncTools = () => { els.toolMore.open = !narrow.matches; };
  narrow.addEventListener('change', syncTools); syncTools();
  bindSelection();
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
    say(`PDF ${view.doc.numPages}쪽을 불러왔습니다. 글자를 드래그해 선택한 뒤 "선택 문장 하이라이트"를 누르세요.`);
  } catch (e) {
    fail(`PDF를 불러오지 못했습니다: ${e.message}. 로컬 서버(예: python -m http.server 8794)에서 index.html을 열었는지 확인하세요.`);
  }
}
main();
