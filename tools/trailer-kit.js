/* What the game trailers share (tools/race-trailer.js, tools/destruction-trailer.js), recorded by
 * tools/record-video.js:
 *   takes      fresh runs of a game on the virtual clock, scripted by a director (the game's opt-in
 *              hook: RaceGame.director, DestructionGame.director) and filmed by several cameras at
 *              once. Filmed square (1280 CSS px at 1.5x: 1920 x 1920), so one take gives both the
 *              16:9 video (the middle 1920 x 1080) and the 9:16 one (the middle 1080 x 1920); a
 *              camera's field of view is given for the 16:9 frame and widened to the square
 *              (squareFov). Slow motion is filmed slow: a shorter step of the virtual clock.
 *   edit       a shot list on the soundtrack's 150 BPM grid (a beat is 12 frames at 30 fps, a bar 48,
 *              37.5 bars a minute) picks frames from the takes by their events (the start, a jump,
 *              a crash, an explosion ...), so every launch and impact lands on a beat.
 *   composite  the chosen frames under the colour grade and the website's look (Barlow Condensed
 *              italic, hazard yellow, slanted tags, cut corners, hazard stripes), one screenshot each,
 *              in either format.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FPS = 30, BEAT = 12, BAR = 48, BARS = 37.5, TOTAL = BARS * BAR;
const F = (bar, beat = 0) => Math.round(bar * BAR + beat * BEAT);
const DT = 1000 / FPS;
const SQ = 1280;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the square frame's field of view whose 16:9 middle has vertical field of view `land` (degrees)
const squareFov = (land) => 2 * Math.atan(Math.tan(land * Math.PI / 360) / 0.5625) * 180 / Math.PI;
const fovOf = (spec) => { const f = spec.fov === undefined ? 50 : spec.fov; return Array.isArray(f) ? f.map(squareFov) : squareFov(f); };

// ---------------------------------------------------------------- recording the takes
/* game: { takes: { name: { url query, run(t) } }, page: the built page's file URL, ready: JS expr,
 *   director: function source run in the page once loaded, status: JS expr -> per-frame status,
 *   events(prev, s, n, push): the game's events from two statuses, crashWait: JS expr true while the
 *   crash solver is still working (the recorder waits in real time), shootJs: JS that draws the
 *   current camera (after __d.cam / __d.k are set) }
 * -> per take: { list: events, frames, captured: { cam: [n...] }, status: [per frame] } */
async function recordTakes(b, game, { dir, log, only }) {
  const events = {};
  for (const [name, take] of Object.entries(game.takes)) {
    if (only && !only.includes(name)) continue;
    const t0 = Date.now();
    await b.send('Emulation.setDeviceMetricsOverride', { width: SQ, height: SQ, deviceScaleFactor: 1.5, mobile: false });
    await b.send('Page.navigate', { url: game.page + '?' + take.query });
    for (let i = 0; i < 600; i++) { await sleep(200); try { if (await b.ev(game.ready)) break; } catch { /* loading */ } }
    if (!(await b.ev(game.ready))) throw new Error(`${name}: the page did not get ready`);
    await b.ev(`(${game.director.toString()})()`);
    const ev = events[name] = { list: [], frames: 0, captured: {}, status: [] };
    let n = 0, prev = null;
    const tdir = path.join(dir, name);
    const shoot = async (camName, spec, k) => {
      const s = Object.assign({}, spec, { fov: fovOf(spec) });
      await b.ev(`__d.cam = ${JSON.stringify(s)}; __d.k = ${k.toFixed(4)}; ${game.shootJs}`);
      const d = path.join(tdir, camName); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, String(n).padStart(5, '0') + '.jpg'), await b.shot(90));
      (ev.captured[camName] = ev.captured[camName] || []).push(n);
    };
    const t = {
      page: (js) => b.ev(js),
      mark: (type, extra) => ev.list.push(Object.assign({ type, n }, extra)),
      forget: (type, before = Infinity) => { ev.list = ev.list.filter((e) => e.type !== type || e.n >= before); },
      get n() { return n; },
      key: async (code, down) => b.send('Input.dispatchKeyEvent', { type: down ? 'keyDown' : 'keyUp', key: code === 'Enter' ? 'Enter' : code, code, windowsVirtualKeyCode: code === 'Enter' ? 13 : 0 }),
      /* step `count` frames, filming each with every camera (none: just run); each: page JS run before
       * every step; opts: { dt (ms of game time a frame: slow motion), until (JS expr: stop early once
       * true), waitCrash (let the crash solver finish when a crash starts) } */
      async frames(count, cams, each, opts = {}) {
        const names = Object.keys(cams || {});
        for (let i = 0; i < count; i++) {
          if (each) await b.ev(each);
          await b.ev(`__d.cam = null; __vstep(${opts.dt || DT})`);
          const s = await b.ev(game.status);
          if (prev) game.events(prev, s, n, (type, extra) => ev.list.push(Object.assign({ type, n }, extra)));
          if (opts.waitCrash !== false) for (let w = 0; w < 900 && (await b.ev(game.crashWait)); w++) await sleep(100);
          prev = s; ev.status[n] = s;
          for (const c of names) await shoot(c, cams[c], count > 1 ? i / (count - 1) : 0);
          n++;
          if (opts.until && (await b.ev(opts.until))) break;
        }
      },
    };
    const setup = await take.run(t);
    ev.frames = n; ev.setup = setup;
    log(`${name}: ${n} frames, events ${ev.list.map((e) => e.type + '@' + e.n + (e.kmh ? ` ${e.kmh} km/h` : '') + (e.text ? ` ${e.text}` : '')).join(', ')} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    if (b.errors.length) throw new Error(`${name}: page errors: ${b.errors.join(' | ')}`);
  }
  return events;
}

// ---------------------------------------------------------------- the edit
// edit: { E: shots [{ f, n, src: { take, cam, ref ('abs' | an event type, its first), off }, ... }],
//   TITLES: [[f, card, sfx]] }
function sourceOf(edit, f, events) {
  const s = edit.E.find((x) => f >= x.f && f < x.f + x.n);
  if (!s || !s.src) return null;
  const { take, cam, ref, off } = s.src, ev = events[take];
  if (!ev) throw new Error(`no take "${take}"`);
  let base = 0;
  if (ref !== 'abs') { const e = ev.list.find((x) => x.type === ref); if (!e) throw new Error(`take "${take}" has no ${ref} event`); base = e.n; }
  const n = base + off + Math.floor((f - s.f) * (s.src.rate || 1));
  if (!(ev.captured[cam] || []).includes(n)) throw new Error(`take "${take}" camera ${cam} has no frame ${n} (frame ${f})`);
  return { take, cam, n, status: ev.status[n] || {} };
}
// the overlay at frame f: the shared parts; extra(o, s, f, src) adds the game's own
function overlayAt(edit, f, events, extra) {
  const s = edit.E.find((x) => f >= x.f && f < x.f + x.n), o = { grade: true, logo: true };
  if (!s) return o;
  const age = f - s.f;
  if (!s.src) { o.black = 1; o.logo = false; }
  if (s.card) o.card = Object.assign({ age }, s.card);
  if (s.dim) o.dim = s.dim;
  const hitAge = age - (s.hitAt || 0);
  if (s.hit && hitAge >= 0) { const v = s.hitV || 1; o.flash = ([0.85, 0.45, 0.2, 0.08][hitAge] || 0) * v; o.punch = 1 + 0.07 * v * Math.exp(-hitAge / 3.5); }
  if (s.countdown) { const i = Math.floor(age / BEAT); o.big = { text: String(3 - i), age: age - i * BEAT, kind: 'count' }; }
  if (s.big && age >= (s.bigAt || 0) && age < (s.bigAt || 0) + (s.bigFor || 22)) o.big = { text: s.big, age: age - (s.bigAt || 0), kind: s.bigKind || 'go', for: s.bigFor || 22 };
  if (s.lower && age >= 2) o.lower = { title: s.lower[0], sub: s.lower[1], age: age - 2, out: age > s.n - 6 ? age - (s.n - 6) : undefined };
  // a wipe into this shot: a slanted yellow bar sweeping across over its first 8 frames
  if (s.wipe && age < 9) o.wipe = age / 8;
  if (s.slow && s.src) o.slow = true;
  const src = s.src ? sourceOf(edit, f, events) : null;
  if (extra) extra(o, s, f, src, age);
  for (const [t0, card] of edit.TITLES) if (f >= t0) { o.card = Object.assign({ age: f - t0, titleAge: f - edit.TITLES[0][0] }, card); o.logo = false; }
  if (f >= TOTAL - 18) o.black = Math.max(o.black || 0, (f - (TOTAL - 18)) / 17);
  return o;
}
// what the music needs: impacts (with glass or not), whooshes, explosions, ticks, the title hits
function musicHits(edit) {
  const hits = [];
  for (const s of edit.E) {
    const t = s.f / FPS;
    if (s.hit === 'crash') hits.push({ t: t + (s.hitAt || 0) / FPS, kind: 'impact', glass: true, v: s.hitV || 1 });
    if (s.hit === 'go') hits.push({ t, kind: 'impact', v: (s.hitV || 1) * 0.7 });
    if (s.hit === 'boom') hits.push({ t: t + (s.hitAt || 0) / FPS, kind: 'boom', v: s.hitV || 1 });
    if (s.hit === 'glass' || s.hit === 'impact') hits.push({ t: t + (s.hitAt || 0) / FPS, kind: 'impact', glass: s.hit === 'glass', v: s.hitV || 1 });
    if (s.sfx === 'card') hits.push({ t, kind: 'card' });
    if (s.sfx === 'whoosh' || s.wipe) hits.push({ t, kind: 'whoosh', dur: 0.35 });
    if (s.sfx === 'cash' || s.sfx === 'tick') hits.push({ t, kind: 'tick', v: 0.8 });
  }
  for (const [f, , sfx] of edit.TITLES) hits.push({ t: f / FPS, kind: sfx });
  return hits;
}
function check(edit, events) {
  for (let f = 0; f < TOTAL; f++) { if (!edit.E.some((x) => f >= x.f && f < x.f + x.n)) throw new Error('no shot at frame ' + f); sourceOf(edit, f, events); }
}

// ---------------------------------------------------------------- the compositor (a page)
// Sizes in vmin (the frame's shorter side), so the same layout serves 16:9 and 9:16; a few rules
// differ by orientation. The look follows the website (css/site.css).
const COMPOSITOR = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,700;0,800;1,800;1,900&family=Barlow:wght@500;600&family=JetBrains+Mono:wght@600;700&display=swap">
<style>
  :root { --hz: #ffc400; --red: #e8241b; --ink: #0b0c0f; }
  html, body { margin: 0; background: #000; overflow: hidden; }
  #st { position: fixed; inset: 0; overflow: hidden; font-family: "Barlow Condensed", Bahnschrift, sans-serif; color: #fff; }
  #src { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; filter: contrast(1.08) saturate(1.15) brightness(1.02); transform-origin: 50% 50%; }
  #st > div { position: absolute; }
  #tint { inset: 0; mix-blend-mode: soft-light; background: linear-gradient(180deg, rgba(40, 70, 160, 0.42), rgba(60, 40, 90, 0.08) 45%, rgba(255, 140, 50, 0.32)); }
  #vig { inset: 0; background: radial-gradient(ellipse 78% 72% at 50% 52%, transparent 55%, rgba(0, 0, 0, 0.62) 100%); }
  #dim, #black { inset: 0; background: #050608; opacity: 0; }
  #flash { inset: 0; background: #fff; opacity: 0; }
  #wipe { inset: -10%; display: none; }
  #wipe i { position: absolute; top: 0; bottom: 0; width: 26%; background: var(--hz); transform: skewX(-18deg); }
  #wipe i + i { width: 9%; background: var(--ink); }
  @media (orientation: landscape) {
    #bars::before, #bars::after { content: ''; position: fixed; left: 0; right: 0; height: 6vh; background: #000; }
    #bars::before { top: 0; } #bars::after { bottom: 0; }
  }
  /* the website's logo, small, in a corner */
  #logo { left: 4vmin; top: 4.2vmin; display: none; align-items: center; gap: 1.4vmin; font: italic 900 3.1vmin/1 "Barlow Condensed", sans-serif; text-transform: uppercase; letter-spacing: 0.02em; text-shadow: 0 0.3vmin 1.2vmin rgba(0,0,0,0.7); }
  @media (orientation: landscape) { #logo { top: 8.4vh; } }
  #logo .tg { width: 3.6vmin; height: 3.6vmin; border-radius: 50%; background: conic-gradient(var(--hz) 0 25%, var(--ink) 0 50%, var(--hz) 0 75%, var(--ink) 0); box-shadow: 0 0 0 0.35vmin var(--hz); }
  #logo b { color: var(--hz); }
  /* the lower third: a yellow slanted tag, a title, a line */
  #lower { left: 4.5vmin; bottom: 12vmin; display: none; max-width: 86vw; }
  @media (orientation: portrait) { #lower { bottom: 21vh; } }
  #lower i { display: block; height: 1vmin; background: repeating-linear-gradient(-45deg, var(--hz) 0 1.6vmin, var(--ink) 1.6vmin 3.2vmin); margin-bottom: 1.6vmin; }
  #lower b { display: inline-block; font: italic 900 7.4vmin/1 "Barlow Condensed", sans-serif; text-transform: uppercase; color: var(--ink); background: var(--hz); padding: 0.4vmin 3vmin 0.2vmin 2.4vmin; clip-path: polygon(1.6vmin 0, 100% 0, calc(100% - 1.6vmin) 100%, 0 100%); }
  #lower span { display: block; margin-top: 1.4vmin; font: 600 3.3vmin/1.25 "Barlow", sans-serif; color: #eef2f7; text-shadow: 0 0.2vmin 1vmin rgba(0,0,0,0.85); }
  /* readouts: impact speed, the car's speed, the damage counter */
  #impact { top: 12vmin; right: 4.5vmin; text-align: right; display: none; font-family: "JetBrains Mono", Consolas, monospace; }
  @media (orientation: portrait) { #impact { top: 16vh; } }
  #impact b { display: block; font-size: 4.2vmin; font-weight: 700; letter-spacing: 0.1em; text-shadow: 0 0 1vmin rgba(0,0,0,0.8); }
  #impact b i { display: inline-block; width: 1.5vmin; height: 1.5vmin; border-radius: 50%; background: #ff3b30; margin-right: 1vmin; }
  #impact span { display: inline-block; margin-top: 1vmin; font-size: 2.6vmin; letter-spacing: 0.14em; color: var(--ink); background: var(--hz); padding: 0.4vmin 1.1vmin; font-weight: 700; }
  #speed { right: 4.5vmin; bottom: 10vmin; display: none; text-align: right; }
  @media (orientation: portrait) { #speed { bottom: 13vh; } }
  #speed b { font: italic 900 13vmin/0.85 "Barlow Condensed", sans-serif; text-shadow: 0 0.6vmin 2vmin rgba(0,0,0,0.7); }
  #speed small { display: block; font: 700 2.6vmin "JetBrains Mono", monospace; letter-spacing: 0.25em; color: var(--hz); }
  #score { top: 9vmin; left: 50%; transform: translateX(-50%); display: none; text-align: center; }
  @media (orientation: landscape) { #score { top: 9vh; } }
  @media (orientation: portrait) { #score { top: 11vh; } }
  #score .card { padding: 1.2vmin 3.4vmin 1vmin; background: rgba(11, 12, 15, 0.82); border: 0.3vmin solid rgba(255,196,0,0.6); clip-path: polygon(0 0, calc(100% - 2vmin) 0, 100% 2vmin, 100% 100%, 2vmin 100%, 0 calc(100% - 2vmin)); }
  #score b { display: block; font: italic 900 9.5vmin/1 "Barlow Condensed", sans-serif; color: var(--hz); letter-spacing: 0.01em; font-variant-numeric: tabular-nums; }
  #score small { display: block; font: 700 2.3vmin "JetBrains Mono", monospace; letter-spacing: 0.24em; color: #d9dee6; }
  #score .mult { display: inline-block; margin-left: 1.4vmin; font: italic 900 5vmin/1 "Barlow Condensed", sans-serif; color: #fff; background: #7b3cff; padding: 0.3vmin 1.4vmin; vertical-align: 1.8vmin; }
  #score .bar { position: relative; height: 1.1vmin; margin-top: 1.2vmin; background: rgba(255,255,255,0.14); }
  #score .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: linear-gradient(90deg, #3fbf6a, var(--hz)); }
  #score .bar u { position: absolute; top: -0.5vmin; bottom: -0.5vmin; width: 0.5vmin; }
  /* a title card (on black, or over the picture) */
  #card { inset: 0; display: none; place-items: center; text-align: center; }
  #card .in { padding: 0 6vmin; }
  #card small { display: inline-block; font: italic 800 3.3vmin/1 "Barlow Condensed", sans-serif; letter-spacing: 0.28em; text-transform: uppercase; color: var(--ink); background: var(--hz); padding: 0.8vmin 2.2vmin 0.6vmin 2.6vmin; margin-bottom: 2.6vmin; clip-path: polygon(1.2vmin 0, 100% 0, calc(100% - 1.2vmin) 100%, 0 100%); }
  #card h1 { margin: 0; font: italic 900 17vmin/0.9 "Barlow Condensed", sans-serif; text-transform: uppercase; text-shadow: 0 0.8vmin 3.4vmin rgba(0,0,0,0.75); white-space: nowrap; display: inline-block; }
  #card h1 em { font-style: italic; color: var(--hz); }
  #card.over .in { margin-top: 38vmin; } #card.over h1 { font-size: 12.5vmin; }
  @media (orientation: portrait) { #card.over .in { margin-top: 70vh; } #card h1 { font-size: 19vmin; } }
  #card.title h1 { font-size: 30vmin; line-height: 0.82; color: var(--hz); }
  #card.title p { margin: 3vmin 0 0; font: italic 800 4.6vmin/1.15 "Barlow Condensed", sans-serif; letter-spacing: 0.16em; text-transform: uppercase; }
  #card .stripe { height: 2.2vmin; margin: 3vmin auto 0; width: 80vmin; max-width: 90vw; background: repeating-linear-gradient(-45deg, var(--hz) 0 3vmin, var(--ink) 3vmin 6vmin); }
  #card .kick { display: inline-flex; align-items: center; gap: 1.6vmin; font: italic 900 4.4vmin/1 "Barlow Condensed", sans-serif; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 2.6vmin; color: #fff; }
  #card .kick .tg { width: 4.6vmin; height: 4.6vmin; border-radius: 50%; background: conic-gradient(var(--hz) 0 25%, var(--ink) 0 50%, var(--hz) 0 75%, var(--ink) 0); box-shadow: 0 0 0 0.45vmin var(--hz); }
  #card .kick b { color: var(--hz); }
  #card .cta { display: inline-block; margin-top: 4vmin; font: italic 900 4.4vmin/1 "Barlow Condensed", sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink); background: var(--hz); padding: 1.6vmin 4vmin 1.3vmin; clip-path: polygon(1.8vmin 0, 100% 0, calc(100% - 1.8vmin) 100%, 0 100%); }
  #card .url { display: block; margin-top: 2.2vmin; font: 700 2.8vmin "JetBrains Mono", monospace; letter-spacing: 0.08em; color: #e6eaf0; }
  /* big words: the countdown, GO, TAKEDOWN, BOOM, GOLD */
  #big { inset: 0; display: none; place-items: center; text-align: center; }
  #big b { font: italic 900 36vmin/1 "Barlow Condensed", sans-serif; text-transform: uppercase; color: var(--hz); text-shadow: 0 1vmin 5vmin rgba(0,0,0,0.6); -webkit-text-stroke: 0.5vmin var(--ink); }
  #big.td b, #big.red b { font-size: 20vmin; color: #fff; -webkit-text-stroke: 0; background: var(--red); padding: 0 5vmin; clip-path: polygon(3.4vmin 0, 100% 0, calc(100% - 3.4vmin) 100%, 0 100%); }
  #big.boom b { font-size: 28vmin; color: #fff; -webkit-text-stroke: 0.6vmin #ff6a1a; text-shadow: 0 0 6vmin rgba(255,120,30,0.9), 0 1vmin 4vmin rgba(0,0,0,0.6); }
  #big.gold b { font-size: 30vmin; color: #ffd84a; -webkit-text-stroke: 0.6vmin #5a3a00; text-shadow: 0 0 7vmin rgba(255,200,40,0.85); }
  #big.mult b { font-size: 30vmin; color: #fff; -webkit-text-stroke: 0; background: #7b3cff; padding: 0 5vmin; clip-path: polygon(3.4vmin 0, 100% 0, calc(100% - 3.4vmin) 100%, 0 100%); }
  @media (orientation: portrait) { #big b { font-size: 30vmin; } #big.td b, #big.red b { font-size: 15vmin; } #big.boom b { font-size: 22vmin; } #big.gold b { font-size: 24vmin; } }
  #slow { left: 4.5vmin; top: 50%; display: none; font: 700 2.6vmin "JetBrains Mono", monospace; letter-spacing: 0.3em; color: var(--hz); writing-mode: vertical-rl; transform: translateY(-50%) rotate(180deg); }
</style></head><body><div id="st"><img id="src" alt=""><div id="tint"></div><div id="vig"></div><div id="dim"></div><div id="black"></div>
<div id="logo"><span class="tg"></span><span>Car Crash <b>Simulation</b></span></div>
<div id="impact"><b><i></i></b><span></span></div><div id="speed"><b></b><small>KM/H</small></div><div id="score"><div class="card"><b></b><small></small><div class="bar"><i></i></div></div></div>
<div id="lower"><i></i><b></b><span></span></div><div id="slow">SLOW MOTION</div><div id="big"><b></b></div><div id="card"><div class="in"></div></div>
<div id="wipe"><i></i><i></i></div><div id="flash"></div><div id="bars"></div></div>
<script>
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  let cardKey = null;
  // text slammed in: big, settling, with an RGB split that fades
  const slam = (el, a, drift) => {
    const sc = 1 + 0.32 * Math.exp(-a / 1.7) + drift * a, sp = 0.9 * Math.exp(-a / 2.2);
    el.style.transform = 'scale(' + sc.toFixed(4) + ')'; el.style.opacity = Math.min(1, 0.35 + a / 2.5).toFixed(3);
    el.style.filter = sp > 0.02 ? 'drop-shadow(' + (-sp).toFixed(2) + 'vmin 0 rgba(255,40,60,.75)) drop-shadow(' + sp.toFixed(2) + 'vmin 0 rgba(0,200,255,.75))' : '';
  };
  const money = (v) => '$' + Math.round(v).toLocaleString('en-US');
  window.show = (url, s) => new Promise((done) => {
    const img = $('#src');
    $('#tint').style.display = $('#vig').style.display = s.grade && !s.black ? 'block' : 'none';
    $('#black').style.opacity = s.black || 0; $('#dim').style.opacity = s.dim || 0; $('#flash').style.opacity = s.flash || 0;
    img.style.transform = s.punch ? 'scale(' + s.punch + ')' : '';
    $('#logo').style.display = s.logo && !s.black && !s.card ? 'flex' : 'none';
    $('#slow').style.display = s.slow && !s.card ? 'block' : 'none';
    const wp = $('#wipe'); wp.style.display = s.wipe !== undefined ? 'block' : 'none';
    if (s.wipe !== undefined) { const x = -40 + 180 * s.wipe; wp.children[0].style.left = x + '%'; wp.children[1].style.left = (x + 24) + '%'; }
    const im = $('#impact'); im.style.display = s.impact ? 'block' : 'none';
    if (s.impact) { im.querySelector('b').innerHTML = '<i></i>' + esc(s.impact.text || ('IMPACT ' + s.impact.kmh + ' KM/H')); im.querySelector('span').textContent = s.impact.label || 'FULL CRASH SOLVER'; }
    const sp = $('#speed'); sp.style.display = s.speed !== undefined && !s.card ? 'block' : 'none';
    if (s.speed !== undefined) sp.querySelector('b').textContent = s.speed;
    const sc = $('#score'); sc.style.display = s.score && !(s.card && !s.card.over) ? 'block' : 'none';
    if (s.score) {
      sc.querySelector('b').innerHTML = money(s.score.total) + (s.score.mult > 1 ? '<span class="mult">×' + s.score.mult + '</span>' : '');
      sc.querySelector('small').textContent = s.score.label || 'DAMAGE';
      const bar = sc.querySelector('.bar'), top = s.score.gold * 1.15;
      bar.querySelector('i').style.width = Math.min(100, 100 * s.score.total / top).toFixed(1) + '%';
      if (!bar.dataset.ticks) { bar.dataset.ticks = 1; for (const [v, c] of [[s.score.bronze, '#d08a4c'], [s.score.silver, '#cfd6df'], [s.score.gold, '#ffc53a']]) { const u = document.createElement('u'); u.style.left = (100 * v / top).toFixed(1) + '%'; u.style.background = c; bar.appendChild(u); } }
    }
    const lw = $('#lower'); lw.style.display = s.lower ? 'block' : 'none';
    if (s.lower) { const k = Math.min(1, s.lower.age / 7); lw.querySelector('b').textContent = s.lower.title; lw.querySelector('span').textContent = s.lower.sub || ''; lw.style.clipPath = 'inset(-2vmin ' + (100 - 100 * k) + '% -2vmin 0)'; lw.querySelector('i').style.width = (6 + 18 * k) + 'vmin'; lw.style.opacity = s.lower.out !== undefined ? Math.max(0, 1 - s.lower.out / 5) : 1; }
    const bg = $('#big'); bg.style.display = s.big ? 'grid' : 'none'; bg.className = s.big ? s.big.kind : '';
    if (s.big) { const b = bg.querySelector('b'); b.textContent = s.big.text; slam(b, s.big.age, 0.004); const fo = s.big.for || 22; b.style.opacity = Math.min(1, 0.35 + s.big.age / 2.5) * (s.big.kind === 'count' ? Math.max(0, 1 - Math.max(0, s.big.age - 8) / 4) : Math.max(0, 1 - Math.max(0, s.big.age - (fo - 6)) / 6)); }
    const cd = $('#card'); cd.style.display = s.card ? 'grid' : 'none';
    if (s.card) {
      const c = s.card, key = JSON.stringify([c.tag, c.title, c.cta, c.url, c.kind, c.over]);
      if (key !== cardKey) {
        cardKey = key; cd.className = (c.over ? 'over ' : '') + (c.kind === 'title' ? 'title' : '');
        cd.querySelector('.in').innerHTML = c.kind === 'title'
          ? '<div class="kick"><span class="tg"></span><span>Car Crash <b>Simulation</b></span></div><h1>' + esc(c.title) + '</h1><div class="stripe"></div><p>' + esc(c.tag) + '</p>' + (c.cta ? '<div class="cta">' + esc(c.cta) + '</div>' : '') + (c.url ? '<span class="url">' + esc(c.url) + '</span>' : '')
          : (c.tag ? '<small>' + esc(c.tag) + '</small><br>' : '') + '<h1>' + c.title + '</h1>';
      }
      const inn = cd.querySelector('.in');
      // a title too wide for the frame (a long word in 9:16) is scaled down to fit, with room for
      // the end titles' slow push in (up to 13%)
      const h1 = inn.querySelector('h1');
      if (h1 && !h1.dataset.fit) { h1.dataset.fit = 1; h1.style.fontSize = ''; const max = innerWidth * 0.8, wd = h1.scrollWidth; if (wd > max) h1.style.fontSize = (parseFloat(getComputedStyle(h1).fontSize) * max / wd).toFixed(1) + 'px'; }
      slam(inn, c.kind === 'title' ? c.titleAge : c.age, c.kind === 'title' ? 0.0008 : 0.0016);
      if (c.kind === 'title') for (const el of inn.querySelectorAll('p, .cta, .url')) slam(el, c.age, 0);
    } else cardKey = null;
    if (!url) { img.style.visibility = 'hidden'; return setTimeout(done, 0); }
    img.style.visibility = 'visible';
    if (img.dataset.url === url) return setTimeout(done, 0);
    img.onload = () => { img.dataset.url = url; setTimeout(done, 0); };
    img.onerror = () => { throw new Error('could not load ' + url); };
    img.src = url;
  });
</script></body></html>`;

// global frames -> composited JPEGs in outDir, at w x h CSS px (x1.5); extra: the game's overlay parts;
// range: [from, to) only those frames, numbered from 0 (the home page's background loop)
async function composite(b, edit, { takesDir, events, outDir, workDir, log, w, h, extra, range }) {
  const page = path.join(workDir, 'compositor.html');
  fs.writeFileSync(page, COMPOSITOR);
  const url = (p) => 'file:///' + p.split(path.sep).join('/');
  await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1.5, mobile: false });
  await b.send('Page.navigate', { url: url(page) });
  await sleep(1500);
  await b.ev('document.fonts.ready.then(() => true)');
  fs.mkdirSync(outDir, { recursive: true });
  const [f0, f1] = range || [0, TOTAL];
  for (let f = f0; f < f1; f++) {
    const s = sourceOf(edit, f, events), o = overlayAt(edit, f, events, extra);
    const file = s ? url(path.join(takesDir, s.take, s.cam, String(s.n).padStart(5, '0') + '.jpg')) : null;
    await b.ev(`show(${JSON.stringify(file)}, ${JSON.stringify(o)})`);
    fs.writeFileSync(path.join(outDir, 'f' + String(f - f0).padStart(5, '0') + '.jpg'), await b.shot(92));
    if (f % 300 === 299) log(`composited ${f + 1} / ${TOTAL} (${w}x${h})`);
  }
}

module.exports = { FPS, BEAT, BAR, BARS, TOTAL, F, DT, SQ, squareFov, recordTakes, sourceOf, overlayAt, musicHits, check, composite, COMPOSITOR };
