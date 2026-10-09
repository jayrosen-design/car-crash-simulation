/* Records the home page's media from the simulator, in headless Chrome:
 *   media/crash-reel.mp4   the trailer: a minute of the simulations cut to an original rock
 *                          soundtrack (the shots are in tools/trailer.js, the music in
 *                          tools/trailer-music.js), and crash-reel-mobile.mp4 (9:16)
 *   media/poster.jpg       the video's poster frame (and poster-mobile.jpg)
 *   media/hero-loop.mp4    the home page's background: the trailer's chorus without titles or sound
 *                          (and hero-loop-mobile.mp4); recorded with the trailer (video) since
 *                          the trailer is filmed square and composited like the game trailers
 *   media/race-trailer.mp4 the Race game's trailer (tools/race-trailer.js, recorded from Race.html),
 *   media/race-trailer-mobile.mp4  the same cut in 9:16, and their posters (media/race-poster.jpg,
 *                          media/race-poster-mobile.jpg)
 *   media/destruction-trailer.mp4  the Destruction game's trailer (tools/destruction-trailer.js, from
 *                          Destruction.html), media/destruction-trailer-mobile.mp4 and their posters
 *   media/shot-rigid.jpg   pictures of the two barrier tests for the home page
 *   media/shot-brick.jpg
 *   media/lab-<id>.jpg     a picture of each crash lab's finished test
 * The page runs on a virtual clock: every frame advances it by exactly 1/30 s and is captured,
 * so the video is smooth however long a frame takes to render. The soundtrack is rendered in the
 * page with Web Audio. Blender encodes the frames and the sound (tools/encode-video.py), so no
 * separate ffmpeg install is needed.
 *   node tools/record-video.js [shots|video|loop|race|destruction|labs] [--chrome <chrome.exe>] [--blender <blender.exe>]
 * The trailers (video, race, destruction; tools/trailer-kit.js) also take --work <dir> (keep the takes
 * there, with events.json), --takes a,b (record only these takes, keeping the others), --edit-only
 * (composite and encode from the takes already in --work), --takes-only, --format desktop|mobile
 * and --no-encode.
 * Rebuild Simulator.html, Race.html and Destruction.html first (node tools/build-standalone.js):
 * this records those files. Rebuild again afterwards, to embed the new media in Car Crash Simulation.html.
 */
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Trailer = require('./trailer.js');
const Kit = require('./trailer-kit.js');
const { renderMusic } = require('./trailer-music.js');

const ROOT = path.join(__dirname, '..');
const MEDIA = path.join(ROOT, 'media');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const CHROME = arg('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const BLENDER = arg('--blender', 'C:/Program Files/Blender Foundation/Blender 5.1/blender.exe');
const ONLY = ['shots', 'video', 'loop', 'race', 'destruction', 'labs'].find(k => process.argv.includes(k));
const W = 1280, H = 720, FPS = 30, DT = 1000 / FPS;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fileUrl = (name) => 'file:///' + path.join(ROOT, name).replace(/\\/g, '/').replace(/ /g, '%20');
const pageUrl = (q) => fileUrl('Simulator.html') + (q || '');

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
// a trailer's poster: the middle of a square take frame, at w x h
async function savePosterCrop(b, jpg, out, w, h) {
  const data = fs.readFileSync(jpg).toString('base64');
  await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1.5, mobile: false });
  await b.send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await b.ev(`new Promise((r) => { document.body.style.margin = 0; const i = new Image(); i.style.cssText = 'display:block;width:100vw;height:100vh;object-fit:cover;filter:contrast(1.08) saturate(1.15) brightness(1.02)'; i.onload = r; i.src = 'data:image/jpeg;base64,${data}'; document.body.appendChild(i); })`);
  fs.writeFileSync(out, await b.shot(86));
}

// ---------------------------------------------------------------- the game trailers
// The takes (fresh runs of the game, filmed square), then the edit composited over them twice: 16:9
// for desktops and 9:16 for phones, both with the soundtrack.
const GAMES = {
  race: { mod: './race-trailer.js', page: 'Race.html', song: 'race' },
  destruction: { mod: './destruction-trailer.js', page: 'Destruction.html', song: 'destruction' },
};
async function gameTrailer(b, key) {
  const G = GAMES[key], T = require(G.mod), t0 = Date.now();
  const work = arg('--work', null) ? path.resolve(arg('--work')) : fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-' + key + '-'));
  const takesDir = path.join(work, 'takes'), evFile = path.join(work, 'events.json');
  fs.mkdirSync(takesDir, { recursive: true });
  let events;
  if (process.argv.includes('--edit-only')) events = JSON.parse(fs.readFileSync(evFile, 'utf8'));
  else {
    const only = arg('--takes', null) ? arg('--takes').split(',') : null;
    for (const name of only || Object.keys(T.game.takes)) fs.rmSync(path.join(takesDir, name), { recursive: true, force: true });
    const rec = await Kit.recordTakes(b, Object.assign({}, T.game, { page: fileUrl(G.page) }), { dir: takesDir, log: console.log, only });
    events = only && fs.existsSync(evFile) ? Object.assign(JSON.parse(fs.readFileSync(evFile, 'utf8')), rec) : rec;
    fs.writeFileSync(evFile, JSON.stringify(events));
    console.log(`${key}: takes recorded in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${takesDir}`);
  }
  if (process.argv.includes('--takes-only')) return;
  Kit.check(T.edit, events);
  const wav = path.join(work, 'soundtrack.wav');
  fs.writeFileSync(wav, await renderSoundtrack(b, { bars: Kit.BARS, hits: Kit.musicHits(T.edit), song: G.song }));
  const P = T.POSTER, pe = events[P.take].list.find((e) => e.type === P.ref);
  const posterJpg = path.join(takesDir, P.take, P.cam, String((pe ? pe.n : 0) + P.off).padStart(5, '0') + '.jpg');
  const formats = [['desktop', W, H, ''], ['mobile', H, W, '-mobile']].filter((x) => !arg('--format', null) || arg('--format') === x[0]);
  for (const [fmt, w, h, suffix] of formats) {
    const framesDir = path.join(work, 'frames-' + fmt);
    fs.rmSync(framesDir, { recursive: true, force: true });
    await Kit.composite(b, T.edit, { takesDir, events, outDir: framesDir, workDir: work, log: console.log, w, h, extra: T.extra });
    await savePosterCrop(b, posterJpg, path.join(MEDIA, key + '-poster' + suffix + '.jpg'), w, h);
    if (process.argv.includes('--no-encode')) continue;
    const out = path.join(MEDIA, key + '-trailer' + suffix + '.mp4');
    // city footage compresses less well than the crash tests: a step lower keeps it embeddable
    execFileSync(BLENDER, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', path.join(__dirname, 'encode-video.py'), '--', framesDir, out, String(FPS), 'VERYLOW', 'audio=' + wav, 'size=' + w + 'x' + h], { stdio: 'inherit' });
    console.log(`wrote media/${path.basename(out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
  }
  console.log(`${key}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s (work: ${work})`);
  if (!arg('--work', null)) fs.rmSync(work, { recursive: true, force: true });
}

// ---------------------------------------------------------------- the simulations' trailer
// The shots filmed square from the simulator (tools/trailer.js, square: true), then composited with
// the kit in 16:9 and 9:16; the chorus again with the grade alone is the home page's background.
async function simTrailer(b) {
  const t0 = Date.now();
  const work = arg('--work', null) ? path.resolve(arg('--work')) : fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-sim-'));
  const takesDir = path.join(work, 'takes'), evFile = path.join(work, 'events.json'), main = path.join(takesDir, 'sim', 'main');
  let events;
  if (process.argv.includes('--edit-only')) events = JSON.parse(fs.readFileSync(evFile, 'utf8'));
  else {
    fs.rmSync(main, { recursive: true, force: true }); fs.mkdirSync(main, { recursive: true });
    await b.send('Emulation.setDeviceMetricsOverride', { width: Kit.SQ, height: Kit.SQ, deviceScaleFactor: 1.5, mobile: false });
    const { status } = await Trailer.record(b, { open: (q) => openSimulator(b, q), framesDir: main, log: console.log, square: true });
    const captured = fs.readdirSync(main).filter((f) => f.endsWith('.jpg')).map((f) => parseInt(f, 10)).sort((x, y) => x - y);
    events = { sim: { list: [], frames: Trailer.TOTAL, captured: { main: captured }, status } };
    fs.writeFileSync(evFile, JSON.stringify(events));
    console.log(`simulations: ${captured.length} frames filmed in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${main}`);
  }
  if (process.argv.includes('--takes-only')) return;
  const edit = Trailer.edit();
  Kit.check(edit, events);
  const enc = (dir, out, quality, w, h, wav) => execFileSync(BLENDER, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', path.join(__dirname, 'encode-video.py'), '--', dir, out, String(FPS), quality].concat(wav ? ['audio=' + wav] : []).concat(['size=' + w + 'x' + h]), { stdio: 'inherit' });
  const formats = [['desktop', W, H, ''], ['mobile', H, W, '-mobile']].filter((x) => !arg('--format', null) || arg('--format') === x[0]);
  const posterJpg = path.join(main, String(Trailer.POSTER).padStart(5, '0') + '.jpg');
  if (ONLY !== 'loop') {
    const wav = path.join(work, 'soundtrack.wav');
    fs.writeFileSync(wav, await renderSoundtrack(b, { bars: Kit.BARS, hits: Kit.musicHits(edit) }));
    for (const [fmt, w, h, suffix] of formats) {
      const framesDir = path.join(work, 'frames-' + fmt);
      fs.rmSync(framesDir, { recursive: true, force: true });
      await Kit.composite(b, edit, { takesDir, events, outDir: framesDir, workDir: work, log: console.log, w, h, extra: Trailer.extra });
      await savePosterCrop(b, posterJpg, path.join(MEDIA, 'poster' + suffix + '.jpg'), w, h);
      if (process.argv.includes('--no-encode')) continue;
      const out = path.join(MEDIA, 'crash-reel' + suffix + '.mp4');
      // LOW keeps it small enough to embed in the home page; the titles stay sharp
      enc(framesDir, out, 'LOW', w, h, wav);
      console.log(`wrote media/${path.basename(out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
    }
  }
  // the background loop: the chorus, with the grade alone (no titles, readouts or flashes, no sound)
  for (const [fmt, w, h, suffix] of formats) {
    const loopDir = path.join(work, 'loop-' + fmt);
    fs.rmSync(loopDir, { recursive: true, force: true });
    await Kit.composite(b, edit, { takesDir, events, outDir: loopDir, workDir: work, log: console.log, w, h, extra: Trailer.clean, range: Trailer.LOOP });
    if (process.argv.includes('--no-encode')) continue;
    const out = path.join(MEDIA, 'hero-loop' + suffix + '.mp4');
    enc(loopDir, out, 'LOW', w, h, null);
    console.log(`wrote media/${path.basename(out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
  }
  console.log(`simulations: done in ${((Date.now() - t0) / 1000).toFixed(0)} s (work: ${work})`);
  if (!arg('--work', null)) fs.rmSync(work, { recursive: true, force: true });
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
    if (!ONLY || ONLY === 'video' || ONLY === 'loop') await simTrailer(b);
    for (const key of ['race', 'destruction']) if (!ONLY || ONLY === key) await gameTrailer(b, key);
    if (b.errors.length) { console.log('page errors:\n' + b.errors.join('\n')); process.exitCode = 1; }
  } finally {
    b.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
