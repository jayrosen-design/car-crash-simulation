/* Crash labs: six focused experiments on the simulator's engine, opened as Simulator.html?lab=<id>:
 *   overlap     frontal offset tests: 40% moderate vs 25% small overlap, rigid or honeycomb barrier
 *   multi       two cars colliding: mass mismatch, momentum and the speed change of each driver
 *   side        side impact by a barrier trolley or a pole, B-pillar steel, curtain airbag
 *   whiplash    rear-impact sled test with an articulated spine and an adjustable head restraint
 *   restraint   the three collisions (vehicle, occupant, organs) with and without belts and airbags
 *   pedestrian  automatic emergency braking and pedestrian impact, steel vs foam bumper
 * Each lab builds its own setup panel, runs its computation, then plays it back in slow motion
 * with live readouts, results and charts. Without ?lab= the classic simulator (app.js) runs instead.
 * Optional URL settings per lab (same names as its controls), e.g. ?lab=side&impactor=pole. */
(() => {
  'use strict';
  const Phys = CrashPhysics, Occ = CrashOccupant, Guid = CrashGuidance, Veh = CrashVehicles, WL = CrashWhiplash, PED = CrashPedestrian, G = 9.81;
  const $ = (s) => document.querySelector(s), $$ = (s) => Array.from(document.querySelectorAll(s));
  const MPH = 0.44704, KPH = 1.609344;
  const params = new URLSearchParams(location.search), LAB_ID = params.get('lab');
  const COL = { blue: '#56b4e9', orange: '#e69f00', green: '#009e73', yellow: '#f0e442', purple: '#cc79a7', deep: '#0072b2', grey: '#8b95a1', red: '#d55e00', white: '#e6e9ee' };
  const mphKmh = (mph) => `${mph} mph (${Math.round(mph * KPH)} km/h)`;
  const fmt = (v, d = 0) => Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const LEXUS = Veh.specs.lexus ? 'lexus' : 'lab';

  // ---------------------------------------------------------------- form builders
  function rangeField(key, label, min, max, step, unit, hint) {
    return `<label class="field"><span class="field-head"><span>${label}</span><span><input data-num="${key}" type="number" min="${min}" max="${max}" step="${step}"> ${unit}</span></span>
      <input data-range="${key}" type="range" min="${min}" max="${max}" step="${step}"><span class="hint" data-hint="${key}">${hint || ''}</span></label>`;
  }
  function segField(key, label, options, hint, extra) {
    return `<div class="field"><span class="field-head"><span>${label}</span><span class="muted">${extra || ''}</span></span><div class="seg" data-seg="${key}">${options.map(([v, l, s]) => `<button data-v="${v}">${l}${s ? `<small>${s}</small>` : ''}</button>`).join('')}</div>${hint ? `<span class="hint" data-hint="${key}">${hint}</span>` : ''}</div>`;
  }
  function switchField(key, label) { return `<label class="switch"><input type="checkbox" data-check="${key}"><span>${label}</span></label>`; }

  // ---------------------------------------------------------------- results helpers
  function metricRow(container, name, value, unit, limit, digits = 0, opts = {}) {
    const r = limit ? value / limit : null;
    const el = document.createElement('div'); el.className = 'metric';
    const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = name;
    const vl = document.createElement('span'); vl.className = 'val'; vl.textContent = `${fmt(value, digits)}${unit}`;
    el.append(nm, vl);
    if (limit) {
      const meter = document.createElement('div'); meter.className = 'meter';
      const fill = document.createElement('i'), mark = document.createElement('b');
      const cls = r >= 1 ? 'bad' : r >= 0.8 ? 'warn' : 'ok';
      fill.style.width = `${Math.min(100, r / 1.5 * 100)}%`; fill.style.background = `var(--${cls})`;
      mark.style.left = `${100 / 1.5}%`;
      meter.append(fill, mark);
      const st = document.createElement('span'); st.className = 'status ' + cls;
      st.textContent = (r >= 1 ? '✕ ' + (opts.over || 'Exceeds limit') : r >= 0.8 ? '! Near limit' : '✓ ' + (opts.under || 'Within limit')) + ` (${opts.limitText || fmt(limit, opts.limitDigits || 0) + unit})` + (opts.extra ? ' · ' + opts.extra : '');
      el.append(meter, st);
    } else if (opts.extra) {
      const st = document.createElement('span'); st.className = 'status muted'; st.textContent = opts.extra; el.append(st);
    }
    container.appendChild(el);
  }
  function note(container, text, cls) { const p = document.createElement('p'); p.className = cls || 'note'; p.textContent = text; container.appendChild(p); return p; }
  function section(title, cls) {
    const s = document.createElement('div'); s.className = 'res-section';
    if (title) { const h = document.createElement('h3'); h.textContent = title; s.appendChild(h); }
    const m = document.createElement('div'); m.className = 'metrics ' + (cls || ''); s.appendChild(m);
    $('#res-body').insertBefore(s, $('#res-tabs'));
    return m;
  }
  const g = (arr) => Float64Array.from(arr, v => v / G);
  const msAxis = (n, dt, t0) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = (i * dt - t0) * 1000; return a; };

  // ---------------------------------------------------------------- page
  const LABS = {};
  let lab = null, cfg = null;
  let state = 'setup', approach = null, task = null, play = null, charts = [], events = [], evIdx = 0, toastTimer = 0;
  let cine = null, pbAuto = null;   // bullet-time, shake and structural sound of the replay (cinematic.js); a lab's own speed plan

  Scene3D.init($('#view'));
  $('#loading').remove();
  Scene3D.setBarrier('none');
  Scene3D.setPath(0, 30, false);
  const fireFx = CrashFire.Effects(Scene3D.scene);
  let hazards = [];   // steam or fire after the crash (CrashFire.assess), one per car that has one

  function toast(msg, ms) {
    const el = $('#toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms || 3500);
  }

  // live readouts during playback
  const live = document.createElement('div');
  live.id = 'live'; live.className = 'panel live'; live.hidden = true;
  $('#app').appendChild(live);
  function setLive(rows) {
    live.innerHTML = rows.map(([k, v, cls]) => `<div><span class="k">${k}</span><span class="v ${cls || ''}">${v}</span></div>`).join('');
  }

  function setState(s) {
    state = s;
    const order = ['setup', 'approach', 'impact', 'playback'];
    $$('#stepper li').forEach(li => {
      const i = order.indexOf(li.dataset.step), cur = order.indexOf(s);
      li.classList.toggle('on', i === cur); li.classList.toggle('done', i < cur);
    });
    $('#setup').hidden = s !== 'setup';
    $('#hud').hidden = s !== 'approach';
    $('#computing').hidden = s !== 'impact';
    $('#results').hidden = s !== 'playback';
    $('#timeline').hidden = s !== 'playback';
    live.hidden = s !== 'playback';
    $('#btn-stop').hidden = !(s === 'approach' || s === 'impact');
    $('#btn-reset').hidden = s === 'setup';
    updateLegend();
  }

  function buildPage() {
    lab = LABS[LAB_ID];
    if (!lab) {
      $('#setup').innerHTML = `<h2>Unknown lab</h2><p class="muted">There is no lab called “${String(LAB_ID).replace(/[<>&"]/g, '')}”. Pick one from the Simulation menu at the top, or on the <a href="Car Crash Simulation.html#simulations">home page</a>.</p>`;
      return false;
    }
    document.title = lab.title + ' · Car Crash Simulation';
    if (lab.steps) $$('#stepper li').forEach(li => { if (lab.steps[li.dataset.step]) li.textContent = lab.steps[li.dataset.step]; if (lab.steps[li.dataset.step] === null) li.hidden = true; });
    cfg = Object.assign({}, lab.defaults);
    for (const k in cfg) {
      const q = params.get(k);
      if (q === null) continue;
      if (typeof cfg[k] === 'number' && Number.isFinite(+q)) cfg[k] = +q;
      else if (typeof cfg[k] === 'boolean') cfg[k] = q === '1' || q === 'true' || q === 'on';
      else cfg[k] = q;
    }
    if (lab.fromUrl) lab.fromUrl(params);
    $('#setup').innerHTML = `<h2>${lab.title}</h2><p class="lab-intro">${lab.intro}</p>${lab.form()}
      <section class="readouts" id="lab-readouts"></section>
      <p id="setup-note" class="note" hidden></p>
      <button id="btn-run" class="primary">${lab.runLabel || 'Run the test'}</button>
      <p class="hint lab-links"><a href="Car Crash Simulation.html#simulations">All simulations</a> · <a href="Simulator.html">Free simulator</a></p>`;
    // results panel skeleton
    $('#res-body').innerHTML = `<div id="res-notes"></div><div id="res-hazard"></div><div class="tabs" role="tablist" id="res-tabs"></div><div class="tab-panels" id="res-panels"></div>
      <p class="disclaimer">${lab.disclaimer || 'Teaching model, not validated against physical crash tests. Use it to compare settings and see trends, not to predict real injuries.'}</p>`;
    bindForm();
    $('#btn-run').addEventListener('click', run);
    return true;
  }

  function bindForm() {
    const root = $('#setup');
    for (const r of root.querySelectorAll('[data-range]')) {
      const key = r.dataset.range, num = root.querySelector(`[data-num="${key}"]`);
      const set = (v) => { v = clamp(Math.round(+v / +r.step) * +r.step, +r.min, +r.max); cfg[key] = +v.toFixed(3); r.value = cfg[key]; num.value = cfg[key]; changed(key); };
      r.value = cfg[key]; num.value = cfg[key];
      r.addEventListener('input', () => set(r.value));
      num.addEventListener('change', () => set(num.value));
    }
    for (const s of root.querySelectorAll('[data-seg]')) {
      const key = s.dataset.seg;
      s.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(cfg[key])));
      s.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b || b.disabled) return;
        s.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
        cfg[key] = b.dataset.v; changed(key);
      });
    }
    for (const c of root.querySelectorAll('[data-check]')) {
      const key = c.dataset.check;
      c.checked = !!cfg[key];
      c.addEventListener('change', () => { cfg[key] = c.checked; changed(key); });
    }
  }
  function syncForm() {
    const root = $('#setup');
    for (const r of root.querySelectorAll('[data-range]')) { r.value = cfg[r.dataset.range]; root.querySelector(`[data-num="${r.dataset.range}"]`).value = cfg[r.dataset.range]; }
    for (const s of root.querySelectorAll('[data-seg]')) s.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(cfg[s.dataset.seg])));
    for (const c of root.querySelectorAll('[data-check]')) c.checked = !!cfg[c.dataset.check];
  }
  function changed(key) {
    if (lab.onChange) lab.onChange(key);
    if (state === 'setup') preview(key);
  }
  function preview(key) {
    const rows = lab.readouts ? lab.readouts() : [];
    $('#lab-readouts').innerHTML = rows.map(([k, v]) => `<div><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
    $('#lab-readouts').hidden = !rows.length;
    for (const [k, text] of Object.entries(lab.hints ? lab.hints() : {})) { const h = $(`[data-hint="${k}"]`); if (h) h.textContent = text; }
    const notes = lab.notes ? lab.notes() : [];
    $('#setup-note').hidden = !notes.length; $('#setup-note').textContent = notes.join(' ');
    lab.preview(key);
  }

  // ---------------------------------------------------------------- run
  function run() {
    if (lab.ready && !lab.ready()) return;
    FX.initAudio();
    Scene3D.particles.clear();
    approach = lab.approach ? lab.approach() : null;
    if (approach) { setState('approach'); if (approach.start) approach.start(); }
    else beginCompute();
  }
  function beginCompute() {
    if (approach && approach.end) approach.end();
    task = lab.compute();
    $('#comp-bar').style.width = '0%';
    $('#comp-text').textContent = '0%';
    setState('impact');
  }
  $('#btn-stop').addEventListener('click', () => {
    if (state === 'approach' && approach && approach.brake && !approach.braked) { approach.brake(); toast('Emergency stop: drive cut, full braking.'); }
    else if (state === 'approach') toSetup();
    else if (state === 'impact') { if (task && task.cancel) task.cancel(); task = null; toast('Computation cancelled.'); toSetup(); }
  });
  $('#btn-reset').addEventListener('click', toSetup);
  function toSetup() {
    FX.engineStop();
    approach = null; task = null; play = null;
    charts.forEach(c => c.destroy()); charts = [];
    Scene3D.particles.clear();
    $$('#tg-strain, #tg-injury, #tg-xray').forEach(t => { t.checked = false; });
    Scene3D.setStrainMode(false); Scene3D.setXray(false);
    if (lab.reset) lab.reset();
    Scene3D.setFollow(null);
    setHazards(null);
    Scene3D.setShake(0); FX.structureUpdate(0); FX.setTimeScale(1);
    setState('setup');
    preview();
  }
  function finishCompute() {
    const r = task.finish(); task = null;
    if (!r) { toSetup(); return; }
    const pb = lab.results(r);
    // the replay's bullet-time and shake: from the crash result, from the lab, or (no crash pulse)
    // just the kicks of its events
    cine = pb.cine || (r.units && r.frames ? Cinematic.fromCrash(r, pb.events || [])
      : Cinematic.track({ t0: 0, g: new Float64Array(Math.ceil(pb.tEnd / Cinematic.BIN) + 2) }, { events: pb.events || [] }));
    pbAuto = pb.auto || null;
    play = Object.assign({ t: pb.tStart, tStart: pb.tStart, tEnd: pb.tEnd, t0: pb.t0, playing: true, after: 0 }, speedSetting());
    setHazards(r);
    events = (pb.events || []).slice().sort((a, b) => a.t - b.t);
    if (pb.camera) { setCamera(pb.camera); $$('.seg[data-name=camera] button').forEach(b => b.classList.toggle('on', b.dataset.v === pb.camera)); }
    resetEventCursor();
    setState('playback');
    applyFrame(play.t);
  }

  // Steam and fire after the crash (labs with a crash result), shown in real time once the replay
  // has reached its end.
  function setHazards(r) {
    hazards = r && r.units && r.frames ? r.units.map((U, u) => CrashFire.assess(r, u)).filter(h => h && (h.fire || h.steam)) : [];
    fireFx.set(hazards, r && r.frames ? r.frames.t.length - 1 : 0);
    if (!hazards.length) { fireFx.update(-1); FX.fireUpdate(0, 0); }
    const box = $('#res-hazard');
    if (!box) return;
    box.innerHTML = '';
    if (!hazards.length) return;
    const p = note(box, CrashFire.describe(hazards, r.units.length > 1), 'note hazard');
    const b = document.createElement('button'); b.className = 'small'; b.textContent = 'Show the aftermath';
    b.addEventListener('click', () => { if (play) scrubTo(play.tEnd); });
    p.append(' ', b);
  }

  // ---------------------------------------------------------------- charts and tabs
  function tabs(list) {
    const bar = $('#res-tabs'), panels = $('#res-panels');
    bar.innerHTML = ''; panels.innerHTML = '';
    charts.forEach(c => c.destroy()); charts = [];
    list.forEach(([key, label], i) => {
      const b = document.createElement('button'); b.setAttribute('role', 'tab'); b.dataset.tab = key; b.textContent = label; if (!i) b.classList.add('on');
      bar.appendChild(b);
      const p = document.createElement('div'); p.dataset.panel = key; p.className = 'charts'; p.hidden = i > 0; panels.appendChild(p);
      b.addEventListener('click', () => {
        bar.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
        panels.querySelectorAll(':scope > div').forEach(q => { q.hidden = q.dataset.panel !== key; });
        charts.forEach(c => c.render());
      });
    });
    return (key) => panels.querySelector(`[data-panel="${key}"]`);
  }
  function lineChart(panel, opts) {
    const c = new Charts.LineChart(panel, Object.assign({ xLabel: 'ms', onScrub: (x) => scrubTo(play.t0 + x / 1000) }, opts));
    charts.push(c);
    return c;
  }
  function stackChart(panel, opts) { const c = new Charts.StackChart(panel, Object.assign({ xLabel: 'ms', onScrub: (x) => scrubTo(play.t0 + x / 1000) }, opts)); charts.push(c); return c; }
  function clearResults() { $('#res-notes').innerHTML = ''; $$('#res-body > .res-section').forEach(s => s.remove()); }

  // ---------------------------------------------------------------- playback
  $('#btn-play').addEventListener('click', togglePlay);
  function togglePlay() {
    if (!play) return;
    if (!play.playing && play.t >= play.tEnd - 1e-6) { play.t = play.tStart; resetEventCursor(); Scene3D.particles.clear(); }
    play.playing = !play.playing;
  }
  // the speed setting: a fixed playback speed, or bullet-time (the lab's own plan, or the speed
  // following the crash pulse)
  function speedSetting() { const v = $('#tl-speed').value; return v === 'auto' ? { speed: Cinematic.FAST, auto: pbAuto || ((t) => cine.speed(t)) } : { speed: +v, auto: null }; }
  $('#tl-speed').addEventListener('change', () => { if (play) Object.assign(play, speedSetting()); });
  $('#tl-scrub').addEventListener('input', (e) => { if (play) scrubTo(play.tStart + (+e.target.value / 1000) * (play.tEnd - play.tStart)); });
  function scrubTo(t) {
    if (!play) return;
    play.t = clamp(t, play.tStart, play.tEnd); play.playing = false;
    resetEventCursor(); Scene3D.particles.clear();
  }
  window.addEventListener('keydown', (e) => {
    if (state !== 'playback' || VideoExport.busy || e.target.matches('input[type=number], select')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowRight') scrubTo(play.t + (e.shiftKey ? 0.01 : 0.001));
    if (e.code === 'ArrowLeft') scrubTo(play.t - (e.shiftKey ? 0.01 : 0.001));
  });
  function setCamera(mode) { if (lab.camera && lab.camera(mode)) return; Scene3D.setCameraMode(mode); }
  const hasPip = () => lab !== LABS.whiplash && lab !== LABS.pedestrian;   // the onboard camera's inset
  $('#btn-video').addEventListener('click', async () => {
    if (!play || VideoExport.busy) return;
    document.body.classList.add('exporting');
    await VideoExport.saveReplay({ play, step: updatePlayback, resetEvents: resetEventCursor, toast: (m) => toast(m, 7000), pip: hasPip(),
      title: lab.title.replace(/ lab$/, ''), fileName: `car-crash-${LAB_ID}.mp4` });
    document.body.classList.remove('exporting');
  });
  // the default view: the free camera (orbit and zoom with the mouse), following the car, from a
  // starting view chosen for the lab
  function freeCam(opts) {
    Scene3D.setCameraMode('free', opts);
    $$('.seg[data-name=camera] button').forEach(b => b.classList.toggle('on', b.dataset.v === 'free'));
  }
  for (const seg of $$('.seg[data-name=camera]')) seg.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    setCamera(b.dataset.v);
  });
  $('#tg-strain').addEventListener('change', (e) => { Scene3D.setStrainMode(e.target.checked); updateLegend(); });
  $('#tg-injury').addEventListener('change', updateLegend);
  $('#tg-xray').addEventListener('change', (e) => Scene3D.setXray(e.target.checked));
  $('#tg-shake').checked = Scene3D.shakeEnabled;
  $('#tg-shake').addEventListener('change', (e) => { Scene3D.shakeEnabled = e.target.checked; });
  function updateLegend() {
    const lg = $('#legend'), parts = [];
    if (state === 'playback' && $('#tg-strain').checked) parts.push(['Car: plastic strain', 'linear-gradient(90deg,#c9ced6,#f0e442 25%,#e69f00 55%,#a8380a)', 'none', 'heavy']);
    if (state === 'playback' && $('#tg-injury').checked) parts.push(['Dummy: worst value so far ÷ limit', 'linear-gradient(90deg,#7fa6c9,#f0e442 50%,#e69f00 99%,#d55e00 100%)', '0', '≥ 1 (exceeds)']);
    lg.hidden = !parts.length;
    lg.innerHTML = '';
    for (const [title, grad, a, b] of parts) {
      const d = document.createElement('div');
      d.innerHTML = `<div></div><div class="ramp"></div><div class="ends"><span></span><span></span></div>`;
      d.children[0].textContent = title; d.children[1].style.background = grad;
      d.children[2].children[0].textContent = a; d.children[2].children[1].textContent = b;
      lg.appendChild(d);
    }
  }
  $('#btn-sound').addEventListener('click', (e) => {
    const on = !FX.enabled; FX.setEnabled(on);
    e.target.textContent = on ? 'Sound: on' : 'Sound: off'; e.target.setAttribute('aria-pressed', on);
  });
  function resetEventCursor() { evIdx = 0; while (evIdx < events.length && events[evIdx].t <= (play ? play.t : 0)) evIdx++; lastCrunch = -1; }
  let lastCrunch = -1;
  function fireEvents(tA, tB) {
    const parts = Scene3D.particles;
    while (evIdx < events.length && events[evIdx].t <= tB) {
      const e = events[evIdx++];
      if (e.t < tA) continue;
      const o = Scene3D.cabin.o, pos = e.x !== undefined ? [e.x, e.y, e.z] : null, inCar = [o.x, o.y, o.z];
      if (e.type === 'first') { FX.crunch(1, pos); if (e.x !== undefined) { parts.spawn(e.x, e.y, e.z, 30, 'spark', [-1, 0.3, 0]); parts.spawn(e.x, e.y, e.z, 14, 'dust'); } }
      else if (e.type === 'contact') {
        if (e.t - lastCrunch > 0.03) { FX.crunch(Math.min(1, e.mag / (e.ref || 1)), pos); lastCrunch = e.t; }
        if (Math.random() < 0.5) parts.spawn(e.x, e.y, e.z, 3, 'spark', [-1, 0.2, 0]);
        if (Math.random() < 0.3) parts.spawn(e.x, Math.max(0.2, e.y), e.z, 2, 'dust');
      } else if (e.type === 'detach') { FX.tear(e.mass, pos); FX.clank(e.mass, pos); parts.spawn(e.x, e.y, e.z, Math.min(24, 6 + Math.round(e.mass)), 'spark', [0, 0.6, 0]); parts.spawn(e.x, Math.max(0.2, e.y), e.z, 4, 'dust'); }
      else if (e.type === 'glass') { FX.glass(e.mass, pos); parts.spawn(e.x, e.y, e.z, 10, 'glass'); }
      else if (e.type === 'crack') FX.crack(0.8, pos);
      else if (e.type === 'burst') { FX.blowout(pos); parts.spawn(e.x, 0.15, e.z, 10, 'dust'); }
      else if (e.type === 'airbag' || e.type === 'curtain') FX.pop(inCar);
      else if (e.type === 'headStrike') FX.hit(e.mag, inCar);
      else if (e.type === 'sideGlass') FX.glass(0.4, inCar);
      else if (e.type === 'warn') FX.beep(1760);
      else if (e.type === 'brake') FX.beep(1320);
      else if (e.type === 'thud') FX.thud(e.mass || 30, pos || inCar);
    }
  }
  function frameIndex(T, t) {
    let lo = 0, hi = T.length - 1;
    if (t <= T[0]) return [0, 0];
    if (t >= T[hi]) return [hi, 0];
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (T[m] <= t) lo = m; else hi = m - 1; }
    return [lo, (t - T[lo]) / (T[lo + 1] - T[lo])];
  }
  function applyFrame(t) {
    lab.frame(t);
    const lv = fireFx.update(hazards.length && play.after > 0 ? play.after : -1);
    FX.fireUpdate(lv.fire, lv.steam);
    const rel = (t - play.t0) * 1000;
    if (play.after > 0) { $('#tl-time').textContent = '+' + (rel / 1000 + play.after).toFixed(1); $('#tl-unit').textContent = 's'; }
    else { $('#tl-time').textContent = (rel >= 0 ? '+' : '') + rel.toFixed(1); $('#tl-unit').textContent = 'ms'; }
    $('#tl-scrub').value = Math.round((t - play.tStart) / (play.tEnd - play.tStart) * 1000);
    $('#btn-play').textContent = play.playing ? 'Pause' : 'Play';
    for (const c of charts) { if (c.el.offsetParent === null) continue; if (c.cursorIndex) c.setCursor(c.cursorIndex(t)); else c.setCursor(rel); }
    setLive(lab.live(t).concat(CrashFire.liveRows(hazards, play.after, lv)));
  }
  function updatePlayback(dt) {
    if (play.playing) {
      const sp = play.auto ? play.auto(play.t) : play.speed;
      FX.setTimeScale(sp);
      const t1 = Math.min(play.tEnd, play.t + dt * sp);
      fireEvents(play.t, t1);
      Scene3D.particles.update(t1 - play.t);
      play.t = t1;
      if (play.t >= play.tEnd) play.playing = false;
    }
    if (!play.playing) FX.setTimeScale(1);
    // after the replay: steam and fire carry on in real time
    play.after = hazards.length && play.t >= play.tEnd - 1e-9 ? play.after + dt : 0;
    applyFrame(play.t);
    // while it plays: the camera shakes and the structure groans with the crash
    const o = Scene3D.cabin.o;
    Scene3D.setShake(play.playing ? cine.shake(play.t) : 0, play.t, cine.dir);
    FX.structureUpdate(play.playing ? cine.power(play.t) : 0, [o.x, o.y, o.z]);
  }

  // ---------------------------------------------------------------- shared crash helpers
  // per-vehicle views of a crash result (node positions and strain of one vehicle, its debris and
  // glass) for the renderer's destruction effects
  function unitView(res, u) {
    const U = res.units[u], F = res.frames, multi = res.units.length > 1;
    if (!multi) return res;
    const sub = (arr, k) => arr.subarray(k * U.off, k * (U.off + U.n));
    res._views = res._views || [];
    if (!res._views[u]) {
      res._views[u] = {
        vehicle: U.key, barrier: res.barrier,
        frames: { t: F.t, pos: F.pos.map(p => sub(p, 3)), strain: F.strain.map(s => sub(s, 1)), axes: F.unitAxes[u], bricks: F.bricks },
        debris: res.debris.filter(d => d.unit === u).map(d => Object.assign({}, d, d.X ? { X: d.X.subarray(3 * U.off, 3 * (U.off + U.n)) } : {})),
        glass: res.glass.filter(gl => gl.unit === u),
      };
    }
    return res._views[u];
  }
  function showCarFrame(slot, view, t) {
    const F = view.frames, [k, s] = frameIndex(F.t, t), k2 = Math.min(F.t.length - 1, k + 1);
    const a = F.axes[k], b = F.axes[k2], lerp = (i) => a[i] + (b[i] - a[i]) * s;
    slot.setCabinFrame([lerp(0), lerp(1), lerp(2)], [lerp(3), lerp(4), lerp(5)], [lerp(6), lerp(7), lerp(8)]);
    slot.updateDestruction(t, k, k2, s);
    slot.setCarDeformed(F.pos[k], F.pos[k2], s, F.strain[k]);
    return [k, k2, s];
  }
  // frontal dummy pose at time t from an occupant run
  function frontalDummy(occ, t, injury) { return Object.assign(Occ.poseAt(occ, t), { injury: injury || null }); }
  const restPose = Occ.restPose();
  function seatedDummy(extra) { return Object.assign({ p3: restPose, bagR: 0, belt: true, injury: null }, extra || {}); }
  // Running injury ratios for the injury map (value so far / limit), as in the free simulator.
  function injurySeries(o) {
    const S = o.metrics.series, n = o.n, dt = o.dt, W = Math.round(0.015 / dt);
    const head = new Float32Array(n), neck = new Float32Array(n), chest = new Float32Array(n), cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + 0.5 * (S.head.r[i] + S.head.r[i - 1]) * dt;
    let hicRun = 0, nijRun = 0, chestRun = 0, avg = 0;
    const win = Math.round(0.003 / dt);
    for (let i = 0; i < n; i++) {
      if (i >= o.i0 - 50 && i <= o.i0 + 3000) for (let j = Math.max(0, i - W); j < i; j++) { const T = (i - j) * dt, a = (cum[i] - cum[j]) / T; if (a > 0) hicRun = Math.max(hicRun, T * Math.pow(a, 2.5)); }
      nijRun = Math.max(nijRun, S.nij[i] || 0);
      avg += S.chest.r[i] - (i >= win ? S.chest.r[i - win] : 0);
      chestRun = Math.max(chestRun, avg / win / Occ.LIMITS.chest3ms, S.defl[i] * 1000 / Occ.LIMITS.chestDefl);
      head[i] = hicRun / Occ.LIMITS.hic15; neck[i] = nijRun / Occ.LIMITS.nij; chest[i] = chestRun;
    }
    return { head, neck, chest, hic: Float32Array.from(head, v => v * Occ.LIMITS.hic15) };
  }
  // the guided approach of the free simulator, into a barrier face at x = -faceOffset
  function guidedApproach(spec, kmh, massKg, faceOffset, onDone) {
    const ax = Phys.axles(spec), speed = kmh / 3.6;
    const app = Guid.createApproach({ speed, angle: 0, massKg, wheelbase: ax.wheelbase, rearToCenter: -ax.rearX, length: spec.length, width: spec.width });
    let braked = false;
    const obj = {
      app, get braked() { return braked; },
      start() { FX.engineStart(); Scene3D.setPath(0, app.distance, true); const p = app.pose(); Scene3D.setCameraMode('chase', { f0: new THREE.Vector3(Math.cos(p.heading), 0, Math.sin(p.heading)) }); $('#hud-target').textContent = `${fmt(kmh / KPH, 0)} mph`; },
      brake() { app.brake(); braked = true; FX.engineStop(); },
      step(dt) {
        const s = app.state, startGap = 0.01 + s.v * 0.004 + faceOffset;
        const steps = Math.min(100, Math.max(1, Math.round(dt * 1000)));
        let travelled = 0;
        for (let i = 0; i < steps; i++) {
          app.step(0.001); travelled += s.v * 0.001;
          if (app.gap() <= startGap) { onDone(app); return true; }
          if (braked && s.v <= 0) { toast(`Stopped ${(app.gap() - faceOffset).toFixed(1)} m short of the barrier. Test aborted.`); setTimeout(toSetup, 1200); return 'abort'; }
        }
        Scene3D.setCarRigid(app.pose(), s.delta, travelled / spec.wheelRadius);
        Scene3D.setDummy(seatedDummy());
        $('#hud-speed').textContent = `${(s.v / MPH).toFixed(1)} mph`;
        $('#hud-force').textContent = `${(s.force / 1000).toFixed(1)} kN`;
        $('#hud-steer').textContent = `${(s.delta * 180 / Math.PI).toFixed(2)}°`;
        $('#hud-xte').textContent = `${(s.crossTrack * 100).toFixed(1)} cm`;
        $('#hud-head').textContent = `${(s.headingError * 180 / Math.PI).toFixed(2)}°`;
        $('#hud-dist').textContent = `${Math.max(0, app.gap() - faceOffset).toFixed(1)} m`;
        $('#hud-mode').textContent = braked ? 'Braking' : (Math.abs(s.v - speed) > 0.3 ? 'Accelerating' : 'Holding speed');
        FX.engineUpdate(s.v * 3.6, s.force / (0.45 * massKg * G));
        return false;
      },
      end() { FX.engineStop(); },
    };
    return obj;
  }
  // a crash computation as a task the page advances a little every frame
  function simTask(sim, after) {
    return {
      advance(ms) { return sim.advance(ms); },
      get done() { return sim.done; },
      progressText() { return `simulated ${(Math.max(0, sim.t - Math.max(0, sim.T0)) * 1000).toFixed(0)} ms after contact`; },
      cancel() { sim.cancel(); },
      finish() { const r = sim.finalize(); return r ? after(r) : null; },
    };
  }
  function instantTask(fn) { let out = null; return { advance() { out = fn(); return 1; }, get done() { return out !== null; }, progressText() { return ''; }, finish() { return out; } }; }
  // crash events for the effects, with the impulse scale the crunch sound needs
  function crashEvents(res, extra) {
    const ref = res.units.reduce((s, u) => s + u.massKg * Math.max(1, Math.abs(u.metrics.impactSpeed) || u.metrics.deltaVVector), 0) / 30;
    return res.events.map(e => e.type === 'contact' ? Object.assign({ ref }, e) : e).concat(extra || []);
  }
  function energyChart(panel, res, t0, opts) {
    const F = res.frames, E = F.energy, fms = Float64Array.from(F.t, t => (t - t0) * 1000), kJ = (key) => Float64Array.from(E, e => (e[key] || 0) / 1000);
    const ch = [
      { y: kJ('carKinetic'), color: COL.blue, label: opts && opts.carLabel || 'Car motion' },
      { y: kJ('debrisKinetic'), color: '#9ad3f5', label: 'Debris motion' },
      { y: kJ('elastic'), color: COL.green, label: 'Elastic (springback)' },
      { y: kJ('plastic'), color: COL.orange, label: 'Plastic deformation' },
    ];
    if (E[0].barrier !== undefined) ch.push({ y: kJ('barrier'), color: '#c3cad0', label: 'Honeycomb crush' });
    ch.push({ y: kJ('fracture'), color: COL.purple, label: 'Fracture (parts off)' }, { y: Float64Array.from(E, e => (e.friction + e.contactSolver) / 1000), color: COL.yellow, label: 'Heat: friction, damping, contact' });
    stackChart(panel, { title: 'Where the kinetic energy goes, kJ', value: `½mv² = ${fmt(res.metrics.energyInitial / 1000)} kJ`, x: fms, xRange: [-20, Math.min((res.tEnd - t0) * 1000, opts && opts.maxMs || 400)], unit: ' kJ', channels: ch });
  }

  // =================================================================== 1. frontal overlap
  LABS.overlap = (() => {
    const spec = Veh.get(LEXUS);
    let barrier = null, res = null, occ = null, inj = null;
    const ov = () => cfg.overlap === 'small' ? 0.25 : 0.40;
    const def = () => {
      const W = spec.width, hc = cfg.barrier === 'honeycomb';
      return { zEdge: -W / 2 + ov() * W, side: -1, width: 1.0, height: 1.5, edgeRadius: hc ? 0.0 : 0.15, honeycomb: hc };
    };
    const faceOffset = () => cfg.barrier === 'honeycomb' ? Phys.HONEYCOMB.main.depth + Phys.HONEYCOMB.bumper.depth : 0;
    function buildBarrier(resDef) {
      if (barrier) barrier.dispose();
      const d = resDef || def();
      let hc = null;
      if (d.honeycomb === true || (d.honeycomb && d.honeycomb.nzc)) {
        const b = Phys.buildOffset(d.honeycomb === true ? d : Object.assign({}, d, { honeycomb: true })).hc;
        hc = { cell: b.h, nzc: b.nzc, nyc: b.nyc, y0: b.y0, depth: b.depth };
      }
      barrier = LabScene.offsetBarrier(Object.assign({}, d, { honeycomb: hc }));
    }
    const MEAS = [   // [label, point, axis (0 x, 1 y, 2 z), sign, limit cm]
      ['Steering column, rearward', 'column', 0, -1, 10], ['Steering column, vertical', 'column', 1, 1, 10], ['Steering column, lateral', 'column', 2, 1, 10],
      ['Brake pedal, rearward', 'pedal', 0, -1, 15], ['Toe pan (footwell), rearward', 'footwell', 0, -1, 15], ['Lower hinge pillar, rearward', 'hinge', 0, -1, 15],
    ];
    return {
      title: 'Frontal overlap lab', runLabel: 'Run the overlap test',
      intro: 'Hit the barrier with only part of the front: 40% (moderate overlap) loads one main frame rail, 25% (small overlap) misses the rails and drives the wheel back into the footwell and hinge pillar.',
      defaults: { mph: 40, overlap: 'moderate', barrier: 'honeycomb' },
      form() {
        return `<section>${rangeField('mph', 'Approach speed', 10, 50, 1, 'mph')}</section>
          <section>${segField('overlap', 'Overlap', [['moderate', '40% moderate', 'main rail'], ['small', '25% small', 'outside the rail']], '', 'driver side')}
          ${segField('barrier', 'Barrier face', [['honeycomb', 'Aluminium honeycomb', 'deformable'], ['rigid', 'Rigid', 'concrete & steel']])}</section>`;
      },
      hints() { return { mph: `${fmt(cfg.mph * KPH)} km/h. 40 mph (64 km/h) is the standard speed of offset tests.`, barrier: cfg.barrier === 'honeycomb' ? 'A 1 m wide block of crushable aluminium honeycomb (0.34 MPa, with a stiffer 1.7 MPa strip in front) on a rigid wall: it crushes like the front of another car.' : 'A rigid block with a rounded edge (150 mm radius): all the energy goes into the car.' }; },
      readouts() { const v = cfg.mph * MPH; return [['Vehicle', spec.short + ', ' + fmt(spec.massKg) + ' kg'], ['Kinetic energy', `${fmt(0.5 * spec.massKg * v * v / 1000)} kJ`], ['Width hitting the barrier', `${fmt(ov() * spec.width * 100)} cm of ${fmt(spec.width * 100)}`]]; },
      preview(key) {
        if (!barrier || key === 'overlap' || key === 'barrier' || key === undefined) buildBarrier();
        const a = guidedApproach(spec, cfg.mph * KPH, spec.massKg, faceOffset(), () => {});
        Scene3D.setPath(0, a.app.distance, true);
        Scene3D.setCarRigid(a.app.pose(), 0, 0);
        Scene3D.setDummy(seatedDummy());
        const p = a.app.pose();
        if (key === undefined) Scene3D.setCameraMode('setup', { frame: { pos: new THREE.Vector3(p.x - 9, 4.2, p.z - 7), target: new THREE.Vector3(p.x + 10, 0.5, -1) } });
      },
      ready() { return !!Scene3D.vehicleModel || spec.key === 'lab'; },
      approach() { return guidedApproach(spec, cfg.mph * KPH, spec.massKg, faceOffset(), () => beginCompute()); },
      compute() {
        const app = approach.app, s = app.state;
        const sim = Phys.createImpactSim({ vehicle: spec, massKg: spec.massKg, stiffness: 'standard', damage: 'realistic', barrier: 'offset', offset: def(), measure: true, structure: { footwell: true },
          pose: app.pose(), speed: s.v, yawRate: s.yawRate });
        Scene3D.setPath(0, app.distance, false);
        const p = app.pose();
        freeCam({ f0: new THREE.Vector3(Math.cos(p.heading), 0, Math.sin(p.heading)), from: 'front' });
        return Object.assign(simTask(sim, (r) => r), { live: sim });
      },
      results(r) {
        res = r;
        Scene3D.setDestruction(res);
        occ = Occ.simulate(res.pulse, { belt: true, airbag: true, interior: spec.interior, cabin: Phys.cabinInput(res, 0) });
        inj = injurySeries(occ);
        const t0 = res.contact ? res.T0 : 0, m = res.metrics, U = res.units[0], M = U.measure;
        clearResults();
        const q = (nm) => M.names.indexOf(nm);
        const series = MEAS.map(([label, pt, axis, sign, limit]) => {
          const arr = Float64Array.from(M.frames, f => sign * f[3 * q(pt) + axis] * 100);
          let mx = 0; for (const v of arr) mx = Math.max(mx, axis === 0 ? v : Math.abs(v));
          return { label, arr, max: mx, resid: axis === 0 ? arr[arr.length - 1] : Math.abs(arr[arr.length - 1]), limit };
        });
        const flagged = series.filter(s => s.max > s.limit);
        note($('#res-notes'), `${cfg.overlap === 'small' ? '25% small' : '40% moderate'} overlap into the ${cfg.barrier === 'honeycomb' ? 'honeycomb' : 'rigid'} barrier at ${mphKmh(cfg.mph)}: ${flagged.length ? flagged.length + ' structural measure' + (flagged.length > 1 ? 's' : '') + ' over the limit (' + flagged.map(s => s.label.toLowerCase()).join(', ') + ').' : 'all structural measures within their limits.'}`);
        const sm = section('Structure: intrusion (largest during the crash)');
        for (const s of series) metricRow(sm, s.label, s.max, ' cm', s.limit, 1, { extra: `after: ${fmt(Math.max(0, s.resid), 1)} cm`, limitText: s.limit + ' cm' });
        const oc = section('Occupant (belted, airbag)');
        const L = Occ.LIMITS, qm = occ.metrics;
        metricRow(oc, 'Head injury criterion (HIC15)', qm.hic15, '', L.hic15);
        metricRow(oc, 'Chest acceleration, 3 ms', qm.chest3ms, ' g', L.chest3ms, 1);
        metricRow(oc, 'Chest deflection', qm.chestDeflMm, ' mm', L.chestDefl, 1);
        metricRow(oc, 'Neck injury criterion (Nij)', qm.nij, '', L.nij, 2);
        metricRow(oc, `Femur force (${qm.femurSide || 'either'} leg)`, qm.femur / 1000, ' kN', L.femur / 1000, 2);
        const vc = section('Vehicle', 'vehicle');
        metricRow(vc, 'Impact speed', m.impactSpeed / MPH, ' mph', null, 1);
        metricRow(vc, 'Speed change (Δv)', U.metrics.deltaVVector / MPH, ' mph', null, 1);
        metricRow(vc, 'Peak deceleration', m.peakDecelG, ' g', null, 1);
        metricRow(vc, 'Peak lateral', U.metrics.peakLateralG, ' g', null, 1);
        metricRow(vc, 'Max crush', m.maxCrush * 100, ' cm', null);
        const a0 = res.frames.axes[0], a1 = res.frames.axes[res.frames.axes.length - 1];
        metricRow(vc, 'Car turned by', Math.abs(Math.atan2(a1[5], a1[3]) - Math.atan2(a0[5], a0[3])) * 180 / Math.PI, '°', null);
        if (res.offset.honeycomb) {
          const H = res.offset.honeycomb, last = H.frames[H.frames.length - 1];
          let mx = 0; for (const v of last) mx = Math.max(mx, v);
          metricRow(vc, 'Honeycomb crushed', mx * 100, ' cm', null);
        }
        // charts
        const tab = tabs([['pulse', 'Crash pulse'], ['intrusion', 'Intrusion'], ['occupant', 'Occupant'], ['energy', 'Energy']]);
        const pu = res.pulse, ptms = msAxis(pu.n, pu.dt, t0), xr = [-20, 250];
        lineChart(tab('pulse'), { title: 'Crash pulse: cabin deceleration, g (CFC 60)', value: `peak ${fmt(m.peakDecelG, 1)} g`, xRange: xr,
          series: [{ x: ptms, y: Float64Array.from(pu.ax, v => -v / G), color: COL.orange, label: 'longitudinal', width: 2 }, { x: ptms, y: g(pu.az), color: COL.blue, label: 'lateral' }] });
        lineChart(tab('pulse'), { title: 'Cabin speed along the approach, mph', value: `Δv ${fmt(m.deltaV / MPH, 1)} mph`, xRange: xr, series: [{ x: ptms, y: Float64Array.from(pu.vLong, v => v / MPH), color: COL.blue, label: 'speed', width: 2 }] });
        lineChart(tab('pulse'), { title: res.offset.honeycomb ? 'Force on the barrier (honeycomb and wall), kN' : 'Force on the barrier, kN', xRange: xr, series: [{ x: ptms, y: Float64Array.from(pu.force, v => v / 1000), color: COL.purple, label: 'normal force', width: 2 }] });
        const fms = Float64Array.from(res.frames.t, t => (t - t0) * 1000);
        lineChart(tab('intrusion'), { title: 'Steering column movement, cm', xRange: xr, limits: [{ y: 10, label: '10 cm' }], series: series.slice(0, 3).map((s, i) => ({ x: fms, y: s.arr, color: [COL.orange, COL.blue, COL.green][i], label: ['rearward', 'vertical', 'lateral'][i], width: i ? 1.5 : 2 })) });
        lineChart(tab('intrusion'), { title: 'Lower intrusion (rearward), cm', xRange: xr, limits: [{ y: 15, label: '15 cm' }], series: series.slice(3).map((s, i) => ({ x: fms, y: s.arr, color: [COL.red, COL.purple, COL.yellow][i], label: ['brake pedal', 'toe pan', 'hinge pillar'][i], width: 2 })) });
        const S = qm.series, tms = msAxis(occ.n, occ.dt, t0);
        lineChart(tab('occupant'), { title: 'Head acceleration, g (CFC 1000)', value: `HIC15 ${fmt(qm.hic15)}`, xRange: xr, shade: [(qm.hicT1 - t0) * 1000, (qm.hicT2 - t0) * 1000], series: [{ x: tms, y: S.head.r, color: COL.orange, label: 'resultant', width: 2 }] });
        lineChart(tab('occupant'), { title: 'Chest deflection, mm', value: `${fmt(qm.chestDeflMm, 1)} mm`, xRange: xr, limits: [{ y: L.chestDefl, label: '63 mm' }], series: [{ x: tms, y: Float64Array.from(S.defl, v => v * 1000), color: COL.blue, label: 'sternum to spine', width: 2 }] });
        energyChart(tab('energy'), res, t0);
        Scene3D.setHeadStrikes(occ.events.filter(e => e.type === 'headStrike' && e.surface === 'windshield').map(e => ({ t: e.t, mag: e.mag, p: [spec.hPoint[0] + e.hx, spec.hPoint[1] + e.hy, spec.hPoint[2] + e.hz] })));
        this.series = series; this.t0 = t0;
        return { tStart: Math.max(res.frames.t[0], t0 - 0.02), tEnd: res.tEnd, t0, events: crashEvents(res, occ.events) };
      },
      frame(t) {
        const [k, k2, s] = showCarFrame(Scene3D.main, res, t);
        if (res.offset.honeycomb) barrier.setCrush(res.offset.honeycomb.frames[s < 0.5 ? k : k2]);
        const si = clamp(Math.round(t / occ.dt), 0, occ.n - 1);
        Scene3D.setDummy(frontalDummy(occ, t, $('#tg-injury').checked ? { head: inj.head[si], neck: inj.neck[si], chest: inj.chest[si] } : null));
      },
      live(t) {
        const pu = res.pulse, i = clamp(Math.round(t / pu.dt), 0, pu.n - 1), [k] = frameIndex(res.frames.t, t);
        const S = this.series, row = (s, i2) => [s.label.replace('Steering column, ', 'Column, '), `${fmt(S[i2].arr[k], 1)} cm`, S[i2].arr[k] > s.limit ? 'bad' : ''];
        return [['Time after contact', `${fmt((t - this.t0) * 1000, 1)} ms`], ['Crash pulse', `${fmt(-pu.ax[i] / G, 1)} g`], row(S[1], 1), row(S[2], 2), row(S[3], 3), row(S[4], 4)];
      },
      reset() { Scene3D.setPath(0, 30, false); res = null; },
    };
  })();

  // =================================================================== 2. two vehicles
  LABS.multi = (() => {
    const CLASSES = {
      compact: { label: 'Compact sedan', note: 'simple model', vehicle: 'lab', mass: 1200 },
      coupe: { label: 'Sports coupe', note: 'Mustang', vehicle: 'mustang', mass: 1890 },
      suv: { label: 'Midsize SUV', note: 'Lexus RX', vehicle: 'lexus', mass: 1950 },
      heavy: { label: 'Heavy SUV', note: 'Lexus RX, loaded', vehicle: 'lexus', mass: 2400 },
    };
    let slotB = null, arrows = null, res = null, occs = null, poses = null, loaded = { a: '', b: '' };
    const specOf = (c) => Veh.get(Veh.specs[CLASSES[c].vehicle] ? CLASSES[c].vehicle : 'lab');
    function geometry() {
      const A = specOf(cfg.aCls), B = specOf(cfg.bCls), va = cfg.aMph * MPH, vb = cfg.bMph * MPH;
      const gap = 0.02 + (va + vb) * 0.004, a = cfg.angle * Math.PI / 180, hb = Math.PI - a;
      const fa = A.xMin + A.length, fb = B.xMin + B.length;
      const pA = { x: -gap / 2 - fa, z: 0, heading: 0 }, pB = { x: Math.cos(a) * (gap / 2 + fb), z: -Math.sin(a) * (gap / 2 + fb), heading: hb };
      return { A, B, va, vb, pA, pB };
    }
    const back = (p, v, t) => ({ x: p.x - Math.cos(p.heading) * v * t, z: p.z - Math.sin(p.heading) * v * t, heading: p.heading });
    async function load() {
      const want = { a: CLASSES[cfg.aCls].vehicle, b: CLASSES[cfg.bCls].vehicle };
      if (!slotB) { slotB = Scene3D.createSlot(); }
      $('#btn-run').disabled = true;
      try {
        await Scene3D.main.setVehicle(Veh.specs[want.a] ? want.a : 'lab');
        await slotB.setVehicle(Veh.specs[want.b] ? want.b : 'lab');
        loaded = want;
      } catch (e) { console.error(e); toast('Could not load a car model: ' + e.message); }
      $('#btn-run').disabled = false;
      place(3);
    }
    function place(tBefore) {
      const G0 = geometry();
      Scene3D.main.setCarRigid(back(G0.pA, Math.max(G0.va, 4), tBefore), 0, 0); slotB.setCarRigid(back(G0.pB, Math.max(G0.vb, 4) * (G0.vb > 0 ? 1 : 0), tBefore), 0, 0);
      Scene3D.main.setDummy(seatedDummy()); slotB.setDummy(seatedDummy());
    }
    return {
      title: 'Two-vehicle collision lab', runLabel: 'Run the collision',
      intro: 'Two cars meet head-on or at an angle. Momentum (p = mv) is shared in the crash, so the lighter car changes speed the most, and its driver takes the harder hit.',
      defaults: { aCls: 'coupe', aMass: 1890, aMph: 40, bCls: 'heavy', bMass: 2400, bMph: 40, angle: 0 },
      form() {
        const cls = Object.entries(CLASSES).map(([k, c]) => [k, c.label.replace(' ', '<br>'), c.note]);
        return `<section class="car-a"><h3>Car A <span class="swatch a"></span></h3>${segField('aCls', 'Vehicle', cls)}${rangeField('aMass', 'Mass', 800, 3000, 50, 'kg')}${rangeField('aMph', 'Speed', 0, 60, 1, 'mph')}</section>
          <section class="car-b"><h3>Car B <span class="swatch b"></span></h3>${segField('bCls', 'Vehicle', cls)}${rangeField('bMass', 'Mass', 800, 3000, 50, 'kg')}${rangeField('bMph', 'Speed', 0, 60, 1, 'mph')}</section>
          <section>${rangeField('angle', 'Approach angle', 0, 45, 1, '°', '0° is head-on; larger angles make an offset, glancing crash.')}</section>`;
      },
      fromUrl(q) {   // a car class from the URL brings its mass, unless the mass is given too
        for (const c of ['a', 'b']) if (CLASSES[cfg[c + 'Cls']] && q.get(c + 'Cls') && !q.get(c + 'Mass')) cfg[c + 'Mass'] = CLASSES[cfg[c + 'Cls']].mass;
        for (const c of ['a', 'b']) if (!CLASSES[cfg[c + 'Cls']]) cfg[c + 'Cls'] = this.defaults[c + 'Cls'];
      },
      onChange(key) {
        if (key === 'aCls') { cfg.aMass = CLASSES[cfg.aCls].mass; syncForm(); }
        if (key === 'bCls') { cfg.bMass = CLASSES[cfg.bCls].mass; syncForm(); }
      },
      hints() { return { aMph: `${fmt(cfg.aMph * KPH)} km/h`, bMph: `${fmt(cfg.bMph * KPH)} km/h` }; },
      readouts() {
        const pa = cfg.aMass * cfg.aMph * MPH, pb = cfg.bMass * cfg.bMph * MPH, a = cfg.angle * Math.PI / 180;
        const px = pa - pb * Math.cos(a), pz = pb * Math.sin(a), M = cfg.aMass + cfg.bMass, vc = Math.hypot(px, pz) / M;
        const ke = 0.5 * cfg.aMass * (cfg.aMph * MPH) ** 2 + 0.5 * cfg.bMass * (cfg.bMph * MPH) ** 2;
        const dvA = Math.hypot(cfg.aMph * MPH - px / M, pz / M), dvB = Math.hypot(-cfg.bMph * MPH * Math.cos(a) - px / M, cfg.bMph * MPH * Math.sin(a) - pz / M);
        return [['Momentum A / B', `${fmt(pa)} / ${fmt(pb)} kg·m/s`], ['Kinetic energy', `${fmt(ke / 1000)} kJ`], ['If they stuck together', `${fmt(vc / MPH, 1)} mph afterwards`],
          ['Δv predicted (no rebound)', `A ${fmt(dvA / MPH, 1)} · B ${fmt(dvB / MPH, 1)} mph`]];
      },
      notes() { return cfg.aMph + cfg.bMph < 1 ? ['Give at least one car some speed.'] : []; },
      preview(key) {
        if (!slotB || key === 'aCls' || key === 'bCls' || key === undefined) { if (!slotB) slotB = Scene3D.createSlot(); load(); }
        else place(3);
        if (!arrows) arrows = LabScene.arrows([0x4f9cf0, 0xe69f00, 0xffffff]);
        arrows.hide();
        if (key === undefined) Scene3D.setCameraMode('setup', { frame: { pos: new THREE.Vector3(-6, 9, -16), target: new THREE.Vector3(0, 0.5, 0) } });
      },
      ready() { return cfg.aMph + cfg.bMph >= 1 && loaded.a === CLASSES[cfg.aCls].vehicle && loaded.b === CLASSES[cfg.bCls].vehicle; },
      approach() {
        const T0 = 2.4;
        let t = 0;
        return {
          start() { FX.engineStart(); },
          step(dt) {
            t += dt;
            if (t >= T0) { beginCompute(); return true; }
            const G0 = geometry();
            Scene3D.main.setCarRigid(back(G0.pA, G0.va, T0 - t), 0, G0.va * dt / G0.A.wheelRadius);
            slotB.setCarRigid(back(G0.pB, G0.vb, T0 - t), 0, G0.vb * dt / G0.B.wheelRadius);
            const gap = Math.max(0, (G0.va + G0.vb) * (T0 - t));
            $('#hud-speed').textContent = `A ${cfg.aMph} · B ${cfg.bMph} mph`; $('#hud-target').textContent = `closing ${fmt((G0.va + G0.vb * Math.cos(cfg.angle * Math.PI / 180)) / MPH, 0)} mph`;
            $('#hud-dist').textContent = `${gap.toFixed(1)} m`; $('#hud-mode').textContent = 'Constant speed';
            for (const id of ['#hud-force', '#hud-steer', '#hud-xte', '#hud-head']) $(id).textContent = '–';
            FX.engineUpdate(Math.max(cfg.aMph, cfg.bMph) * KPH, 0.3);
            return false;
          },
          end() { FX.engineStop(); },
        };
      },
      compute() {
        const G0 = geometry();
        const sim = Phys.createImpactSim({ barrier: 'none', measure: true, duration: 1.4, vehicles: [
          { vehicle: G0.A, massKg: cfg.aMass, stiffness: 'standard', damage: 'realistic', pose: G0.pA, speed: G0.va },
          { vehicle: G0.B, massKg: cfg.bMass, stiffness: 'standard', damage: 'realistic', pose: G0.pB, speed: G0.vb }] });
        // the camera follows the pair's centre of mass (it moves at a steady speed through the crash)
        const cm = new THREE.Vector3(), mA = cfg.aMass, mB = cfg.bMass;
        Scene3D.setFollow(() => cm.copy(Scene3D.main.ctx.o).multiplyScalar(mA).addScaledVector(slotB.ctx.o, mB).multiplyScalar(1 / (mA + mB)));
        const c0 = Scene3D.main.ctx.o.clone().multiplyScalar(mA).addScaledVector(slotB.ctx.o, mB).multiplyScalar(1 / (mA + mB));
        freeCam({ f0: new THREE.Vector3(1, 0, 0), frame: { pos: c0.clone().add(new THREE.Vector3(-4.5, 6.5, -10.5)), target: c0.clone().add(new THREE.Vector3(0, 0.4, 0)) } });
        return simTask(sim, (r) => r);
      },
      results(r) {
        res = r;
        Scene3D.main.setDestruction(unitView(res, 0)); slotB.setDestruction(unitView(res, 1));
        occs = res.units.map((U, u) => Occ.simulate(U.pulse, { belt: true, airbag: true, interior: U.spec.interior, cabin: Phys.cabinInput(res, u) }));
        const t0 = res.contact ? res.T0 : 0;
        clearResults();
        const [A, B] = res.units, mA = A.massKg, mB = B.massKg;
        const E0 = res.frames.energy[0], E1 = res.frames.energy[res.frames.energy.length - 1];
        const k150 = frameIndex(res.frames.t, t0 + 0.15)[0], E150 = res.frames.energy[k150];
        const same = Math.abs(mA - mB) / Math.max(mA, mB) < 0.05 && Math.abs(cfg.aMph - cfg.bMph) <= 1 && cfg.angle <= 2;
        const dvA = A.metrics.deltaVVector / MPH, dvB = B.metrics.deltaVVector / MPH, light = mA < mB ? 'A' : 'B';
        note($('#res-notes'), same ? `Equal masses at equal speeds: each car's speed change (${fmt(dvA)} and ${fmt(dvB)} mph) equals its own speed plus a little rebound, exactly as if each had hit a rigid barrier at ${cfg.aMph} mph.`
          : Math.max(mA, mB) / Math.min(mA, mB) < 1.1 ? `The cars weigh about the same (${fmt(mA)} and ${fmt(mB)} kg), so they share the momentum almost equally: speed changes of ${fmt(dvA, 1)} and ${fmt(dvB, 1)} mph. The same impact force acts on both (Newton's third law).`
          : `Car ${light} weighs ${fmt(Math.max(mA, mB) / Math.min(mA, mB), 1)}× less, so its velocity changes ${fmt(Math.max(dvA, dvB) / Math.max(1e-6, Math.min(dvA, dvB)), 1)}× as much (${fmt(light === 'A' ? dvA : dvB, 1)} against ${fmt(light === 'A' ? dvB : dvA, 1)} mph): the same impact force acts on both cars (Newton's third law), but a = F / m.`);
        const dvMax = Math.max(A.metrics.deltaVVector, B.metrics.deltaVVector) / MPH;
        const sec = section('Driver speed change (Δv)');
        sec.classList.add('dv');
        res.units.forEach((U, u) => {
          const dv = U.metrics.deltaVVector / MPH, q = occs[u].metrics;
          const el = document.createElement('div'); el.className = 'dvbar ' + (u ? 'b' : 'a');
          el.innerHTML = `<div class="dv-head"><b>${u ? 'B' : 'A'}: ${U.spec.short}, ${fmt(U.massKg)} kg</b><span>${fmt(dv, 1)} mph (${fmt(dv * KPH)} km/h)</span></div><div class="dv-track"><i style="width:${(dv / Math.max(1, dvMax) * 100).toFixed(1)}%"></i></div>
            <div class="dv-foot">peak ${fmt(U.metrics.peakDecelG, 0)} g · crush ${fmt(U.metrics.maxCrush * 100)} cm · driver HIC ${fmt(q.hic15)} · chest ${fmt(q.chestDeflMm)} mm</div>`;
          sec.appendChild(el);
        });
        const mom = section('Momentum, p = mv (kg·m/s)', 'vehicle');
        const u0 = E0.units, u1 = E150.units;
        metricRow(mom, 'Car A before', Math.hypot(u0[0].px, u0[0].pz), '', null); metricRow(mom, 'Car B before', Math.hypot(u0[1].px, u0[1].pz), '', null);
        metricRow(mom, 'Total before', Math.hypot(u0[0].px + u0[1].px, u0[0].pz + u0[1].pz), '', null);
        metricRow(mom, 'Total 150 ms later', Math.hypot(u1[0].px + u1[1].px, u1[0].pz + u1[1].pz), '', null, 0, { extra: 'tyres and road take some away' });
        const en = section('Kinetic energy (kJ)', 'vehicle');
        metricRow(en, 'Before', (u0[0].kinetic + u0[1].kinetic) / 1000, ' kJ', null);
        metricRow(en, 'Left 150 ms later', (u1[0].kinetic + u1[1].kinetic) / 1000, ' kJ', null);
        metricRow(en, 'Bent metal, car A', E1.units[0].plastic / 1000, ' kJ', null); metricRow(en, 'Bent metal, car B', E1.units[1].plastic / 1000, ' kJ', null);
        metricRow(en, 'Heat & other losses', (E1.friction + E1.contactSolver + E1.elastic) / 1000, ' kJ', null, 0, { extra: 'friction, damping, contact' });
        const tab = tabs([['dv', 'Δv & pulse'], ['energy', 'Energy'], ['occupants', 'Drivers']]);
        const xr = [-20, 250];
        const dvSeries = (U) => { const p = U.pulse, a = new Float64Array(p.n); for (let i = 0; i < p.n; i++) a[i] = Math.hypot(p.vLong[i] - p.vLong[p.i0], p.vLat[i] - p.vLat[p.i0]) / MPH; return a; };
        const ptA = msAxis(A.pulse.n, A.pulse.dt, t0), ptB = msAxis(B.pulse.n, B.pulse.dt, t0);
        lineChart(tab('dv'), { title: 'Speed change of each car (Δv), mph', xRange: xr, series: [{ x: ptA, y: dvSeries(A), color: COL.blue, label: 'car A', width: 2 }, { x: ptB, y: dvSeries(B), color: COL.orange, label: 'car B', width: 2 }] });
        lineChart(tab('dv'), { title: 'Cabin deceleration, g (CFC 60)', xRange: xr, series: [{ x: ptA, y: Float64Array.from(A.pulse.ax, v => -v / G), color: COL.blue, label: 'car A', width: 2 }, { x: ptB, y: Float64Array.from(B.pulse.ax, v => -v / G), color: COL.orange, label: 'car B', width: 2 }] });
        lineChart(tab('dv'), { title: 'Force between the cars, kN', value: 'equal and opposite', xRange: xr, series: [{ x: ptA, y: Float64Array.from(A.pulse.force, v => v / 1000), color: COL.purple, label: 'contact force', width: 2 }] });
        const F = res.frames, fms = Float64Array.from(F.t, t => (t - t0) * 1000), kJ = (fn) => Float64Array.from(F.energy, e => fn(e) / 1000);
        stackChart(tab('energy'), { title: 'Where the kinetic energy goes, kJ', value: `½mv² = ${fmt(res.metrics.energyInitial / 1000)} kJ`, x: fms, xRange: [-20, 400], unit: ' kJ', channels: [
          { y: kJ(e => e.units[0].kinetic), color: COL.blue, label: 'Car A motion' }, { y: kJ(e => e.units[1].kinetic), color: COL.orange, label: 'Car B motion' },
          { y: kJ(e => e.units[0].plastic), color: '#9ad3f5', label: 'Bent metal A' }, { y: kJ(e => e.units[1].plastic), color: '#f3c46b', label: 'Bent metal B' },
          { y: kJ(e => e.elastic + e.fracture + e.debrisKinetic), color: COL.green, label: 'Springback & parts' },
          { y: kJ(e => e.friction + e.contactSolver), color: COL.yellow, label: 'Heat: friction, damping, contact' }] });
        const tA = msAxis(occs[0].n, occs[0].dt, t0);
        lineChart(tab('occupants'), { title: 'Driver head acceleration, g', xRange: xr, series: [{ x: tA, y: occs[0].metrics.series.head.r, color: COL.blue, label: `A: HIC ${fmt(occs[0].metrics.hic15)}`, width: 2 }, { x: msAxis(occs[1].n, occs[1].dt, t0), y: occs[1].metrics.series.head.r, color: COL.orange, label: `B: HIC ${fmt(occs[1].metrics.hic15)}`, width: 2 }] });
        lineChart(tab('occupants'), { title: 'Driver chest deflection, mm', xRange: xr, limits: [{ y: Occ.LIMITS.chestDefl, label: '63 mm' }], series: [{ x: tA, y: Float64Array.from(occs[0].metrics.series.defl, v => v * 1000), color: COL.blue, label: 'A', width: 2 }, { x: msAxis(occs[1].n, occs[1].dt, t0), y: Float64Array.from(occs[1].metrics.series.defl, v => v * 1000), color: COL.orange, label: 'B', width: 2 }] });
        this.t0 = t0;
        return { tStart: Math.max(res.frames.t[0], t0 - 0.03), tEnd: res.tEnd, t0, events: crashEvents(res, occs[0].events.concat(occs[1].events)) };
      },
      frame(t) {
        showCarFrame(Scene3D.main, unitView(res, 0), t); showCarFrame(slotB, unitView(res, 1), t);
        Scene3D.main.setDummy(frontalDummy(occs[0], t)); slotB.setDummy(frontalDummy(occs[1], t));
        // momentum arrows: each car's, and the total at the crash point
        const [k] = frameIndex(res.frames.t, t), e = res.frames.energy[k], sc = 1 / 6000;
        const axA = res.frames.unitAxes[0][k], axB = res.frames.unitAxes[1][k];
        arrows.set(0, [axA[0], 2.2, axA[2]], [e.units[0].px, 0, e.units[0].pz], sc);
        arrows.set(1, [axB[0], 2.2, axB[2]], [e.units[1].px, 0, e.units[1].pz], sc);
        arrows.set(2, [(axA[0] + axB[0]) / 2, 3.2, (axA[2] + axB[2]) / 2], [e.units[0].px + e.units[1].px, 0, e.units[0].pz + e.units[1].pz], sc);
      },
      live(t) {
        const out = [['Time after contact', `${fmt((t - this.t0) * 1000, 1)} ms`]];
        res.units.forEach((U, u) => {
          const p = U.pulse, i = clamp(Math.round(t / p.dt), 0, p.n - 1);
          out.push([`Δv car ${u ? 'B' : 'A'}`, `${fmt(Math.hypot(p.vLong[i] - p.vLong[p.i0], p.vLat[i] - p.vLat[p.i0]) / MPH, 1)} mph`, u ? 'cb' : 'ca']);
        });
        const [k] = frameIndex(res.frames.t, t), e = res.frames.energy[k];
        out.push(['Kinetic energy left', `${fmt((e.units[0].kinetic + e.units[1].kinetic) / 1000)} kJ`], ['Total momentum', `${fmt(Math.hypot(e.units[0].px + e.units[1].px, e.units[0].pz + e.units[1].pz))} kg·m/s`]);
        return out;
      },
      reset() { if (arrows) arrows.hide(); res = null; Scene3D.setFollow(null); place(3); },
    };
  })();

  // =================================================================== 3. side impact
  LABS.side = (() => {
    const spec = Veh.get(LEXUS);
    let trolley = null, pole = null, res = null, side = null, input = null;
    const W = spec.width, H = spec.hPoint;
    const speedMph = () => cfg.impactor === 'pole' ? 20 : 37;
    const poleDef = () => ({ x: H[0] + 0.05, z: -W / 2 - Phys.POLE_RADIUS - 0.03, r: Phys.POLE_RADIUS });
    const mdbPose = (tBefore) => { const M = Veh.MDB; return { x: H[0] - 0.1, z: -W / 2 - 0.02 - (M.xMin + M.length) - speedMph() * MPH * tBefore, heading: Math.PI / 2 }; };
    const carPose = (tBefore) => ({ x: 0, z: cfg.impactor === 'pole' ? speedMph() * MPH * tBefore : 0, heading: 0 });
    function props() {
      if (trolley) { trolley.dispose(); trolley = null; }
      if (pole) { pole.dispose(); pole = null; }
      if (cfg.impactor === 'pole') pole = LabScene.pole(poleDef());
      else trolley = LabScene.trolley(Veh.MDB);
    }
    // the side dummy's sideways movement applied to the seated frontal dummy, segment by segment
    function sideDummyPose(o, t) {
      const pi = clamp(Math.round(t / (o.dt * o.poseEvery)), 0, Math.ceil(o.n / o.poseEvery) - 1), b = pi * o.poseStride, P = Occ.SIDE_PARTICLES, FP = Occ.PARTICLES;
      const d = (i) => -(o.pose[b + 2 * i] - o.pose[2 * i]);   // + toward the car's right; the first pose is the seated one
      const p3 = Float64Array.from(restPose), move = (ids, dz) => { for (const i of ids) p3[3 * i + 2] += dz; };
      move([FP.HL, FP.HR, FP.SAC], d(P.PEL)); move([FP.KL, FP.KR], 0.6 * d(P.PEL));
      move([FP.THX, FP.STN], d(P.THX)); move([FP.T1, FP.SHL, FP.SHR], d(P.T1));
      move([FP.OC], d(P.OC)); move([FP.HF, FP.HB], d(P.HD));
      return seatedDummy({ p3, curtain: o.pose[b + 2 * P.NP] });
    }
    function runDummy() {
      side = Occ.simulateSide(input, { curtain: cfg.curtain });
      return side;
    }
    return {
      title: 'Side impact lab', runLabel: 'Run the side impact',
      intro: 'A side has no crumple zone: half a metre of door, B-pillar and sill between the striking object and the driver. Strong steel keeps the door out; a curtain airbag cushions the head.',
      defaults: { impactor: 'mdb', steel: 'uhss', curtain: true },
      form() {
        return `<section>${segField('impactor', 'Striking object', [['mdb', 'SUV-height barrier', '1,900 kg at 37 mph'], ['pole', 'Rigid pole', 'car slides in at 20 mph']])}</section>
          <section>${segField('steel', 'B-pillar and door ring steel', [['mild', 'Mild steel', 'about 250 MPa'], ['uhss', 'Hot-stamped', 'ultra-high-strength, 1,500 MPa']])}
          <div class="field"><span class="field-head"><span>Driver protection</span><span class="muted">side-impact dummy</span></span><div class="toggles">${switchField('curtain', 'Curtain airbag')}</div></div></section>`;
      },
      hints() { return { impactor: cfg.impactor === 'pole' ? 'The car slides sideways on a low-friction carrier into a 254 mm pole aligned with the driver: the narrow pole concentrates the load on the door.' : 'A 1,900 kg trolley whose crushable face stands at SUV height strikes the driver\'s side at 37 mph (60 km/h), centred on the B-pillar.', steel: cfg.steel === 'uhss' ? 'Press-hardened boron steel: about six times the yield strength of mild steel, so the B-pillar and door ring resist intrusion.' : 'Ordinary mild steel in the B-pillar and door ring: it yields early and lets the side intrude.' }; },
      readouts() { const v = speedMph() * MPH, m = cfg.impactor === 'pole' ? spec.massKg : Veh.MDB.massKg; return [['Struck car', `${spec.short}, ${fmt(spec.massKg)} kg`], ['Impact speed', mphKmh(speedMph())], ['Kinetic energy', `${fmt(0.5 * m * v * v / 1000)} kJ`]]; },
      preview(key) {
        if (key === undefined || key === 'impactor') props();
        Scene3D.setCarRigid(carPose(cfg.impactor === 'pole' ? 1.6 : 0), 0, 0);
        Scene3D.setDummy(seatedDummy());
        if (trolley) trolley.setRigid(mdbPose(1.6));
        Scene3D.main.setOnboardSide(1);
        if (key === undefined || key === 'impactor') Scene3D.setCameraMode('setup', { frame: { pos: new THREE.Vector3(7.5, 4.2, -9), target: new THREE.Vector3(-0.5, 0.6, -2) } });
      },
      ready() { return !!Scene3D.vehicleModel || spec.key === 'lab'; },
      approach() {
        const T0 = 1.6;
        let t = 0;
        return {
          start() { FX.engineStart(); },
          step(dt) {
            t += dt;
            if (t >= T0) { beginCompute(); return true; }
            if (trolley) trolley.setRigid(mdbPose(T0 - t)); else Scene3D.setCarRigid(carPose(T0 - t), 0, 0);
            $('#hud-speed').textContent = mphKmh(speedMph()); $('#hud-target').textContent = cfg.impactor === 'pole' ? 'car on a sled' : 'barrier trolley';
            $('#hud-dist').textContent = `${(speedMph() * MPH * (T0 - t)).toFixed(1)} m`; $('#hud-mode').textContent = 'Constant speed';
            for (const id of ['#hud-force', '#hud-steer', '#hud-xte', '#hud-head']) $(id).textContent = '–';
            FX.engineUpdate(speedMph() * KPH, 0.3);
            return false;
          },
          end() { FX.engineStop(); },
        };
      },
      compute() {
        const units = [{ vehicle: spec, massKg: spec.massKg, stiffness: 'standard', damage: 'realistic', pose: carPose(0), speed: 0, structure: { steel: cfg.steel } }];
        const c = { barrier: cfg.impactor === 'pole' ? 'pole' : 'none', measure: true, duration: 0.5, vehicles: units };
        if (cfg.impactor === 'pole') { units[0].velocity = [0, -speedMph() * MPH]; c.pole = poleDef(); c.sled = true; }
        else { const M = Veh.MDB; units.push({ vehicle: M, massKg: M.massKg, stiffness: 'standard', pose: mdbPose(0), speed: speedMph() * MPH }); }
        freeCam({ frame: { pos: new THREE.Vector3(5.2, 2.6, -5.6), target: new THREE.Vector3(0, 0.8, -0.8) } });
        return simTask(Phys.createImpactSim(c), (r) => r);
      },
      results(r) {
        res = r; input = Phys.sideInput(res);
        Scene3D.setDestruction(unitView(res, 0));
        runDummy();
        return this.build();
      },
      build() {
        const t0 = res.contact ? res.T0 : 0, U = res.units[0], M = U.measure, q = (nm) => M.names.indexOf(nm);
        clearResults();
        const intr = (nm) => Float64Array.from(M.frames, f => f[3 * q(nm) + 2] * 100);
        const bp = intr('bpillarMid'), dT = intr('doorThorax'), dP = intr('doorPelvis'), dH = intr('doorHead');
        const mx = (a) => Math.max(...a), last = (a) => a[a.length - 1];
        const fire = side.tFire >= 0 ? side.tFire + 0.006 : -1, full = fire >= 0 ? fire + 0.018 : -1;
        const kFull = full >= 0 ? frameIndex(res.frames.t, full)[0] : -1;
        note($('#res-notes'), `${cfg.impactor === 'pole' ? 'Pole at 20 mph' : 'Barrier at 37 mph'}, ${cfg.steel === 'uhss' ? 'hot-stamped' : 'mild-steel'} B-pillar: the B-pillar came in ${fmt(mx(bp), 1)} cm (${mx(bp) > 15 ? 'over' : 'within'} the 15 cm limit).` +
          (fire >= 0 ? ` The curtain airbag fired ${fmt((fire - t0) * 1000, 0)} ms after contact and was full at ${fmt((full - t0) * 1000, 0)} ms, when the door at chest height had already moved in ${fmt(dT[kFull], 1)} cm.` : cfg.curtain ? ' The curtain airbag did not fire.' : ' No curtain airbag.'));
        const st = section('Intrusion (largest during the crash)');
        metricRow(st, 'B-pillar, at mid-height', mx(bp), ' cm', 15, 1, { extra: `after: ${fmt(Math.max(0, last(bp)), 1)} cm`, limitText: '15 cm' });
        metricRow(st, 'Door at chest height', mx(dT), ' cm', null, 1, { extra: `after: ${fmt(Math.max(0, last(dT)), 1)} cm` });
        metricRow(st, 'Door at pelvis height', mx(dP), ' cm', null, 1, { extra: `after: ${fmt(Math.max(0, last(dP)), 1)} cm` });
        metricRow(st, 'Window line', mx(dH), ' cm', null, 1);
        const oc = section('Side-impact dummy');
        const sm = side.metrics, L = Occ.SIDE_LIMITS;
        metricRow(oc, 'Head injury criterion (HIC36)', sm.hic36, '', L.hic36);
        metricRow(oc, 'Rib deflection (chest potentiometer)', sm.ribDeflMm, ' mm', L.ribDefl, 1);
        metricRow(oc, 'Pelvis force', sm.pelvisForce / 1000, ' kN', L.pelvisForce / 1000, 2);
        const tg = document.createElement('div'); tg.className = 'toggles rerun';
        tg.innerHTML = `<label class="switch"><input type="checkbox" id="pb-curtain" ${cfg.curtain ? 'checked' : ''}><span>Curtain airbag</span></label><span class="muted small">Re-runs the dummy on this same crash</span>`;
        oc.parentNode.appendChild(tg);
        tg.querySelector('input').addEventListener('change', (e) => { cfg.curtain = e.target.checked; runDummy(); const pb = this.build(); events = pb.events.sort((a, b) => a.t - b.t); resetEventCursor(); applyFrame(play.t); });
        const vc = section('Struck car', 'vehicle');
        metricRow(vc, 'Speed change (Δv)', U.metrics.deltaVFar / MPH, ' mph', null, 1);
        metricRow(vc, 'Peak lateral accel.', Math.max(...Array.from(input.a, v => Math.abs(v))) / G, ' g', null, 1);
        const tab = tabs([['door', 'Door & airbag'], ['chest', 'Chest'], ['head', 'Head & car']]);
        const fms = Float64Array.from(res.frames.t, t => (t - t0) * 1000), xr = [-10, 150];
        lineChart(tab('door'), { title: 'Intrusion toward the driver, cm', value: fire >= 0 ? `curtain inflating ${fmt((fire - t0) * 1000)}–${fmt((full - t0) * 1000)} ms` : 'no curtain airbag', xRange: xr,
          shade: fire >= 0 ? [(fire - t0) * 1000, (full - t0) * 1000] : null, limits: [{ y: 15, label: 'B-pillar 15 cm' }],
          series: [{ x: fms, y: bp, color: COL.red, label: 'B-pillar', width: 2 }, { x: fms, y: dT, color: COL.orange, label: 'door, chest' }, { x: fms, y: dP, color: COL.blue, label: 'door, pelvis' }, { x: fms, y: dH, color: COL.green, label: 'window' }] });
        const sms = msAxis(side.n, side.dt, t0), S = sm.series;
        lineChart(tab('door'), { title: 'Curtain airbag inflation, %', xRange: xr, series: [{ x: sms, y: Float64Array.from(side.bag, v => v * 100), color: COL.white, label: 'inflated', width: 2 }] });
        lineChart(tab('chest'), { title: 'Rib deflection (potentiometer), mm', value: `${fmt(sm.ribDeflMm, 1)} mm`, xRange: xr, limits: [{ y: L.ribDefl, label: '44 mm' }], series: [{ x: sms, y: S.rib, color: COL.orange, label: 'struck-side ribs', width: 2 }] });
        lineChart(tab('chest'), { title: 'Pelvis force, kN', value: `${fmt(sm.pelvisForce / 1000, 2)} kN`, xRange: xr, limits: [{ y: L.pelvisForce / 1000, label: '6 kN' }], series: [{ x: sms, y: Float64Array.from(S.pelvis, v => v / 1000), color: COL.blue, label: 'door on pelvis', width: 2 }] });
        lineChart(tab('head'), { title: 'Head acceleration, g (CFC 1000)', value: `HIC36 ${fmt(sm.hic36)}`, xRange: xr, shade: [(sm.hicT1 - t0) * 1000, (sm.hicT2 - t0) * 1000], series: [{ x: sms, y: S.head, color: COL.orange, label: 'lateral', width: 2 }] });
        lineChart(tab('head'), { title: 'Struck car, lateral acceleration, g (CFC 60)', xRange: xr, series: [{ x: msAxis(input.n, input.dt, t0), y: g(input.a), color: COL.blue, label: 'at the seats', width: 2 }] });
        this.series = { bp, dT }; this.t0 = t0;
        return { tStart: Math.max(res.frames.t[0], t0 - 0.02), tEnd: Math.min(res.tEnd, t0 + 0.4), t0, events: crashEvents(res, side.events) };
      },
      frame(t) {
        const [k, k2, s] = showCarFrame(Scene3D.main, unitView(res, 0), t);
        if (trolley && res.units[1]) {
          const U = res.units[1], F = res.frames, sub = (p) => p.subarray(3 * U.off, 3 * (U.off + U.n));
          trolley.setDeformed(sub(F.pos[k]), sub(F.pos[k2]), s, F.unitAxes[1][k]);
        }
        Scene3D.setDummy(sideDummyPose(side, t));
      },
      live(t) {
        const [k] = frameIndex(res.frames.t, t), si = clamp(Math.round(t / side.dt), 0, side.n - 1), f = side.bag[si];
        return [['Time after contact', `${fmt((t - this.t0) * 1000, 1)} ms`], ['B-pillar in', `${fmt(this.series.bp[k], 1)} cm`, this.series.bp[k] > 15 ? 'bad' : ''], ['Door at chest in', `${fmt(this.series.dT[k], 1)} cm`],
          ['Rib deflection', `${fmt(side.metrics.series.rib[si], 1)} mm`, side.metrics.series.rib[si] > 44 ? 'bad' : ''], ['Curtain airbag', !cfg.curtain ? 'none' : f <= 0 ? 'stowed' : f < 1 ? `inflating ${fmt(f * 100)}%` : 'full']];
      },
      reset() { res = null; Scene3D.setCarRigid(carPose(0), 0, 0); },
    };
  })();

  // =================================================================== 4. whiplash sled
  LABS.whiplash = (() => {
    let sled = null, out = null, sledX = null;
    const geomOpts = () => ({ strikeMph: cfg.mph, backset: cfg.backset / 100, height: cfg.height / 100 });
    let geoPreview = null;
    function previewGeometry() {
      // geometry of the head restraint for the current settings, from a very short, zero-pulse run
      geoPreview = WL.simulate(Object.assign(geomOpts(), { strikeMph: 0.0001 }));
      return geoPreview;
    }
    function hideCars(on) { Scene3D.main.setVisible(!on); }
    return {
      title: 'Whiplash sled lab', runLabel: 'Fire the sled',
      intro: 'A seat on a sled is shoved forward, as when a stopped car is hit from behind. The torso goes with the seat; the head stays behind until the head restraint catches it. The closer and higher the restraint, the sooner that happens.',
      steps: { approach: null, impact: 'Compute' },
      defaults: { mph: 20, backset: 4, height: -3 },
      form() {
        return `<section>${rangeField('mph', 'Ram impulse (striking car speed)', 20, 30, 1, 'mph')}</section>
          <section>${rangeField('backset', 'Head restraint backset', 0, 12, 0.5, 'cm', 'Horizontal gap from the back of the head to the restraint.')}
          ${rangeField('height', 'Head restraint height', -12, 4, 0.5, 'cm', 'Top of the restraint relative to the top of the head (negative: below it).')}</section>`;
      },
      hints() {
        const dv = 0.5 * cfg.mph * MPH;
        return { mph: `The sled's speed jumps by ${fmt(dv / MPH, 1)} mph (${fmt(dv * 3.6, 1)} km/h) in 91 ms, peaking at ${fmt(2 * dv / WL.PULSE_T / G, 1)} g, as in a stationary car struck at ${cfg.mph} mph.` };
      },
      readouts() { return [['Dummy', 'rear-impact dummy, 24 vertebrae'], ['Seatback', '25°, yields above 2.2 kN·m']]; },
      notes() { return cfg.backset > 7 || cfg.height < -6 ? ['A restraint far behind the head or well below its top is poorly placed: expect late contact and a large neck bend.'] : []; },
      preview() {
        hideCars(true);
        if (!sled) sled = LabScene.sled(WL);
        const o = previewGeometry(), NP = WL.NP;
        sled.set({ x: Array.from(o.seated.x), y: Array.from(o.seated.y), sb: 0, sledX: 0, hrForce: 0, geometry: o.geometry });
        Scene3D.setCameraMode('setup', { frame: { pos: new THREE.Vector3(0.6, 1.5, -3.6), target: new THREE.Vector3(0.0, 1.0, 0) } });
        Scene3D.main.ctx.o.set(0, 1, 0);
      },
      approach() { return null; },
      compute() { return instantTask(() => WL.simulate(geomOpts())); },
      results(r) {
        out = r;
        const m = out.metrics, L = WL.LIMITS;
        // sled displacement
        sledX = new Float64Array(out.n); let x = 0;
        for (let k = 0; k < out.n; k++) { x += out.sledV[k] * out.dt; sledX[k] = x; }
        clearResults();
        const okC = m.contactMs >= 0 && m.contactMs <= L.contactMs, okT = m.t1PeakG <= L.t1G;
        note($('#res-notes'), okC && okT ? `Both seat-design criteria met: the head reached the restraint ${fmt(m.contactMs)} ms after the sled started (70 ms or less) and the upper spine (T1) peaked at ${fmt(m.t1PeakG, 1)} g (9.5 g or less).`
          : `Seat-design criteria: ${okC ? 'head restraint contact in time' : m.contactMs < 0 ? 'the head never reached the restraint' : `head restraint contact too late (${fmt(m.contactMs)} ms, limit 70 ms)`}; ${okT ? 'T1 acceleration within 9.5 g' : `T1 acceleration too high (${fmt(m.t1PeakG, 1)} g)`}.`);
        const sec = section('Seat-design criteria');
        metricRow(sec, 'Head restraint contact time', m.contactMs >= 0 ? m.contactMs : 300, ' ms', L.contactMs, 0, { extra: m.contactMs >= 0 ? '' : 'no contact', limitText: '70 ms' });
        metricRow(sec, 'Upper spine (T1) forward acceleration', m.t1PeakG, ' g', L.t1G, 1, { limitText: '9.5 g' });
        const nk = section('Neck');
        metricRow(nk, 'Neck injury criterion (NIC)', m.nic, ' m²/s²', L.nic, 1);
        metricRow(nk, 'Largest neck extension (head tipped back)', m.neckExtensionDeg, '°', null);
        metricRow(nk, 'Head restraint force', m.headRestraintForce, ' N', null);
        const tab = tabs([['spine', 'Sled & spine'], ['neck', 'Head & neck']]);
        const t0 = out.t0, tms = msAxis(out.n, out.dt, t0), xr = [-10, 250], S = m.series;
        lineChart(tab('spine'), { title: 'Acceleration, g (CFC 60)', value: `T1 ${fmt(m.t1PeakG, 1)} g`, xRange: xr, limits: [{ y: L.t1G, label: '9.5 g' }],
          series: [{ x: tms, y: S.sled, color: COL.grey, label: 'sled' }, { x: tms, y: S.t1, color: COL.orange, label: 'upper spine (T1)', width: 2 }, { x: tms, y: S.head, color: COL.blue, label: 'head' }] });
        lineChart(tab('spine'), { title: 'Head restraint force, N', value: m.contactMs >= 0 ? `contact at ${fmt(m.contactMs)} ms` : 'no contact', xRange: xr, shade: [0, Math.min(250, m.contactMs >= 0 ? m.contactMs : 250)],
          limits: [{ y: 0, label: '' }], series: [{ x: tms, y: out.hrF, color: COL.purple, label: 'head on restraint', width: 2 }] });
        lineChart(tab('neck'), { title: 'Neck extension (head tipped back relative to T1), °', xRange: xr, series: [{ x: tms, y: Float64Array.from(out.neckAngle, v => -v * 180 / Math.PI), color: COL.red, label: 'extension', width: 2 }] });
        const nic = new Float64Array(out.n); for (let k = 0; k < out.n; k++) nic[k] = 0.2 * out.relA[k] + out.relV[k] * Math.abs(out.relV[k]);
        lineChart(tab('neck'), { title: 'Neck injury criterion NIC, m²/s²', value: `${fmt(m.nic, 1)}`, xRange: xr, limits: [{ y: L.nic, label: '15' }], series: [{ x: tms, y: nic, color: COL.yellow, label: 'NIC', width: 2 }] });
        const evs = [{ t: t0, type: 'thud', mass: 60 }];
        if (m.contactMs >= 0) evs.push({ t: t0 + m.contactMs / 1000, type: 'headStrike', mag: 3000 });
        // bullet-time and shake follow the sled's acceleration
        const per = Math.max(1, Math.round(Cinematic.BIN / out.dt)), gs = new Float64Array(Math.ceil(out.n / per));
        for (let k = 0; k < out.n; k++) gs[Math.floor(k / per)] = Math.max(gs[Math.floor(k / per)], Math.abs(S.sled[k]));
        const cine = Cinematic.track({ t0: 0, g: gs, dir: [1, 0, 0] }, { tContact: t0, events: evs });
        return { tStart: 0, tEnd: 0.3, t0, events: evs, camera: 'free', cine };
      },
      camera(mode) {
        const frames = { side: [V3(0.6, 1.4, -3.4), V3(0.1, 1.0, 0)], front: [V3(2.6, 1.6, -2.6), V3(0, 1.0, 0)], top: [V3(0.2, 4.2, -0.4), V3(0.2, 0.9, 0)], onboard: [V3(0.25, 1.75, -0.9), V3(-0.1, 1.45, 0)], free: [V3(1.1, 1.5, -3.3), V3(0.1, 1.0, 0)] };
        if (!(mode in frames)) return false;
        const f = frames[mode], dx = V3(sled ? sled.sledX : 0, 0, 0), frame = { pos: f[0].clone().add(dx), target: f[1].clone().add(dx) };
        // the free view follows the sled (the lab keeps the cabin point on it); the others stay put
        if (mode === 'free') freeCam({ frame }); else Scene3D.setCameraMode('setup', { frame });
        return true;
      },
      frame(t) {
        const k = clamp(Math.round(t / out.dt), 0, out.n - 1), pi = clamp(Math.round(t / (out.dt * out.poseEvery)), 0, Math.ceil(out.n / out.poseEvery) - 1), o = pi * out.poseStride;
        const xs = [], ys = [];
        for (let i = 0; i < WL.NP; i++) { xs.push(out.pose[o + 2 * i]); ys.push(out.pose[o + 2 * i + 1]); }
        sled.set({ x: xs, y: ys, sb: out.pose[o + 2 * WL.NP], sledX: sledX[k], hrForce: out.hrF[k], geometry: out.geometry });
        Scene3D.main.ctx.o.set(sledX[k], 1, 0);
      },
      live(t) {
        const k = clamp(Math.round(t / out.dt), 0, out.n - 1), m = out.metrics;
        const t1 = m.series.t1[k];
        return [['Time since the sled started', `${fmt((t - out.t0) * 1000, 1)} ms`], ['Sled speed', `${fmt(out.sledV[k] / MPH, 1)} mph`], ['Upper spine (T1)', `${fmt(t1, 1)} g`, t1 > 9.5 ? 'bad' : ''],
          ['Head restraint', out.hrF[k] > 10 ? `touching, ${fmt(out.hrF[k])} N` : m.contactMs >= 0 && t - out.t0 < m.contactMs / 1000 ? 'not yet' : 'free'], ['Neck extension', `${fmt(-out.neckAngle[k] * 180 / Math.PI)}°`]];
      },
      reset() { },
    };
  })();
  function V3(x, y, z) { return new THREE.Vector3(x, y, z); }

  // =================================================================== 5. restraints and the three collisions
  LABS.restraint = (() => {
    const spec = Veh.get(LEXUS), KMH = 56;
    const OPTS = {
      none: { label: 'Unbelted', belt: false, airbag: false },
      belt: { label: '3-point belt', belt: true, airbag: false, pretensioner: false, loadLimiter: false },
      full: { label: 'Belt + limiter + airbags', belt: true, airbag: true, pretensioner: true, loadLimiter: true },
    };
    let res = null, runs = null, occ = null, org = null, trail = null, inj = null;
    const occOpts = (k) => Object.assign({ interior: spec.interior }, OPTS[k]);
    function headPath(o) {   // head centre in the H-point frame (x forward, y up, z right), one point per pose
      const out = [], F = 3 * Occ.PARTICLES.HF, B = 3 * Occ.PARTICLES.HB;
      for (let p = 0; p * o.poseStride < o.pose.length; p++) { const b = p * o.poseStride; out.push([0, 1, 2].map(c => (o.pose[b + F + c] + o.pose[b + B + c]) / 2)); }
      return out;
    }
    return {
      title: 'Occupant restraint lab', runLabel: 'Run the crash at 35 mph',
      intro: 'Every crash is three collisions: the car hits the barrier, the occupant hits the belt, airbag or interior, and the organs hit the inside of the body. Belts and airbags stretch the second one out, lowering the force (J = FΔt).',
      defaults: { restraint: 'full' },
      form() {
        return `<section>${segField('restraint', 'Restraint system', [['none', 'Unbelted'], ['belt', '3-point belt', 'plain'], ['full', 'Belt + limiter', '+ pretensioner, airbags']])}</section>`;
      },
      hints() { return { restraint: { none: 'Nothing holds the occupant: they keep going at 35 mph until the steering wheel, windshield and dash stop them.', belt: 'A plain belt with its slack and no force limit: it stops the torso but loads the chest hard.', full: 'The pretensioner takes out the slack in the first milliseconds; the force limiter lets webbing pay out at 4.5 kN; the airbag catches the head.' }[cfg.restraint] }; },
      readouts() { return [['Crash', '35 mph (56 km/h) into a rigid barrier, full width'], ['Vehicle', `${spec.short}, ${fmt(spec.massKg)} kg`], ['Dummy', '50th-percentile male']]; },
      preview(key) {
        Scene3D.setBarrier('rigid');
        const a = guidedApproach(spec, KMH, spec.massKg, 0, () => {});
        Scene3D.setPath(0, a.app.distance, true);
        Scene3D.setCarRigid(a.app.pose(), 0, 0);
        Scene3D.setDummy(seatedDummy({ belt: OPTS[cfg.restraint].belt }));
        if (!trail) trail = LabScene.trail(Scene3D.main, 0xf0e442);
        trail.hide();
        const p = a.app.pose();
        if (key === undefined) Scene3D.setCameraMode('setup', { frame: { pos: new THREE.Vector3(p.x - 9, 4.5, p.z - 7), target: new THREE.Vector3(p.x + 10, 0.5, 0) } });
      },
      ready() { return !!Scene3D.vehicleModel || spec.key === 'lab'; },
      approach() { return guidedApproach(spec, KMH, spec.massKg, 0, () => beginCompute()); },
      compute() {
        const app = approach.app, s = app.state;
        const sim = Phys.createImpactSim({ vehicle: spec, massKg: spec.massKg, stiffness: 'standard', damage: 'realistic', barrier: 'rigid', pose: app.pose(), speed: s.v, yawRate: s.yawRate });
        Scene3D.setPath(0, app.distance, false);
        const o = Scene3D.cabin.o;
        freeCam({ f0: new THREE.Vector3(1, 0, 0), frame: { pos: o.clone().add(new THREE.Vector3(1.4, 1.1, -3.9)), target: o.clone().add(new THREE.Vector3(0.5, 0.15, 0)) } });
        return simTask(sim, (r) => r);
      },
      results(r) {
        res = r;
        Scene3D.setDestruction(res);
        const cabin = Phys.cabinInput(res, 0);
        runs = {}; for (const k of Object.keys(OPTS)) runs[k] = Occ.simulate(res.pulse, Object.assign({ cabin }, occOpts(k)));
        return this.show();
      },
      show() {
        occ = runs[cfg.restraint]; org = Occ.organs(occ, res.pulse); inj = injurySeries(occ);
        const t0 = res.contact ? res.T0 : 0, qm = occ.metrics, L = Occ.LIMITS;
        clearResults();
        const ph = org.phases;
        const host = document.createElement('div'); host.className = 'res-section';
        host.innerHTML = `<h3>The three collisions</h3><div class="phases" id="phases"></div>`;
        $('#res-body').insertBefore(host, $('#res-tabs'));
        const W = 200, bar = (p, i, label, text) => p.t0 < 0 ? '' : `<div class="phase p${i}"><span class="ph-name">${label}</span><div class="ph-track"><i style="left:${clamp((p.t0 - t0) * 1000 / W * 100, 0, 100)}%;width:${clamp((p.t1 - p.t0) * 1000 / W * 100, 0.8, 100)}%"></i></div><span class="ph-text">${text}</span></div>`;
        $('#phases').innerHTML = bar(ph[0], 1, '1. Vehicle', `crushes against the barrier, ${fmt((ph[0].t1 - ph[0].t0) * 1000)} ms to a stop`) +
          bar(ph[1], 2, '2. Occupant', ph[1].t0 >= 0 ? `meets the ${cfg.restraint === 'none' ? 'wheel, windshield and dash' : cfg.restraint === 'belt' ? 'belt' : 'belt and airbag'} from ${fmt((ph[1].t0 - t0) * 1000)} to ${fmt((ph[1].t1 - t0) * 1000)} ms, peak ${fmt(ph[1].peakF / 1000, 1)} kN` : 'no contact recorded') +
          bar(ph[2], 3, '3. Organs', `brain moves ${fmt(org.brainMaxMm, 1)} mm in the skull, heart ${fmt(org.heartMaxMm)} mm in the chest`) +
          `<div class="ph-axis"><span>0</span><span>50</span><span>100</span><span>150</span><span>200 ms</span></div>`;
        const oc = section(`Occupant: ${OPTS[cfg.restraint].label.toLowerCase()}`);
        metricRow(oc, 'Head injury criterion (HIC15)', qm.hic15, '', L.hic15);
        metricRow(oc, 'Chest compression', qm.chestDeflMm, ' mm', 50, 1, { limitText: 'target under 50 mm' });
        metricRow(oc, 'Chest acceleration, 3 ms', qm.chest3ms, ' g', L.chest3ms, 1);
        const sw = document.createElement('div'); sw.className = 'rerun';
        sw.innerHTML = segField('restraintPb', 'Try another restraint on the same crash', Object.entries(OPTS).map(([k, o]) => [k, o.label]));
        oc.parentNode.appendChild(sw);
        sw.querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.v === cfg.restraint); b.addEventListener('click', () => { cfg.restraint = b.dataset.v; syncForm(); const pb = this.show(); events = pb.events.sort((a, c) => a.t - c.t); resetEventCursor(); applyFrame(play.t); }); });
        // comparison
        const cmp = document.createElement('div'); cmp.className = 'res-section';
        const excursion = (o) => { const p = headPath(o); let mx = 0; for (const q of p) mx = Math.max(mx, q[0] - p[0][0]); return mx * 100; };
        cmp.innerHTML = `<h3>All three on this crash</h3><table class="cmp"><thead><tr><th></th><th>HIC15</th><th>Chest</th><th>Peak load</th><th>Head forward</th></tr></thead><tbody>` +
          Object.entries(runs).map(([k, o]) => { const og = Occ.organs(o, res.pulse); return `<tr class="${k === cfg.restraint ? 'on' : ''}"><td>${OPTS[k].label}</td><td>${fmt(o.metrics.hic15)}</td><td>${fmt(o.metrics.chestDeflMm)} mm</td><td>${fmt(og.phases[1].peakF / 1000, 1)} kN</td><td>${fmt(excursion(o))} cm</td></tr>`; }).join('') + `</tbody></table>
          <p class="muted small">Same crash pulse for all three: only the restraints differ. Peak load is the largest force from the belt, airbag or interior on the dummy.</p>`;
        $('#res-body').insertBefore(cmp, $('#res-tabs'));
        // charts
        const tab = tabs([['path', 'Head path'], ['occupant', 'Occupant'], ['organs', 'Third collision']]);
        const xr = [-20, 220], tms = msAxis(occ.n, occ.dt, t0), S = qm.series;
        const paths = Object.fromEntries(Object.keys(OPTS).map(k => [k, headPath(runs[k])]));
        const order = [cfg.restraint].concat(Object.keys(OPTS).filter(k => k !== cfg.restraint)), cols = { none: COL.red, belt: COL.orange, full: COL.blue };
        const pathChart = lineChart(tab('path'), { title: 'Head path seen from the side, cm (forward →, up ↑)', xLabel: 'cm forward of the seat', xRange: [-10, 110], yRange: [-10, 90], cursor: 'point',
          series: order.map(k => ({ x: Float64Array.from(paths[k], p => p[0] * 100), y: Float64Array.from(paths[k], p => (p[1] - paths[k][0][1]) * 100), color: cols[k], label: OPTS[k].label, width: k === cfg.restraint ? 2.5 : 1, dash: k === cfg.restraint ? null : [4, 3] })) });
        pathChart.cursorIndex = (t) => clamp(Math.round(t / (occ.dt * occ.poseEvery)), 0, paths[cfg.restraint].length - 1);
        lineChart(tab('occupant'), { title: 'Head acceleration, g (CFC 1000)', value: `HIC15 ${fmt(qm.hic15)}`, xRange: xr, shade: [(qm.hicT1 - t0) * 1000, (qm.hicT2 - t0) * 1000],
          series: [{ x: tms, y: S.head.r, color: COL.orange, label: 'resultant', width: 2 }] });
        lineChart(tab('occupant'), { title: 'Chest compression, mm', value: `${fmt(qm.chestDeflMm, 1)} mm`, xRange: xr, limits: [{ y: 50, label: 'target 50 mm' }], series: [{ x: tms, y: Float64Array.from(S.defl, v => v * 1000), color: COL.blue, label: 'sternum to spine', width: 2 }] });
        lineChart(tab('occupant'), { title: 'Restraint and interior forces, kN', xRange: xr, series: [{ x: tms, y: Float64Array.from(occ.beltT, v => v / 1000), color: COL.blue, label: 'shoulder belt' }, { x: tms, y: Float64Array.from(occ.lapT, v => v / 1000), color: COL.green, label: 'lap belt' }, { x: tms, y: Float64Array.from(occ.interiorF, v => v / 1000), color: COL.red, label: 'airbag & interior', width: 2 }] });
        lineChart(tab('organs'), { title: 'Brain movement inside the skull, mm', value: `${fmt(org.brainMaxMm, 1)} mm`, xRange: xr, shade: [(ph[2].t0 - t0) * 1000, (ph[2].t1 - t0) * 1000], series: [{ x: tms, y: Float64Array.from(org.brain.disp, v => v * 1000), color: COL.purple, label: 'brain', width: 2 }] });
        lineChart(tab('organs'), { title: 'Heart and aorta movement in the chest, mm', value: `${fmt(org.heartMaxMm)} mm`, xRange: xr, shade: [(ph[2].t0 - t0) * 1000, (ph[2].t1 - t0) * 1000], series: [{ x: tms, y: Float64Array.from(org.heart.disp, v => v * 1000), color: COL.red, label: 'heart', width: 2 }] });
        note(tab('organs'), 'The organs are modelled as masses on springs inside the head and chest: they keep moving after the body has stopped, then hit the inside of the skull or rib cage. That third collision is why a hard stop can injure the brain or tear the aorta without a mark outside.', 'muted small');
        Scene3D.setHeadStrikes(occ.events.filter(e => e.type === 'headStrike' && e.surface === 'windshield').map(e => ({ t: e.t, mag: e.mag, p: [spec.hPoint[0] + e.hx, spec.hPoint[1] + e.hy, spec.hPoint[2] + e.hz] })));
        this.path = paths[cfg.restraint]; this.t0 = t0;
        return { tStart: Math.max(res.frames.t[0], t0 - 0.02), tEnd: Math.min(res.tEnd, t0 + 0.6), t0, events: crashEvents(res, occ.events) };
      },
      frame(t) {
        showCarFrame(Scene3D.main, res, t);
        const si = clamp(Math.round(t / occ.dt), 0, occ.n - 1);
        Scene3D.setDummy(frontalDummy(occ, t, $('#tg-injury').checked ? { head: inj.head[si], neck: inj.neck[si], chest: inj.chest[si] } : null));
        const pi = clamp(Math.round(t / (occ.dt * occ.poseEvery)), 0, this.path.length - 1);
        trail.set(this.path.slice(Math.max(0, pi - 599), pi + 1));
      },
      live(t) {
        const si = clamp(Math.round(t / occ.dt), 0, occ.n - 1), ph = org.phases;
        const phase = t < ph[0].t0 ? 'before contact' : ph[1].t0 >= 0 && t >= ph[1].t0 && t <= ph[1].t1 ? (t >= ph[2].t0 ? '2nd & 3rd: occupant and organs' : '2nd: occupant meets restraints') : t >= ph[2].t0 && t <= ph[2].t1 ? '3rd: organs' : t <= ph[0].t1 ? '1st: vehicle crushing' : 'after';
        const defl = occ.metrics.series.defl[si] * 1000;
        return [['Time after contact', `${fmt((t - this.t0) * 1000, 1)} ms`], ['Collision', phase], ['HIC so far', fmt(inj.hic[si]), inj.hic[si] > 700 ? 'bad' : ''], ['Chest compression', `${fmt(defl, 1)} mm`, defl > 50 ? 'bad' : ''],
          ['Belt force', `${fmt((occ.beltT[si] + occ.lapT[si]) / 1000, 1)} kN`]];
      },
      reset() { if (trail) trail.hide(); res = null; },
    };
  })();

  // =================================================================== 6. pedestrian and AEB
  LABS.pedestrian = (() => {
    const spec = Veh.get(LEXUS);
    let out = null, ped = null, cone = null, parked = null, plan = null, tImp = Infinity;
    const STATE = ['Scanning', 'Pedestrian in view', 'Tracking', 'Warning', 'Braking', 'Impact'];
    const frontOf = spec.xMin + spec.length;
    function figure() { if (ped) ped.dispose(); ped = LabScene.pedestrian(cfg.target, PED.BODY[cfg.target]); }
    function setParked(on) {
      if (on && !parked) { parked = Scene3D.createSlot(); parked.setVehicle(Veh.specs.mustang ? 'mustang' : 'lab'); }
      if (parked) { parked.setVisible(on); if (on) { parked.setCarRigid({ x: -3.75 - 0.0, z: 2.45, heading: 0 }, 0, 0); parked.setDummy(seatedDummy({ belt: false })); parked.interior.visible = false; } }
    }
    return {
      title: 'Pedestrian & emergency braking lab', runLabel: 'Drive',
      intro: 'A pedestrian steps into the road. With automatic emergency braking the car\'s radar and camera spot them, warn and brake; without it the car arrives at full speed. A softer bumper lowers the blow to the legs.',
      steps: { approach: null, impact: 'Compute' },
      defaults: { mph: 25, target: 'adult', bumper: 'foam', aeb: true },
      form() {
        return `<section>${rangeField('mph', 'Vehicle speed', 12, 37, 1, 'mph')}
          ${segField('target', 'Pedestrian', [['adult', 'Adult', '1.75 m, walking'], ['child', 'Child', '6 years, behind a parked car']])}</section>
          <section>${segField('bumper', 'Bumper', [['steel', 'Rigid steel', 'stiff beam'], ['foam', 'Energy-absorbing', 'foam & composite']])}
          <div class="field"><span class="field-head"><span>Active safety</span></span><div class="toggles">${switchField('aeb', 'Automatic emergency braking')}</div></div></section>`;
      },
      hints() { return { mph: `${fmt(cfg.mph * KPH)} km/h. Stopping from this speed at 0.85 g takes ${fmt((cfg.mph * MPH) ** 2 / (2 * 0.85 * G), 1)} m.`, target: cfg.target === 'child' ? 'The child runs out from in front of a parked car: the sensors can\'t see them until they clear it.' : 'The adult walks in from the kerb, in plain view of the sensors.' }; },
      readouts() { return [['Vehicle', spec.short], ['Sensor', 'radar + camera, ±25°, ' + (cfg.target === 'child' ? '45' : '60') + ' m'], ['Braking', 'warns at 1.8 s, full brake at 1.1 s to impact']]; },
      preview(key) {
        if (key === undefined || key === 'target') figure();
        setParked(cfg.target === 'child');
        plan = PED.plan({ kmh: cfg.mph * KPH, target: cfg.target, aeb: false, width: spec.width, length: spec.length });
        Scene3D.setPath(0, -plan.x0 + 10, true);
        Scene3D.setCarRigid({ x: plan.x0 - frontOf, z: 0, heading: 0 }, 0, 0);
        Scene3D.setDummy(seatedDummy());
        ped.walk(0, PED.BODY[cfg.target].start, 0, false); ped.setBox(false);
        if (!cone) cone = LabScene.sensorCone(PED.SENSOR.fov, 60);
        cone.set(plan.x0, 0, 0, 0, 0); cone.group.visible = cfg.aeb;
        if (key === undefined) Scene3D.setCameraMode('setup', { frame: { pos: new THREE.Vector3(6, 6, 12), target: new THREE.Vector3(-8, 0.5, 0) } });
      },
      ready() { return !!Scene3D.vehicleModel || spec.key === 'lab'; },
      approach() { return null; },
      compute() { return instantTask(() => PED.simulate({ kmh: cfg.mph * KPH, target: cfg.target, aeb: cfg.aeb, bumper: cfg.bumper, vehicle: spec })); },
      results(r) {
        out = r; plan = out.plan;
        tImp = plan.impact ? plan.impact.t : Infinity;
        clearResults();
        const P = plan, im = out.impact;
        const rel = (t) => t >= 0 ? `${fmt(Math.max(0, (P.impact ? P.impact.t : P.tc) - t), 2)} s before ${P.impact ? 'impact' : 'the crossing'}` : 'never';
        const v0 = cfg.mph;
        if (!P.impact) note($('#res-notes'), `Avoided: automatic emergency braking stopped the car ${fmt(P.distLeft, 1)} m short of the ${cfg.target}.`);
        else note($('#res-notes'), cfg.aeb ? (P.impact.v < P.v0 - 0.3 ? `Impact at ${fmt(P.impact.v / MPH, 1)} mph instead of ${v0}: braking took off ${fmt(100 * (1 - (P.impact.v / P.v0) ** 2))}% of the impact energy.` : `The system couldn't react in time: impact at ${fmt(P.impact.v / MPH, 1)} mph.`) : `No emergency braking: impact at the full ${v0} mph.`);
        const ae = section('Emergency braking');
        metricRow(ae, 'Pedestrian first seen', 0, '', null, 0, { extra: rel(P.seen) });
        if (cfg.aeb) {
          metricRow(ae, 'Warning chime', 0, '', null, 0, { extra: rel(P.warn) });
          metricRow(ae, 'Full braking', 0, '', null, 0, { extra: rel(P.brake) });
        }
        metricRow(ae, P.impact ? 'Impact speed' : 'Stopped, distance to spare', P.impact ? P.impact.v / MPH : P.distLeft, P.impact ? ' mph' : ' m', null, 1);
        $$('#res-body .metric .val').forEach(v => { if (v.textContent === '0') v.textContent = ''; });
        const tab = tabs([['speed', 'Speed & braking'], ['pulse', 'Pedestrian pulses']].concat(im ? [] : []));
        const tAx = Float64Array.from(P.t, t => (t - tImp < 1e9 ? t - (P.impact ? P.impact.t : P.tc) : t) * 1000);
        lineChart(tab('speed'), { title: 'Car speed, mph', xLabel: 'ms from impact', xRange: [Math.max(tAx[0], -3500), Math.min(tAx[tAx.length - 1], 800)],
          shade: P.brake >= 0 ? [(P.brake - (P.impact ? P.impact.t : P.tc)) * 1000, Math.min(800, ((P.stopped >= 0 ? P.stopped : P.t[P.t.length - 1]) - (P.impact ? P.impact.t : P.tc)) * 1000)] : null,
          series: [{ x: tAx, y: Float64Array.from(P.carV, v => v / MPH), color: COL.blue, label: 'speed', width: 2 }] });
        if (im) {
          const m = im.metrics, cm = out.compare.impact.metrics, L = PED.LIMITS, other = out.compare.bumper;
          const pc = section('Pedestrian dummy');
          metricRow(pc, 'Head injury criterion (HIC15), on the car', m.hic15, '', L.hic15, 0, { extra: m.hicSurface === 'none' ? 'the head did not touch the car' : `head hit the ${m.hicSurface}` + (m.headImpactSpeed > 0.5 ? ` at ${fmt(m.headImpactSpeed / MPH, 1)} mph` : '') });
          if (m.hicRoad > 1) metricRow(pc, 'Head injury criterion, falling onto the road', m.hicRoad, '', L.hic15, 0);
          metricRow(pc, 'Knee bending', m.kneeDeg, '°', L.kneeDeg, 0);
          metricRow(pc, 'Upper leg (tibia) acceleration', m.tibiaPeakG, ' g', L.tibiaG, 0);
          metricRow(pc, 'Pelvis acceleration', m.pelvisPeakG, ' g', L.pelvisG, 0);
          const ex = section('Impact', 'vehicle');
          if (m.wad) metricRow(ex, 'Head wrap-around distance', m.wad, ' m', null, 2);
          metricRow(ex, 'Thrown', m.throwM, ' m', null, 1);
          metricRow(ex, `With the ${other === 'foam' ? 'energy-absorbing' : 'steel'} bumper`, cm.tibiaPeakG, ' g leg', null, 0, { extra: `HIC ${fmt(cm.hic15)}, knee ${fmt(cm.kneeDeg)}°` });
          const t0 = 0, xr = [-20, 400], tms = msAxis(im.n, im.dt, 0);
          const sel = cfg.bumper === 'foam' ? 'energy-absorbing' : 'steel', oth = other === 'foam' ? 'energy-absorbing' : 'steel';
          lineChart(tab('pulse'), { title: 'Leg (tibia) acceleration, g  (1 g = 9.81 m/s²)', xLabel: 'ms from impact', xRange: [-10, 120], limits: [{ y: L.tibiaG, label: `${L.tibiaG} g` }],
            series: [{ x: tms, y: m.series.knee, color: COL.orange, label: `${sel} bumper`, width: 2 }, { x: msAxis(out.compare.impact.n, out.compare.impact.dt, 0), y: cm.series.knee, color: COL.grey, label: `${oth} bumper`, dash: [4, 3] }] });
          lineChart(tab('pulse'), { title: 'Head acceleration, g  (1 g = 9.81 m/s²)', value: `HIC15 ${fmt(m.hic15)}`, xLabel: 'ms from impact', xRange: xr,
            series: [{ x: tms, y: m.series.head, color: COL.red, label: `${sel} bumper`, width: 2 }, { x: msAxis(out.compare.impact.n, out.compare.impact.dt, 0), y: cm.series.head, color: COL.grey, label: `${oth} bumper`, dash: [4, 3] }] });
          lineChart(tab('pulse'), { title: 'Pelvis acceleration, m/s²', xLabel: 'ms from impact', xRange: xr,
            series: [{ x: tms, y: Float64Array.from(m.series.pelvis, v => v * G), color: COL.blue, label: `${sel} bumper`, width: 2 }, { x: msAxis(out.compare.impact.n, out.compare.impact.dt, 0), y: Float64Array.from(cm.series.pelvis, v => v * G), color: COL.grey, label: `${oth} bumper`, dash: [4, 3] }] });
        } else note(tab('pulse'), 'No impact, so no pulses to compare: the car stopped in time.', 'muted small');
        const evs = [];
        if (P.warn >= 0) evs.push({ t: P.warn, type: 'warn' });
        if (P.brake >= 0) evs.push({ t: P.brake, type: 'brake' });
        if (P.impact) { evs.push({ t: P.impact.t, type: 'thud', mass: 40 }); for (const e of im.events) evs.push(Object.assign({}, e, { t: P.impact.t + e.t })); }
        const tEnd = P.impact ? P.impact.t + 1.5 : P.t[P.t.length - 1];
        const tc = P.impact ? P.impact.t : P.tc;
        // real time until just before impact, then slow motion
        const auto = P.impact ? (t) => (t > tc - 0.12 && t < tc + 0.35 ? 0.06 : t >= tc + 0.35 ? 0.3 : 1) : () => 1;
        this.tc = tc;
        // the free camera rides beside the car on its left, a little raised, with the crossing ahead in view
        Scene3D.setCarRigid({ x: P.carX[0] - frontOf, z: 0, heading: 0 }, 0, 0);
        const o = Scene3D.cabin.o;
        freeCam({ f0: new THREE.Vector3(1, 0, 0), frame: { pos: o.clone().add(new THREE.Vector3(1.0, 2.3, -8.0)), target: o.clone().add(new THREE.Vector3(1.3, 0.7, 0.4)) } });
        return { tStart: 0, tEnd, t0: tc, events: evs, auto };
      },
      frame(t) {
        const P = plan, k = clamp(Math.round(t / P.dt), 0, P.t.length - 1);
        const im = out.impact, after = P.impact && t >= P.impact.t;
        let carX = P.carX[k];
        if (after) { const j = clamp(Math.round((t - P.impact.t) / im.dt), 0, im.n - 1); carX = im.carX[j]; }
        const prevX = this._x === undefined ? carX : this._x; this._x = carX;
        Scene3D.setCarRigid({ x: carX - frontOf, z: 0, heading: 0 }, 0, (carX - prevX) / spec.wheelRadius);
        Scene3D.setDummy(seatedDummy());
        cone.group.visible = cfg.aeb;
        cone.set(carX, 0, 0, after ? 5 : P.state[k], 0.016);
        if (!after) {
          const z = P.pedZ[k], B = PED.BODY[cfg.target];
          ped.walk(0, z, (B.start - z) / 0.32, true);
          ped.setBox(cfg.aeb && P.visible[k] === 1);
        } else {
          const pi = clamp(Math.round((t - P.impact.t) / (im.dt * im.poseEvery)), 0, Math.floor(im.n / im.poseEvery) - 1), o = pi * (2 * 6 + 1);
          const px = [], py = [];
          for (let i = 0; i < 6; i++) { px.push(im.pose[o + 2 * i]); py.push(im.pose[o + 2 * i + 1]); }
          ped.chain(px, py, P.impact.z); ped.setBox(false);
        }
      },
      live(t) {
        const P = plan, k = clamp(Math.round(t / P.dt), 0, P.t.length - 1), v = P.carV[k], after = P.impact && t >= P.impact.t;
        const gap = Math.max(0, 0 - P.carX[k] - PED.BODY[cfg.target].r[3]);
        const ttc = v > 0.2 ? gap / v : Infinity;
        return [['Car speed', `${fmt(v / MPH, 1)} mph`], ['To the pedestrian\'s path', after ? 'impact' : `${fmt(gap, 1)} m`], ['Time to collision', after ? '–' : ttc < 9 ? `${fmt(ttc, 2)} s` : '–'],
          ['Sensors', cfg.aeb ? (after ? 'Impact' : STATE[P.state[k]]) : 'AEB off', P.state[k] >= 4 ? 'bad' : P.state[k] === 3 ? 'warn' : '']];
      },
      reset() { this._x = undefined; },
    };
  })();

  // ---------------------------------------------------------------- loop
  if (!buildPage()) { Scene3D.render(0, false, 0); return; }
  setState('setup');
  preview();
  // the lab's main car (imported model) loads in the background
  (async () => {
    const want = lab === LABS.multi ? null : LEXUS;
    if (!want || lab === LABS.whiplash) return;
    $('#btn-run').disabled = true;
    try { await Scene3D.setVehicle(want); } catch (e) { console.error(e); toast('Could not load the car model: ' + e.message); }
    $('#btn-run').disabled = false;
    if (state === 'setup') preview();
  })();
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (VideoExport.busy) { requestAnimationFrame(frame); return; }   // the exporter steps and draws
    try {
      if (state === 'approach' && approach) { const r = approach.step(dt); if (r === 'abort') approach = null; }
      else if (state === 'impact' && task) {
        const p = task.advance(12);
        $('#comp-bar').style.width = `${(p * 100).toFixed(0)}%`;
        $('#comp-text').textContent = `${(p * 100).toFixed(0)}%  ·  ${task.progressText()}`;
        if (task.live && lab.liveImpact) lab.liveImpact(task.live);
        if (task.done) finishCompute();
      } else if (state === 'playback' && play) updatePlayback(dt);
    } catch (err) { console.error(err); toast('Error: ' + err.message); toSetup(); }
    const bottom = state === 'playback' ? $('#timeline').offsetHeight + 12 : 0;
    const pip = state === 'playback' && hasPip();
    Scene3D.render(dt, pip, bottom);
    const pr = Scene3D.pipRect, lbl = $('#pip-label');
    lbl.hidden = !pr;
    if (pr) { lbl.style.left = pr.left + 'px'; lbl.style.top = (pr.top - 20) + 'px'; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.CrashLabs = { get state() { return state; }, get cfg() { return cfg; }, get play() { return play; }, LABS, scrubTo, setCfg(c) { Object.assign(cfg, c); syncForm(); preview(); },
    ready() { return state === 'setup' && !$('#btn-run').disabled && (!lab.ready || lab.ready()); } };
})();
