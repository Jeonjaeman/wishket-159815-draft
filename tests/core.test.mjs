import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clipRectToPage, cssRectToPdfRect, pdfRectToCssBox, isValidPdfRect, selectionRectsToPdf,
  normalizePdfRect, nextZoom, isValidScore, createReviewStore, ZOOM_LEVELS, PRESET_COMMENTS, AUTHOR,
} from '../core.mjs';

/** pdf.js PageViewport(회전 0)와 같은 수학: transform = [s,0,0,-s,0,h*s]. */
function fakeViewport(scale, pageWidth = 595, pageHeight = 842) {
  const t = [scale, 0, 0, -scale, 0, pageHeight * scale];
  const apply = (x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
  const inverse = (x, y) => {
    const d = t[0] * t[3] - t[1] * t[2];
    return [(x * t[3] - y * t[2] + t[2] * t[5] - t[4] * t[3]) / d, (-x * t[1] + y * t[0] + t[4] * t[1] - t[5] * t[0]) / d];
  };
  return {
    scale, width: pageWidth * scale, height: pageHeight * scale, rawDims: { pageWidth, pageHeight },
    convertToPdfPoint: inverse,
    convertToViewportRectangle([x1, y1, x2, y2]) { return [...apply(x1, y1), ...apply(x2, y2)]; },
  };
}
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('CSS 사각형 → PDF 좌표 → CSS 왕복이 확대율과 무관하게 일치한다', () => {
  const vp1 = fakeViewport(1);
  const css = { left: 100, top: 200, right: 300, bottom: 215 };
  const pdf = cssRectToPdfRect(css, vp1);
  assert.ok(isValidPdfRect(pdf, 595, 842));
  near(pdf[0], 100); near(pdf[2], 300); near(pdf[3], 842 - 200); near(pdf[1], 842 - 215);
  const back = pdfRectToCssBox(pdf, vp1);
  near(back.left, 100); near(back.top, 200); near(back.width, 200); near(back.height, 15);
  const z = pdfRectToCssBox(pdf, fakeViewport(1.5));
  near(z.left, 150); near(z.top, 300); near(z.width, 300); near(z.height, 22.5);
});

test('normalizePdfRect는 뒤집힌 좌표를 정렬하고, PDF 사각형 유효성은 경계와 넓이를 검사한다', () => {
  assert.deepEqual(normalizePdfRect([10, 30, 5, 20]), [5, 20, 10, 30]);
  assert.equal(isValidPdfRect([0, 0, 595, 842], 595, 842), true);
  assert.equal(isValidPdfRect([10, 10, 10, 20], 595, 842), false, '폭 0');
  assert.equal(isValidPdfRect([10, 10, 20, 10], 595, 842), false, '높이 0');
  assert.equal(isValidPdfRect([-5, 10, 20, 30], 595, 842), false, '쪽 바깥');
  assert.equal(isValidPdfRect([10, 10, 600, 30], 595, 842), false, '쪽 너비 초과');
  assert.equal(isValidPdfRect([NaN, 10, 20, 30], 595, 842), false);
  assert.equal(isValidPdfRect([0, 0, Infinity, 1], 595, 842), false);
  assert.equal(isValidPdfRect([1, 2, 3], 595, 842), false);
  assert.equal(isValidPdfRect('x', 595, 842), false);
});

test('쪽 밖으로 나간 선택 사각형은 잘리고, 완전히 밖이면 버려진다', () => {
  const page = { left: 50, top: 50, right: 645, bottom: 892 };
  assert.deepEqual(clipRectToPage({ left: 0, top: 40, right: 100, bottom: 60 }, page), { left: 50, top: 50, right: 100, bottom: 60 });
  assert.equal(clipRectToPage({ left: 0, top: 0, right: 40, bottom: 40 }, page), null);
  assert.equal(clipRectToPage({ left: 60, top: 60, right: 60, bottom: 80 }, page), null, '폭 0');
});

test('selectionRectsToPdf: 쪽 오프셋 보정 · 중복 제거 · 빈 사각형 제외', () => {
  const vp = fakeViewport(2);
  const pageBox = { left: 20, top: 30, right: 20 + vp.width, bottom: 30 + vp.height };
  const rects = [
    { left: 120, top: 130, right: 320, bottom: 150 },
    { left: 120, top: 130, right: 320, bottom: 150 }, // 중복(브라우저가 같은 줄을 두 번 줄 때)
    { left: 400, top: 400, right: 400, bottom: 420 }, // 폭 0
    { left: -500, top: -500, right: -400, bottom: -490 }, // 쪽 밖
  ];
  const out = selectionRectsToPdf(rects, pageBox, vp);
  assert.equal(out.length, 1);
  const [x1, y1, x2, y2] = out[0];
  near(x1, 50); near(x2, 150); near(y2, 842 - 50); near(y1, 842 - 60);
  const box = pdfRectToCssBox(out[0], vp);
  near(box.left, 100); near(box.top, 100); near(box.width, 200); near(box.height, 20);
  assert.deepEqual(selectionRectsToPdf([], pageBox, vp), []);
});

test('확대 단계는 75/100/125/150 안에서만 움직인다', () => {
  assert.deepEqual(ZOOM_LEVELS, [75, 100, 125, 150]);
  assert.equal(nextZoom(100, 1), 125);
  assert.equal(nextZoom(150, 1), 150);
  assert.equal(nextZoom(75, -1), 75);
  assert.equal(nextZoom(999, 1), 125, '알 수 없는 값은 100 기준');
});

test('점수는 1..10 정수만 유효하고 0·소수·문자열은 거부된다', () => {
  for (let v = 1; v <= 10; v++) assert.equal(isValidScore(v), true);
  for (const bad of [0, 11, -1, 7.5, '7', null, undefined, NaN, Infinity]) assert.equal(isValidScore(bad), false, String(bad));
});

test('스토어: 하이라이트 추가 검증과 선택 상태', () => {
  const s = createReviewStore();
  assert.throws(() => s.addHighlight({ page: 0, rects: [[0, 0, 1, 1]], text: 'a' }));
  assert.throws(() => s.addHighlight({ page: 1, rects: [], text: 'a' }));
  assert.throws(() => s.addHighlight({ page: 1, rects: [[0, 0, 1, 1]], text: '   ' }));
  const h = s.addHighlight({ page: 2, rects: [[10, 10, 50, 20]], text: ' 열린 책상 ' });
  assert.equal(h.text, '열린 책상');
  assert.equal(h.author, AUTHOR);
  assert.equal(s.state.selectedHighlightId, h.id);
  assert.equal(s.highlightCount(2), 1);
  assert.equal(s.highlightCount(1), 0);
  s.selectHighlight('없는-id');
  assert.equal(s.state.selectedHighlightId, null);
});

test('스토어: 댓글은 프리셋만, 하이라이트 연결 또는 전체 문서, 답글은 1단계', () => {
  const s = createReviewStore();
  const h = s.addHighlight({ page: 1, rects: [[0, 0, 10, 10]], text: '문장' });
  assert.throws(() => s.addComment({ highlightId: h.id, presetIndex: 9 }), /예시/);
  assert.throws(() => s.addComment({ highlightId: 'ghost', presetIndex: 0 }), /찾을 수 없습니다/);
  const c1 = s.addComment({ highlightId: h.id, presetIndex: 0 });
  assert.equal(c1.body, PRESET_COMMENTS[0]);
  assert.equal(c1.quote, '문장');
  assert.equal(c1.page, 1);
  const c2 = s.addComment({ highlightId: null, presetIndex: 1 });
  assert.equal(c2.highlightId, null);
  assert.equal(c2.quote, null);
  assert.equal(s.state.activeCommentId, c2.id);
  const r = s.addReply(c1.id);
  assert.equal(c1.replies.length, 1);
  assert.equal(r.author.name, '리뷰어 B(가상)');
  assert.equal('replies' in r, false, '답글에는 하위 답글 컨테이너가 없다');
  assert.throws(() => s.addReply('nope'));
  s.setActiveComment(c1.id);
  assert.equal(s.state.selectedHighlightId, h.id, '댓글 활성화 시 연결된 하이라이트도 선택');
});

test('스토어: 점수 선택 전에는 검토 완료 불가, 점수 변경 시 완료 해제', () => {
  const s = createReviewStore();
  assert.throws(() => s.completeReview(), /점수/);
  assert.throws(() => s.setScore(0));
  assert.throws(() => s.setScore(5.5));
  s.setScore(7);
  assert.equal(s.completeReview(), true);
  assert.equal(s.state.completed, true);
  s.setScore(8);
  assert.equal(s.state.completed, false);
});

test('스토어: 숨기기 필터는 표시만 바꾸고 메모리를 지우지 않는다', () => {
  const s = createReviewStore();
  s.addHighlight({ page: 1, rects: [[0, 0, 10, 10]], text: '가' });
  s.addHighlight({ page: 2, rects: [[0, 0, 10, 10]], text: '나' });
  assert.equal(s.visibleHighlights(1).length, 1);
  s.setFilter('hidden');
  assert.equal(s.visibleHighlights(1).length, 0);
  assert.equal(s.state.highlights.length, 2);
  s.setFilter('mine');
  assert.equal(s.visibleHighlights(2).length, 1);
  assert.throws(() => s.setFilter('others'));
});

test('스토어: 구독 알림과 reset', () => {
  const s = createReviewStore();
  let n = 0; const off = s.subscribe(() => n++);
  s.addHighlight({ page: 1, rects: [[0, 0, 10, 10]], text: '가' });
  s.setScore(3);
  assert.equal(n, 2);
  s.reset();
  assert.equal(n, 3);
  assert.deepEqual(s.state, { highlights: [], comments: [], score: null, completed: false, filter: 'all', selectedHighlightId: null, activeCommentId: null });
  off(); s.setScore(4); assert.equal(n, 3);
});
