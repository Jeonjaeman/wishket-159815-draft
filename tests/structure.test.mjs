import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const html = read('index.html'), css = read('style.css'), app = read('app.mjs'), core = read('core.mjs'), readme = read('README.md');
const pkg = JSON.parse(read('package.json'));

test('로컬 자원만 사용: 외부 URL · fetch · 저장소 호출 없음', () => {
  for (const [name, src] of [['index.html', html], ['style.css', css], ['app.mjs', app], ['core.mjs', core]]) {
    assert.doesNotMatch(src, /https?:\/\//, `${name}에 외부 URL`);
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|XMLHttpRequest|\bfetch\(/, `${name}에 저장소/네트워크 호출`);
  }
  assert.match(app, /import\('\.\/vendor\/pdf\.mjs'\)/);
  assert.match(app, /workerSrc = '\.\/vendor\/pdf\.worker\.mjs'/);
  assert.match(app, /'\.\/assets\/sample-application\.pdf'/);
  assert.match(css, /url\("\.\/assets\/fonts\/IBMPlexSansKR-Regular\.ttf"\)/);
  assert.match(html, /<script type="module" src="\.\/app\.mjs"><\/script>/);
});

test('고정 의존성과 vendor · 폰트 · 샘플 PDF 파일이 보존된다', () => {
  assert.equal(pkg.dependencies['pdfjs-dist'], '5.4.624');
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.mjs');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.packages['node_modules/pdfjs-dist'].version, '5.4.624');
  for (const f of ['vendor/pdf.mjs', 'vendor/pdf.worker.mjs', 'vendor/pdf_viewer.css', 'vendor/PDFJS_LICENSE.txt', 'assets/fonts/IBMPlexSansKR-Regular.ttf', 'assets/fonts/OFL.txt', 'assets/sample-application.pdf']) {
    assert.ok(existsSync(join(root, f)), `${f} 누락`);
    assert.ok(statSync(join(root, f)).size > 0, `${f} 비어 있음`);
  }
  const pdf = readFileSync(join(root, 'assets/sample-application.pdf'));
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-', '실제 PDF 서명');
  assert.ok(pdf.length > 50_000);
});

test('pdf.js 실제 렌더 경로: canvas + TextLayer + viewport 좌표 변환 사용', () => {
  assert.match(app, /new view\.pdfjs\.TextLayer\(\{ textContentSource: textContent, container: els\.textLayer, viewport \}\)/);
  assert.match(app, /page\.render\(\{ canvasContext/);
  assert.match(app, /getClientRects\(\)/);
  assert.match(core, /convertToPdfPoint/);
  assert.match(core, /convertToViewportRectangle/);
  assert.match(app, /document\.createRange\(\)/, '예시 문장 선택은 실제 Range');
  assert.match(css, /\.textLayer :is\(span, br\)/);
  assert.match(css, /--total-scale-factor/);
});

test('UI 계약: 시연 띠 · 가상 명칭 · 도구줄 · 점수 1..10(0 없음) · 완료 버튼', () => {
  assert.match(html, /로컬 단일 사용자 시연 · 공동 동기화·서버 권한 미구현 · 새로고침 시 초기화/);
  assert.match(html, /함께 읽는 방 · 리뷰 시연/);
  assert.match(html, /가상 프로젝트 · 열린 책상/);
  assert.doesNotMatch(html, /WESS\+?/, '실제 브랜드명 미사용');
  for (const id of ['btn-highlight', 'btn-example', 'btn-prev', 'btn-next', 'btn-zoom-in', 'btn-zoom-out', 'btn-fit', 'filter', 'btn-comment', 'btn-detach', 'btn-complete', 'score-row', 'status', 'error', 'new-story', 'thumbs', 'text-layer', 'highlight-layer', 'comment-body', 'topic-checks', 'tab-all', 'tab-page', 'count-all', 'count-page', 'tool-more']) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} 누락`);
  }
  assert.match(html, /<option value="all">/); assert.match(html, /<option value="mine">/); assert.match(html, /<option value="hidden">/);
  assert.match(app, /for \(let v = 1; v <= 10; v\+\+\)/);
  assert.match(app, /aria-pressed/);
  assert.match(html, /검토 완료\(시연\)/);
  assert.match(html, /id="btn-complete" class="btn btn-primary" disabled/);
  assert.match(html, /data-preset="0"/); assert.match(html, /data-preset="1"/);
  assert.match(app, /PRESET_COMMENTS\[Number\(b\.dataset\.preset\)\]/, '예문 버튼은 textarea를 채우기만 한다');
  assert.match(html, /가상 집계 · 실제 다중사용자 점수 아님/);
  assert.match(html, /<details class="aggregate">/);
  assert.match(html, /점수는 운영진만 봅니다/);
});

test('자유 입력은 댓글 textarea(500자)뿐 · 개인정보 입력란 없음 · 모든 버튼 type="button"', () => {
  assert.doesNotMatch(html, /<form/);
  assert.doesNotMatch(html, /type="text"|type="email"|type="tel"|type="password"|autocomplete=/);
  assert.equal((html.match(/<textarea/g) || []).length, 1);
  assert.match(html, /<textarea id="comment-body" class="textarea" rows="3" maxlength="500"/);
  assert.match(app, /maxlength="\$\{MAX_COMMENT_LENGTH\}"/, '인라인 수정 폼도 같은 길이 제한');
  assert.match(html, /시연용 문장만 입력 · 개인정보 입력 금지 · 전송\/저장 없음/);
  assert.equal((html.match(/개인정보/g) || []).length, 1, '입력 근처 안내 한 번만');
  assert.match(app, /querySelector\('\.comment-body'\)\.textContent = c\.body/, '본문은 textContent로만 표시');
  assert.match(app, /querySelector\('\.reply-body'\)\.textContent = r\.body/);
  assert.doesNotMatch(app, /innerHTML = `[^`]*\$\{(?:escapeHtml\()?[cr]\.body/, '본문을 innerHTML 템플릿에 넣지 않음');
  assert.doesNotMatch(app, /\bprompt\(|\bconfirm\(|\balert\(/, '차단형 대화상자 없음');
  for (const t of ['interest', 'visit', 'space']) assert.match(html, new RegExp(`<input type="checkbox" name="topic" value="${t}"`));
  for (const m of html.matchAll(/<button\b[^>]*>/g)) assert.match(m[0], /type="button"/, m[0]);
  for (const m of app.matchAll(/<button\b[^>]*>/g)) assert.match(m[0], /type="button"/, m[0]);
  assert.match(app, /\.type = 'button'/);
  const created = (app.match(/document\.createElement\('button'\)/g) || []).length;
  const typed = (app.match(/\.type = 'button'/g) || []).length;
  assert.ok(typed >= created, '생성한 버튼마다 type=button 지정');
});

test('접근성 계약: 12px 최소 · 44px 컨트롤 · 포커스 윤곽 · 라이브 영역 · reduced motion', () => {
  const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 5);
  assert.ok(sizes.every((v) => v >= 12), `12px 미만 글자: ${sizes.filter((v) => v < 12)}`);
  assert.match(css, /--control: 44px/);
  assert.match(css, /:focus-visible \{ outline/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /role="toolbar"/);
  assert.match(css, /\.toolbar \{ display: flex; flex-wrap: wrap/);
  assert.match(css, /@media \(max-width: 1100px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\);/, '좁은 화면에서 대화 패널이 PDF 아래로');
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) minmax\(500px, 32%\)/, '데스크톱: 대화 ≥500px(44px 점수 버튼 10개 한 줄)');
  assert.match(app, /prefers-reduced-motion: reduce/);
  assert.match(app, /behavior: reduced\(\) \? 'auto' : 'smooth'/);
  assert.match(css, /\.highlight-layer \{ position: absolute; inset: 0; pointer-events: none/);
});

test('README: 실행법 · 범위 · 라이선스 · 미구현 항목이 적혀 있고 내부 문서 경로가 없다', () => {
  for (const s of ['python -m http.server 8794', 'Apache', 'OFL', 'pdfjs-dist 5.4.624', 'IBM Plex Sans KR', '미구현', 'RLS', '역할', '신청자', '운영진']) {
    assert.ok(readme.includes(s), `README에 "${s}" 누락`);
  }
  for (const name of [html, css, app, core, readme]) {
    assert.doesNotMatch(name, /위시캣|attach-159815|mockup-images|spec\.txt|PLANS|D:\\|D:\//, '내부 경로/문서명 노출');
  }
});

test('화면 계약: 탭 2개 · 꼭지 칩 3개 · 상태는 SR 전용 · 경고 문구 중복 제거 · 미구현 표기', () => {
  assert.match(html, /role="tab" id="tab-all"[^>]*aria-selected="true"[^>]*>함께 나눈 이야기/);
  assert.match(html, /role="tab" id="tab-page"[^>]*>이 쪽\(<span id="tab-page-no">1<\/span>p\)만/);
  assert.match(app, /store\.setTab\(t\.dataset\.tab\)/);
  assert.match(app, /commentCount\(view\.pageNo\)/, '탭 수는 현재 쪽 기준으로 다시 계산');
  assert.match(css, /\.tab\[aria-selected="true"\] \{ background: var\(--ink\); color: var\(--paper\); \}/);
  for (const c of ['① 흥미로운 점', '② 실제로 보고 싶은지', '③ 공간에서의 가능성']) assert.match(html, new RegExp(`<li class="chip">${c}</li>`));
  assert.match(html, /<p id="status" class="sr-only" role="status" aria-live="polite">/);
  assert.match(html, /이해관계 제외 · 이 시연에서는 미구현/);
  assert.doesNotMatch(html, /2차 범위|목록으로 돌아가기는 이 시연에 없습니다/);
  assert.equal((html.match(/서버 권한/g) || []).length, 1, '서버 권한 경고는 띠 한 번');
  assert.doesNotMatch(html, /class="hint"/);
  assert.match(html, /<details class="tool-help">/);
  assert.match(html, /<details class="tool-more" id="tool-more">\s*<summary class="btn">/);
  assert.match(app, /matchMedia\('\(max-width: 600px\)'\)/, '모바일에서만 도구 접힘');
  assert.match(css, /\.aggregate summary \{[^}]*min-height: var\(--control\)/);
});

test('선택 처리: upstream endOfContent 이동 · 마지막 실제 Range 보존 · 표식은 쪽 오른쪽 여백', () => {
  assert.match(app, /document\.addEventListener\('selectionchange'/);
  assert.match(app, /compareBoundaryPoints\(Range\.END_TO_END, prevRange\)/);
  assert.match(app, /insertBefore\(end, modifyStart \? anchor : anchor\.nextSibling\)/);
  assert.match(app, /layer\.classList\.add\('selecting'\)/);
  assert.match(css, /\.textLayer\.selecting \.endOfContent \{ top: 0; \}/);
  assert.match(css, /\.textLayer \.endOfContent \{[^}]*user-select: none/);
  assert.match(app, /view\.lastRange = range\.cloneRange\(\)/);
  assert.match(app, /text: range\.toString\(\)/, '선택 원문은 Range에서');
  assert.match(app, /caretRangeFromPoint|caretPositionFromPoint/, '여백 드래그는 가장 가까운 실제 텍스트 노드 위치로 앵커');
  assert.match(app, /setBaseAndExtent\(pos\.node, pos\.offset, pos\.node, pos\.offset\)/);
  assert.match(app, /if \(ev\.pointerType !== 'mouse'/, '터치·펜은 네이티브 선택 유지');
  assert.match(app, /const markerLeft = view\.viewport\.width \+ 8;/, '표식 x는 항상 쪽 폭 밖');
  assert.match(app, /className = 'hl-link'/);
  assert.match(css, /\.page-frame \{[^}]*padding-right: var\(--gutter\)/);
  assert.match(app, /els\.scroll\.clientWidth - 34 - GUTTER/);
  assert.match(app, /return view\.fit \? fit : Math\.max\(1, fit\);/, '기본 배율 1:1 이상, 맞춤은 선택');
  assert.doesNotMatch(css, /\.pdf-scroll \{[^}]*justify-content: center/, '넘칠 때 왼쪽이 잘리지 않도록 margin auto 중앙 정렬');
  assert.match(css, /\.page-frame \{ flex: 0 0 auto; margin: 0 auto;/);
});

// Browser-measured regression: derived scale must be set on the rendered page.
test('real sample font metrics and page-local scale avoid mobile selection drift', () => {
  assert.match(app, /setProperty\('--total-scale-factor', String\(viewport.scale\)\)/);
  assert.match(app, /document.fonts.load/);
  assert.match(app, /style.fontFamily = '"IBM Plex Sans KR"'/);
  assert.match(app, /selectionRectsToPdf\(picked.range.getClientRects\(\), els.canvas.getBoundingClientRect\(\)/);
});
