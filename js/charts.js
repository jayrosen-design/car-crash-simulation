/* Small canvas charts for telemetry: line charts with limit lines and a scrub cursor, and a
 * stacked-area chart for the energy breakdown. Static content is drawn once to an offscreen
 * canvas; moving the cursor only blits and overlays. */
const Charts = (() => {
  'use strict';
  const PAD = { l: 42, r: 10, t: 8, b: 20 };
  const AXIS = '#3a434f', GRID = '#222a33', TEXT = '#98a2ae';

  function niceTicks(lo, hi, n) {
    const span = hi - lo || 1, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => span / s <= n) || mag * 10;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function fmt(v) { const a = Math.abs(v); return a < 1e-9 ? '0' : a >= 10 ? v.toFixed(0) : a >= 1 ? v.toFixed(1) : v.toFixed(2); }

  class Base {
    constructor(container, opts) {
      this.opts = opts;
      this.el = document.createElement('div');
      this.el.className = 'chart';
      this.titleEl = document.createElement('div');
      this.titleEl.className = 'chart-title';
      this.canvas = document.createElement('canvas');
      this.legendEl = document.createElement('div');
      this.legendEl.className = 'chart-legend';
      this.el.append(this.titleEl, this.canvas, this.legendEl);
      container.appendChild(this.el);
      this.off = document.createElement('canvas');
      this.cursor = null;
      this.setTitle(opts.title, opts.value);
      const scrub = (e) => {
        if (!this.opts.onScrub) return;
        const r = this.canvas.getBoundingClientRect();
        this.opts.onScrub(this.xFromPx(e.clientX - r.left));
      };
      let down = false;
      this.canvas.addEventListener('pointerdown', (e) => { down = true; this.canvas.setPointerCapture(e.pointerId); scrub(e); });
      this.canvas.addEventListener('pointermove', (e) => { if (down) scrub(e); });
      this.canvas.addEventListener('pointerup', () => { down = false; });
      this.ro = new ResizeObserver(() => this.render());
      this.ro.observe(this.canvas);
    }
    setTitle(title, value) {
      this.titleEl.innerHTML = '';
      const a = document.createElement('span'); a.textContent = title;
      this.titleEl.appendChild(a);
      if (value) { const b = document.createElement('b'); b.textContent = value; this.titleEl.appendChild(b); }
    }
    size() {
      const dpr = window.devicePixelRatio || 1, w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      if (!w || !h) return null;
      for (const c of [this.canvas, this.off]) { if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); } }
      return { w, h, dpr };
    }
    xToPx(x) { const [a, b] = this.xr; return PAD.l + (x - a) / (b - a) * (this.w - PAD.l - PAD.r); }
    yToPx(y) { const [a, b] = this.yr; return this.h - PAD.b - (y - a) / (b - a) * (this.h - PAD.t - PAD.b); }
    xFromPx(px) { const [a, b] = this.xr; return a + (px - PAD.l) / (this.w - PAD.l - PAD.r) * (b - a); }
    axes(ctx) {
      ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = TEXT; ctx.lineWidth = 1;
      for (const y of niceTicks(this.yr[0], this.yr[1], 4)) {
        const py = Math.round(this.yToPx(y)) + 0.5;
        ctx.strokeStyle = y === 0 ? AXIS : GRID; ctx.beginPath(); ctx.moveTo(PAD.l, py); ctx.lineTo(this.w - PAD.r, py); ctx.stroke();
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(fmt(y), PAD.l - 4, py);
      }
      for (const x of niceTicks(this.xr[0], this.xr[1], 6)) {
        const px = Math.round(this.xToPx(x)) + 0.5;
        ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(px, PAD.t); ctx.lineTo(px, this.h - PAD.b); ctx.stroke();
        ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(fmt(x), px, this.h - PAD.b + 3);
      }
      if (this.opts.xLabel) { ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(this.opts.xLabel, this.w - PAD.r, this.h - PAD.b - 2); }
      if (this.opts.yLabel) { ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(this.opts.yLabel, PAD.l + 4, PAD.t); }
    }
    render() {
      const s = this.size(); if (!s) return;
      this.w = s.w; this.h = s.h;
      const ctx = this.off.getContext('2d');
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      ctx.clearRect(0, 0, s.w, s.h);
      this.drawStatic(ctx);
      this.drawCursor();
    }
    setCursor(x) { this.cursor = x; this.drawCursor(); }
    drawCursor() {
      if (!this.w) return;
      const ctx = this.canvas.getContext('2d'), dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.off, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.drawOverlay(ctx);
    }
    destroy() { this.ro.disconnect(); this.el.remove(); }
  }

  /* opts: { title, value, series: [{ x, y, color, label, width, dash }], xRange, yRange,
   *         limits: [{ y, label }], shade: [x0, x1], xLabel, yLabel, cursor: 'x' | 'point', onScrub } */
  class LineChart extends Base {
    constructor(container, opts) {
      super(container, opts);
      this.legendEl.innerHTML = '';
      for (const s of opts.series) {
        if (!s.label) continue;
        const sp = document.createElement('span'); sp.style.setProperty('--c', s.color); sp.textContent = s.label;
        this.legendEl.appendChild(sp);
      }
      this.xr = opts.xRange;
      if (opts.yRange) this.yr = opts.yRange;
      else {
        let lo = Infinity, hi = -Infinity;
        for (const s of opts.series) for (let i = 0; i < s.x.length; i++) {
          if (s.x[i] < this.xr[0] || s.x[i] > this.xr[1]) continue;
          lo = Math.min(lo, s.y[i]); hi = Math.max(hi, s.y[i]);
        }
        for (const l of opts.limits || []) { lo = Math.min(lo, l.y); hi = Math.max(hi, l.y); }
        if (!isFinite(lo)) { lo = 0; hi = 1; }
        lo = Math.min(0, lo); const pad = (hi - lo) * 0.08 || 1;
        this.yr = [lo < 0 ? lo - pad : 0, hi + pad];
      }
      this.render();
    }
    drawStatic(ctx) {
      const o = this.opts;
      if (o.shade) {
        ctx.fillStyle = 'rgba(230,159,0,0.14)';
        const a = this.xToPx(o.shade[0]), b = this.xToPx(o.shade[1]);
        ctx.fillRect(a, PAD.t, Math.max(1, b - a), this.h - PAD.t - PAD.b);
      }
      this.axes(ctx);
      ctx.save();
      ctx.beginPath(); ctx.rect(PAD.l, PAD.t, this.w - PAD.l - PAD.r, this.h - PAD.t - PAD.b); ctx.clip();
      for (const l of o.limits || []) {
        const py = this.yToPx(l.y);
        ctx.strokeStyle = '#d55e00'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(PAD.l, py); ctx.lineTo(this.w - PAD.r, py); ctx.stroke();
        ctx.setLineDash([]);
        if (l.label) { ctx.fillStyle = '#e8a37a'; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(l.label, this.w - PAD.r - 2, py - 2); }
      }
      for (const s of o.series) {
        ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.5; ctx.setLineDash(s.dash || []);
        ctx.beginPath();
        let started = false;
        const step = Math.max(1, Math.floor(s.x.length / (this.w * 3)));
        for (let i = 0; i < s.x.length; i += step) {
          const x = s.x[i];
          if (x < this.xr[0] - 1e-9 || x > this.xr[1] + 1e-9) { started = false; continue; }
          const px = this.xToPx(x), py = this.yToPx(s.y[i]);
          if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        }
        ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.restore();
    }
    drawOverlay(ctx) {
      if (this.cursor == null) return;
      const o = this.opts;
      if (o.cursor === 'point') {
        const s = o.series[0], i = this.cursor;
        if (i < 0 || i >= s.x.length) return;
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(this.xToPx(s.x[i]), this.yToPx(s.y[i]), 3.5, 0, Math.PI * 2); ctx.fill();
        return;
      }
      if (this.cursor < this.xr[0] || this.cursor > this.xr[1]) return;
      const px = Math.round(this.xToPx(this.cursor)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, PAD.t); ctx.lineTo(px, this.h - PAD.b); ctx.stroke();
    }
  }

  /* Stacked areas. opts: { title, value, x, channels: [{ y, color, label }], xRange, xLabel, unit, onScrub } */
  class StackChart extends Base {
    constructor(container, opts) {
      super(container, opts);
      this.xr = opts.xRange;
      let hi = 0;
      for (let i = 0; i < opts.x.length; i++) {
        let s = 0; for (const c of opts.channels) s += Math.max(0, c.y[i]);
        hi = Math.max(hi, s);
      }
      this.yr = [0, hi * 1.05 || 1];
      this.legendItems = opts.channels.map(c => {
        const sp = document.createElement('span'); sp.style.setProperty('--c', c.color);
        this.legendEl.appendChild(sp);
        return sp;
      });
      this.updateLegend(opts.x.length - 1);
      this.render();
    }
    drawStatic(ctx) {
      this.axes(ctx);
      const { x, channels } = this.opts, n = x.length, base = new Float64Array(n);
      for (const c of channels) {
        ctx.fillStyle = c.color; ctx.globalAlpha = 0.85;
        ctx.beginPath();
        for (let i = 0; i < n; i++) ctx.lineTo(this.xToPx(x[i]), this.yToPx(base[i] + Math.max(0, c.y[i])));
        for (let i = n - 1; i >= 0; i--) ctx.lineTo(this.xToPx(x[i]), this.yToPx(base[i]));
        ctx.closePath(); ctx.fill();
        for (let i = 0; i < n; i++) base[i] += Math.max(0, c.y[i]);
      }
      ctx.globalAlpha = 1;
    }
    indexAt(xv) {
      const x = this.opts.x; let lo = 0, hi = x.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (x[m] <= xv) lo = m; else hi = m - 1; }
      return lo;
    }
    updateLegend(i) {
      const u = this.opts.unit || '';
      this.opts.channels.forEach((c, k) => { this.legendItems[k].textContent = `${c.label} ${c.y[i].toFixed(1)}${u}`; });
    }
    setCursor(x) { super.setCursor(x); this.updateLegend(this.indexAt(x)); }
    drawOverlay(ctx) {
      if (this.cursor == null || this.cursor < this.xr[0] || this.cursor > this.xr[1]) return;
      const px = Math.round(this.xToPx(this.cursor)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.beginPath(); ctx.moveTo(px, PAD.t); ctx.lineTo(px, this.h - PAD.b); ctx.stroke();
    }
  }

  return { LineChart, StackChart };
})();
