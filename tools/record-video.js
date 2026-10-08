/* Records the home page's media from the simulator, in headless Chrome:
 *   media/crash-reel.mp4   the trailer: a minute of the simulations cut to an original rock
 *                          soundtrack (the shots are in tools/trailer.js, the music in
 *                          tools/trailer-music.js)
 *   media/poster.jpg       the video's poster frame
 *   media/hero-loop.mp4    the home page's background: the trailer's chorus without titles or sound
 *   media/race-trailer.mp4 the Race game's trailer (tools/race-trailer.js, recorded from Race.html), and
 *   media/race-poster.jpg  its poster
 *   media/shot-rigid.jpg   pictures of the two barrier tests for the home page
 *   media/shot-brick.jpg
 *   media/lab-<id>.jpg     a picture of each crash lab's finished test
 * The page runs on a virtual clock: every frame advances it by exactly 1/30 s and is captured,
 * so the video is smooth however long a frame takes to render. The soundtrack is rendered in the
 * page with Web Audio. Blender encodes the frames and the sound (tools/encode-video.py), so no
 * separate ffmpeg install is needed.
 *   node tools/record-video.js [shots|video|loop|race|labs] [--chrome <chrome.exe>] [--blender <blender.exe>]
 * Rebuild Simulator.html first (node tools/build-standalone.js): this records that file. Rebuild
 * again afterwards, to embed the new media in Car Crash Simulation.html.
 */
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Trailer = require('./trailer.js');
const RaceTrailer = require('./race-trailer.js');
const { renderMusic } = require('./trailer-music.js');

const ROOT = path.join(__dirname, '..');
const MEDIA = path.join(ROOT, 'media');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const CHROME = arg('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const BLENDER = arg('--blender', 'C:/Program Files/Blender Foundation/Blender 5.1/blender.exe');
const ONLY = ['shots', 'video', 'loop', 'race', 'labs'].find(k => process.argv.includes(k));
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

// in-page helpers for the pictures: UI actions, a clean view and cameras
const HELPERS = `(() => {
  const css = document.createElement('style');
  css.textContent = '.rec-clean #topbar, .rec-clean .panel, .rec-clean #pip-label, .rec-clean #toast, .rec-clean #legend { display: none !important; }';
  document.head.appendChild(css);
  const q = (s) => document.querySelector(s);
  window.__rec = {
    step: (ms) => window.__vstep(ms),
    click(sel) { q(sel).click(); },
    clean(on) { document.body.classList.toggle('rec-clean', on); },
    noPip() { const r = Scene3D.render; Scene3D.render = (dt, pip, b) => r(dt, false, b); },
    state() { return q('#stepper li.on')?.dataset.step; },
    ready() { return window.CrashLabs ? CrashLabs.ready() : typeof Scene3D === 'object' && !q('#btn-run').disabled && (!!Scene3D.vehicleModel || q('.seg[data-name=vehicle] button.on')?.dataset.v === 'lab'); },
    // a fixed camera (lab pictures)
    look(px, py, pz, tx, ty, tz) { Scene3D.setCameraMode('free', { frame: { pos: new THREE.Vector3(px, py, pz), target: new THREE.Vector3(tx, ty, tz) } }); },
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

// ---------------------------------------------------------------- the trailers' soundtracks
// rendered in the page (OfflineAudioContext), then fetched as a WAV in base64 chunks
async function renderSoundtrack(b, song) {
  const n = await b.ev(`(${renderMusic.toString()})(${JSON.stringify(song)})`);
  const parts = [];
  for (let o = 0; o < n; o += 1 << 20) {
    parts.push(Buffer.from(await b.ev(`(() => { const a = window.__wav.subarray(${o}, ${o + (1 << 20)}); let s = ''; for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.subarray(i, i + 8192)); return btoa(s); })()`), 'base64'));
  }
  const st = await b.ev('window.__wavStats');
  console.log(`soundtrack: ${st.seconds.toFixed(1)} s, ${st.rmsDb.toFixed(1)} dBFS RMS`);
  return Buffer.concat(parts);
}
// a poster: one frame, at the video's size
async function savePoster(b, jpg, out) {
  const data = fs.readFileSync(jpg).toString('base64');
  await b.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await b.send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await b.ev(`new Promise((r) => { document.body.style.margin = 0; const i = new Image(); i.style.cssText = 'display:block;width:100vw;height:100vh'; i.onload = r; i.src = 'data:image/jpeg;base64,${data}'; document.body.appendChild(i); })`);
  fs.writeFileSync(out, await b.shot(88));
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
    if (!ONLY || ONLY === 'shots') {
      await recordShot(b, '?preset=rigid', 75, `__rec.orbit(-112, 8.2, 3.1, 0.7)`, path.join(MEDIA, 'shot-rigid.jpg'));
      await recordShot(b, '?preset=brick', 170, `__rec.orbit(-52, 6.4, 2.1, 1.4)`, path.join(MEDIA, 'shot-brick.jpg'));
    }
    if (!ONLY || ONLY === 'video') {
      const t0 = Date.now();
      const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-frames-'));
      // drawn at 1920 x 1080 (the same layout at 1.5x) and scaled down when encoded
      await b.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1.5, mobile: false });
      const { frames } = await Trailer.record(b, { open: (q) => openSimulator(b, q), framesDir, log: console.log });
      console.log(`captured ${frames} frames (${(frames / FPS).toFixed(1)} s of video) in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${framesDir}`);
      const wav = path.join(framesDir, 'soundtrack.wav');
      fs.writeFileSync(wav, await renderSoundtrack(b, { bars: Trailer.BARS, hits: Trailer.musicHits() }));
      await savePoster(b, path.join(framesDir, 'f' + String(Trailer.POSTER).padStart(5, '0') + '.jpg'), path.join(MEDIA, 'poster.jpg'));
      // LOW keeps it small enough to embed in the home page; the titles stay sharp
      execFileSync(BLENDER, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', path.join(__dirname, 'encode-video.py'), '--', framesDir, path.join(MEDIA, 'crash-reel.mp4'), String(FPS), 'LOW', 'audio=' + wav, 'size=' + W + 'x' + H], { stdio: 'inherit' });
      const mb = fs.statSync(path.join(MEDIA, 'crash-reel.mp4')).size / 1048576;
      console.log(`wrote media/crash-reel.mp4 (${mb.toFixed(1)} MB)`);
      fs.rmSync(framesDir, { recursive: true, force: true });
    }
    if (!ONLY || ONLY === 'video' || ONLY === 'loop') {
      // the background loop: the trailer's chorus again, with the colour grade but no titles
      const loopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-loop-'));
      await b.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1.5, mobile: false });
      const [a, z] = Trailer.LOOP;
      await Trailer.record(b, { open: (q) => openSimulator(b, q), framesDir: loopDir, log: console.log, only: (s) => s.f >= a && s.f + s.n <= z, clean: true });
      execFileSync(BLENDER, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', path.join(__dirname, 'encode-video.py'), '--', loopDir, path.join(MEDIA, 'hero-loop.mp4'), String(FPS), 'LOW', 'size=' + W + 'x' + H], { stdio: 'inherit' });
      console.log(`wrote media/hero-loop.mp4 (${(fs.statSync(path.join(MEDIA, 'hero-loop.mp4')).size / 1048576).toFixed(1)} MB, ${((z - a) / FPS).toFixed(1)} s)`);
      fs.rmSync(loopDir, { recursive: true, force: true });
    }
    if (!ONLY || ONLY === 'race') {
      // the Race trailer: the takes (fresh races), then the edit composited over them
      const t0 = Date.now();
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-race-'));
      const takesDir = path.join(work, 'takes'), framesDir = path.join(work, 'frames');
      fs.mkdirSync(takesDir); fs.mkdirSync(framesDir);
      await b.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1.5, mobile: false });
      const race = 'file:///' + path.join(ROOT, 'Race.html').replace(/\\/g, '/').replace(/ /g, '%20');
      const events = await RaceTrailer.recordTakes(b, { dir: takesDir, log: console.log, page: race });
      RaceTrailer.check(events);
      await RaceTrailer.composite(b, { takesDir, events, outDir: framesDir, workDir: work, log: console.log });
      console.log(`recorded and composited ${RaceTrailer.TOTAL} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${work}`);
      const wav = path.join(work, 'soundtrack.wav');
      fs.writeFileSync(wav, await renderSoundtrack(b, { bars: RaceTrailer.BARS, hits: RaceTrailer.musicHits(), song: 'race' }));
      await savePoster(b, RaceTrailer.posterSource(takesDir, events), path.join(MEDIA, 'race-poster.jpg'));
      // city footage compresses less well than the crash tests: a step lower keeps it embeddable
      execFileSync(BLENDER, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', path.join(__dirname, 'encode-video.py'), '--', framesDir, path.join(MEDIA, 'race-trailer.mp4'), String(FPS), 'VERYLOW', 'audio=' + wav, 'size=' + W + 'x' + H], { stdio: 'inherit' });
      console.log(`wrote media/race-trailer.mp4 (${(fs.statSync(path.join(MEDIA, 'race-trailer.mp4')).size / 1048576).toFixed(1)} MB)`);
      fs.rmSync(work, { recursive: true, force: true });
    }
    if (b.errors.length) { console.log('page errors:\n' + b.errors.join('\n')); process.exitCode = 1; }
  } finally {
    b.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
