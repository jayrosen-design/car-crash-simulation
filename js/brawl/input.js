/* The Hurricane Brawl game's controls: keyboard, mouse and gamepad (an Xbox controller, through the
 * Gamepad API's standard mapping), merged each frame.
 *
 *                 keyboard                   mouse                          controller
 *   move          W A S D, arrows            hold the left button: toward   left stick
 *                                            the cursor
 *   boost         Shift                      double-click and hold          A, right trigger
 *   special       Space                      right button (aimed at the     X, B, left trigger
 *                                            cursor)
 *   camera        Q / E turn, Z / X zoom,    wheel zooms, middle-drag       right stick (turn, zoom)
 *                 C north-up or free         turns                          Y north-up or free
 *   big map       Tab                                                       View
 *   pause         Esc, P                                                    Menu
 *   sound         M
 *   menus         arrows, WASD; Enter        click                          d-pad, left stick; A; B back
 *
 * Other controllers in the standard mapping work the same by position (the bottom face button boosts,
 * the left one fires the special): a Nintendo Switch Pro Controller (B boosts, Y special, ZR / ZL,
 * X camera, − map, + pause; in menus A picks and B goes back, as on the Switch) and a PlayStation pad
 * (✕, □, R2 / L2 ...). labels names the buttons of the controller in use, for the screen.
 *
 * poll() gives the move as a screen-space vector (x right, y up), so the game turns it into a
 * direction on the globe from the camera. The mouse gives its position in normalised device
 * coordinates; the game picks the globe under it. Rumble, where supported, through the gamepad's
 * vibrationActuator.
 */
const BrawlInput = (() => {
  'use strict';
  const keys = new Set();
  const pressed = new Set();     // keys pressed since the last poll
  const DEAD = 0.15;
  let lastPad = null, device = 'keyboard', kind = 'xbox';
  // the face and shoulder buttons' names by position: bottom, right, left, top (buttons 0-3), the
  // bumpers and triggers (4-7), and the two small middle buttons (8, 9)
  const LABELS = {
    xbox: { bottom: 'A', right: 'B', left: 'X', top: 'Y', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', view: 'View', menu: 'Menu', ok: 'A' },
    switch: { bottom: 'B', right: 'A', left: 'Y', top: 'X', lb: 'L', rb: 'R', lt: 'ZL', rt: 'ZR', view: '\u2212', menu: '+', ok: 'A' },
    playstation: { bottom: '\u2715', right: '\u25cb', left: '\u25a1', top: '\u25b3', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', view: 'Create', menu: 'Options', ok: '\u2715' },
  };
  const kindOf = (id) => /057e|nintendo|pro controller|joy-con/i.test(id) ? 'switch' : /054c|dualsense|dualshock|playstation/i.test(id) ? 'playstation' : 'xbox';
  const mouse = { x: 0, y: 0, over: false, left: false, boostHold: false, lastUp: -1e9, right: false, wheel: 0, dragX: 0, middle: false };

  function onKey(e, down) {
    if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
    const k = e.code;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].includes(k)) e.preventDefault();
    if (down) { if (!keys.has(k)) pressed.add(k); keys.add(k); device = 'keyboard'; } else keys.delete(k);
  }
  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));
  window.addEventListener('blur', () => { keys.clear(); mouse.left = mouse.right = mouse.middle = mouse.boostHold = false; });
  window.addEventListener('gamepaddisconnected', () => { lastPad = null; });

  // the mouse on the game's view (the globe)
  function bindView(el) {
    const at = (e) => { const r = el.getBoundingClientRect(); mouse.x = (e.clientX - r.left) / r.width * 2 - 1; mouse.y = -((e.clientY - r.top) / r.height * 2 - 1); };
    el.addEventListener('pointermove', (e) => { at(e); mouse.over = true; if (mouse.middle) mouse.dragX += e.movementX || 0; if (e.pointerType === 'mouse' && (mouse.left || mouse.middle)) device = 'mouse'; });
    el.addEventListener('pointerleave', () => { mouse.over = false; });
    el.addEventListener('pointerdown', (e) => {
      at(e); mouse.over = true; device = 'mouse';
      if (e.button === 0) { mouse.left = true; mouse.boostHold = performance.now() - mouse.lastUp < 300; }
      else if (e.button === 2) mouse.right = true;
      else if (e.button === 1) { mouse.middle = true; e.preventDefault(); }
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* a synthetic event */ }
    });
    const up = (e) => {
      if (e.button === 0) { if (mouse.left) mouse.lastUp = performance.now(); mouse.left = false; mouse.boostHold = false; }
      else if (e.button === 1) mouse.middle = false;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', () => { mouse.left = mouse.middle = mouse.boostHold = false; });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => { e.preventDefault(); mouse.wheel += Math.sign(e.deltaY); device = 'mouse'; }, { passive: false });
  }

  const dz = (v) => Math.abs(v) < DEAD ? 0 : Math.sign(v) * (Math.abs(v) - DEAD) / (1 - DEAD);
  const prevButtons = [];
  const armed = [true, true];
  const flick = (i, v) => { if (Math.abs(v) < 0.3) armed[i] = true; else if (Math.abs(v) > 0.6 && armed[i]) { armed[i] = false; return Math.sign(v); } return 0; };

  /* -> { move: {x, y}, steer (mouse steering held), mouse: {x, y, over}, boost, special,
   *      turn (-1..1 held: Q/E, the right stick), drag (middle-drag, px), zoom (-1..1 held: in is
   *      positive), wheel (notches, down positive), camera, map, pause, mute, restart, start, back,
   *      any, device, nav: {x, y} } */
  function poll() {
    const k = (...c) => c.some(x => keys.has(x)), e = (...c) => c.some(x => pressed.has(x));
    const out = {
      move: { x: (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0), y: (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0) },
      steer: mouse.left, mouse: { x: mouse.x, y: mouse.y, over: mouse.over },
      boost: k('ShiftLeft', 'ShiftRight') || mouse.boostHold, special: e('Space') || mouse.right,
      turn: (k('KeyE') ? 1 : 0) - (k('KeyQ') ? 1 : 0), drag: mouse.dragX, wheel: mouse.wheel,
      zoom: (k('KeyX', 'Equal', 'NumpadAdd') ? 1 : 0) - (k('KeyZ', 'Minus', 'NumpadSubtract') ? 1 : 0),
      camera: e('KeyC'), map: e('Tab'), pause: e('Escape', 'KeyP'), mute: e('KeyM'), restart: e('KeyR'),
      start: e('Enter', 'NumpadEnter', 'Space'), back: e('Escape', 'Backspace'),
      any: pressed.size > 0 || mouse.right,
      nav: { x: (e('KeyD', 'ArrowRight') ? 1 : 0) - (e('KeyA', 'ArrowLeft') ? 1 : 0), y: (e('KeyS', 'ArrowDown') ? 1 : 0) - (e('KeyW', 'ArrowUp') ? 1 : 0) },
    };
    if (out.move.x && out.move.y) { out.move.x *= Math.SQRT1_2; out.move.y *= Math.SQRT1_2; }
    mouse.right = false; mouse.wheel = 0; mouse.dragX = 0;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) if (p && p.connected && (p.mapping === 'standard' || !gp)) { gp = p; if (p.mapping === 'standard') break; }
    lastPad = gp;
    if (gp) kind = kindOf(gp.id);
    if (gp) {
      const b = (i) => gp.buttons[i] ? gp.buttons[i].value : 0, bp = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
      const edge = (i) => bp(i) && !prevButtons[i];
      const ax = (i) => gp.axes[i] || 0;
      // the left stick, with a radial dead zone
      let sx = ax(0), sy = -ax(1);
      const m = Math.hypot(sx, sy);
      if (m < DEAD) { sx = 0; sy = 0; } else { const f = Math.min(1, (m - DEAD) / (1 - DEAD)) / m; sx *= f; sy *= f; }
      const used = m > DEAD || Math.abs(ax(2)) > DEAD || Math.abs(ax(3)) > DEAD || gp.buttons.some(x => x && x.pressed);
      if (Math.hypot(sx, sy) > Math.hypot(out.move.x, out.move.y)) out.move = { x: sx, y: sy };
      out.boost = out.boost || bp(0) || b(7) > 0.3;
      out.special = out.special || edge(2) || edge(1) || (b(6) > 0.5 && !prevButtons[6]);
      out.turn += dz(ax(2)) * 1.4;
      out.zoom += -dz(ax(3)) * 1.4;
      out.camera = out.camera || edge(3);
      out.map = out.map || edge(8);
      out.pause = out.pause || edge(9);
      // menus: Nintendo's A (on the right) picks and B (at the bottom) goes back; the others the other way
      const okB = kind === 'switch' ? 1 : 0, backB = kind === 'switch' ? 0 : 1;
      out.start = out.start || edge(okB) || edge(9);
      out.back = out.back || edge(backB);
      const fx = flick(0, ax(0)), fy = flick(1, ax(1));
      out.nav.x = out.nav.x || (edge(15) ? 1 : edge(14) ? -1 : fx);
      out.nav.y = out.nav.y || (edge(13) ? 1 : edge(12) ? -1 : fy);
      out.any = out.any || gp.buttons.some((x, i) => edge(i));
      if (used) device = 'gamepad';
      gp.buttons.forEach((x, i) => { prevButtons[i] = i === 6 ? b(6) > 0.5 : !!(x && x.pressed); });
    }
    pressed.clear();
    out.device = device;
    return out;
  }
  function rumble(strong, weak, ms) {
    const act = lastPad && lastPad.vibrationActuator;
    if (act && act.playEffect) act.playEffect('dual-rumble', { duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) }).catch(() => {});
  }
  return { poll, rumble, bindView, LABELS, get pad() { return lastPad ? lastPad.id : ''; }, get device() { return device; }, get kind() { return kind; }, get labels() { return LABELS[kind]; } };
})();
