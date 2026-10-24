// PDF 대기 중인 접수를 가져와 체크된 상담지 PDF를 만들고 접수 스크립트에 붙인다.
// GitHub 작업(.github/workflows/render.yml)이 5분마다 실행. 로컬 시험: CHROME_PATH=msedge.exe 경로
//   node render.mjs --check   → 대기 건수만 확인 (GITHUB_OUTPUT 에 count=N)
//   node render.mjs           → 변환·전송
import http from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENDPOINT = process.env.ENDPOINT;
const KEY = process.env.RENDER_KEY;
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const ROOT = fileURLToPath(new URL('..', import.meta.url));   // 저장소 루트 = 사이트 폴더

if (!ENDPOINT || !KEY) { console.error('ENDPOINT / RENDER_KEY 가 없어요'); process.exit(1); }

async function pending() {
  const r = await fetch(`${ENDPOINT}?action=pending&key=${encodeURIComponent(KEY)}`);
  const j = await r.json();
  if (!j.ok) throw new Error('pending 실패: ' + JSON.stringify(j));
  return j.items || [];
}

async function attach(id, pdf) {
  const r = await fetch(ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'attach', key: KEY, id, pdf: Buffer.from(pdf).toString('base64') })
  });
  return r.json();
}

// file:// 로 열면 글꼴이 막히므로 사이트 폴더를 잠깐 로컬 서버로 연다
const TYPES = { '.html': 'text/html; charset=utf-8', '.woff2': 'font/woff2', '.js': 'text/javascript', '.css': 'text/css' };
function serve() {
  const srv = http.createServer(async (req, res) => {
    try {
      const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
      const file = join(ROOT, p || 'index.html');
      if (!file.startsWith(ROOT)) throw new Error('path');
      const buf = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(buf);
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

const items = await pending();
console.log('대기', items.length, '건');
if (process.argv.includes('--check')) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `count=${items.length}\n`);
  process.exit(0);
}
if (!items.length) process.exit(0);

const { default: puppeteer } = await import('puppeteer-core');
const srv = await serve();
const url = `http://127.0.0.1:${srv.address().port}/index.html#render`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--font-render-hinting=none'] });
let fail = 0;
try {
  for (const it of items) {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
      await page.waitForFunction(() => window.__yuhiha && window.__yuhiha.ready, { timeout: 20000 });
      await page.evaluate(st => window.__yuhiha.apply(st), it.state);
      await page.emulateMediaType('print');
      await page.evaluate(() => document.fonts.ready);
      const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
      const res = await attach(it.id, pdf);
      console.log(it.id, it.filename, Math.round(pdf.length / 1024) + 'KB', JSON.stringify(res));
      if (!res.ok) fail++;
    } catch (err) {
      fail++; console.error(it.id, err.message);
    } finally { await page.close(); }
  }
} finally {
  await browser.close(); srv.close();
}
process.exit(fail ? 1 : 0);
