/* Background music: the Car Crash Simulation soundtrack, one song at a time, with a mixer between them.
 *
 * A page asks for a cue every frame (Music.play('menu'), Music.play('race:harbour') ...). When the
 * cue's song changes, the mixer crossfades from the song playing to the new one (equal-power fades on
 * two decks). A song loops on a splice found by analysis (tools/build-music.js --analyze): 25 ms
 * before a drum hit that both places share, lined up to the millisecond, crossfaded over 40 ms, so the
 * loop keeps the beat. Pauses and the slow-motion crash camera duck the music (quieter, muffled). A page
 * change fades it out first (Music.leave, and same-window links), and the menu and simulator songs pick
 * up where they left off on the next page.
 *
 * Songs are decoded into Web Audio buffers (sample-accurate splices) from media/music/<song>.js: the
 * MP3 as base64 in a classic script, so it also loads from file:// (where fetch is blocked and an
 * <audio> element routed through Web Audio plays silence). Off in scripted runs (?test, ?director)
 * and with ?music=0. */
const Music = (() => {
  'use strict';
  // the songs: loudness trim (dB, to -16 LUFS integrated) and the loop: at loop[0] s the song splices
  // back to loop[1] s
  const SONGS = {
    'full-throttle':        { title: 'Full Throttle',        db: 0.0,  loop: [142.616, 59.011] },
    'no-brakes-downtown':   { title: 'No Brakes Downtown',   db: -0.4, loop: [140.947, 74.137] },
    'midnight-freight':     { title: 'Midnight Freight',     db: -0.2, loop: [185.127, 75.360] },
    'fuel-for-the-fire':    { title: 'Fuel for the Fire',    db: -0.3, loop: [78.249, 35.195] },    // loops before the change of groove at 84 s, so the halftime break is never reached
    'million-dollar-wreck': { title: 'Million Dollar Wreck', db: 0.3,  loop: [93.368, 41.450] },
    'impact-velocity':      { title: 'Impact Velocity',      db: -0.8, loop: [175.790, 103.383] },
    'after-the-impact':     { title: 'After the Impact',     db: 0.3,  loop: [94.827, 43.356] },
  };
  // which song each cue plays. Three songs of the cue sheet aren't made yet; the closest brief stands in:
  //   Gravity Doesn't Care (Race: hillside)    -> Full Throttle (fast vocal rock, like its brief)
  //   Chain Reaction (Destruction: crossroads) -> Fuel for the Fire (fast instrumental; tankers and fuel)
  //   Ignition (menus: car and track select)   -> Impact Velocity (mid-tempo instrumental loop)
  const CUES = {
    menu: 'impact-velocity',
    results: 'after-the-impact',
    simulator: 'impact-velocity',
    'race:downtown': 'no-brakes-downtown', 'race:harbour': 'midnight-freight', 'race:hillside': 'full-throttle',
    'destruction:crossroads': 'fuel-for-the-fire', 'destruction:docklands': 'fuel-for-the-fire', 'destruction:boulevard': 'million-dollar-wreck',
  };
  const RESUME = new Set(['menu', 'simulator']);   // these pick up where they stopped; the rest start from the top
  const FADES = { results: [2.5, 1.5] };           // [out, in] s for a change to that cue; else 1.2 and 0.8 (1.5 and 1 from the results)
  const LEVEL = 0.5;      // the music under the game's own sounds (about -22 LUFS)
  const SPLICE = 0.04;    // s: the crossfade at a loop's splice
  const LEAVE = 0.25;     // s: the fade before a page change

  const q = new URLSearchParams(location.search);
  const OFF = q.has('test') || q.has('director') || q.get('music') === '0';
  const TOUCH = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const KEEP = TOUCH ? 2 : 3;   // decoded songs kept (a 3-minute song is about 60 MB)

  let ctx = null, duckG = null, lp = null, out = null;
  let enabled = (() => { try { return localStorage.getItem('music') !== 'off'; } catch (e) { return true; } })();
  let want = null;          // { cue, song } last asked for
  let deck = null;          // the song playing: { song, cue, buf, gain, env, parts: [{ src, gain, t0, off0, splice }] }
  const fading = [];        // decks fading out
  const buffers = new Map();   // song -> { p: Promise<AudioBuffer>, buf once decoded }, least recently used first
  let queue = Promise.resolve();   // preloads wait for what's already loading
  const resumeAt = {};      // song -> position (s) to pick up from
  let duckWant = [1, false], title = null, hid = false, leaving = null;
  const buttons = [];

  // where the last page left the menu and simulator songs
  try {
    const s = JSON.parse(sessionStorage.getItem('music-left') || 'null');
    if (s && Date.now() - s.at < 120000) for (const k in s.songs) if (SONGS[k]) resumeAt[k] = s.songs[k];
    sessionStorage.removeItem('music-left');
  } catch (e) { /* no session storage */ }

  function context() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    duckG = ctx.createGain(); duckG.gain.value = duckWant[0];
    lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = duckWant[1] ? 900 : 20000;
    out = ctx.createGain(); out.gain.value = enabled ? LEVEL : 0;
    duckG.connect(lp).connect(out).connect(ctx.destination);
    ctx.onstatechange = () => { if (ctx.state === 'running' && title) showTitle(); };
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  }
  // browsers start sound only after a click, tap or key press (Chrome also after one on the last page
  // of the site); until then the song waits, decoded
  const activated = () => !navigator.userActivation || navigator.userActivation.hasBeenActive;
  const unlock = () => { if (!ctx) begin(); else if (ctx.state !== 'running' && !document.hidden) ctx.resume().catch(() => {}); };
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlock, true);
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) { if (ctx.state === 'running') { hid = true; ctx.suspend(); } }
    else if (hid) { hid = false; ctx.resume().catch(() => {}); }
  });

  // ---------------------------------------------------------------- loading
  function decode(ab) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const c = OAC ? new OAC(2, 1, 44100) : context();   // at the songs' own rate, whatever the speakers run at
    return new Promise((resolve, reject) => { const p = c.decodeAudioData(ab, resolve, reject); if (p && p.then) p.then(resolve, reject); });
  }
  function load(song) {
    let e = buffers.get(song);
    if (e) { buffers.delete(song); buffers.set(song, e); return e.p; }
    e = {};
    const p = e.p = new Promise((resolve, reject) => {
      const take = () => { const d = window.MUSIC_DATA && window.MUSIC_DATA[song]; if (!d) { reject(new Error('no data in media/music/' + song + '.js')); return; } delete window.MUSIC_DATA[song]; resolve(d); };
      if (window.MUSIC_DATA && window.MUSIC_DATA[song]) { take(); return; }
      const s = document.createElement('script');
      s.src = 'media/music/' + song + '.js';
      s.onload = () => { s.remove(); take(); };
      s.onerror = () => { s.remove(); reject(new Error('could not load media/music/' + song + '.js')); };
      document.head.appendChild(s);
    }).then((b64) => fetch('data:audio/mpeg;base64,' + b64)).then((r) => r.arrayBuffer()).then(decode).then((buf) => { e.buf = buf; return buf; });
    p.catch((err) => { if (buffers.get(song) === e) buffers.delete(song); console.warn('Music: ' + err.message); });
    buffers.set(song, e);
    const busy = new Set([song, want && want.song, deck && deck.song, ...fading.map((d) => d.song)]);
    for (const k of [...buffers.keys()]) if (buffers.size > KEEP && !busy.has(k)) buffers.delete(k);
    return p;
  }
  // decode songs a page will want next, after whatever is loading now, as far as memory allows (fine to
  // call every frame)
  const asked = new Set();
  function preload(...cues) {
    if (OFF) return;
    for (const c of cues) {
      const song = CUES[c];
      if (!song || asked.has(song)) continue;
      asked.add(song);
      queue = queue.then(() => { if (buffers.has(song) || buffers.size < KEEP) return load(song); }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- the decks
  const pos = (d, t) => { let p = d.parts[0]; for (const x of d.parts) if (x.t0 <= t) p = x; return p ? p.off0 + (t - p.t0) : 0; };
  // a position inside the part that plays: past the splice means after it
  function wrap(song, s) {
    const S = SONGS[song], [A, B] = S.loop;
    while (s > A - 0.3) s -= A - B;
    return Math.max(0, s);
  }
  // an equal-power fade of a deck's gain from where it is to `to`, over dur s from now; the envelope is
  // kept, so a fade that interrupts another starts from the value reached
  function fade(d, to, dur) {
    const t = ctx.currentTime, from = level(d, t), n = 48, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1); c[i] = to > from ? from + (to - from) * Math.sin(x * Math.PI / 2) : to + (from - to) * Math.cos(x * Math.PI / 2); }
    d.gain.gain.cancelScheduledValues(Math.min(t, d.env.t));   // from the last fade's start: no curves overlap (Firefox throws)
    d.gain.gain.setValueCurveAtTime(c, t, dur);
    d.env = { t, dur, c };
  }
  function level(d, t) {
    const e = d.env, x = (t - e.t) / e.dur;
    if (x <= 0) return e.c[0];
    if (x >= 1) return e.c[e.c.length - 1];
    const i = x * (e.c.length - 1), k = Math.floor(i);
    return e.c[k] + (e.c[k + 1] - e.c[k]) * (i - k);
  }
  function addPart(d, t, off, splice) {
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = d.buf;
    src.connect(g).connect(d.gain);
    if (splice) { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + SPLICE); }
    src.start(t, off);
    const part = { src, gain: g, t0: t, off0: off, splice: 0 };
    src.onended = () => { const i = d.parts.indexOf(part); if (i >= 0) d.parts.splice(i, 1); g.disconnect(); if (!d.parts.length && d === deck) deck = null; };
    d.parts.push(part);
  }
  // sources start a little ahead: one told to start "now" starts late by the audio thread's lag, and the
  // splices are timed from when the part started
  const AHEAD = 0.05;
  function start(song, cue, buf, from, [fOut, fIn]) {
    const t = ctx.currentTime + AHEAD;
    if (deck) stopDeck(fOut);
    const g = ctx.createGain(), S = SONGS[song];
    g.connect(duckG);
    deck = { song, cue, buf, gain: g, env: { t, dur: 1, c: [0, 0] }, parts: [] };
    deck.gain.gain.value = 0;
    fade(deck, Math.pow(10, S.db / 20), from ? 1 : fIn);
    addPart(deck, t, from);
    if (!from) { title = S.title; if (ctx.state === 'running') showTitle(); }
  }
  function stopDeck(dur) {
    const d = deck; deck = null;
    if (RESUME.has(d.cue)) resumeAt[d.song] = wrap(d.song, pos(d, ctx.currentTime));
    fade(d, 0, dur);
    fading.push(d);
    const end = ctx.currentTime + dur + 0.05;
    for (const p of d.parts) { p.src.onended = null; p.src.stop(end); }
    setTimeout(() => { d.gain.disconnect(); fading.splice(fading.indexOf(d), 1); }, (dur + 0.3) * 1000);
  }
  // splices: 3 s ahead, the next part is scheduled to the sample
  setInterval(() => {
    if (!ctx || !deck || !deck.parts.length) return;
    const p = deck.parts[deck.parts.length - 1], [A, B] = SONGS[deck.song].loop;
    if (p.splice || p.off0 >= A) return;
    const tA = p.t0 + (A - p.off0), t = Math.max(ctx.currentTime + AHEAD, tA - SPLICE / 2);
    if (tA - ctx.currentTime > 3) return;
    p.splice = t;
    p.gain.gain.setValueAtTime(1, t); p.gain.gain.linearRampToValueAtTime(0, t + SPLICE);
    p.src.stop(t + SPLICE + 0.01);
    addPart(deck, t, B + (t - tA), true);
  }, 100);

  // ---------------------------------------------------------------- what pages call
  // the song for a cue; a cue that plays the song already playing changes nothing
  function play(cue) {
    if (OFF || !CUES[cue] || (want && want.cue === cue)) return;
    const prev = want, song = CUES[cue];
    want = { cue, song, prev: prev && prev.cue };
    if (deck && deck.song === song) { deck.cue = cue; return; }
    const p = load(song);
    queue = queue.then(() => p).catch(() => {});
    p.then(begin, () => { if (want && want.song === song && deck && ctx) stopDeck(1); });
  }
  // the song asked for, once it's decoded and sound is allowed
  function begin() {
    if (!want || (deck && deck.song === want.song)) return;
    const e = buffers.get(want.song);
    if (!e || !e.buf || (!ctx && !activated()) || !context()) return;
    const { song, cue } = want;
    const from = RESUME.has(cue) && resumeAt[song] != null ? wrap(song, resumeAt[song]) : 0;
    start(song, cue, e.buf, from, FADES[cue] || (want.prev === 'results' ? [1.5, 1] : [1.2, 0.8]));
  }
  // level: 1 normal, less to duck; muffle: a low-pass (paused, the crash camera)
  function duck(lvl = 1, muffle = false) {
    if (duckWant[0] === lvl && duckWant[1] === muffle) return;
    duckWant = [lvl, muffle];
    if (!ctx) return;
    const t = ctx.currentTime;
    duckG.gain.setTargetAtTime(lvl, t, 0.12);
    lp.frequency.setTargetAtTime(muffle ? 900 : 20000, t, muffle ? 0.08 : 0.25);
  }
  // fade out, then go (a reload or another page); the menu or simulator song is kept for the next page
  function leave(go) {
    if (leaving) { leaving = go; return; }
    save();
    if (!ctx || ctx.state !== 'running' || !deck) { go(); return; }
    leaving = go;
    const t = ctx.currentTime;
    out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(out.gain.value, t); out.gain.linearRampToValueAtTime(0, t + LEAVE);
    setTimeout(() => { const g = leaving; leaving = null; g(); }, LEAVE * 1000 + 20);
  }
  function save() {
    if (!ctx) return;
    if (deck && RESUME.has(deck.cue)) resumeAt[deck.song] = wrap(deck.song, pos(deck, ctx.currentTime));
    try { sessionStorage.setItem('music-left', JSON.stringify({ at: Date.now(), songs: resumeAt })); } catch (e) { /* not kept */ }
  }
  window.addEventListener('pagehide', save);
  // same-window links fade the music out before they go
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
    const u = new URL(a.href, location.href);
    if (u.href.split('#')[0] === location.href.split('#')[0] || !/^(https?|file):$/.test(u.protocol) || !deck) return;
    e.preventDefault();
    leave(() => { location.href = a.href; });
  });

  function setEnabled(on) {
    enabled = on;
    try { localStorage.setItem('music', on ? 'on' : 'off'); } catch (e) { /* not kept */ }
    if (out) { const t = ctx.currentTime; out.gain.cancelScheduledValues(t); out.gain.setTargetAtTime(on ? LEVEL : 0, t, 0.08); }
    for (const b of buttons) paint(b);
    if (on && deck) { title = SONGS[deck.song].title; showTitle(); }
  }
  const paint = (b) => { b.textContent = enabled ? 'Music: on' : 'Music: off'; b.setAttribute('aria-pressed', String(enabled)); };
  // a button that turns the music on and off (M does too)
  function bindButton(b) { if (!b) return; buttons.push(b); paint(b); b.addEventListener('click', () => setEnabled(!enabled)); }
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyM' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    setEnabled(!enabled);
  });

  // ---------------------------------------------------------------- now playing
  function showTitle() {
    if (!enabled || !title || !document.body) return;
    let el = document.getElementById('music-now');
    if (!el) {
      const st = document.createElement('style');
      st.textContent = '#music-now { position: fixed; left: 16px; bottom: 16px; z-index: 40; padding: 7px 12px; border-radius: 8px; background: rgba(10, 12, 16, 0.72); border: 1px solid rgba(255, 255, 255, 0.12); color: #eef1f5; font: 600 13px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; letter-spacing: 0.02em; pointer-events: none; opacity: 0; }' +
        ' #music-now b { color: #f2b233; font-weight: 700; margin-right: 6px; } body.touch #music-now { left: max(16px, env(safe-area-inset-left)); bottom: calc(max(16px, env(safe-area-inset-bottom)) + 100px); }';   // above the steering buttons
      document.head.prepend(st);   // first, so a page's own stylesheet can move it
      el = document.createElement('div'); el.id = 'music-now'; el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.innerHTML = '<b>♪</b>';
    el.appendChild(document.createTextNode(title));
    title = null;
    if (el.animate) el.animate([{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: 4500, easing: 'ease-out', fill: 'forwards' });
  }

  return {
    play, duck, preload, leave, bindButton, setEnabled, SONGS, CUES,
    get enabled() { return enabled; },
    // for checks: what plays, where, and the mixer's output node
    get status() {
      return { ctx: ctx && ctx.state, want: want && want.cue, song: deck && deck.song, cue: deck && deck.cue, pos: deck && ctx ? +pos(deck, ctx.currentTime).toFixed(3) : null,
        parts: deck ? deck.parts.length : 0, fading: fading.length, loaded: [...buffers.keys()].filter((k) => buffers.get(k).buf), duck: duckWant.slice(), enabled };
    },
    get output() { return out; },
  };
})();
