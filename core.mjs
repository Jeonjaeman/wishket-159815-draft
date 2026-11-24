// core.mjs — DOM 없는 순수 로직: PDF 좌표 기하, 점수 검증, 메모리 상태.
// 모든 상태는 JS 메모리에만 있으며 새로고침 시 사라진다.

export const AUTHOR = { id: 'a', name: '리뷰어 A(가상)', initial: '가' };
export const REPLY_AUTHOR = { id: 'b', name: '리뷰어 B(가상)', initial: '나' };
export const ZOOM_LEVELS = [75, 100, 125, 150];
export const FILTERS = ['all', 'mine', 'hidden'];
export const PRESET_COMMENTS = [
  '이 제안의 관객 참여 방식이 흥미롭습니다.',
  '운영 계획을 더 구체화하면 좋겠습니다.',
];
export const PRESET_REPLY = '예시 답글: 같은 부분을 다시 읽어 보고 싶습니다.';
export const EXAMPLE_PHRASE = '열린 책상';

// ---------- 기하 ----------
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** CSS px 사각형을 쪽 영역 안으로 자른다. 비어 있으면 null. */
export function clipRectToPage(rect, page) {
  const left = Math.max(rect.left, page.left);
  const top = Math.max(rect.top, page.top);
  const right = Math.min(rect.right, page.right);
  const bottom = Math.min(rect.bottom, page.bottom);
  if (!(right - left > 0.5) || !(bottom - top > 0.5)) return null;
  return { left, top, right, bottom };
}

/** 쪽 기준 CSS px 사각형 → 확대율 무관 PDF 좌표 [x1,y1,x2,y2] (정규화). */
export function cssRectToPdfRect(rect, viewport) {
  const [ax, ay] = viewport.convertToPdfPoint(rect.left, rect.top);
  const [bx, by] = viewport.convertToPdfPoint(rect.right, rect.bottom);
  return normalizePdfRect([ax, ay, bx, by]);
}

export function normalizePdfRect([x1, y1, x2, y2]) {
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

/** PDF 좌표 사각형 → 현재 viewport의 CSS px 박스 {left, top, width, height}. */
export function pdfRectToCssBox(pdfRect, viewport) {
  const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(pdfRect);
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** 유한 · 넓이 있음 · 쪽(PDF 단위) 안에 있음. */
export function isValidPdfRect(r, pageWidth, pageHeight) {
  if (!Array.isArray(r) || r.length !== 4 || !r.every(finite)) return false;
  const [x1, y1, x2, y2] = r;
  if (!(x2 - x1 > 0) || !(y2 - y1 > 0)) return false;
  return x1 >= -0.5 && y1 >= -0.5 && x2 <= pageWidth + 0.5 && y2 <= pageHeight + 0.5;
}

/**
 * 선택 영역(ClientRect 목록) → 쪽에 잘린 PDF 사각형 목록.
 * pageBox: 쪽 컨테이너의 getBoundingClientRect, viewport: pdf.js PageViewport.
 */
export function selectionRectsToPdf(clientRects, pageBox, viewport) {
  const out = [];
  for (const cr of clientRects) {
    const clipped = clipRectToPage(cr, pageBox);
    if (!clipped) continue;
    const local = {
      left: clipped.left - pageBox.left,
      top: clipped.top - pageBox.top,
      right: clipped.right - pageBox.left,
      bottom: clipped.bottom - pageBox.top,
    };
    const pdfRect = cssRectToPdfRect(local, viewport);
    const { pageWidth, pageHeight } = viewport.rawDims;
    if (isValidPdfRect(pdfRect, pageWidth, pageHeight)) out.push(pdfRect);
  }
  return dedupeRects(out);
}

function dedupeRects(rects) {
  const seen = new Set();
  return rects.filter((r) => {
    const key = r.map((v) => Math.round(v * 10)).join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function nextZoom(current, direction) {
  const i = ZOOM_LEVELS.indexOf(current);
  const j = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, (i < 0 ? 1 : i) + direction));
  return ZOOM_LEVELS[j];
}

// ---------- 점수 ----------
export function isValidScore(v) {
  return Number.isInteger(v) && v >= 1 && v <= 10;
}

// ---------- 상태 ----------
let seq = 0;
const nextId = (p) => `${p}-${++seq}`;

export function createReviewStore() {
  const state = {
    highlights: [],
    comments: [],
    score: null,
    completed: false,
    filter: 'all',
    selectedHighlightId: null,
    activeCommentId: null,
  };
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(state));

  return {
    get state() { return state; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    addHighlight({ page, rects, text }) {
      if (!Number.isInteger(page) || page < 1) throw new Error('쪽 번호가 올바르지 않습니다.');
      if (!Array.isArray(rects) || rects.length === 0) throw new Error('선택 영역이 비어 있습니다.');
      const trimmed = String(text || '').trim();
      if (!trimmed) throw new Error('선택한 글자가 없습니다.');
      const h = { id: nextId('h'), page, rects, text: trimmed, author: AUTHOR, createdAt: Date.now() };
      state.highlights.push(h);
      state.selectedHighlightId = h.id;
      emit();
      return h;
    },

    selectHighlight(id) {
      state.selectedHighlightId = id && state.highlights.some((h) => h.id === id) ? id : null;
      if (state.selectedHighlightId) {
        const c = state.comments.find((x) => x.highlightId === id);
        state.activeCommentId = c ? c.id : null;
      }
      emit();
    },

    addComment({ highlightId = null, presetIndex }) {
      const body = PRESET_COMMENTS[presetIndex];
      if (!body) throw new Error('댓글 예시를 선택해 주세요.');
      if (highlightId && !state.highlights.some((h) => h.id === highlightId)) {
        throw new Error('연결할 하이라이트를 찾을 수 없습니다.');
      }
      const h = state.highlights.find((x) => x.id === highlightId);
      const c = {
        id: nextId('c'), highlightId: h ? h.id : null, page: h ? h.page : null,
        quote: h ? h.text : null, body, author: AUTHOR, replies: [], createdAt: Date.now(),
      };
      state.comments.push(c);
      state.activeCommentId = c.id;
      emit();
      return c;
    },

    addReply(commentId) {
      const c = state.comments.find((x) => x.id === commentId);
      if (!c) throw new Error('답글을 달 댓글을 찾을 수 없습니다.');
      const r = { id: nextId('r'), body: PRESET_REPLY, author: REPLY_AUTHOR, createdAt: Date.now() };
      c.replies.push(r); // 답글은 1단계만: 답글의 답글은 구조상 존재하지 않는다.
      state.activeCommentId = c.id;
      emit();
      return r;
    },

    setActiveComment(id) {
      const c = state.comments.find((x) => x.id === id);
      state.activeCommentId = c ? c.id : null;
      state.selectedHighlightId = c && c.highlightId ? c.highlightId : state.selectedHighlightId;
      emit();
    },

    setScore(v) {
      if (!isValidScore(v)) throw new Error('점수는 1부터 10까지의 정수만 가능합니다.');
      state.score = v;
      state.completed = false;
      emit();
    },

    completeReview() {
      if (!isValidScore(state.score)) throw new Error('점수를 먼저 선택해 주세요.');
      state.completed = true;
      emit();
      return true;
    },

    setFilter(f) {
      if (!FILTERS.includes(f)) throw new Error('알 수 없는 보기 옵션입니다.');
      state.filter = f;
      emit();
    },

    /** 필터는 표시만 바꾸고 메모리는 지우지 않는다. 단일 사용자 시연이라 'mine' == 'all'. */
    visibleHighlights(page) {
      if (state.filter === 'hidden') return [];
      return state.highlights.filter((h) => h.page === page);
    },

    highlightCount(page) {
      return state.highlights.filter((h) => h.page === page).length;
    },

    reset() {
      state.highlights = []; state.comments = []; state.score = null; state.completed = false;
      state.filter = 'all'; state.selectedHighlightId = null; state.activeCommentId = null;
      emit();
    },
  };
}
