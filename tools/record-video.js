/* Records the home page's media from the simulator, in headless Chrome:
 *   media/crash-reel.mp4   about a minute of Lexus crashes, driven through the setup panel
 *   media/poster.jpg       the video's poster frame
 *   media/shot-rigid.jpg   pictures of the two barrier tests for the home page
 *   media/shot-brick.jpg
 *   media/lab-<id>.jpg     a picture of each crash lab's finished test
 * The page runs on a virtual clock: every frame advances it by exactly 1/30 s and is captured,
 * so the video is smooth however long a frame takes to render. Blender encodes the frames
 * (tools/encode-video.py), so no separate ffmpeg install is needed.
 *   node tools/record-video.js [shots|video|labs] [--chrome <chrome.exe>] [--blender <blender.exe>]
 * Rebuild Simulator.html first (node tools/build-standalone.js): this records that file. Rebuild
 * again afterwards, to embed the new media in Car Crash Simulation.html.
 */
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MEDIA = path.join(ROOT, 'media');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const CHROME = arg('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const BLENDER = arg('--blender', 'C:/Program Files/Blender Foundation/Blender 5.1/blender.exe');
const ONLY = ['shots', 'video', 'labs'].find(k => process.argv.includes(k));
const W = 1280, H = 720, FPS = 30, DT = 1000 / FPS;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pageUrl = (q) => 'file:///' + path.join(ROOT, 'Simulator.html').replace(/\\/g, '/').replace(/ /g, '%20') + (q || '');

// ---------------------------------------------------------------- Chrome over the DevTools protocol
async function openBrowser() {
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-chrome-'));
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run',
    `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not up yet */ }
  }
  if (!target) throw new Error('Chrome did not start (' + CHROME + ')');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map(), errors = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, (m) => m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  // virtual clock: requestAnimationFrame callbacks only run when the recorder steps the page
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const q = []; let base = null, vt = 0;
    window.requestAnimationFrame = (cb) => { q.push(cb); return q.length; };
    window.cancelAnimationFrame = () => {};
    window.__vstep = (ms) => { if (base === null) base = performance.now(); vt += ms; const cbs = q.splice(0); for (const cb of cbs) cb(base + vt); };
  })();` });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n  in: ' + expr.slice(0, 200));
    return r.result.value;
  };
  const shot = async (quality = 90) => Buffer.from((await send('Page.captureScreenshot', { format: 'jpeg', quality })).data, 'base64');
  const close = () => { try { ws.close(); } catch { /* closed */ } proc.kill(); };
  return { send, ev, shot, close, errors };
}

// in-page helpers: a drawn cursor, captions, an end card, and UI actions
const HELPERS = `(() => {
  const css = document.createElement('style');
  css.textContent = \`
    #rec-cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 10000; pointer-events: none; display: none; filter: drop-shadow(0 2px 3px rgba(0,0,0,.55)); }
    #rec-ripple { position: fixed; z-index: 9999; pointer-events: none; border: 2px solid #4f9cf0; border-radius: 50%; display: none; }
    #rec-cap { position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%); z-index: 9998; pointer-events: none; display: none;
      background: rgba(11,15,20,.84); border: 1px solid #2b333d; border-left: 4px solid #4f9cf0; border-radius: 10px; padding: 10px 18px 11px; text-align: left; min-width: 360px; }
    #rec-cap b { display: block; font: 700 21px/1.25 system-ui, "Segoe UI", sans-serif; color: #e6e9ee; letter-spacing: .2px; }
    #rec-cap span { display: block; font: 15px/1.35 system-ui, "Segoe UI", sans-serif; color: #b8c1cc; margin-top: 2px; }
    #rec-card { position: fixed; inset: 0; z-index: 10001; display: none; place-items: center; text-align: center; background: rgba(9,12,16,.9); }
    #rec-card h1 { margin: 0; font: 800 54px/1.1 system-ui, "Segoe UI", sans-serif; color: #e6e9ee; letter-spacing: .5px; }
    #rec-card p { margin: 14px 0 0; font: 20px/1.4 system-ui, "Segoe UI", sans-serif; color: #98a2ae; }
    #rec-card i { display: block; width: 80px; height: 4px; background: #4f9cf0; margin: 22px auto 0; border-radius: 2px; }
    .rec-clean #topbar, .rec-clean .panel, .rec-clean #pip-label, .rec-clean #toast, .rec-clean #legend { display: none !important; }\`;
  document.head.appendChild(css);
  const cur = document.createElement('div'); cur.id = 'rec-cursor';
  cur.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2 L4 19 L8.6 14.8 L11.6 21.4 L14.4 20.2 L11.4 13.7 L17.6 13.7 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const rip = document.createElement('div'); rip.id = 'rec-ripple';
  const cap = document.createElement('div'); cap.id = 'rec-cap'; cap.innerHTML = '<b></b><span></span>';
  const card = document.createElement('div'); card.id = 'rec-card';
  card.innerHTML = '<div><h1>Car Crash Simulation</h1><p>Physics-based crash testing that runs in your browser</p><i></i></div>';
  document.body.append(cur, rip, cap, card);
  const q = (s) => document.querySelector(s);
  window.__rec = {
    step: (ms) => window.__vstep(ms),
    cursor(x, y, show) { cur.style.display = show === false ? 'none' : 'block'; cur.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 2) + 'px)'; },
    ripple(x, y, k) {   // k: 0..1 through the click
      if (k >= 1) { rip.style.display = 'none'; return; }
      const r = 6 + 22 * k; rip.style.display = 'block'; rip.style.opacity = String(1 - k);
      rip.style.left = (x - r) + 'px'; rip.style.top = (y - r) + 'px'; rip.style.width = rip.style.height = 2 * r + 'px';
    },
    center(sel) { const el = q(sel); el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; },
    thumb(sel, v) { const el = q(sel); el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(), t = (v - +el.min) / (+el.max - +el.min); return [r.left + 8 + t * (r.width - 16), r.top + r.height / 2]; },
    setRange(sel, v) { const el = q(sel); el.value = v; el.dispatchEvent(new Event('input')); },
    click(sel) { q(sel).click(); },
    caption(title, sub, alpha) { cap.style.display = alpha > 0 ? 'block' : 'none'; cap.style.opacity = String(alpha); cap.querySelector('b').textContent = title; cap.querySelector('span').textContent = sub; },
    card(alpha) { card.style.display = alpha > 0 ? 'grid' : 'none'; card.style.opacity = String(alpha); },
    clean(on) { document.body.classList.toggle('rec-clean', on); },
    noPip() { const r = Scene3D.render; Scene3D.render = (dt, pip, b) => r(dt, false, b); },
    state() { return q('#stepper li.on')?.dataset.step; },
    ready() { return window.CrashLabs ? CrashLabs.ready() : typeof Scene3D === 'object' && !q('#btn-run').disabled && (!!Scene3D.vehicleModel || q('.seg[data-name=vehicle] button.on')?.dataset.v === 'lab'); },
    // a fixed camera (lab pictures)
    look(px, py, pz, tx, ty, tz) { Scene3D.setCameraMode('free', { frame: { pos: new THREE.Vector3(px, py, pz), target: new THREE.Vector3(tx, ty, tz) } }); },
    speed(v) { const s = q('#tl-speed'); s.value = String(v); s.dispatchEvent(new Event('change')); },
    playing() { return q('#btn-play').textContent === 'Pause'; },
    time() { return q('#tl-time').textContent; },
    // camera: an orbit around the car (free camera)
    orbit(deg, dist, height, ahead) {
      const c = Scene3D.cabin, o = c.o.clone().addScaledVector(c.f0, ahead || 0), a = deg * Math.PI / 180;
      const dir = c.f0.clone().multiplyScalar(Math.cos(a)).addScaledVector(c.l0, Math.sin(a));
      document.querySelectorAll('.seg[data-name=camera] button').forEach(x => x.classList.toggle('on', x.dataset.v === 'free'));
      Scene3D.setCameraMode('free', { frame: { pos: o.clone().addScaledVector(dir, dist).add(new THREE.Vector3(0, height, 0)), target: o.clone().add(new THREE.Vector3(0, 0.5, 0)) } });
    },
  };
})();`;

// ---------------------------------------------------------------- a director for the page
function director(b, framesDir) {
  let frameNo = 0, captured = 0, cx = W / 2, cy = H / 2, cursorOn = false;
  let caption = null;   // { title, sub, start }
  const ease = (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const d = {
    get captured() { return captured; },
    // advance one frame (1/30 s of page time) and capture it (or not)
    async frame(capture = true, extra = '') {
      let capJs = '';
      if (caption) {
        const age = captured - caption.start, alpha = caption.out !== undefined ? Math.max(0, 1 - (captured - caption.out) / 8) : Math.min(1, age / 8);
        capJs = `__rec.caption(${JSON.stringify(caption.title)}, ${JSON.stringify(caption.sub)}, ${alpha.toFixed(3)});`;
        if (alpha === 0 && caption.out !== undefined) caption = null;
      }
      await b.ev(`__rec.step(${DT});__rec.cursor(${cx.toFixed(1)}, ${cy.toFixed(1)}, ${cursorOn});${capJs}${extra}`);
      frameNo++;
      if (capture) { fs.writeFileSync(path.join(framesDir, 'f' + String(captured).padStart(5, '0') + '.jpg'), await b.shot(92)); captured++; }
    },
    async hold(n, extra) { for (let i = 0; i < n; i++) await d.frame(true, typeof extra === 'function' ? extra(i, n) : (extra || '')); },
    caption(title, sub) { caption = { title, sub, start: captured }; },
    captionOut() { if (caption) caption.out = captured; },
    showCursor(on) { cursorOn = on; },
    async move(to, n = 14) {
      const x0 = cx, y0 = cy;
      for (let i = 1; i <= n; i++) { const t = ease(i / n); cx = x0 + (to[0] - x0) * t; cy = y0 + (to[1] - y0) * t; await d.frame(); }
    },
    async click(sel, n = 14) {
      const p = await b.ev(`__rec.center(${JSON.stringify(sel)})`);
      await d.move(p, n);
      for (let i = 0; i < 7; i++) await d.frame(true, `__rec.ripple(${p[0]}, ${p[1]}, ${(i / 6).toFixed(3)});` + (i === 1 ? `__rec.click(${JSON.stringify(sel)});` : ''));
    },
    async drag(sel, from, to, n = 24) {
      await d.move(await b.ev(`__rec.thumb(${JSON.stringify(sel)}, ${from})`), 12);
      for (let i = 1; i <= n; i++) {
        const v = Math.round(from + (to - from) * ease(i / n));
        const p = await b.ev(`__rec.setRange(${JSON.stringify(sel)}, ${v}); __rec.thumb(${JSON.stringify(sel)}, ${v})`);
        cx = p[0]; cy = p[1];
        await d.frame();
      }
      await d.hold(4);
    },
    // run page frames until the test reaches `state`, capturing every k-th frame
    async until(state, k, maxFrames = 3000) {
      for (let i = 0; i < maxFrames; i++) {
        if (await b.ev('__rec.state()') === state) return;
        await d.frame(i % k === 0);
      }
      throw new Error('timed out waiting for ' + state);
    },
  };
  return d;
}

async function openSimulator(b, query) {
  await b.send('Page.navigate', { url: pageUrl(query) });
  for (let i = 0; i < 200; i++) {
    await sleep(100);
    try { if (await b.ev('typeof Scene3D === "object" && typeof CarModels === "object" && (!location.search.includes("lab=") || !!window.CrashLabs)')) break; } catch { /* loading */ }
  }
  await b.ev(HELPERS);
  // let the vehicle model load (the page clock must tick for the app to settle)
  for (let i = 0; i < 300; i++) { await b.ev(`__rec.step(${DT})`); if (await b.ev('__rec.ready()')) return; await sleep(30); }
  const why = await b.ev(`JSON.stringify({ run: document.querySelector('#btn-run').disabled, status: document.querySelector('#veh-status').textContent, model: !!Scene3D.vehicleModel, loading: document.querySelector('#loading') && document.querySelector('#loading').textContent, toast: document.querySelector('#toast').textContent })`);
  throw new Error('the simulator did not become ready: ' + why + (b.errors.length ? ' ' + b.errors.join(' | ') : ''));
}

// ---------------------------------------------------------------- the reel (about 60 s)
async function recordReel(b) {
  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-frames-'));
  await openSimulator(b, '');
  const d = director(b, framesDir);
  const playFor = async (n, extra) => d.hold(n, extra);

  // 0 - intro: the Lexus on the test track, camera circling
  d.caption('Car Crash Simulation', 'Physics-based crash testing in the browser');
  await d.hold(84, (i, n) => `__rec.orbit(${(200 - 70 * i / n).toFixed(2)}, 7.5, 2.4, 0.4);`);
  d.captionOut();

  // 1 - set up and run: 64 km/h head-on, rigid barrier, Realistic damage
  await b.ev(`Scene3D.setCameraMode('setup')`);
  d.caption('Set up a test', 'Choose the car, speed, angle, barrier and damage level');
  d.showCursor(true);
  await d.move([140, 330], 12);
  await d.click('.seg[data-name=vehicle] button[data-v=lexus]');
  await d.drag('#in-speed', 56, 64, 20);
  await d.click('.seg[data-name=barrier] button[data-v=rigid]', 12);
  await d.click('.seg[data-name=damage] button[data-v=realistic]', 12);
  await d.click('#btn-run', 14);
  d.showCursor(false); d.captionOut();
  d.caption('Automated approach', 'Cruise control and steering hold the car on its line');
  await d.until('impact', 2);
  d.caption('Impact computed in 0.1 ms steps', 'Then replayed in slow motion, like a high-speed camera');
  await d.until('playback', 5);
  await b.ev(`__rec.speed(0.1); document.querySelector('#btn-collapse').click();`);
  d.caption('64 km/h · head-on · rigid barrier', 'Realistic damage: the front crumples, lamps shatter, the airbag fires');
  await playFor(126);
  d.captionOut();

  // 2 - 100 km/h at 30 degrees, Dramatic damage
  d.showCursor(true);
  await d.click('#btn-reset', 14);
  d.caption('Change the angle and speed', 'Dramatic damage lets parts break off at lower speeds');
  await d.drag('#in-angle', 0, -30, 20);
  await d.drag('#in-speed', 64, 100, 20);
  await d.click('.seg[data-name=damage] button[data-v=dramatic]', 12);
  await d.click('#btn-run', 14);
  d.showCursor(false); d.captionOut();
  await d.until('impact', 2);
  await d.until('playback', 5);
  await b.ev(`__rec.speed(0.1); document.querySelector('.seg[data-name=camera] button[data-v=front]').click();`);
  d.caption('100 km/h · 30° angle · Dramatic damage', 'Panels tear off, glass shatters, wheels break away');
  await playFor(96);
  await b.ev(`__rec.speed(0.25)`);
  await playFor(96, (i, n) => `__rec.orbit(${(-60 + 150 * i / n).toFixed(2)}, 9, 3.2, 1.2);`);
  d.captionOut();

  // 3 - brick wall, 80 km/h
  d.showCursor(true);
  await d.click('#btn-reset', 14);
  await d.click('.seg[data-name=barrier] button[data-v=brick]', 12);
  await d.drag('#in-angle', -30, 0, 16);
  await d.drag('#in-speed', 100, 80, 16);
  await d.click('#btn-run', 14);
  d.showCursor(false);
  await d.until('impact', 2);
  d.caption('Brick wall', '366 mortared bricks: joints crack, the wall breaks up and scatters');
  await d.until('playback', 12);
  await b.ev(`__rec.speed(0.1); document.querySelector('.seg[data-name=camera] button[data-v=side]').click();`);
  d.caption('80 km/h · brick wall · Dramatic damage', 'Bricks and car parts are rigid bodies that tumble and settle');
  await playFor(90);
  await b.ev(`__rec.speed(0.25)`);
  await playFor(96, (i, n) => `__rec.orbit(${(-40 - 70 * i / n).toFixed(2)}, 10, 3.6, 2.5);`);
  d.captionOut();

  // 4 - 150 km/h at 15 degrees: inside the cabin, then the debris field
  d.showCursor(true);
  await d.click('#btn-reset', 14);
  await d.click('.seg[data-name=barrier] button[data-v=rigid]', 12);
  await d.drag('#in-speed', 80, 150, 18);
  await d.drag('#in-angle', 0, 15, 14);
  await d.click('#btn-run', 14);
  d.showCursor(false);
  await d.until('impact', 2);
  await d.until('playback', 5);
  await b.ev(`__rec.speed(0.05); document.querySelector('.seg[data-name=camera] button[data-v=onboard]').click();`);
  d.caption('150 km/h · 15° · onboard camera', 'Dummy, seatbelt, airbag and flying glass, frame by frame');
  await playFor(72);
  await b.ev(`__rec.speed(0.25)`);
  d.caption('Wheels, panels and glass come off', 'Every part keeps the shape it was crushed into');
  await playFor(110, (i, n) => `__rec.orbit(${(40 + 120 * i / n).toFixed(2)}, 12, 4.2, 3);`);
  d.captionOut();

  // 5 - results: injury criteria, charts, strain map
  d.showCursor(true);
  await d.click('#btn-collapse', 14);
  await d.click('#tg-strain', 12);
  d.caption('Results', 'Injury criteria, crash pulse, energy and a strain map of the car');
  d.showCursor(false);
  await playFor(70, (i, n) => `__rec.orbit(${(150 + 30 * i / n).toFixed(2)}, 10, 4, 1);`);
  d.captionOut();

  // 6 - end card
  await d.hold(97, (i) => `__rec.card(${Math.min(1, (i + 1) / 10).toFixed(2)});`);
  return { framesDir, frames: d.captured };
}

// ---------------------------------------------------------------- barrier-test pictures
async function recordShot(b, query, tSince, frameJs, file) {
  await openSimulator(b, query);
  await b.ev('__rec.noPip()');
  await b.ev(`__rec.click('#btn-run')`);
  for (let i = 0; i < 3000 && await b.ev('__rec.state()') !== 'playback'; i++) await b.ev(`__rec.step(${DT})`);
  await b.ev(`if (__rec.playing()) document.querySelector('#btn-play').click(); __rec.clean(true);`);
  // scrub to tSince ms after first contact (arrow keys step 1 ms; set the scrubber directly)
  // (the time readout updates on the next frame, so step one after each scrub)
  for (let v = 0; v <= 1000; v++) {
    const ms = await b.ev(`(() => { const s = document.querySelector('#tl-scrub'); s.value = ${v}; s.dispatchEvent(new Event('input')); __rec.step(${DT}); return parseFloat(__rec.time()); })()`);
    if (ms >= tSince) break;
  }
  for (let i = 0; i < 45; i++) await b.ev(`__rec.step(${DT}); ${frameJs}`);   // let the camera settle
  fs.writeFileSync(file, await b.shot(90));
  console.log('wrote', path.relative(ROOT, file), 'at', await b.ev('__rec.time()'), 'ms');
}

// ---------------------------------------------------------------- crash-lab pictures
// Each lab runs with its default settings (plus the query), is paused `tSince` ms after its
// reference time (first contact, the sled start, the pedestrian impact) and shot with a camera.
const ONLY_LAB = arg('--lab', null);
const LAB_SHOTS = [
  ['overlap', '', 95, `__rec.orbit(-112, 6.4, 3.6, 1.5)`],
  ['multi', '', 75, `__rec.look(-5.2, 3.6, -6.4, -0.4, 0.5, 0)`],
  ['side', 'steel=mild', 70, `__rec.look(5.6, 2.7, -5.4, 0.1, 0.8, -0.9)`],
  ['whiplash', 'backset=8&height=-5', 95, `__rec.look(0.75, 1.45, -3.0, 0.15, 1.05, 0)`],
  ['restraint', '', 85, `document.querySelector('#tg-xray').click(); __rec.orbit(-95, 4.6, 1.2, 0.4)`],
  ['pedestrian', 'mph=30&aeb=0', 105, `__rec.orbit(-72, 6.4, 1.5, 2.0)`],
];
async function recordLabShot(b, id, query, tSince, cameraJs) {
  if (ONLY_LAB && ONLY_LAB !== id) return;
  await openSimulator(b, '?lab=' + id + (query ? '&' + query : ''));
  await b.ev('__rec.noPip()');
  await b.ev(`__rec.click('#btn-run')`);
  for (let i = 0; i < 4000 && await b.ev('CrashLabs.state') !== 'playback'; i++) await b.ev(`__rec.step(${DT})`);
  await b.ev(`(() => { const p = CrashLabs.play; p.playing = false; CrashLabs.scrubTo(p.t0 + ${tSince} / 1000); __rec.clean(true); })()`);
  await b.ev(`__rec.step(${DT}); ${cameraJs}`);
  for (let i = 0; i < 45; i++) await b.ev(`__rec.step(${DT})`);   // let the camera settle
  const file = path.join(MEDIA, 'lab-' + id + '.jpg');
  fs.writeFileSync(file, await b.shot(88));
  console.log('wrote', path.relative(ROOT, file), 'at', await b.ev('__rec.time()'), 'ms');
}

(async () => {
  fs.mkdirSync(MEDIA, { recursive: true });
  const b = await openBrowser();
  try {
    if (ONLY === 'labs') {
      for (const [id, q, t, cam] of LAB_SHOTS) await recordLabShot(b, id, q, t, cam);
      if (b.errors.length) { console.log('page errors:\n' + b.errors.join('\n')); process.exitCode = 1; }
      return;
    }
    if (ONLY !== 'video') {
      await recordShot(b, '?preset=rigid', 75, `__rec.orbit(-112, 8.2, 3.1, 0.7)`, path.join(MEDIA, 'shot-rigid.jpg'));
      await recordShot(b, '?preset=brick', 170, `__rec.orbit(-52, 6.4, 2.1, 1.4)`, path.join(MEDIA, 'shot-brick.jpg'));
    }
    if (ONLY !== 'shots') {
      const t0 = Date.now();
      const { framesDir, frames } = await recordReel(b);
      console.log(`captured ${frames} frames (${(frames / FPS).toFixed(1)} s of video) in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${framesDir}`);
      fs.copyFileSync(path.join(framesDir, 'f' + String(Math.min(frames - 1, 640)).padStart(5, '0') + '.jpg'), path.join(MEDIA, 'poster.jpg'));
      // LOW keeps it near 11 MB, small enough to embed in the home page; the text stays sharp
      execFileSync(BLENDER, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', path.join(__dirname, 'encode-video.py'), '--', framesDir, path.join(MEDIA, 'crash-reel.mp4'), String(FPS), 'LOW'], { stdio: 'inherit' });
      const mb = fs.statSync(path.join(MEDIA, 'crash-reel.mp4')).size / 1048576;
      console.log(`wrote media/crash-reel.mp4 (${mb.toFixed(1)} MB)`);
      fs.rmSync(framesDir, { recursive: true, force: true });
    }
    if (b.errors.length) { console.log('page errors:\n' + b.errors.join('\n')); process.exitCode = 1; }
  } finally {
    b.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
