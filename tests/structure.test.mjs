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
  for (const id of ['btn-highlight', 'btn-example', 'btn-prev', 'btn-next', 'btn-zoom-in', 'btn-zoom-out', 'filter', 'btn-comment', 'btn-detach', 'btn-complete', 'score-row', 'status', 'error', 'new-story', 'thumbs', 'text-layer', 'highlight-layer']) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} 누락`);
  }
  assert.match(html, /<option value="all">/); assert.match(html, /<option value="mine">/); assert.match(html, /<option value="hidden">/);
  assert.match(app, /for \(let v = 1; v <= 10; v\+\+\)/);
  assert.match(app, /aria-pressed/);
  assert.match(html, /검토 완료\(시연\)/);
  assert.match(html, /id="btn-complete" class="btn btn-primary" disabled/);
  assert.match(html, /이 제안의 관객 참여 방식이 흥미롭습니다\./);
  assert.match(html, /운영 계획을 더 구체화하면 좋겠습니다\./);
  assert.match(html, /가상 집계 · 실제 다중사용자 점수 아님/);
  assert.match(html, /<details class="aggregate">/);
  assert.match(html, /점수는 운영진만 봅니다/);
});

test('폼 없음 · 모든 버튼 type="button" · 텍스트 입력란 없음', () => {
  assert.doesNotMatch(html, /<form/);
  assert.doesNotMatch(html, /<textarea|type="text"|type="email"|type="tel"/);
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
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\);/, '모바일에서 대화 패널이 PDF 아래로');
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

// Browser-measured regression: derived scale must be set on the rendered page.
test('real sample font metrics and page-local scale avoid mobile selection drift', () => {
  assert.match(app, /setProperty\('--total-scale-factor', String\(viewport.scale\)\)/);
  assert.match(app, /document.fonts.load/);
  assert.match(app, /style.fontFamily = '"IBM Plex Sans KR"'/);
  assert.match(app, /selectionRectsToPdf\(picked.range.getClientRects\(\), els.canvas.getBoundingClientRect\(\)/);
});
