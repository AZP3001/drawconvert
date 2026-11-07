'use strict';
// Drives index.html in headless Chrome: loads each fixture through the file input,
// waits for tracing, checks the stroke preview, moves the sliders, clicks Convert and re-parses the
// downloaded .sdocx with the FORMAT.md parser. Fails on any page exception or console error.
// Usage: node tests/browser_smoke.js        (CHROME=/path/to/chrome to pick the browser)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { parseSdocx, strokesOf } = require('./sdocx_parser.js');

const HTML = path.join(__dirname, '..', 'index.html');
const FIXTURES = ['simple_lines', 'thick_brush', 'color_sketch', 'shading'];

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  const candidates = fs.existsSync(base) ? fs.readdirSync(base).flatMap((d) => [
    path.join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
    path.join(base, d, 'chrome-linux64', 'chrome'),
  ]) : [];
  candidates.push('/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser');
  return candidates.find((c) => fs.existsSync(c));
}

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error('No Chrome/Chromium found; set CHROME=/path/to/chrome');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sdocx-smoke-'));
  const downloads = path.join(work, 'downloads');
  fs.mkdirSync(downloads);
  const proc = spawn(chrome, ['--headless', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${path.join(work, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${log}`)), 15000);
    proc.stderr.on('data', (d) => {
      log += d;
      const m = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => reject(new Error(`Chrome exited (${code}):\n${log}`)));
  });

  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools connection failed')); });
  let nextId = 1;
  const pending = new Map(), listeners = [];
  const problems = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ''}`)); else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') problems.push(`exception: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    for (const l of listeners) l(msg);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const waitFor = (predicate, what, ms = 20000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    listeners.push((msg) => { if (predicate(msg)) { clearTimeout(timer); resolve(msg); } });
  });

  let failures = 0;
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const page = (method, params) => send(method, params, sessionId);
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
    await page('Page.enable');
    await page('Runtime.enable');
    const loaded = waitFor((m) => m.method === 'Page.loadEventFired', 'page load');
    await page('Page.navigate', { url: 'file://' + HTML });
    await loaded;
    const evaluate = async (expression) => {
      const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    };
    const waitStatus = async (what) => {
      for (const started = Date.now(); Date.now() - started < 30000;) {
        const status = await evaluate('document.getElementById("status").textContent');
        if (/^(Ready|Done)/.test(status)) return status;
        if (document_error(status)) throw new Error(`${what}: page reports "${status}"`);
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`${what}: status never became ready`);
    };
    const document_error = (status) => /could not|failed|no lines|too many|please/i.test(status);
    const inkedPixels = 'new Promise((resolve) => requestAnimationFrame(() => { const c = document.getElementById("stroke-canvas"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) n++; resolve(n); }))';
    // Comparison slider: the picture canvas must sit exactly under the strokes (ink overlap of the two canvases).
    const pictureOverlap = 'new Promise((resolve) => requestAnimationFrame(() => { const px = (id) => { const c = document.getElementById(id); return c.getContext("2d").getImageData(0, 0, c.width, c.height).data; }; const a = px("stroke-canvas"), b = px("picture-canvas"); let lo = 0, hi = 0; for (let i = 0; i < a.length; i += 4) { const x = 255 - Math.min(a[i], a[i + 1], a[i + 2]), y = 255 - Math.min(b[i], b[i + 1], b[i + 2]); lo += Math.min(x, y); hi += Math.max(x, y); } resolve(lo / hi); }))';
    const moveDivider = '(() => { const s = document.getElementById("split"); s.value = "30"; s.dispatchEvent(new Event("input")); return document.getElementById("compare").style.getPropertyValue("--split"); })()';

    for (const name of FIXTURES) {
      const { root } = await page('DOM.getDocument');
      const { nodeId } = await page('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-input' });
      await page('DOM.setFileInputFiles', { nodeId, files: [path.join(__dirname, 'fixtures', name + '.png')] });
      const status = await waitStatus(`${name} trace`);
      const count = await evaluate('document.getElementById("stroke-count").textContent');
      const inked = await evaluate(inkedPixels);
      const strokes = Number((count.match(/^([\d,]+)/) || [])[1]?.replace(/,/g, ''));   // "1,195 strokes · …"
      if (!(strokes > 0 && inked > 500)) { failures++; console.log(`  FAIL ${name}: preview shows ${count}, ${inked} inked canvas pixels`); }
      const overlap = await evaluate(pictureOverlap), split = await evaluate(moveDivider);
      if (!(overlap > 0.8) || split !== '30%') { failures++; console.log(`  FAIL ${name}: picture overlaps the strokes ${overlap.toFixed(3)}, divider at "${split}"`); }
      // Exercise every setting: detail re-trace, margin and background redraw.
      await evaluate('(() => { const d = document.getElementById("detail"); d.value = "20"; d.dispatchEvent(new Event("input")); })()');
      await new Promise((r) => setTimeout(r, 400));
      await waitStatus(`${name} re-trace`);
      await evaluate('(() => { const m = document.getElementById("margin"); m.value = "6"; m.dispatchEvent(new Event("input")); const b = document.getElementById("background"); b.value = "auto"; b.dispatchEvent(new Event("change")); })()');
      await evaluate(`(() => { const d = document.getElementById("detail"); d.value = "60"; d.dispatchEvent(new Event("input")); document.getElementById("note-name").value = ${JSON.stringify(name)}; })()`);
      await new Promise((r) => setTimeout(r, 400));
      await waitStatus(`${name} re-trace`);
      // Lines are written as pieces whose count follows the page scale, so compare with the preview as converted (margin 6).
      const shown = Number(((await evaluate('document.getElementById("stroke-count").textContent')).match(/^([\d,]+)/) || [])[1]?.replace(/,/g, ''));
      const done = waitFor((m) => m.method === 'Browser.downloadProgress' && m.params.state === 'completed', `${name} download`);
      await evaluate('document.getElementById("convert").click()');
      await done;
      const final = await waitStatus(`${name} convert`);
      const file = path.join(downloads, name + '.sdocx');
      const doc = parseSdocx(fs.readFileSync(file));
      const written = strokesOf(doc).length;
      const reported = Number((final.match(/([\d,]+) strokes/) || [])[1]?.replace(/,/g, ''));
      if (written !== reported || written !== shown) { failures++; console.log(`  FAIL ${name}: preview ${shown}, status ${reported}, file ${written} strokes`); }
      if (doc.pages[0].properties.bgColor === undefined) { failures++; console.log(`  FAIL ${name}: page background missing`); }
      // The accuracy shown under the preview: a misplaced or unpainted comparison scores far below the fixtures' ~90-99 %.
      const match = await evaluate('document.getElementById("match").textContent');
      if (!(parseFloat(match) >= 85 && parseFloat(match) <= 100)) { failures++; console.log(`  FAIL ${name}: accuracy shows "${match}"`); }
      console.log(`  ${name}: ${status} | preview ${count}, ${inked} inked px, accuracy ${match}, picture overlap ${overlap.toFixed(3)} | downloaded ${path.basename(file)} → ${written} strokes, parses OK`);
    }
  } finally {
    ws.close();
    proc.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
  for (const p of problems) { failures++; console.log(`  FAIL page ${p}`); }
  console.log(failures ? `\n${failures} browser check(s) failed.` : '\nBrowser smoke test passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
