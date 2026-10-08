/* Builds the website's two reading pages from README.md, so the site and the README say the same
 * thing:
 *   physics.html   how the physics works, the dummies and injury criteria, the crash labs and their
 *                  diagrams, rendering, every equation, verification, design decisions, limitations
 *   sources.html   the numbered references and the credits
 *   node tools/build-site.js
 * The pages share css/site.css with home.html. Equations are drawn by KaTeX and the diagrams by
 * Mermaid, both from jsDelivr; without a connection the equations show as TeX. Edit README.md (or
 * the page frame below) and rebuild; don't edit the output. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const REPO = 'https://github.com/jayrosen-design/car-crash-simulation';
const KATEX = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist';
const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';

// the README's chapters that each page carries, in order
const PHYSICS = ['How the physics works', 'Occupant and injury models', 'How each crash lab works', 'Simulation diagrams',
  'Rendering the damage', 'Equations and sources', 'Verification', 'Design decisions', 'Limitations'];
const SOURCES = ['References', 'Credits'];

// ---------------------------------------------------------------- the README, by chapter
const chapters = new Map();
{
  let title = null, lines = [];
  for (const line of README.split('\n')) {
    const m = line.match(/^## (.+)$/);
    if (m) { if (title) chapters.set(title, lines); title = m[1].trim(); lines = []; } else if (title) lines.push(line);
  }
  chapters.set(title, lines);
}
for (const t of [...PHYSICS, ...SOURCES]) if (!chapters.has(t)) throw new Error(`README.md has no chapter "${t}"`);

// GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens
const slug = (text) => text.replace(/[`*]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
const idsOf = (titles) => {
  const ids = new Set();
  for (const t of titles) {
    ids.add(slug(t));
    for (const l of chapters.get(t)) { const m = l.match(/^#{3,4} (.+)$/); if (m) ids.add(slug(m[1])); }
  }
  return ids;
};
const PAGE_IDS = { 'physics.html': idsOf(PHYSICS), 'sources.html': idsOf(SOURCES) };
for (const l of chapters.get('References')) { const m = l.match(/<a id="(ref-\d+)"><\/a>/); if (m) PAGE_IDS['sources.html'].add(m[1]); }

// ---------------------------------------------------------------- markdown (the README's subset)
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s) => esc(s).replace(/"/g, '&quot;');
let page = null;   // the page being built: README links are pointed at the right page

function href(url) {
  if (!url.startsWith('#')) return url;
  const id = url.slice(1);
  if (PAGE_IDS[page].has(id)) return url;
  for (const [file, ids] of Object.entries(PAGE_IDS)) if (ids.has(id)) return file + url;
  return REPO + url;   // a part of the README the site doesn't carry
}

function inline(s) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
  s = s.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_, pre, t) => pre + hold(`<span class="tex" data-tex="${attr(t)}">${esc(t)}</span>`));
  s = s.replace(/<a id="[^"]*"><\/a>/g, '');
  s = s.replace(/\\([[\]*_|\\`$])/g, (_, c) => hold(esc(c)));
  // links; a URL may hold balanced parentheses, as some DOIs do
  s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_, t, u) => hold(`<a href="${attr(href(u))}">`) + t + hold('</a>'));
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\s][^*]*?)\*/g, '<em>$1</em>');
  while (/\u0000\d+\u0000/.test(s)) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[+i]);
  // citations: [12, 14] made of reference links
  return s.replace(/\[((?:<a href="sources\.html#ref-\d+">\d+<\/a>(?:, )?)+)\]/g, '<span class="cite">[$1]</span>');
}

const indent = (l) => l.length - l.trimStart().length;
const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

function blocks(lines, toc) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^(\s*)```(\w*)\s*$/))) {
      const ind = m[1].length, lang = m[2], body = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i].slice(Math.min(ind, indent(lines[i]))));
      i++;
      const text = body.join('\n');
      if (lang === 'math') out.push(`<div class="math" data-tex="${attr(text)}">${esc(text)}</div>`);
      else if (lang === 'mermaid') out.push(`<pre class="mermaid">${esc(text)}</pre>`);
      else out.push(`<pre><code>${esc(text)}</code></pre>`);
      continue;
    }
    if ((m = line.match(/^(#{3,4}) (.+)$/))) {
      const level = m[1].length, id = slug(m[2]);
      if (toc && level === 3) toc.push({ level, id, text: m[2].replace(/[`*]/g, '') });
      out.push(`<h${level} id="${id}">${inline(m[2])}</h${level}>`);
      i++; continue;
    }
    if (/^---+\s*$/.test(line)) { i++; continue; }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      out.push(table(rows));
      continue;
    }
    if (LIST.test(line)) { const r = list(lines, i, toc); out.push(r.html); i = r.end; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{3,4} /.test(lines[i]) && !/^\s*\|/.test(lines[i]) && !LIST.test(lines[i])) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

function list(lines, start, toc) {
  const first = lines[start].match(LIST), ind = first[1].length, ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(LIST);
    if (!m || m[1].length !== ind || /\d/.test(m[2]) !== ordered) break;
    const at = lines[i].length - m[3].length, body = [m[3]];
    for (i++; i < lines.length; ) {
      if (!lines[i].trim()) {
        let j = i; while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && indent(lines[j]) > ind) { while (i < j) { body.push(''); i++; } continue; }
        break;
      }
      if (indent(lines[i]) > ind) { body.push(lines[i].slice(Math.min(at, indent(lines[i])))); i++; continue; }
      break;
    }
    items.push(body);
  }
  const lis = items.map((b) => {
    let html = blocks(b, null);
    if (!b.some((l) => !l.trim())) html = html.replace(/^<p>([\s\S]*?)<\/p>/, '$1');   // a tight item
    return `<li>${html}</li>`;
  });
  const tag = ordered ? 'ol' : 'ul', startNo = ordered ? parseInt(first[2], 10) : 1;
  return { html: `<${tag}${ordered && startNo !== 1 ? ` start="${startNo}"` : ''}>\n${lis.join('\n')}\n</${tag}>`, end: i };
}

function table(rows) {
  const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
  return `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>\n${body.join('\n')}\n</tbody></table></div>`;
}

// ---------------------------------------------------------------- the page frame
const FONTS = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,700;0,800;1,700;1,800;1,900&family=Barlow:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600;700&display=swap';
function frame({ file, title, description, head = '', hero, main, tail = '' }) {
  const nav = [['home.html#simulations', 'Simulations'], ['home.html#games', 'Race'], ['physics.html', 'Physics'], ['sources.html', 'Sources']]
    .map(([h, t]) => `<a href="${h}"${h === file ? ' aria-current="page"' : ''}>${t}</a>`).join('\n      ');
  return `<!doctype html>
<!-- Generated by tools/build-site.js from README.md. Edit that and rebuild. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Car Crash Simulation</title>
<meta name="description" content="${attr(description)}">
<meta name="theme-color" content="#06070a">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="css/site.css">
${head}</head>
<body>

<header class="top">
  <div class="wrap">
    <a class="logo" href="home.html"><i class="target"></i>Car Crash <b>Simulation</b></a>
    <nav class="nav" aria-label="Site">
      ${nav}
    </nav>
    <a class="btn primary small" href="Simulator.html">Play now</a>
  </div>
</header>

<main>
${hero}
${main}
</main>

<footer class="foot">
  <div class="wrap">
    <div class="row">
      <a class="logo" href="home.html"><i class="target"></i>Car Crash <b>Simulation</b></a>
      <nav aria-label="Footer">
        <a href="home.html#simulations">Simulations</a>
        <a href="home.html#games">Race</a>
        <a href="physics.html">Physics</a>
        <a href="sources.html">Sources</a>
        <a href="Simulator.html">Simulator</a>
      </nav>
    </div>
    <p class="indie">Car Crash Simulation · an independent project. This page is built from the project's <a href="${REPO}#readme">README</a>.</p>
  </div>
</footer>
${tail}</body>
</html>
`;
}

// ---------------------------------------------------------------- physics.html
function physicsPage() {
  page = 'physics.html';
  const toc = [], parts = [];
  PHYSICS.forEach((title, n) => {
    const id = slug(title), lines = chapters.get(title);
    toc.push({ level: 2, id, text: title });
    let body;
    if (title === 'Simulation diagrams') {
      // one fold-out per simulation; Mermaid draws a diagram when its fold-out opens
      const intro = [], subs = [];
      for (const l of lines) { const m = l.match(/^### (.+)$/); if (m) subs.push({ title: m[1], lines: [] }); else (subs.length ? subs[subs.length - 1].lines : intro).push(l); }
      body = blocks(intro, null) + subs.map((s) => `\n<details class="diagram" id="${slug(s.title)}"><summary>${inline(s.title)}</summary><div class="in">\n${blocks(s.lines, null)}\n</div></details>`).join('');
    } else body = blocks(lines, toc);
    parts.push(`<h2 id="${id}" data-no="Chapter ${String(n + 1).padStart(2, '0')}">${inline(title)}</h2>\n${body}`);
  });
  const tocHtml = toc.map((t) => `<li><a class="${t.level === 2 ? 'h2' : 'h3'}" href="#${t.id}">${esc(t.text)}</a></li>`).join('\n      ');
  const hero = `<section class="page-hero">
  <img src="media/lab-restraint.jpg" alt="">
  <div class="wrap">
    <p class="kicker"><span class="dot"></span>Under the hood</p>
    <h1>The <span class="hz-text">physics</span></h1>
    <p class="lead">The crash is a physics computation, not a canned animation. This is how it works, written out as the code computes it: the car's lattice and its solver, the crash-test dummies and their injury criteria, the eight test set-ups, the rendering, and every equation with its source.</p>
    <ol class="steps">
      <li><h3>Set up</h3><p>Choose the car, speed, angle, barrier, damage level and restraints. Drag the handle in the 3D view to aim the approach.</p></li>
      <li><h3>Approach</h3><p>An automated driver, with cruise control and steering, brings the car up to speed and holds it on its line. An emergency stop brakes the car, or cancels the run while the impact is computed.</p></li>
      <li><h3>Impact</h3><p>The crash is computed in 0.1-millisecond steps, fine enough to resolve a crash pulse that lasts about a tenth of a second. It takes one to a few seconds.</p></li>
      <li><h3>Replay</h3><p>Watch in slow motion, scrub frame by frame, switch cameras and read the results. You can also re-run the dummy with or without its belt and airbag.</p></li>
    </ol>
  </div>
</section>`;
  const main = `<div class="wrap docs">
  <nav class="toc" aria-label="On this page">
    <p>On this page</p>
    <ol>
      ${tocHtml}
    </ol>
  </nav>
  <article class="doc">
<div class="note"><strong>About the numbers</strong> Car Crash Simulation is an independent project for demonstration and teaching. Its physics follows real crash-test practice, but it hasn't been validated against physical crash tests. Use it to compare settings and see trends, not to predict real-world injuries.</div>
${parts.join('\n')}
  </article>
</div>`;
  const tail = `<script defer src="${KATEX}/katex.min.js"></script>
<script>
  // equations: KaTeX draws each one (until it loads, or without a connection, the TeX shows)
  window.addEventListener('load', function () {
    if (!window.katex) return;
    document.querySelectorAll('.math, .tex').forEach(function (el) {
      try { katex.render(el.dataset.tex, el, { displayMode: el.classList.contains('math'), throwOnError: false }); el.classList.add('done'); } catch (e) { /* the TeX stays */ }
    });
  });
  // the contents follow the reading position
  (function () {
    var links = {}; document.querySelectorAll('.toc a').forEach(function (a) { links[a.getAttribute('href').slice(1)] = a; });
    var heads = Object.keys(links).map(function (id) { return document.getElementById(id); }).filter(Boolean);
    function mark() {
      var cur = heads[0];
      for (var i = 0; i < heads.length; i++) if (heads[i].getBoundingClientRect().top < 140) cur = heads[i];
      for (var id in links) links[id].classList.toggle('on', cur && id === cur.id);
    }
    window.addEventListener('scroll', mark, { passive: true }); mark();
  })();
</script>
<script type="module">
  // diagrams: drawn by Mermaid when their fold-out first opens
  let mermaid = null;
  async function draw(d) {
    const nodes = [...d.querySelectorAll('pre.mermaid:not([data-processed])')];
    if (!nodes.length) return;
    try {
      if (!mermaid) { mermaid = (await import('${MERMAID}')).default; mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict', fontFamily: 'Barlow, sans-serif' }); }
      await mermaid.run({ nodes });
    } catch (e) { console.warn('diagram', e); }
  }
  document.querySelectorAll('details.diagram').forEach((d) => d.addEventListener('toggle', () => { if (d.open) draw(d); }));
  const hash = decodeURIComponent(location.hash.slice(1)), target = hash && document.getElementById(hash);
  if (target && target.matches('details.diagram')) { target.open = true; draw(target); }
</script>
`;
  return frame({ file: 'physics.html', title: 'The physics', head: `<link rel="stylesheet" href="${KATEX}/katex.min.css">\n`,
    description: 'How Car Crash Simulation works: the vehicle lattice and its XPBD solver, contacts, destruction, the GPU solver, crash-test dummies and injury criteria, and every equation with its source.',
    hero, main, tail });
}

// ---------------------------------------------------------------- sources.html
function sourcesPage() {
  page = 'sources.html';
  const lines = chapters.get('References'), intro = [], groups = [];
  for (const l of lines) {
    const g = l.match(/^\*\*(.+)\*\*\s*$/), item = l.match(/^(\d+)\. <a id="(ref-\d+)"><\/a>(.*)$/);
    if (g) groups.push({ title: g[1], items: [] });
    else if (item) { if (!groups.length) throw new Error('a reference before the first group'); groups[groups.length - 1].items.push({ n: +item[1], id: item[2], text: item[3] }); }
    else if (l.trim() && l.trim() !== '---') { if (groups.length) throw new Error('unexpected line among the references: ' + l); intro.push(l); }
  }
  const count = groups.reduce((a, g) => a + g.items.length, 0);
  const refs = groups.map((g) => `<section class="refgroup">
  <h2 id="${slug(g.title)}">${inline(g.title)}</h2>
  <ol start="${g.items[0].n}">
${g.items.map((it) => `    <li id="${it.id}" value="${it.n}">${inline(it.text)}</li>`).join('\n')}
  </ol>
</section>`).join('\n');
  const hero = `<section class="page-hero">
  <img src="media/shot-rigid.jpg" alt="">
  <div class="wrap">
    <p class="kicker"><span class="dot"></span>Science and sources</p>
    <h1>The <span class="hz-text">sources</span></h1>
    <p class="lead">The physics, injury criteria and test set-ups follow published research, standards and crash-test protocols: ${count} references, each checked against the original. The <a href="physics.html#equations-and-sources">equations</a> cite them by these numbers.</p>
  </div>
</section>`;
  const main = `<div class="wrap" style="padding-top:56px;padding-bottom:96px">
  <article class="doc" id="references">
<div class="refs-intro">${blocks(intro, null)}</div>
${refs}
<h2 id="credits" data-no="Models · textures · libraries" style="margin-top:96px">Credits</h2>
${blocks(chapters.get('Credits'), null)}
  </article>
</div>`;
  return frame({ file: 'sources.html', title: 'Sources', hero, main,
    description: 'The research, standards and crash-test protocols behind Car Crash Simulation, numbered as the equations cite them, and the credits for the car models and libraries.' });
}

for (const [file, build] of [['physics.html', physicsPage], ['sources.html', sourcesPage]]) {
  const html = build();
  const bad = html.match(/\u0000|\{\{|&lt;a id=/);
  if (bad) throw new Error(`${file}: unconverted markup near "${html.slice(Math.max(0, bad.index - 60), bad.index + 60)}"`);
  fs.writeFileSync(path.join(ROOT, file), html);
  console.log(`wrote ${file}: ${(html.length / 1024).toFixed(0)} KB`);
}
