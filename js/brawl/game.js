/* The Hurricane Brawl game: the select screen, a match, the HUD and the results.
 *
 * A match: you and 1-5 rival storms (each a different type, driven by ai.js) start at places that
 * suit them; a countdown, then two, three or five minutes of brawling over the globe (sim.js). The
 * most damage to the Earth wins. The camera rides above your storm with "up" on the screen toward the
 * north (or free, turned with Q / E or the right stick); your move input is turned into a direction
 * on the globe from it. The mouse steers toward the point under the cursor and aims the specials
 * that aim (lightning). Behind the select screen a match between four AI storms plays.
 *
 * HUD: the clock and the Earth's damage at the top, the standings at the top left, your storm (energy
 * and category, the terrain under you and what it does to you, the special's cooldown, the matchups)
 * at the bottom left, the map at the bottom right (Tab or View for a big one); a feed of what happens
 * (cities devastated, KOs, energy surges), money popping up over the cities you hit, labels over the
 * storms and arrows to the ones out of sight.
 *
 * URL: ?storm=<type>, ?rivals=1-5, ?time=<seconds>, ?ai=breeze|gale|tempest, ?seed=, ?demo=0 (no
 * match behind the select screen), ?bloom=0, ?clouds=0, ?test=1 (an AI plays your storm at once; the
 * results go in window.__brawl).
 */
const BrawlGame = (() => {
  'use strict';
  const E = BrawlEarth, S = BrawlStorms, Sim = BrawlSim, AI = BrawlAI, IN = BrawlInput, AU = BrawlAudio;
  const q = new URLSearchParams(location.search);
  const $ = (s) => document.querySelector(s);
  const TEST = q.get('test');
  const money = (v) => v >= 1e12 ? '$' + (v / 1e12).toFixed(v >= 1e13 ? 1 : 2) + 'T' : v >= 1e9 ? '$' + (v / 1e9).toFixed(v >= 1e11 ? 0 : 1) + 'B' : v >= 1e6 ? '$' + Math.round(v / 1e6) + 'M' : '$' + Math.round(v);
  const clock = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  const store = {
    get(k, d) { try { const v = localStorage.getItem('brawl-' + k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('brawl-' + k, String(v)); } catch (e) { /* no storage */ } },
  };
  const TIMES = [120, 180, 300];
  const cfg = {
    storm: q.get('storm') || store.get('storm', 'hurricane'),
    rivals: +(q.get('rivals') || store.get('rivals', 3)),
    time: +(q.get('time') || store.get('time', 180)),
    ai: q.get('ai') || store.get('ai', 'gale'),
  };
  if (!S.TYPES[cfg.storm]) cfg.storm = 'hurricane';
  cfg.rivals = Math.max(1, Math.min(5, Math.round(cfg.rivals) || 3));
  if (!(cfg.time > 0)) cfg.time = 180;
  if (TEST && !q.get('time')) cfg.time = 30;
  if (!AI.LEVELS[cfg.ai]) cfg.ai = 'gale';
  const SPECIAL_SOUND = { surge: 'surge', dash: 'dash', whiteout: 'freeze', haboob: 'haboob', firestorm: 'fire' };
  const ICONS = {
    hurricane: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M16 16m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0"/><path d="M19 13.5C20 8 15 3 8 4"/><path d="M13 18.5C12 24 17 29 24 28"/></svg>',
    tornado: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 6h24M7 11h18M10 16h13M12 21h9M14 26h5"/></svg>',
    blizzard: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M16 3v26M4.7 9.5l22.6 13M4.7 22.5l22.6-13M12 5l4 4 4-4M12 27l4-4 4 4"/></svg>',
    sandstorm: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M3 9c4-3 7 3 11 0s7 3 11 0M3 16c4-3 7 3 11 0s7 3 11 0M3 23c4-3 7 3 11 0s7 3 11 0"/><circle cx="28" cy="9" r="1" fill="currentColor"/></svg>',
    supercell: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"><path d="M8 18a5 5 0 0 1 1-10 7 7 0 0 1 13 1 4.5 4.5 0 0 1 1 9z"/><path d="M17 18l-4 6h5l-3 6" /></svg>',
    wildfire: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M16 29c-6 0-9-4-9-9 0-6 6-8 6-15 4 3 5 6 5 9 1-1 2-3 2-5 3 3 6 6 6 11 0 5-4 9-10 9z"/><path d="M16 29c-2 0-4-2-4-4 0-3 3-4 4-7 2 3 4 4 4 7 0 2-2 4-4 4z"/></svg>',
  };
  const ARROW = '<svg viewBox="0 0 24 24"><path d="M12 2l8 16-8-4-8 4z" fill="currentColor"/></svg>';
  const fullName = (s) => s.def.name + ' ' + s.name;
  const typeColor = (k) => S.TYPES[k].color;

  let render = null, state = 'loading', sim = null, ais = [];
  const cam = { p: E.vec(18, -30), fwd: [0, 1, 0], alt: 16000, altT: 7000, tilt: 0.5, shake: 0, mode: 'north', shiftX: 0 };
  let sunAngle = 0, countdown = 0, overT = 0, wantSpecial = false, hintT = 0, hintDevice = '', acc = 0, lastBeep = -1;
  let koAt = null, brawled = new Set(), mapBig = false, cityTick = 0;
  const frames = [];

  // ---------------------------------------------------------------- the select screen
  let selRow = 0;
  const ROWS = 5;
  function buildSelect() {
    const grid = $('#sel-storms');
    for (const k of S.ORDER) {
      const d = S.TYPES[k], b = document.createElement('button');
      b.type = 'button'; b.className = 'sel-storm'; b.setAttribute('role', 'radio'); b.dataset.k = k;
      b.innerHTML = `<span style="color:${d.color}">${ICONS[k]}</span><div><b>${d.name}</b><span>${d.special.name}</span></div>`;
      b.addEventListener('click', () => { setStorm(k); selRow = 0; showFocus(); AU.play('blip'); });
      grid.appendChild(b);
    }
    const opts = (el, list, get, set) => {
      for (const [v, label] of list) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'opt'; b.setAttribute('role', 'radio'); b.textContent = label; b.dataset.v = v;
        b.addEventListener('click', () => { set(v); refreshSelect(); AU.play('blip'); });
        el.appendChild(b);
      }
      el._get = get;
    };
    opts($('#sel-rivals'), [1, 2, 3, 4, 5].map(n => [n, String(n)]), () => cfg.rivals, (v) => { cfg.rivals = +v; store.set('rivals', v); });
    opts($('#sel-time'), TIMES.map(t => [t, clock(t)]), () => cfg.time, (v) => { cfg.time = +v; store.set('time', v); });
    opts($('#sel-ai'), Object.entries(AI.LEVELS).map(([k, l]) => [k, l.label]), () => cfg.ai, (v) => { cfg.ai = v; store.set('ai', v); });
    $('#btn-start').addEventListener('click', () => startMatch());
    for (const el of document.querySelectorAll('.sel-row')) el.addEventListener('pointerenter', () => { selRow = +el.dataset.row; showFocus(); });
    refreshSelect();
  }
  function setStorm(k) { cfg.storm = k; store.set('storm', k); refreshSelect(); }
  function refreshSelect() {
    for (const b of document.querySelectorAll('.sel-storm')) b.setAttribute('aria-checked', String(b.dataset.k === cfg.storm));
    for (const el of [$('#sel-rivals'), $('#sel-time'), $('#sel-ai')]) for (const b of el.children) b.setAttribute('aria-checked', String(String(el._get()) === b.dataset.v));
    const d = S.TYPES[cfg.storm];
    $('#det-name').innerHTML = `<span style="color:${d.color}">${d.name}</span>`;
    $('#det-blurb').textContent = d.blurb;
    const punch = (t) => t.power * t.rMax * t.rMax;
    const maxPunch = Math.max(...S.ORDER.map(k => punch(S.TYPES[k])));
    const bar = (k, v) => `<div class="bar"><span class="k">${k}</span><span class="track"><i style="width:${Math.round(v * 100)}%"></i></span></div>`;
    $('#det-bars').innerHTML = bar('Size', d.rMax / 760) + bar('Speed', d.speed / 560) + bar('Wrecking', punch(d) / maxPunch);
    const terr = Object.entries(d.gain).map(([k, g]) => ({ label: E.TERRAINS[E.T[k]].label, g })).sort((a, b) => b.g - a.g);
    const feeds = terr.filter(t => t.g >= 3).map(t => `${t.label} <small>+${t.g}/s</small>`).join('');
    const dies = terr.filter(t => t.g <= -4).sort((a, b) => a.g - b.g).slice(0, 4).map(t => t.label.toLowerCase()).join(', ');
    const strong = S.beats(cfg.storm), weak = S.beatenBy(cfg.storm);
    $('#det-specs').innerHTML = `<dt>Feeds on</dt><dd>${feeds}</dd><dt>Dies over</dt><dd>${dies}</dd>` +
      `<dt>Special</dt><dd><b>${d.special.name}</b><small>${d.special.text} Every ${d.special.cooldown} s.</small></dd>` +
      `<dt>Strong vs</dt><dd><b style="color:${typeColor(strong)}">${S.TYPES[strong].name}</b><small>${S.WHY[cfg.storm]}.</small></dd>` +
      `<dt>Weak vs</dt><dd><b style="color:${typeColor(weak)}">${S.TYPES[weak].name}</b><small>${S.WHY[weak]}.</small></dd>`;
    const best = +store.get('best-' + cfg.storm, 0);
    $('#det-best').textContent = best ? `Your best as the ${d.name.toLowerCase()}: ${money(best)}` : '';
    showFocus();
  }
  function showFocus() {
    for (const el of document.querySelectorAll('.sel-row')) el.classList.toggle('focus', +el.dataset.row === selRow);
    $('#btn-start').classList.toggle('focus', selRow === 4);
  }
  function selectInput(inp) {
    const ok = inp.device === 'gamepad' ? IN.labels.ok : 'A';
    if (ok !== selectInput.ok) { selectInput.ok = ok; $('#btn-start small').textContent = 'Enter · ' + ok; $('.sel-hint').textContent = `↑ ↓ choose a row · ← → change it · Enter or ${ok} to start · or click`; }
    if (inp.nav.y) { selRow = (selRow + inp.nav.y + ROWS) % ROWS; showFocus(); AU.play('blip', 0.6); }
    if (inp.nav.x) {
      const step = (list, cur) => list[(list.indexOf(cur) + inp.nav.x + list.length) % list.length];
      if (selRow === 0) setStorm(step(S.ORDER, cfg.storm));
      else if (selRow === 1) { cfg.rivals = Math.max(1, Math.min(5, cfg.rivals + inp.nav.x)); store.set('rivals', cfg.rivals); }
      else if (selRow === 2) { cfg.time = step(TIMES, TIMES.includes(cfg.time) ? cfg.time : 180); store.set('time', cfg.time); }
      else if (selRow === 3) { cfg.ai = step(Object.keys(AI.LEVELS), cfg.ai); store.set('ai', cfg.ai); }
      refreshSelect();
      AU.play('blip', 0.6);
    }
    if (inp.start) startMatch();
  }

  // the match behind the select screen
  function startDemo() {
    const r = E.rng((Math.random() * 1e9) | 0);
    const types = S.ORDER.slice().sort(() => r() - 0.5).slice(0, 4);
    sim = Sim.create({ seed: (r() * 1e9) | 0, duration: 1e9, storms: types.map((t, i) => ({ type: t, name: S.NAMES[i], color: S.COLORS[i + 1], ai: true })) });
    ais = sim.storms.map((s, i) => AI.create(sim, i, 'gale'));
    render.setSim(sim);
    clearLabels();
  }
  function showSelect() {
    state = 'select';
    $('#select').hidden = false; $('#hud').hidden = true; $('#results').hidden = true; $('#pause').hidden = true;
    cam.altT = 15500; cam.mode = 'north';
    if (q.get('demo') !== '0') startDemo();
    refreshSelect();
  }

  // ---------------------------------------------------------------- a match
  function startMatch() {
    AU.start();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const seed = q.get('seed') ? +q.get('seed') : (Math.random() * 1e9) | 0;
    const r = E.rng(seed ^ 0x5bd1e995);
    const others = S.ORDER.filter(k => k !== cfg.storm).sort(() => r() - 0.5).slice(0, cfg.rivals);
    const names = S.NAMES.slice().sort(() => r() - 0.5);
    const storms = [{ type: cfg.storm, name: names[0], color: S.COLORS[0], ai: !!TEST }]
      .concat(others.map((t, i) => ({ type: t, name: names[i + 1], color: S.COLORS[i + 1], ai: true })));
    sim = Sim.create({ seed, duration: cfg.time, storms });
    ais = sim.storms.map((s, i) => s.ai ? AI.create(sim, i, i === 0 ? 'gale' : cfg.ai) : null);
    render.setSim(sim);
    makeLabels();
    const me = sim.storms[0];
    cam.p = me.p.slice(); cam.fwd = E.north(me.p); cam.alt = 12000; cam.altT = +store.get('zoom', 7000) || 7000; cam.mode = store.get('cam', 'north');
    sunAngle = E.latLon(me.p).lon * E.DEG + 0.5;
    countdown = 3.2; overT = 0; acc = 0; wantSpecial = false; koAt = null; brawled = new Set(); lastBeep = -1;
    $('#select').hidden = true; $('#results').hidden = true; $('#pause').hidden = true; $('#hud').hidden = false;
    $('#h-feed').innerHTML = ''; $('#popups').innerHTML = ''; $('#banner').innerHTML = '';
    setupCard();
    fuelMap(me.type);
    hintT = 9; hintDevice = '';
    state = 'countdown';
    frames.length = 0;
  }
  function setupCard() {
    const me = sim.storms[0], d = me.def;
    $('#h-chip').style.background = me.color;
    $('#h-storm').textContent = fullName(me);
    $('#h-special').textContent = d.special.name;
    $('#h-strong').textContent = S.TYPES[S.beats(me.type)].name;
    $('#h-strong').style.color = typeColor(S.beats(me.type));
    $('#h-weak').textContent = S.TYPES[S.beatenBy(me.type)].name;
    $('#h-weak').style.color = typeColor(S.beatenBy(me.type));
  }

  // your input, as the simulation takes it
  function playerInput(inp) {
    const me = sim.storms[0];
    let dir = null, mag = 0, aim = null;
    if (Math.hypot(inp.move.x, inp.move.y) > 0.05) {
      const right = E.cross(cam.fwd, me.p);
      dir = E.add(E.scale(cam.fwd, inp.move.y), right, inp.move.x);
      mag = Math.min(1, Math.hypot(inp.move.x, inp.move.y));
    } else if (inp.steer && inp.mouse.over) {
      const hit = render.pick(inp.mouse.x, inp.mouse.y);
      if (hit) { dir = E.toward(me.p, hit); mag = Math.min(1, E.dist(me.p, hit) / Math.max(150, me.r * 0.4)); }
    }
    if (inp.device !== 'gamepad' && inp.mouse.over) aim = render.pick(inp.mouse.x, inp.mouse.y);
    return { dir, mag, boost: inp.boost, special: false, aim };
  }

  function stepMatch(dt, inp) {
    if (inp.special) wantSpecial = true;
    const pin = ais[0] ? null : playerInput(inp);
    acc += dt;
    let n = 0;
    while (acc >= Sim.DT && n < 6) {
      acc -= Sim.DT; n++;
      if (pin) { pin.special = wantSpecial; wantSpecial = false; }
      sim.step(sim.storms.map((s, i) => ais[i] ? ais[i].input(Sim.DT) : pin));
      handleEvents(sim.events);
      if (sim.over) break;
    }
    if (acc > Sim.DT * 6) acc = 0;
  }
  function stepDemo(dt) {
    acc += dt;
    let n = 0;
    while (acc >= Sim.DT && n < 3) {
      acc -= Sim.DT; n++;
      sim.step(sim.storms.map((s, i) => ais[i].input(Sim.DT)));
      for (const e of sim.events) render.onEvent(e);
    }
    if (acc > Sim.DT * 3) acc = 0;
  }

  // ---------------------------------------------------------------- what happened
  const near = (p) => { const d = E.dist(p, cam.p); return Math.max(0, 1 - d / 7000) * (1.15 - 0.5 * camHeight()); };
  const camHeight = () => Math.min(1, Math.max(0, (cam.alt - 2500) / 13500));
  function handleEvents(events) {
    const me = sim.storms[0];
    for (const e of events) {
      render.onEvent(e);
      if (e.type === 'city') {
        if (e.s === 0) {
          const c = E.cities[e.c];
          popup(c, e.amount);
          if (performance.now() - cityTick > 90) { cityTick = performance.now(); AU.play('city', 0.6); }
        }
      } else if (e.type === 'devastated') {
        const c = E.cities[e.c];
        if (e.s === 0 || c.value > 1.5e11) feed(`<b>${c.name}</b> devastated by ${tagName(sim.storms[e.s])}`, sim.storms[e.s].color);
      } else if (e.type === 'ko') {
        const v = sim.storms[e.s], by = e.by >= 0 ? sim.storms[e.by] : null;
        feed(by ? `${tagName(by)} took out ${tagName(v)}` : `${tagName(v)} fell apart over ${E.TERRAINS[v.terrain].label.toLowerCase()}`, by ? by.color : v.color);
        if (e.s === 0) { banner('Dissipated', by ? `${fullName(by)} took you out. Back in ${Sim.RESPAWN} s` : `Back in ${Sim.RESPAWN} s`, '#ff5a4f'); AU.play('ko', 1); IN.rumble(1, 0.7, 600); cam.shake = 1; koAt = e.p; }
        else if (e.by === 0) { banner('Knockout!', `${fullName(v)} is gone · +25 energy`, '#ffc23d'); AU.play('ko', 0.8); AU.play('win', 0.5); IN.rumble(0.6, 0.6, 300); }
        else AU.play('ko', near(e.p) * 0.6);
      } else if (e.type === 'hit') {
        if (e.a === 0 || e.b === 0) {
          const k = Math.min(1, e.amount / 12);
          cam.shake = Math.max(cam.shake, 0.3 + 0.7 * k);
          AU.play('thud', 0.5 + 0.5 * k);
          IN.rumble(0.3 + 0.7 * k, 0.5, 120 + 200 * k);
          if (e.b === 0) flashHurt(k);
        } else if (e.kind !== 'bolt') AU.play('thud', near(e.p) * 0.5);
      } else if (e.type === 'special') {
        const s = sim.storms[e.s], v = e.s === 0 ? 1 : near(s.p) * 0.8;
        if (SPECIAL_SOUND[e.key]) AU.play(SPECIAL_SOUND[e.key], v);
        if (e.s === 0) IN.rumble(0.25, 0.6, 200);
      } else if (e.type === 'bolt') {
        AU.play('thunder', Math.max(e.s === 0 ? 0.5 : 0, near(e.p)));
      } else if (e.type === 'pickup') {
        if (e.s === 0) { banner(e.name, '+35 energy · faster for 5 s', '#ffd36b'); AU.play('pickup', 1); IN.rumble(0.2, 0.5, 200); }
        else feed(`${tagName(sim.storms[e.s])} took the energy surge (${e.name.toLowerCase()})`, '#ffd36b');
      } else if (e.type === 'surge-spawn') {
        feed('An energy surge has formed: see the gold mark on the map', '#ffd36b');
        AU.play('blip', 0.5);
      } else if (e.type === 'brawl') {
        const other = e.a === 0 ? e.b : e.b === 0 ? e.a : -1;
        if (other >= 0) {
          if (!brawled.has(other)) { brawled.add(other); banner('Fujiwhara!', `Locked in a brawl with ${fullName(sim.storms[other])}`, '#a98bff'); }
          AU.play('thud', 0.5);
        }
      } else if (e.type === 'respawn') {
        if (e.s === 0) { banner('Reborn', `${E.TERRAINS[E.terrainAt(me.p)].label}: shielded for a moment`, me.color); koAt = null; }
      }
    }
  }
  const tagName = (s) => `<b style="color:${s.color}">${fullName(s)}</b>`;
  function feed(html, color) {
    const box = $('#h-feed'), d = document.createElement('div');
    d.innerHTML = html; d.style.borderLeftColor = color;
    box.prepend(d);
    while (box.children.length > 5) box.lastChild.remove();
    setTimeout(() => d.remove(), 6000);
  }
  function banner(big, small, color) {
    const b = $('#banner');
    b.innerHTML = `<div class="b" style="color:${color || '#fff'}">${big}</div>` + (small ? `<div class="s">${small}</div>` : '');
  }
  function popup(c, amount) {
    const box = $('#popups');
    if (box.children.length > 7) return;
    const at = render.project(c.p, 0.004);
    if (!at.visible) return;
    const d = document.createElement('div');
    d.innerHTML = `+${money(amount)}<small>${c.name}</small>`;
    d.style.transform = `translate(${(at.x + (Math.random() - 0.5) * 50).toFixed(0)}px, ${(at.y - 18 - Math.random() * 24).toFixed(0)}px) translateX(-50%)`;
    box.appendChild(d);
    setTimeout(() => d.remove(), 1300);
  }
  let hurtV = 0;
  const flashHurt = (k) => { hurtV = Math.max(hurtV, 0.4 + 0.6 * k); };

  // ---------------------------------------------------------------- labels and arrows
  let labels = [];
  function clearLabels() { $('#labels').innerHTML = ''; $('#arrows').innerHTML = ''; labels = []; }
  function makeLabels() {
    clearLabels();
    labels = sim.storms.map((s, i) => {
      const tag = document.createElement('div');
      tag.className = 'tag' + (i === 0 ? ' you' : '');
      tag.style.color = s.color;
      $('#labels').appendChild(tag);
      const arrow = document.createElement('div');
      arrow.className = 'arrow';
      arrow.style.color = s.color;
      arrow.innerHTML = ARROW + '<span></span>';
      $('#arrows').appendChild(arrow);
      return { tag, arrow, text: '' };
    });
  }
  function updateLabels() {
    if (!labels.length || !sim) return;
    const me = sim.storms[0], W = innerWidth, H = innerHeight;
    sim.storms.forEach((s, i) => {
      const L = labels[i];
      const text = (i === 0 ? 'You' : fullName(s)) + (s.alive ? `<span>${s.def.scale(S.category(s.E))}</span>` : '<span>gone</span>');
      if (text !== L.text) { L.tag.innerHTML = text; L.text = text; }
      const at = s.alive ? render.project(E.along(s.p, cam.fwd, s.r * 0.85), 0.03) : { visible: false };
      L.tag.style.display = at.visible ? '' : 'none';
      if (at.visible) L.tag.style.transform = `translate(${at.x.toFixed(0)}px, ${at.y.toFixed(0)}px) translate(-50%, -100%)`;
      // an arrow at the edge toward a rival out of sight
      const show = i > 0 && s.alive && me.alive && !render.project(s.p).visible && state !== 'over';
      L.arrow.style.display = show ? '' : 'none';
      if (show) {
        const u = E.toward(me.p, s.p), right = E.cross(cam.fwd, me.p);
        const ax = E.dot(u, right), ay = E.dot(u, cam.fwd), a = Math.atan2(ax, ay);
        const rx = W / 2 - 46, ry = H / 2 - 46;
        const x = W / 2 + Math.sin(a) * rx, y = H / 2 - Math.cos(a) * ry;
        L.arrow.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -50%)`;
        L.arrow.firstChild.style.transform = `rotate(${a}rad)`;
        L.arrow.lastChild.textContent = Math.round(E.dist(me.p, s.p) / 100) * 100 + ' km';
      }
    });
  }

  // ---------------------------------------------------------------- the HUD
  let boardT = 0, mapT = 0, mapBase = null, mapDmg = null, mapFuel = null;
  function initMap() {
    mapBase = document.createElement('canvas'); mapBase.width = E.TW; mapBase.height = E.TH;
    mapBase.getContext('2d').putImageData(new ImageData(render.mapImage, E.TW, E.TH), 0, 0);
    mapDmg = document.createElement('canvas'); mapDmg.width = E.RW; mapDmg.height = E.RH;
    mapFuel = document.createElement('canvas'); mapFuel.width = E.TW; mapFuel.height = E.TH;
  }
  // for the big map: where your storm gains energy (green) and where it loses it fast (red)
  function fuelMap(type) {
    const x = mapFuel.getContext('2d'), img = x.createImageData(E.TW, E.TH), g = S.TYPES[type].gain;
    for (let i = 0; i < E.TW * E.TH; i++) {
      const v = g[E.TERRAINS[E.terrainGrid[i]].key];
      if (v >= 3) img.data.set([90, 255, 160, 80], i * 4); else if (v <= -4) img.data.set([200, 40, 30, 38], i * 4);
    }
    x.putImageData(img, 0, 0);
  }
  function drawMap() {
    const cv = $('#h-map'), x = cv.getContext('2d'), W = cv.width, H = cv.height;
    x.imageSmoothingEnabled = true;
    x.drawImage(mapBase, 0, 0, W, H);
    mapDmg.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(render.damage), E.RW, E.RH), 0, 0);
    x.globalAlpha = 0.9; x.drawImage(mapDmg, 0, 0, W, H); x.globalAlpha = 1;
    if (mapBig) { x.drawImage(mapFuel, 0, 0, W, H); x.fillStyle = 'rgba(8,12,20,0.75)'; x.fillRect(8, H - 30, 470, 22); x.fillStyle = '#dfe6f0'; x.font = '600 14px system-ui, sans-serif'; x.fillText('Green: where you gain energy · red: where you lose it fast', 16, H - 14); }
    const xy = (p) => { const { lat, lon } = E.latLon(p); return [(lon + 180) / 360 * W, (90 - lat) / 180 * H]; };
    const both = (px, fn) => { fn(px); if (px < 40) fn(px + W); if (px > W - 40) fn(px - W); };
    for (const g of sim.surges) { const [px, py] = xy(g.p); both(px, (X) => { x.fillStyle = '#ffd36b'; x.beginPath(); x.arc(X, py, 4 + Math.sin(performance.now() / 150), 0, 7); x.fill(); }); }
    sim.storms.forEach((s, i) => {
      if (!s.alive) return;
      const [px, py] = xy(s.p), rad = Math.max(3, s.r / 111.2 / 360 * W);
      both(px, (X) => {
        x.globalAlpha = 0.35; x.fillStyle = s.color; x.beginPath(); x.arc(X, py, rad, 0, 7); x.fill();
        x.globalAlpha = 1; x.beginPath(); x.arc(X, py, 3.5, 0, 7); x.fill();
        if (i === 0) { x.strokeStyle = '#fff'; x.lineWidth = 2; x.beginPath(); x.arc(X, py, rad + 2, 0, 7); x.stroke(); }
      });
    });
  }
  let last = { cat: '', terrain: '', gain: '' };
  function updateHUD(dt) {
    if (state !== 'play' && state !== 'countdown' && state !== 'over') return;
    const me = sim.storms[0];
    $('#h-time').textContent = clock(Math.ceil(sim.left));
    $('#h-time').classList.toggle('hurry', sim.left <= 10 && !sim.over);
    $('#h-world').textContent = money(sim.total);
    boardT -= dt;
    if (boardT <= 0) {
      boardT = 0.2;
      $('#h-board').innerHTML = sim.ranking().map(s => `<li class="${s.i === 0 ? 'you' : ''} ${s.alive ? '' : 'out'}"><i style="background:${s.color}"></i><span>${s.i === 0 ? 'You' : fullName(s)}${s.i === 0 ? ` <small>${s.def.name.toLowerCase()}</small>` : ''}</span><b>${money(s.stats.damage)}</b></li>`).join('');
    }
    const cat = me.alive ? me.def.scale(S.category(me.E)) : 'Gone';
    if (cat !== last.cat) { $('#h-cat').textContent = cat; last.cat = cat; }
    $('#h-energy').style.width = (me.alive ? me.E : 0).toFixed(1) + '%';
    $('#h-me').classList.toggle('low', me.E < 25);
    $('#h-me').classList.toggle('boost', me.boosting);
    const tl = me.alive ? E.TERRAINS[me.terrain].label : `Back in ${Math.ceil(me.respawn)} s`;
    if (tl !== last.terrain) { $('#h-terrain').textContent = tl; last.terrain = tl; }
    const g = me.alive ? (me.gain > 0 ? '+' : '') + me.gain + '/s' : '';
    if (g !== last.gain) { const el = $('#h-gain'); el.textContent = g; el.className = me.gain > 0 ? 'up' : me.gain < 0 ? 'down' : ''; last.gain = g; }
    const cd = me.def.special.cooldown;
    $('#h-cd').style.width = ((1 - me.cool / cd) * 100).toFixed(0) + '%';
    $('.h-special').classList.toggle('ready', me.cool <= 0);
    mapT -= dt;
    if (mapT <= 0) { mapT = 0.1; drawMap(); }
    // the controls hint, for whatever you used last
    const dev = IN.device === 'gamepad' ? 'gamepad-' + IN.kind : IN.device, L = IN.labels;
    if (dev !== hintDevice) {
      hintDevice = dev; hintT = 8;
      $('#h-hint').textContent = IN.device === 'gamepad' ? `Left stick: move · ${L.bottom} / ${L.rt}: boost · ${L.left} / ${L.lt}: special · right stick: camera · ${L.view}: map · ${L.menu}: pause`
        : dev === 'mouse' ? 'Hold left button: move · double-click and hold: boost · right button: special · wheel: zoom'
        : 'WASD: move · Shift: boost · Space: special · Q/E turn · Z/X zoom · Tab: map · Esc: pause';
      $('#h-special-key').textContent = IN.device === 'gamepad' ? L.left : dev === 'mouse' ? 'Right' : 'Space';
    }
    hintT -= dt;
    $('#h-hint').classList.toggle('off', hintT <= 0);
    hurtV *= Math.exp(-dt * 3);
    $('#hurt').style.opacity = hurtV.toFixed(2);
  }

  // ---------------------------------------------------------------- the camera
  function follow(dt, inp, target, fast) {
    const d = E.dist(cam.p, target);
    if (d > 1) cam.p = E.along(cam.p, E.toward(cam.p, target), d * (1 - Math.exp(-dt * (fast ? 7 : 2.5))));
    let f = E.tangent(cam.p, cam.fwd);
    cam.fwd = E.len(f) > 1e-3 ? E.norm(f) : E.north(cam.p);
    if (inp) {
      const turn = inp.turn * 1.5 * dt + inp.drag * 0.006;
      if (Math.abs(turn) > 1e-4) { cam.fwd = E.turn(cam.p, cam.fwd, -turn); if (cam.mode !== 'free') { cam.mode = 'free'; store.set('cam', 'free'); } }
      if (inp.camera) { cam.mode = cam.mode === 'north' ? 'free' : 'north'; store.set('cam', cam.mode); feed(cam.mode === 'north' ? 'Camera: north up' : 'Camera: free (Q / E to turn)', '#38d4ff'); }
      if (inp.zoom || inp.wheel) { cam.altT = Math.max(2500, Math.min(16000, cam.altT * Math.exp(-inp.zoom * 1.3 * dt) * Math.pow(1.12, inp.wheel))); store.set('zoom', Math.round(cam.altT)); }
    }
    if (cam.mode === 'north' && Math.abs(cam.p[1]) < 0.96) {
      const n = E.north(cam.p);
      cam.fwd = E.norm(E.add(cam.fwd, E.add(n, cam.fwd, -1), 1 - Math.exp(-dt * 2.5)));
    }
    cam.alt += (cam.altT - cam.alt) * (1 - Math.exp(-dt * 4));
    cam.tilt = 0.62 - 0.4 * camHeight();
    cam.shake *= Math.exp(-dt * 5);
  }

  // ---------------------------------------------------------------- pause and results
  let menuBtns = [], menuFocus = 0;
  function menu(btns) { menuBtns = btns; menuFocus = 0; focusMenu(); }
  function focusMenu() { menuBtns.forEach((b, i) => b.classList.toggle('focus', i === menuFocus)); }
  function menuInput(inp) {
    const d = inp.nav.x || inp.nav.y;
    if (d) { menuFocus = (menuFocus + d + menuBtns.length) % menuBtns.length; focusMenu(); AU.play('blip', 0.6); }
    if (inp.start) menuBtns[menuFocus].click();
  }
  function pause() {
    state = 'paused';
    $('#pause').hidden = false;
    menu([$('#btn-resume'), $('#btn-restart'), $('#btn-quit')]);
  }
  function resume() { $('#pause').hidden = true; state = countdown > 0 ? 'countdown' : 'play'; }
  function endMatch() {
    state = 'over'; overT = 0;
    const rank = sim.ranking(), place = rank.findIndex(s => s.i === 0) + 1;
    banner('Time!', place === 1 ? 'You did the most damage' : `You came ${ordinal(place)}`, place === 1 ? '#ffc23d' : '#fff');
    AU.play(place === 1 ? 'win' : 'go', 1);
  }
  const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  function showResults() {
    const rank = sim.ranking(), me = sim.storms[0], place = rank.indexOf(me) + 1;
    const best = +store.get('best-' + me.type, 0), isBest = me.stats.damage > best;
    if (isBest && !TEST) store.set('best-' + me.type, Math.round(me.stats.damage));
    $('#res-title').textContent = place === 1 ? 'You win!' : `${ordinal(place)} place`;
    $('#res-sub').textContent = `${fullName(me)} did ${money(me.stats.damage)} of damage` + (isBest && !TEST ? ' · a new best' : best ? ` · your best is ${money(best)}` : '') + `. The Earth took ${money(sim.total)} in ${clock(sim.duration)}.`;
    const worst = (s) => { let bi = -1, bv = 0; s.stats.cityDamage.forEach((v, i) => { if (v > bv) { bv = v; bi = i; } }); return bi >= 0 ? `${E.cities[bi].name} ${money(bv)}` : '–'; };
    $('#res-table').innerHTML = '<tr><th>#</th><th>Storm</th><th class="n">Damage</th><th class="n">Devastated</th><th class="n">KOs</th><th class="n">Lost</th><th>Hit hardest</th></tr>' +
      rank.map((s, i) => `<tr class="${s === me ? 'you' : ''}"><td>${i + 1}</td><td><i style="background:${s.color}"></i>${s === me ? 'You' : fullName(s)}<small>${s.def.name} · peak ${s.def.scale(s.stats.peak)}</small></td><td class="n">${money(s.stats.damage)}</td><td class="n">${s.stats.devastated}</td><td class="n">${s.stats.kos}</td><td class="n">${s.stats.downs}</td><td>${worst(s)}</td></tr>`).join('');
    $('#results').hidden = false;
    menu([$('#btn-again'), $('#btn-change')]);
    if (TEST) {
      const ft = frames.slice().sort((a, b) => a - b), pct = (p) => ft[Math.min(ft.length - 1, Math.floor(ft.length * p))] || 0;
      window.__brawl = {
        place, total: sim.total, duration: sim.duration,
        ranking: rank.map(s => ({ type: s.type, name: fullName(s), damage: s.stats.damage, kos: s.stats.kos, downs: s.stats.downs, devastated: s.stats.devastated, peak: s.stats.peak, specials: s.stats.specials })),
        frameMs: { median: pct(0.5), p95: pct(0.95), max: ft[ft.length - 1] || 0, n: ft.length }, bloom: render.bloom,
      };
    }
  }

  // ---------------------------------------------------------------- the loop
  let then = performance.now();
  // one frame; the next is asked for whatever happens in this one
  function loop(now) {
    try { frame(now); } finally { requestAnimationFrame(loop); }
  }
  function frame(now) {
    const dt = Math.min(0.1, (now - then) / 1000);
    then = now;
    const inp = IN.poll();
    if (inp.mute) { AU.setMuted(!AU.muted); feed(AU.muted ? 'Sound off (M)' : 'Sound on (M)', '#38d4ff'); }
    if (inp.map && (state === 'play' || state === 'countdown')) { mapBig = !mapBig; $('#h-map').classList.toggle('big', mapBig); }
    let simDt = dt;
    if (state === 'select') {
      selectInput(inp);
      if (sim && state === 'select') stepDemo(dt);
      cam.p = E.along(cam.p, E.east(cam.p), dt * 260);
      cam.p = E.along(cam.p, E.toward(cam.p, E.vec(16, E.latLon(cam.p).lon)), Math.min(1, dt) * 200);
      cam.fwd = E.north(cam.p);
      cam.alt += (cam.altT - cam.alt) * (1 - Math.exp(-dt * 2)); cam.tilt = 0.12; cam.center = true; cam.shiftX = innerWidth > 1000 && innerHeight > 600 ? 0.06 : 0;
    } else if (state === 'countdown') {
      cam.shiftX = 0; cam.center = false;
      const before = Math.ceil(countdown);
      countdown -= dt;
      const now2 = Math.ceil(countdown);
      if (now2 !== before || $('#banner').innerHTML === '') {
        if (now2 > 0) { banner(String(now2), now2 === 3 ? `You are ${fullName(sim.storms[0])}: wreck the world` : '', '#fff'); AU.play('beep', 0.8); }
      }
      if (countdown <= 0) { state = 'play'; banner('Brawl!', '', '#38d4ff'); AU.play('go', 1); IN.rumble(0.4, 0.4, 200); }
      follow(dt, inp, sim.storms[0].p, true);
      if (inp.pause) pause();
    } else if (state === 'play') {
      cam.shiftX = 0;
      if (inp.pause) pause();
      else {
        stepMatch(dt, inp);
        const me = sim.storms[0];
        follow(dt, inp, me.alive ? me.p : koAt || cam.p, me.alive && E.dist(cam.p, me.p) < 3000);
        const left = Math.ceil(sim.left);
        if (left <= 10 && left !== lastBeep && left > 0) { lastBeep = left; AU.play('beep', 0.7); }
        if (sim.over) endMatch();
        frames.push(dt * 1000);
      }
    } else if (state === 'paused') {
      simDt = 0;
      if (inp.pause || inp.back) resume();
      else if (inp.restart) startMatch();
      else menuInput(inp);
    } else if (state === 'over') {
      overT += dt;
      follow(dt, null, sim.storms[0].alive ? sim.storms[0].p : cam.p, false);
      if (overT > 1.6 && $('#results').hidden) showResults();
      if (!$('#results').hidden) { if (inp.back) showSelect(); else menuInput(inp); }
    }
    if (state !== 'paused') sunAngle += dt * Math.PI * 2 / 120;
    const me = sim && state !== 'select' ? sim.storms[0] : null;
    let brawl = 0;
    if (me && me.alive) for (const o of sim.storms) if (o !== me && o.alive && E.dist(o.p, me.p) < (o.r + me.r) * Sim.CONTACT) brawl = 1;
    AU.update(me && me.alive ? me.E / 100 : 0.25, camHeight(), brawl, state !== 'paused');
    render.frame(simDt, cam, sunAngle);
    updateLabels();
    updateHUD(dt);
  }

  // ---------------------------------------------------------------- start
  async function boot() {
    $('#loading').textContent = 'Building the Earth…';
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    render = BrawlRender.create($('#view'));
    IN.bindView($('#view'));
    buildSelect();
    initMap();
    $('#btn-resume').addEventListener('click', resume);
    $('#btn-restart').addEventListener('click', () => startMatch());
    $('#btn-quit').addEventListener('click', showSelect);
    $('#btn-again').addEventListener('click', () => startMatch());
    $('#btn-change').addEventListener('click', showSelect);
    $('#loading').hidden = true;
    if (TEST) startMatch(); else showSelect();
    requestAnimationFrame((t) => { then = t; loop(t); });
  }
  boot().catch((err) => { $('#loading').hidden = false; $('#loading').textContent = 'Could not start: ' + err.message; console.error(err); });
  return { get sim() { return sim; }, get state() { return state; }, get render() { return render; }, cam, cfg };
})();
