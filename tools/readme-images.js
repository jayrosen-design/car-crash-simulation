/* The README's pictures, captured from the website itself (home.html) in headless Chrome, so the
 * README on GitHub, which can't use the site's stylesheet, looks like the site:
 *   media/readme/hero.jpg               the home page's hero: the title over the trailer's background
 *   media/readme/card-<n>.jpg           the eight simulations' cards (picture, tag, number, title,
 *                                       specs; the description and the link left out), n = 1..8
 *   media/readme/race.jpg               the Race card (picture, tag, title, specs and its buttons:
 *                                       Play Race, Watch the trailer; the description left out)
 *   media/readme/destruction.jpg        the Destruction card, the same way
 *   node tools/readme-images.js [--chrome <chrome.exe>]
 * Re-run it after the home page's pictures or posters change. The pictures are only for the README
 * (.vercelignore keeps them off the website).
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'media', 'readme');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const CHROME = arg('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const port = 9300 + Math.floor(Math.random() * 400);
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-readme-'))}`,
    '--no-first-run', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 60 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ } }
  if (!target) throw new Error('Chrome did not start (' + CHROME + ')');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map(), errors = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  // an element's box on the page (CSS px), and a capture of it at 2x
  const shoot = async (selector, file, pad = 0) => {
    const b = await ev(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; })()`);
    const clip = { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.w + 2 * pad, height: b.h + 2 * pad, scale: 1 };
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 86, clip, captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(shot.data, 'base64'));
    console.log(`wrote media/readme/${file} (${Math.round(clip.width * 2)} x ${Math.round(clip.height * 2)})`);
  };
  try {
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    await send('Page.navigate', { url: 'file:///' + path.join(ROOT, 'home.html').replace(/\\/g, '/') });
    await sleep(2500);
    await ev('document.fonts.ready.then(() => true)');
    // still pictures: the background loop paused on its poster, nothing mid-animation
    await ev(`(() => { const s = document.createElement('style'); s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }'; document.head.appendChild(s);
      const v = document.getElementById('loop'); v.pause(); v.removeAttribute('src'); v.load(); return true; })()`);
    await sleep(500);
    await shoot('.hero', 'hero.jpg');
    // the cards without their description and link (the picture, tag, number, title and specs)
    await ev(`(() => { const s = document.createElement('style'); s.textContent = '.labs .card .body > p, .labs .card .go { display: none !important; } .labs .card .body { padding-bottom: 20px !important; }'; document.head.appendChild(s); return true; })()`);
    const n = await ev(`document.querySelectorAll('.labs .card').length`);
    for (let i = 0; i < n; i++) await shoot(`.labs .card:nth-of-type(${i + 1})`, `card-${i + 1}.jpg`);
    // the game modes' cards, named after their trailers (race, destruction), without the description
    await ev(`(() => { const s = document.createElement('style'); s.textContent = '.card.game .body > p { display: none !important; }'; document.head.appendChild(s); return true; })()`);
    const games = await ev(`Array.from(document.querySelectorAll('.card.game .shot video')).map(v => v.id)`);
    for (let i = 0; i < games.length; i++) await shoot(`.card.game:has(#${games[i]})`, `${games[i]}.jpg`);
    if (errors.length) { console.log('page errors:\n' + errors.join('\n')); process.exitCode = 1; }
  } finally {
    try { ws.close(); } catch { /* closed */ }
    proc.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
