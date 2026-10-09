/* The home page's trailer (media/crash-reel.mp4): one minute of the simulations cut to an original
 * rock soundtrack (tools/trailer-music.js), recorded from Simulator.html by tools/record-video.js.
 *
 * Everything is on one grid: 150 BPM at 30 fps makes a beat exactly 12 frames and a bar 48, so
 * the trailer is 37.5 bars (1,800 frames). Each crash is cut so its first contact lands on a beat,
 * and the music's hits come from the same shot list.
 *
 * The crashes are the simulator's own runs with the GPU (WebGPU) solver, except the brick wall,
 * which the GPU solver doesn't handle (it runs on the CPU, as it does in the app). The recorder
 * drives each replay frame by frame: it sets the replay speed (the trailer's own bullet-time) and
 * the camera, and lays the titles, the colour grade and the flashes over the page before each
 * capture. Approach shots are taken while the cars drive in: every approach frame is drawn once
 * per approach camera, and the frames that end at contact are kept.
 *
 * square: true (record-video.js) films raw frames instead, square (1920 x 1920) with each camera's
 * field of view widened (tools/trailer-kit.js squareFov), with the replay's clock and speed per
 * frame; the kit's compositor then lays the website's look over them in 16:9 and in 9:16 (edit()).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Kit = require('./trailer-kit.js');

const FPS = 30, BEAT = 12, BAR = 48, BARS = 37.5, TOTAL = BARS * BAR;
const F = (bar, beat = 0) => Math.round(bar * BAR + beat * BEAT);

// ---------------------------------------------------------------- the simulations
const SCENES = {
  barrier: '?preset=rigid&solver=gpu&vehicle=lexus&speed=150&damage=dramatic',
  twocar: '?lab=multi&solver=gpu&aMph=60&bMph=60',
  overlap: '?lab=overlap&solver=gpu&overlap=small&barrier=rigid&mph=50',
  side: '?lab=side&solver=gpu&impactor=mdb&steel=mild',
  restraint: '?lab=restraint&solver=gpu',
  brick: '?preset=brick&vehicle=lexus&speed=120&damage=dramatic',   // no GPU solver for the wall
};

// ---------------------------------------------------------------- cameras
// An orbit around an anchor: a = angle from the car's forward direction (degrees; -90 is the
// driver's side), d = distance, h = height, ahead = how far the centre sits in front of the
// anchor, lift = height of the aim point, fov = vertical field of view. A pair [start, end] moves
// over the shot. Anchors: 'start' (the car where the shot starts, fixed), 'car' (follows the car),
// 'mid' (between the two cars of the two-car lab), 'world' (x = 0 is the barrier face). aim:
// [a, d, h] looks at that point around the anchor instead of at the centre.
const cam = (anchor, a, d, h, o = {}) => Object.assign({ anchor, a, d, h, ahead: 0, lift: 0.5, fov: 40 }, o);
const ONBOARD = { onboard: true, fov: 62 };

// ---------------------------------------------------------------- the shot list
// kind: 'card' (a title on black), 'approach' (n frames ending `end` frames before contact),
// 'replay' (from `from` ms after contact, speed keyframes [[frame, replay speed], ...]),
// 'after' (the aftermath, `after` s after the replay ends). hit: the impact sound and a flash.
const S = [];
const shot = (f, n, o) => S.push(Object.assign({ f, n }, o));
const slow = (s) => [[0, s], [1e9, s]];

// intro: title cards between the cars driving in
shot(F(0), 24, { kind: 'card', card: { tag: 'Car Crash Simulation', title: 'Eight crash tests' }, sfx: 'card' });
shot(F(0, 2), 24, { kind: 'approach', scene: 'barrier', end: 26, cam: cam('car', [-58, -70], [3.4, 3.0], [0.45, 0.4], { ahead: 0.8, lift: 0.45, fov: 52 }), sfx: 'whoosh' });
shot(F(1), 24, { kind: 'card', card: { title: 'One physics engine' }, sfx: 'card' });
shot(F(1, 2), 24, { kind: 'approach', scene: 'twocar', end: 3, cam: cam('car', [172, 168], [5.6, 5.0], [1.3, 1.2], { ahead: 3, lift: 0.8, fov: 50 }), sfx: 'whoosh' });
shot(F(2), 24, { kind: 'card', card: { tag: 'WebGPU', title: 'Solved on your GPU' }, sfx: 'card' });
shot(F(2, 2), 24, { kind: 'approach', scene: 'side', end: 5, cam: cam('start', -84, 1.8, 0.95, { aim: [-90, 25, 0.6], fov: 58 }), sfx: 'whoosh' });
shot(F(3), 12, { kind: 'approach', scene: 'barrier', end: 0, cam: { anchor: 'world', pos: [-0.9, 0.42, -2.0], look: [-18, 0.7, 0.2], fov: 50 } });
shot(F(3, 1), 12, { kind: 'approach', scene: 'brick', end: 0, cam: { anchor: 'world', pos: [-1.2, 0.5, 2.3], look: [-18, 0.8, -0.3], fov: 50 } });
shot(F(3, 2), 12, { kind: 'approach', scene: 'overlap', end: 0, cam: cam('car', [-75, -82], [2.8, 2.6], [0.6, 0.6], { ahead: 1.2, lift: 0.5, fov: 54 }) });
shot(F(3, 3), 12, { kind: 'card', card: null, sfx: 'tick' });

// verse: one crash after another, each on the beat
shot(F(4), 48, { kind: 'replay', scene: 'barrier', from: 0, speed: [[0, 0.06], [6, 0.025], [48, 0.03]], hit: 'glass',
  cam: cam('start', [-104, -110], [5.6, 5.0], [1.0, 0.95], { ahead: 0.9, lift: 0.6, fov: 42 }), hud: true,
  lower: ['150 km/h · rigid barrier', 'Lexus RX 350 · WebGPU solver'] });
shot(F(5), 48, { kind: 'replay', scene: 'barrier', from: 28, speed: slow(0.025), cam: ONBOARD, hud: true });
shot(F(6), 12, { kind: 'approach', scene: 'overlap', end: 0, cam: { anchor: 'world', pos: [-1.6, 0.45, -1.5], look: [-18, 0.7, -0.4], fov: 52 } });
shot(F(6, 1), 36, { kind: 'replay', scene: 'overlap', from: 0, speed: [[0, 0.05], [24, 0.04], [36, 0.25]], hit: 'impact',
  cam: cam('start', [28, 36], [5.6, 5.0], [1.4, 1.5], { ahead: 1.6, lift: 0.5, fov: 42 }), hud: true,
  lower: ['25% small overlap · 80 km/h', 'The wheel is driven back into the footwell'] });
shot(F(7), 12, { kind: 'approach', scene: 'twocar', end: 12, cam: cam('car', [176, 174], [4.6, 4.4], [1.1, 1.1], { ahead: 3, lift: 0.8, fov: 52 }) });
shot(F(7, 1), 12, { kind: 'approach', scene: 'twocar', end: 0, cam: cam('mid', [-86, -82], [7.5, 7.0], [0.5, 0.5], { lift: 0.55, fov: 58 }) });
shot(F(7, 2), 72, { kind: 'replay', scene: 'twocar', from: 0, speed: [[0, 0.04], [44, 0.03], [72, 0.3]], hit: 'glass',
  cam: cam('mid', [-80, -92], [7.0, 6.0], [0.9, 1.0], { lift: 0.6, fov: 40 }), hud: true,
  lower: ['Head-on · 60 + 60 mph', 'Mustang GT500 vs Lexus RX 350 · WebGPU solver'] });
shot(F(9), 12, { kind: 'approach', scene: 'side', end: 0, cam: cam('car', [-120, -124], [4.2, 4.0], [0.8, 0.8], { lift: 0.8, fov: 52 }) });
shot(F(9, 1), 36, { kind: 'replay', scene: 'side', from: 0, speed: [[0, 0.05], [30, 0.04], [36, 0.12]], hit: 'glass',
  cam: cam('start', [-140, -146], [6.0, 5.6], [1.5, 1.4], { lift: 0.8, fov: 42 }), hud: true,
  lower: ['Side impact · 60 km/h', '1,900 kg barrier into a mild-steel B-pillar'] });
shot(F(10), 48, { kind: 'replay', scene: 'restraint', from: 12, speed: slow(0.04), xray: true, hit: 'impact',
  cam: cam('start', [-96, -88], [3.3, 3.0], [0.9, 1.0], { ahead: 0.4, lift: 0.9, fov: 40 }), hud: true,
  lower: ['X-ray view', 'Belt, airbag and the dummy inside the crash'] });
shot(F(11), 48, { kind: 'replay', scene: 'barrier', from: 70, speed: [[0, 0.1], [48, 0.45]],
  cam: cam('start', [-152, -162], [6.4, 7.2], [1.3, 1.8], { ahead: 0.6, lift: 0.8, fov: 42 }), sfx: 'whoosh' });

// pre-chorus: bullet-time
shot(F(12), 48, { kind: 'replay', scene: 'barrier', from: 24, speed: slow(0.008), cam: Object.assign({}, ONBOARD, { fov: 58 }), hud: true,
  card: { tag: 'Bullet-time', title: 'Every millisecond', over: true } });
shot(F(13), 48, { kind: 'replay', scene: 'twocar', from: 8, speed: slow(0.012),
  cam: cam('mid', [-60, -66], [4.8, 4.3], [2.5, 2.3], { lift: 0.5, fov: 38 }), hud: true,
  card: { tag: '0.1 ms physics steps', title: 'Metal that folds', over: true } });
shot(F(14), 48, { kind: 'replay', scene: 'barrier', from: 30, speed: slow(0.014),
  cam: cam('start', [-96, -102], [3.4, 3.0], [1.5, 1.45], { ahead: 0.2, lift: 1.05, fov: 42 }), hud: true,
  card: { tag: 'Windows break from the strain', title: 'Glass that shatters', over: true } });
shot(F(15), 12, { kind: 'replay', scene: 'barrier', from: 90, speed: slow(0.05), strain: true, cam: cam('start', [-110, -112], [6.0, 5.8], [1.6, 1.6], { ahead: 0.9, lift: 0.6 }) });
shot(F(15, 1), 12, { kind: 'replay', scene: 'restraint', from: 70, speed: slow(0.05), xray: true, cam: cam('start', [-84, -86], [2.9, 2.8], [1.0, 1.0], { ahead: 0.5, lift: 0.95 }) });
shot(F(15, 2), 12, { kind: 'replay', scene: 'side', from: 40, speed: slow(0.05), strain: true, cam: cam('start', [-90, -92], [5.0, 4.8], [1.2, 1.2], { lift: 0.8 }) });
shot(F(15, 3), 12, { kind: 'card', card: null });

// chorus: the brick wall, then the crashes again from new angles
shot(F(16), 48, { kind: 'replay', scene: 'brick', from: 0, speed: [[0, 0.06], [16, 0.06], [48, 0.2]], hit: 'glass',
  cam: cam('start', [-28, -36], [7.2, 6.6], [1.1, 1.0], { ahead: 1.0, lift: 0.9, fov: 44 }), hud: true,
  lower: ['Brick wall · 120 km/h', '366 mortared bricks · dramatic damage'] });
shot(F(17), 48, { kind: 'replay', scene: 'brick', from: 90, speed: [[0, 0.12], [48, 0.3]],
  cam: cam('start', [-112, -120], [7.4, 7.0], [1.6, 1.8], { ahead: 1.2, lift: 0.8, fov: 44 }) });
shot(F(18), 48, { kind: 'replay', scene: 'brick', from: 330, speed: [[0, 0.4], [48, 0.6]],
  cam: cam('start', [-40, -18], [9.0, 10.5], [2.6, 3.4], { ahead: 1.5, lift: 0.6, fov: 44 }) });
shot(F(19), 48, { kind: 'replay', scene: 'twocar', from: 0, speed: [[0, 0.06], [30, 0.06], [48, 0.35]], hit: 'impact',
  cam: cam('mid', [-58, -66], [7.5, 7.0], [3.0, 2.8], { lift: 0.5, fov: 42 }) });
shot(F(20), 48, { kind: 'replay', scene: 'barrier', from: 140, speed: [[0, 0.4], [48, 0.6]],
  cam: cam('start', [-128, -140], [8.5, 9.0], [1.6, 2.2], { ahead: 0.5, lift: 1.0, fov: 42 }), sfx: 'whoosh' });
shot(F(21), 48, { kind: 'replay', scene: 'overlap', from: 100, speed: [[0, 0.35], [48, 0.6]],
  cam: cam('start', [-110, -128], [8.0, 8.5], [2.8, 3.2], { ahead: 0.5, lift: 0.5, fov: 42 }) });
shot(F(22), 48, { kind: 'replay', scene: 'side', from: 0, speed: [[0, 0.04], [48, 0.1]], hit: 'impact',
  cam: cam('start', [-30, -42], [6.4, 6.0], [2.6, 2.4], { lift: 0.7, fov: 42 }) });
shot(F(23), 48, { kind: 'replay', scene: 'brick', from: 12, speed: slow(0.03), cam: ONBOARD, hit: 'glass', hud: true });

// breakdown: the fire
shot(F(24), 48, { kind: 'after', scene: 'barrier', after: 7, cam: cam('start', [-150, -136], [6.8, 6.2], [1.1, 1.0], { ahead: 1.6, lift: 0.9, fov: 42 }),
  lower: ['Aftermath', 'The engine was driven back into the firewall'] });
shot(F(25), 48, { kind: 'after', scene: 'barrier', after: 9, cam: ONBOARD,
  card: { tag: 'Steam · smoke · fire', title: 'Nothing is scripted', over: true } });
shot(F(26), 48, { kind: 'after', scene: 'barrier', after: 11, cam: cam('start', [-100, -112], [8.0, 11.5], [0.8, 3.6], { ahead: 1.6, lift: 1.4, fov: 42 }) });
shot(F(27), 12, { kind: 'replay', scene: 'twocar', from: 30, speed: slow(0.05), strain: true, cam: cam('mid', [-70, -72], [5.4, 5.2], [1.4, 1.4], { fov: 40 }) });
shot(F(27, 1), 12, { kind: 'replay', scene: 'overlap', from: 60, speed: slow(0.05), strain: true, cam: cam('start', [30, 32], [5.0, 4.8], [1.8, 1.8], { ahead: 1.6 }) });
shot(F(27, 2), 12, { kind: 'replay', scene: 'restraint', from: 90, speed: slow(0.05), xray: true, cam: cam('start', [-100, -102], [3.0, 2.9], [0.9, 0.9], { ahead: 0.5, lift: 0.95 }) });
shot(F(27, 3), 12, { kind: 'card', card: null });

// last chorus: faster and faster
const RAPID = [
  ['barrier', 0, slow(0.05), cam('start', [-96, -100], [4.6, 4.3], [0.8, 0.8], { ahead: 0.9, lift: 0.6, fov: 44 }), 'glass'],
  ['twocar', 0, slow(0.06), cam('mid', [-118, -124], [5.6, 5.2], [0.7, 0.7], { lift: 0.6, fov: 44 }), 'impact'],
  ['brick', 45, slow(0.15), cam('start', [-20, -24], [6.2, 5.8], [0.9, 0.9], { ahead: 1.0, lift: 1.0, fov: 46 }), 'glass'],
  ['side', 0, slow(0.06), cam('start', [-150, -154], [4.8, 4.6], [1.1, 1.1], { lift: 0.8, fov: 46 }), 'impact'],
  ['overlap', 0, slow(0.06), cam('start', [20, 26], [4.6, 4.4], [1.0, 1.0], { ahead: 1.8, lift: 0.5, fov: 46 }), 'impact'],
  ['barrier', 34, slow(0.03), ONBOARD, 'glass'],
  ['twocar', 10, slow(0.04), cam('mid', [-84, -88], [3.0, 2.8], [1.4, 1.3], { lift: 0.5, fov: 40 }), 'impact'],
  ['brick', 120, slow(0.3), cam('start', [-120, -128], [6.4, 6.4], [1.2, 1.4], { ahead: 1.5, lift: 0.8, fov: 46 }), 'impact'],
];
RAPID.forEach(([scene, from, speed, c, hit], i) => shot(F(28 + i / 2), 24, { kind: 'replay', scene, from, speed, cam: c, hit, hitV: 0.6 }));
const FASTER = [
  ['barrier', 220, slow(0.6), cam('start', [-160, -164], [8.0, 8.0], [1.6, 1.6], { ahead: 0.5, lift: 1.0 })],
  ['twocar', 120, slow(0.6), cam('mid', [-30, -34], [8.0, 8.0], [2.0, 2.0], { lift: 0.5 })],
  ['brick', 480, slow(0.7), cam('start', [-60, -64], [9.5, 9.5], [2.4, 2.4], { ahead: 2.0, lift: 0.6 })],
  ['side', 60, slow(0.2), cam('start', [-40, -44], [5.6, 5.6], [2.0, 2.0], { lift: 0.8 })],
  ['overlap', 300, slow(0.7), cam('start', [-150, -154], [8.0, 8.0], [2.4, 2.4], { ahead: 0.5, lift: 0.5 })],
  ['restraint', 60, slow(0.1), cam('start', [-110, -112], [3.1, 3.0], [1.0, 1.0], { ahead: 0.5, lift: 0.95 }), { xray: true }],
  ['brick', 40, slow(0.05), ONBOARD],
  ['barrier', 0, slow(0.04), cam('start', [-104, -108], [4.2, 4.0], [0.6, 0.6], { ahead: 0.6, lift: 0.6, fov: 46 })],
];
FASTER.forEach(([scene, from, speed, c, extra], i) => shot(F(32, i), 12, Object.assign({ kind: 'replay', scene, from, speed, cam: c, hit: 'impact', hitV: 0.45 }, extra)));

// the end: title, line, call to action, over the brick wall in very slow motion
shot(F(34), TOTAL - F(34), { kind: 'replay', scene: 'brick', from: 60, speed: slow(0.03), dim: 0.62,
  cam: cam('start', [-24, -34], [7.0, 6.2], [1.2, 1.1], { ahead: 1.0, lift: 1.0, fov: 44 }) });
const TITLES = [
  [F(34), { kind: 'title', title: 'Car Crash Simulation', tag: 'Real physics · Real crashes' }, 'title'],
  [F(35), { kind: 'title', title: 'Car Crash Simulation', tag: 'Eight crash tests · Bullet-time · WebGPU' }, 'card'],
  [F(36), { kind: 'title', title: 'Car Crash Simulation', tag: 'Play free in your browser', cta: 'car-crash-simulation.vercel.app' }, 'title'],
];

// ---------------------------------------------------------------- what the music needs
function musicHits() {
  const hits = [];
  for (const s of S) {
    const t = s.f / FPS;
    if (s.hit) hits.push({ t, kind: 'impact', glass: s.hit === 'glass', v: s.hitV || 1 });
    if (s.sfx === 'card') hits.push({ t, kind: 'card' });
    if (s.sfx === 'whoosh') hits.push({ t, kind: 'whoosh', dur: 0.35 });
    if (s.sfx === 'tick') hits.push({ t, kind: 'tick' });
  }
  for (const [f, , sfx] of TITLES) hits.push({ t: f / FPS, kind: sfx });
  return hits;
}

// ---------------------------------------------------------------- the overlay (in the page)
const OVERLAY = `(() => {
  const css = document.createElement('style');
  css.textContent = \`
    body.trailer #app > *:not(#view) { display: none !important; }
    body.trailer #view canvas { filter: contrast(1.14) saturate(1.22) brightness(0.97); transform-origin: 50% 50%; }
    #tr { position: fixed; inset: 0; z-index: 20000; pointer-events: none; overflow: hidden; font-family: Bahnschrift, "Segoe UI", sans-serif; color: #fff; }
    #tr > div { position: absolute; }
    #tr-tint { inset: 0; mix-blend-mode: soft-light; background: linear-gradient(180deg, rgba(0, 110, 160, 0.55), rgba(0, 60, 90, 0.15) 45%, rgba(255, 140, 50, 0.35)); }
    #tr-vig { inset: 0; background: radial-gradient(ellipse 75% 70% at 50% 52%, transparent 55%, rgba(0, 0, 0, 0.62) 100%); }
    #tr-dim { inset: 0; background: #000; opacity: 0; }
    #tr-black { inset: 0; background: #050608; opacity: 0; }
    #tr-flash { inset: 0; background: #fff; opacity: 0; }
    #tr-bars::before, #tr-bars::after { content: ''; position: fixed; left: 0; right: 0; height: 7.5vh; background: #000; }
    #tr-bars::before { top: 0; } #tr-bars::after { bottom: 0; }
    #tr-hud { top: 10.5vh; right: 4.2vw; text-align: right; font-family: Consolas, "Cascadia Mono", monospace; display: none; }
    #tr-hud b { display: block; font-size: 3.4vh; font-weight: 700; letter-spacing: 0.1em; text-shadow: 0 0 1vh rgba(0,0,0,0.8); }
    #tr-hud span { display: inline-block; margin-top: 0.8vh; font-size: 2.2vh; letter-spacing: 0.14em; color: #111; background: #ffc400; padding: 0.3vh 0.9vh; font-weight: 700; }
    #tr-hud i { display: inline-block; width: 1.2vh; height: 1.2vh; border-radius: 50%; background: #ff3b30; margin-right: 0.8vh; vertical-align: 0.15vh; }
    #tr-lower { left: 4.2vw; bottom: 11.5vh; display: none; }
    #tr-lower i { display: block; height: 0.7vh; width: 7vh; background: #ffc400; margin-bottom: 1.2vh; }
    #tr-lower b { display: block; font-size: 5.2vh; font-weight: 700; font-stretch: condensed; font-variation-settings: "wdth" 75; text-transform: uppercase; letter-spacing: 0.02em; line-height: 1; text-shadow: 0 0.3vh 1.5vh rgba(0,0,0,0.7); }
    #tr-lower span { display: block; margin-top: 0.9vh; font-size: 2.5vh; color: #d6dce4; letter-spacing: 0.04em; text-shadow: 0 0.2vh 1vh rgba(0,0,0,0.8); }
    #tr-card { inset: 0; display: none; place-items: center; text-align: center; }
    #tr-card .in { transform-origin: 50% 50%; }
    #tr-card small { display: inline-block; font-size: 2.6vh; font-weight: 700; letter-spacing: 0.32em; text-transform: uppercase; color: #111; background: #ffc400; padding: 0.5vh 1.4vh 0.5vh 1.7vh; margin-bottom: 2.2vh; }
    #tr-card h1 { margin: 0; font-size: 15vh; line-height: 0.92; font-weight: 700; font-stretch: condensed; font-variation-settings: "wdth" 75; text-transform: uppercase; letter-spacing: 0.01em; }
    #tr-card.over h1 { font-size: 11vh; text-shadow: 0 0.6vh 3vh rgba(0,0,0,0.75); }
    #tr-card.over .in { margin-top: 30vh; }
    #tr-card.title h1 { font-size: 13.5vh; }
    #tr-card .stripe { height: 1.6vh; margin: 2.6vh auto 0; width: 62vh; background: repeating-linear-gradient(-45deg, #ffc400 0 2.2vh, #111 2.2vh 4.4vh); }
    #tr-card .target { width: 9vh; height: 9vh; border-radius: 50%; margin: 0 auto 2.6vh; background: conic-gradient(#ffc400 0 25%, #111 0 50%, #ffc400 0 75%, #111 0); box-shadow: 0 0 0 0.6vh #111, 0 0 0 1vh #ffc400; }
    #tr-card .cta { display: inline-block; margin-top: 3vh; font-size: 3vh; letter-spacing: 0.08em; padding: 1.1vh 2.6vh; border: 0.35vh solid #fff; font-weight: 600; }
  \`;
  document.head.appendChild(css);
  const tr = document.createElement('div'); tr.id = 'tr';
  tr.innerHTML = '<div id="tr-tint"></div><div id="tr-vig"></div><div id="tr-dim"></div><div id="tr-black"></div>' +
    '<div id="tr-hud"><b></b><span></span></div><div id="tr-lower"><i></i><b></b><span></span></div><div id="tr-card"><div class="in"></div></div>' +
    '<div id="tr-flash"></div><div id="tr-bars"></div>';
  document.body.appendChild(tr);
  document.body.classList.add('trailer');
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  let cardKey = null;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const val = (x, k) => Array.isArray(x) ? x[0] + (x[1] - x[0]) * k : x;
  const T = window.__tr = {
    cam: null, k: 0, anchor: null,
    // where the shot's camera looks from and at, for progress k (0..1) through the shot
    place() {
      const c = T.cam; if (!c) return;
      const camera = Scene3D.camera;
      if (c.onboard) { if (Scene3D.camMode !== 'onboard') Scene3D.setCameraMode('onboard'); camera.fov = c.fov; camera.updateProjectionMatrix(); return; }
      const k = T.k < 0.5 ? 2 * T.k * T.k : 1 - Math.pow(-2 * T.k + 2, 2) / 2;
      let o, fw;
      if (c.anchor === 'world') {
        camera.fov = c.fov; camera.updateProjectionMatrix();
        Scene3D.setFollow(() => V(0, 0, 0));
        Scene3D.setCameraMode('free', { frame: { pos: V(...c.pos), target: V(...c.look) } });
        return;
      }
      const ctx = Scene3D.cabin;
      if (c.anchor === 'mid') {
        const a = Scene3D.slots[0].ctx.o, b = Scene3D.slots[1].ctx.o;
        o = a.clone().add(b).multiplyScalar(0.5);
        fw = V(1, 0, 0);
      } else if (c.anchor === 'car') { o = ctx.o.clone(); fw = V(ctx.f.x, 0, ctx.f.z).normalize(); }
      else { if (!T.anchor) T.anchor = { o: ctx.o.clone(), f: V(ctx.f0.x, 0, ctx.f0.z).normalize() }; o = T.anchor.o.clone(); fw = T.anchor.f.clone(); }
      const side = V(-fw.z, 0, fw.x), a = val(c.a, k) * Math.PI / 180, d = val(c.d, k), h = val(c.h, k);
      const centre = o.clone().addScaledVector(fw, val(c.ahead, k));
      const dir = fw.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
      const pos = centre.clone().addScaledVector(dir, d); pos.y = o.y + h;
      let look = centre.clone(); look.y = o.y + val(c.lift, k);
      if (c.aim) { const b = c.aim[0] * Math.PI / 180; look = o.clone().addScaledVector(fw, Math.cos(b) * c.aim[1]).addScaledVector(side, Math.sin(b) * c.aim[1]); look.y = o.y + c.aim[2]; }
      camera.fov = val(c.fov, k); camera.updateProjectionMatrix();
      Scene3D.setFollow(() => look);
      Scene3D.setCameraMode('free', { frame: { pos, target: look } });
    },
    // the overlay for one frame: s = { grade, black, dim, flash, punch, hud, lower, card }
    frame(s) {
      $('#tr-tint').style.display = $('#tr-vig').style.display = s.grade ? 'block' : 'none';
      $('#tr-black').style.opacity = s.black || 0;
      $('#tr-dim').style.opacity = s.dim || 0;
      $('#tr-flash').style.opacity = s.flash || 0;
      const cv = document.querySelector('#view canvas'); if (cv) cv.style.transform = s.punch ? 'scale(' + s.punch + ')' : '';
      const hud = $('#tr-hud');
      hud.style.display = s.hud ? 'block' : 'none';
      if (s.hud && T.play) {
        const ms = (T.play.t - T.play.t0) * 1000, sp = s.hud.speed;
        hud.querySelector('b').innerHTML = '<i></i>T ' + (ms < 0 ? '−' : '+') + Math.abs(ms).toFixed(1).padStart(5, '0') + ' MS';
        hud.querySelector('span').textContent = sp >= 1 ? sp.toFixed(0) + '×' : '1/' + Math.round(1 / sp) + '×  SPEED';
      }
      const lw = $('#tr-lower');
      lw.style.display = s.lower ? 'block' : 'none';
      if (s.lower) {
        lw.querySelector('b').textContent = s.lower.title; lw.querySelector('span').textContent = s.lower.sub || '';
        const k = Math.min(1, s.lower.age / 7);
        lw.style.clipPath = 'inset(0 ' + (100 - 100 * k) + '% 0 0)';
        lw.querySelector('i').style.width = (3 + 6 * k) + 'vh';
        lw.style.opacity = s.lower.out !== undefined ? Math.max(0, 1 - s.lower.out / 5) : 1;
      }
      const cd = $('#tr-card');
      cd.style.display = s.card ? 'grid' : 'none';
      if (s.card) {
        const c = s.card, key = JSON.stringify([c.tag, c.title, c.cta, c.kind, c.over]);
        if (key !== cardKey) {
          cardKey = key;
          cd.className = (c.over ? 'over ' : '') + (c.kind === 'title' ? 'title' : '');
          cd.querySelector('.in').innerHTML = (c.kind === 'title' ? '<div class="target"></div>' : '') + (c.tag && c.kind !== 'title' ? '<small>' + esc(c.tag) + '</small>' : '') +
            '<h1>' + esc(c.title) + '</h1>' + (c.kind === 'title' ? '<div class="stripe"></div>' + (c.tag ? '<p style="margin:2.4vh 0 0;font-size:3.4vh;letter-spacing:.18em;text-transform:uppercase;font-weight:600">' + esc(c.tag) + '</p>' : '') : '') +
            (c.cta ? '<div class="cta">' + esc(c.cta) + '</div>' : '');
        }
        // a slam: in from 1.3x with a red-blue split that settles, then a slow push in
        const slam = (el, a, drift) => {
          const sc = 1 + 0.32 * Math.exp(-a / 1.7) + drift * a, split = 0.9 * Math.exp(-a / 2.2);
          el.style.transform = 'scale(' + sc.toFixed(4) + ')';
          el.style.opacity = Math.min(1, 0.35 + a / 2.5).toFixed(3);
          el.style.textShadow = split > 0.02 ? (-split).toFixed(2) + 'vh 0 rgba(255,40,60,.75), ' + split.toFixed(2) + 'vh 0 rgba(0,200,255,.75)' + (c.over ? ', 0 0.6vh 3vh rgba(0,0,0,0.75)' : '') : (c.over ? '0 0.6vh 3vh rgba(0,0,0,0.75)' : '');
        };
        const inn = cd.querySelector('.in');
        slam(inn, c.kind === 'title' ? c.titleAge : c.age, c.kind === 'title' ? 0.0008 : 0.0016);
        if (c.kind === 'title') for (const el of inn.querySelectorAll('p, .cta')) slam(el, c.age, 0);
      } else cardKey = null;
    },
  };
  // the trailer's camera goes in just before each draw; the momentum arrows stay out of it
  const draw = Scene3D.render;
  Scene3D.render = (dt, pip, bottom) => {
    T.place();
    Scene3D.scene.children.forEach((o) => { if (o.type === 'ArrowHelper') o.visible = false; });
    return draw(dt, false, bottom);
  };
  // the replay's state: the app hands it to the video exporter, so ask for it that way
  T.grabPlay = () => new Promise((resolve) => {
    const save = VideoExport.saveReplay;
    VideoExport.saveReplay = async (p) => { T.play = p.play; T.resetEvents = p.resetEvents; VideoExport.saveReplay = save; resolve(true); };
    document.querySelector('#btn-video').click();
  });
  T.seek = (t) => { const p = T.play; p.t = Math.max(p.tStart, Math.min(p.tEnd, t)); p.playing = false; p.after = 0; T.resetEvents(); Scene3D.particles.clear(); };
  T.speed = (s) => { const p = T.play; p.auto = null; p.speed = s; p.playing = p.t < p.tEnd; };
})();`;

// ---------------------------------------------------------------- the overlay state per frame
function overlayAt(f) {
  const s = { grade: true };
  const sh = S.find((x) => f >= x.f && f < x.f + x.n);
  if (sh) {
    const age = f - sh.f;
    if (sh.kind === 'card') { s.black = 1; s.grade = false; if (sh.card) s.card = Object.assign({ age }, sh.card); }
    else if (sh.card) s.card = Object.assign({ age }, sh.card);
    if (sh.dim) s.dim = sh.dim;
    if (sh.hit) {
      const v = sh.hitV || 1;
      s.flash = [0.85, 0.45, 0.2, 0.08][age] * v || 0;
      s.punch = 1 + 0.07 * v * Math.exp(-age / 3.5);
    }
    if (sh.hud && !sh.card) s.hud = { speed: speedAt(sh, age) };
    if (sh.lower && age >= 2) s.lower = { title: sh.lower[0], sub: sh.lower[1], age: age - 2, out: age > sh.n - 6 ? age - (sh.n - 6) : undefined };
  }
  for (const [t0, card] of TITLES) if (f >= t0) s.card = Object.assign({ age: f - t0, titleAge: f - TITLES[0][0] }, card);
  if (f >= TOTAL - 18) s.black = Math.max(s.black || 0, (f - (TOTAL - 18)) / 17);
  return s;
}
function speedAt(sh, i) {
  const kf = sh.speed;
  if (i <= kf[0][0]) return kf[0][1];
  for (let j = 1; j < kf.length; j++) {
    if (i <= kf[j][0]) { const [a, sa] = kf[j - 1], [b, sb] = kf[j], k = (i - a) / (b - a); return sa * Math.pow(sb / sa, k); }
  }
  return kf[kf.length - 1][1];
}

// ---------------------------------------------------------------- recording
// b: the browser (record-video.js), open(query): loads the simulator ready to run, framesDir:
// where frame f goes as f<00000>.jpg, log: progress output, only: record just the shots it
// accepts, clean: the colour grade alone, without titles, readouts or flashes (the home page's
// background loop).
async function record(b, { open, framesDir, log, only, clean, square }) {
  const overlay = square ? () => ({}) : clean ? (f) => S.find((x) => f >= x.f && f < x.f + x.n).kind === 'card' ? { black: 1 } : { grade: true } : overlayAt;
  const DT = 1000 / FPS;
  const file = (f) => path.join(framesDir, (square ? '' : 'f') + String(f).padStart(5, '0') + '.jpg');
  // square: the replay's time after contact and speed per frame (the compositor's readout)
  const status = [];
  const capture = async (f) => {
    await b.ev(`__tr.frame(${JSON.stringify(overlay(f))})`);
    fs.writeFileSync(file(f), await b.shot(93));
    if (square) status[f] = await b.ev(`__tr.play ? { ms: +((__tr.play.t - __tr.play.t0) * 1000).toFixed(1) } : {}`);
  };
  const sq = (c) => (square && c && c.fov !== undefined ? Object.assign({}, c, { fov: Array.isArray(c.fov) ? c.fov.map(Kit.squareFov) : Kit.squareFov(c.fov) }) : c);
  const camJs = (c, k) => `__tr.cam = ${JSON.stringify(sq(c))}; __tr.k = ${k.toFixed(4)};`;
  for (const s of S) if (s.f + s.n > TOTAL || s.f < 0) throw new Error('shot outside the trailer at frame ' + s.f);
  const owner = new Int32Array(TOTAL).fill(-1);
  S.forEach((s, i) => { for (let f = s.f; f < s.f + s.n; f++) { if (owner[f] >= 0) throw new Error('shots overlap at frame ' + f); owner[f] = i; } });
  for (let f = 0; f < TOTAL; f++) if (owner[f] < 0) throw new Error('no shot at frame ' + f);
  // approach frames are taken with the grade only, so no titles may fall on them
  for (const s of S.filter((x) => x.kind === 'approach')) for (let f = s.f; f < s.f + s.n; f++) {
    if (Object.keys(overlayAt(f)).join() !== 'grade') throw new Error('an approach shot has titles at frame ' + f);
  }

  const want = only || (() => true);
  for (const [scene, query] of Object.entries(SCENES)) {
    const shots = S.filter((s) => s.scene === scene && want(s));
    if (!shots.length) continue;
    const t0 = Date.now();
    await open(query);
    await b.ev(OVERLAY);
    // raw frames: no letterbox and no grade in the page (the compositor adds its own)
    if (square) await b.ev(`(() => { const c = document.createElement('style'); c.textContent = 'body.trailer #view canvas { filter: none !important; } #tr-bars { display: none !important; }'; document.head.appendChild(c); })()`);
    // the approach, drawn once per approach camera; the frames are numbered back from contact
    const approach = shots.filter((s) => s.kind === 'approach');
    const tmp = fs.mkdtempSync(path.join(framesDir, 'ap-'));
    await b.ev(`__tr.cam = null; document.querySelector('#btn-run').click()`);
    let n = 0;
    for (let i = 0; i < 9000; i++) {
      const st = await b.ev(`window.CrashLabs ? CrashLabs.state : document.querySelector('#stepper li.on').dataset.step`);
      if (st === 'approach') {
        for (let c = 0; c < approach.length; c++) {
          await b.ev(camJs(approach[c].cam, 0) + (c === 0 ? `__rec.step(${DT})` : 'Scene3D.render(0, false, 0)'));
          await b.ev(`__tr.frame(${JSON.stringify(square ? {} : { grade: true })})`);
          fs.writeFileSync(path.join(tmp, `${c}-${n}.jpg`), await b.shot(93));
        }
        if (!approach.length) await b.ev(`__rec.step(${DT})`);
        n++;
      } else {
        if (st === 'playback') break;
        await b.ev(`__tr.cam = null; __rec.step(${DT})`);
        if (st === 'impact') await new Promise((r) => setTimeout(r, 4));
      }
    }
    for (const [c, s] of approach.entries()) {
      for (let j = 0; j < s.n; j++) {
        const k = n - 1 - s.end - (s.n - 1 - j);
        if (k < 0) throw new Error(`${scene}: the approach is only ${n} frames`);
        fs.copyFileSync(path.join(tmp, `${c}-${k}.jpg`), file(s.f + j));
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    // the replay: positioned, then played at the shot's speeds
    await b.ev('__tr.grabPlay()');
    const info = await b.ev(`({ t0: __tr.play.t0, tStart: __tr.play.tStart, tEnd: __tr.play.tEnd })`);
    const replays = shots.filter((s) => s.kind === 'replay').concat(shots.filter((s) => s.kind === 'after').sort((x, y) => x.after - y.after));
    let afterAt = -1;
    for (const s of replays) {
      await b.ev(`Scene3D.setStrainMode(${!!s.strain}); Scene3D.setXray(${!!s.xray}); __tr.anchor = null; __tr.cam = ${JSON.stringify(sq(s.cam))}; __tr.k = 0;`);
      if (s.kind === 'replay') {
        const from = info.t0 + s.from / 1000;
        if (s.from > 4) {   // run in from a little earlier, so sparks and glass already fly
          await b.ev(`__tr.seek(${Math.max(info.tStart, from - 0.04)}); __tr.speed(${(0.04 / 8 * FPS).toFixed(5)})`);
          for (let i = 0; i < 8; i++) await b.ev(`__rec.step(${DT})`);
          await b.ev(`__tr.play.t = ${from}`);
        } else await b.ev(`__tr.seek(${from})`);
        afterAt = -1;
      } else {
        if (afterAt < 0) { await b.ev(`__tr.seek(${info.tEnd}); __tr.play.after = 0`); afterAt = 0; }
        while (afterAt < s.after - 1e-6) { await b.ev(`__tr.cam = ${JSON.stringify(sq(s.cam))}; __rec.step(${DT})`); afterAt += 1 / FPS; }
      }
      for (let j = 0; j < s.n; j++) {
        const pre = s.kind === 'replay' ? `__tr.speed(${speedAt(s, j)});` : '';
        await b.ev(`${pre} ${camJs(s.cam, s.n > 1 ? j / (s.n - 1) : 0)} __rec.step(${DT})`);
        if (s.kind === 'after') afterAt += 1 / FPS;
        await capture(s.f + j);
        if (square && s.kind === 'replay') status[s.f + j].speed = speedAt(s, j);
      }
    }
    await b.ev(`Scene3D.setStrainMode(false); Scene3D.setXray(false)`);
    log(`${scene}: ${shots.length} shots (${shots.reduce((a, s) => a + s.n, 0)} frames, approach ${n} frames) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  // the title cards on black (square: the compositor draws them)
  if (!square) for (const s of S.filter((x) => x.kind === 'card' && want(x))) for (let j = 0; j < s.n; j++) await capture(s.f + j);
  const isCard = (f) => S.find((x) => f >= x.f && f < x.f + x.n).kind === 'card';
  if (!only) for (let f = 0; f < TOTAL; f++) if (!(square && isCard(f)) && !fs.existsSync(file(f))) throw new Error('frame ' + f + ' was not recorded');
  return { frames: TOTAL, fps: FPS, status };
}

// ---------------------------------------------------------------- the edit for the kit's compositor
// The same shots over the square frames (take 'sim', camera 'main', frame = the trailer's frame),
// with the website's look: logo, lower thirds, slammed titles, the replay clock as a readout.
function edit() {
  const E = S.map((s) => {
    const e = { f: s.f, n: s.n, sfx: s.sfx, hit: s.hit, hitV: s.hitV, dim: s.dim, lower: s.lower, hud: s.hud };
    if (s.kind === 'card') { if (s.card) e.card = s.card; }
    else { e.src = { take: 'sim', cam: 'main', ref: 'abs', off: s.f }; if (s.card) e.card = s.card; }
    return e;
  });
  const KIT_TITLES = [
    [F(34), { kind: 'title', title: 'Simulator', tag: 'Real physics · real crashes' }, 'title'],
    [F(35), { kind: 'title', title: 'Simulator', tag: 'Eight crash tests · bullet-time · WebGPU' }, 'card'],
    [F(36), { kind: 'title', title: 'Simulator', tag: 'Play free in your browser', cta: 'Play now', url: 'car-crash-simulation.vercel.app' }, 'title'],
  ];
  return { E, TITLES: KIT_TITLES };
}
// the readout: the time after contact and the replay speed, from the frame's status
function extra(o, s, f, src) {
  if (!src || !s.hud || s.card) return;
  const st = src.status;
  if (st.ms === undefined) return;
  const sp = st.speed || 1;
  o.impact = { text: 'T ' + (st.ms < 0 ? '−' : '+') + Math.abs(st.ms).toFixed(1).padStart(6, '0') + ' MS', label: sp >= 1 ? sp.toFixed(0) + '× SPEED' : '1/' + Math.round(1 / sp) + '× SPEED' };
}
// the background loop: the picture and the grade alone
function clean(o) { for (const k of Object.keys(o)) if (k !== 'grade' && k !== 'black') delete o[k]; o.logo = false; }

// the poster: the brick wall bursting, from the wide shot
const POSTER = F(18) + 16;
// the home page's background loop (media/hero-loop.mp4): the chorus, recorded clean
const LOOP = [F(16), F(24)];

module.exports = { record, musicHits, edit, extra, clean, BARS, FPS, TOTAL, POSTER, LOOP, SCENES, S, overlayAt };
