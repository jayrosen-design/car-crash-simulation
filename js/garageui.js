/* The garage screen's pieces, shared by the Race and Destruction select screens, in the style of the
 * garage design video: a lineup of every vehicle as a side silhouette, all to one scale over a metre
 * ruler, and the chosen one's spec card (big name, class line, orange figures, the violet rule).
 *
 * lineup(el, items, onPick) draws the strip into el (items: [{ key, name, paint (hex), phys }], phys
 * the model's data: CAR_PHYS or RIG_PHYS, for the profile and wheels) -> { select(key) }.
 * card(el, entry, perf) fills a spec card from a garage entry (js/garage.js) and, for the top speed
 * the design doesn't give, the measured figures.
 *
 * Uses the DOM only (no three.js).
 */
const GarageUI = (() => {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const hex = (h) => '#' + h.toString(16).padStart(6, '0');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // a side silhouette in metres (x from the rear, y up): the profile's top and bottom, and the wheels
  function shape(phys) {
    const top = phys.profileTop, bot = phys.profileBottom || top.map(([u]) => [u, 0.1]);
    const pts = top.concat(bot.slice().reverse()).map(([u, y]) => `${u.toFixed(3)},${(-y).toFixed(3)}`).join(' ');
    const wheels = [];
    if (phys.tireRadius) for (const k of ['RL', 'FL']) wheels.push([phys.hubs[k][0] - phys.xMin, phys.hubs[k][1], phys.tireRadius, phys.rimRadius]);
    else for (const p of (phys.parts || []).filter(q => q.name.startsWith('WHEEL_') && q.pivot[2] <= 0)) {
      const r = (p.hi[1] - p.lo[1]) / 2;
      wheels.push([p.pivot[0] - phys.xMin, p.pivot[1], r, r * 0.58]);
    }
    return { pts, wheels, L: phys.length, H: Math.max(...top.map(q => q[1])) };
  }

  function lineup(el, items, onPick) {
    const GAP = 0.7, shapes = items.map(it => shape(it.phys));
    const total = shapes.reduce((s, q) => s + q.L, 0) + GAP * (items.length + 1), Hm = 2.6;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 ${-Hm} ${total} ${Hm + 0.75}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMax meet');
    svg.setAttribute('class', 'lineup-svg');
    let x = GAP, out = '';
    const at = {};
    items.forEach((it, i) => {
      const s = shapes[i];
      at[it.key] = { x, L: s.L };
      out += `<g class="lineup-car" data-car="${it.key}" role="radio" aria-label="${esc(it.name)}" tabindex="-1" transform="translate(${x.toFixed(3)},0)">` +
        `<title>${esc(it.name)}</title><rect class="hit" x="-0.3" y="${-Hm}" width="${(s.L + 0.6).toFixed(3)}" height="${Hm + 0.1}"/>` +
        `<polygon points="${s.pts}" fill="${hex(it.paint)}"/>` +
        s.wheels.map(([u, y, r, rr]) => `<circle cx="${u.toFixed(3)}" cy="${(-y).toFixed(3)}" r="${r.toFixed(3)}" class="tyre"/><circle cx="${u.toFixed(3)}" cy="${(-y).toFixed(3)}" r="${rr.toFixed(3)}" class="rim"/>`).join('') +
        `</g>`;
      x += s.L + GAP;
    });
    // the ground and a ruler every metre, numbered every five
    out += `<line class="ground" x1="0" y1="0" x2="${total.toFixed(3)}" y2="0"/>`;
    for (let m = 0; m <= Math.floor(total); m++) out += `<line class="tick${m % 5 ? '' : ' major'}" x1="${m}" y1="0" x2="${m}" y2="${m % 5 ? 0.12 : 0.24}"/>` + (m % 5 ? '' : `<text x="${m + 0.08}" y="0.62">${m === 0 ? '0 m' : m}</text>`);
    out += `<rect class="pick" x="0" y="0.05" width="1" height="0.08"/>`;
    svg.innerHTML = out;
    el.innerHTML = '';
    el.appendChild(svg);
    svg.querySelectorAll('.lineup-car').forEach(g => g.addEventListener('click', () => onPick(g.dataset.car)));
    const pick = svg.querySelector('.pick');
    return {
      select(key) {
        svg.querySelectorAll('.lineup-car').forEach(g => g.setAttribute('aria-checked', String(g.dataset.car === key)));
        const a = at[key];
        if (a) { pick.setAttribute('x', a.x.toFixed(3)); pick.setAttribute('width', a.L.toFixed(3)); }
      },
    };
  }

  // the spec card's lines, as the video wrote them
  function card(el, v, perf) {
    const n = (x) => Math.round(x).toLocaleString('en-US'), f2 = (x) => x.toFixed(2);
    const mass = v.type === 'car' ? v.lattice.massKg : v.rig.massKg;
    const dims = v.type === 'hover' ? `${f2(v.size[1])} m span · ${f2(v.size[2])} m tall` : `${f2(v.size[0])} × ${f2(v.size[1])} × ${f2(v.size[2])} m`;
    const top = v.targets && v.targets.top || (perf ? Math.round(perf.top) : 0);
    const modes = [v.race && v.race !== 'unranked' ? 'race' : null, v.destruction ? 'destruction' : null, v.race === 'unranked' ? 'race unranked' : null].filter(Boolean).join(' · ');
    const paint = v.paint ? v.paint.name : 'eight finishes';
    // (the video's high-speed camera tag: a frame time from the vehicle's name, so it stays put)
    let h = 0; for (const c of v.key) h = (h * 31 + c.charCodeAt(0)) % 997;
    el.innerHTML = `<h3 class="card-name">${esc(v.name)}</h3><p class="card-line">${esc(v.line)}</p>` +
      `<p class="card-mono">mass ${n(mass)} kg · ${dims}</p>` +
      `<p class="card-mono">target ${top} km/h · ${esc(v.note || v.kind.toLowerCase())}</p>` +
      `<p class="card-mono">${modes} · paint: ${esc(paint)}</p>` +
      `<p class="card-cam"><i></i>high-speed cam · 1/40× · t = ${(0.04 + h / 997 * 0.02).toFixed(4)} s</p>`;
  }

  return { lineup, card };
})();
