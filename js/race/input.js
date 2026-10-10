/* The Race game's controls: keyboard and gamepad (an Xbox controller, through the Gamepad API's
 * standard mapping), merged into one driving input each frame.
 *
 *   steer        A / D, Left / Right arrows       left stick
 *   accelerate   W, Up arrow                      right trigger
 *   brake        S, Down arrow (reverse)          left trigger
 *   handbrake    Space                            X
 *   boost        Shift, N                         A, right bumper
 *   camera       C                                Y
 *   look back    B                                left bumper
 *   reset        R                                View
 *   pause        Esc, P                           Menu
 *   menus        arrows, WASD; Enter              d-pad, left stick; A
 *
 * On a touch screen the game shows on-screen buttons (game.html #touch, bindTouch): steer left and
 * right, gas, brake, boost, drift (handbrake), and camera, back on the road, pause.
 *
 * Keyboard steering eases in and out (a key is all or nothing; a stick isn't). Rumble, where the
 * browser and controller support it, through the gamepad's vibrationActuator. menu() moves a
 * highlight through an open menu's buttons (a pause menu, the results) and presses the one chosen.
 */
const RaceInput = (() => {
  'use strict';
  const keys = new Set();
  const pressed = new Set();     // keys pressed since the last poll (edges)
  let kSteer = 0, padId = '', lastPad = null;
  const DEAD = 0.12;

  function onKey(e, down) {
    if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
    const k = e.code;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(k)) e.preventDefault();
    if (down) { if (!keys.has(k)) pressed.add(k); keys.add(k); } else keys.delete(k);
  }
  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));
  window.addEventListener('blur', () => keys.clear());
  window.addEventListener('gamepadconnected', (e) => { padId = e.gamepad.id; });
  window.addEventListener('gamepaddisconnected', () => { padId = ''; lastPad = null; });

  const dz = (v) => Math.abs(v) < DEAD ? 0 : Math.sign(v) * (Math.abs(v) - DEAD) / (1 - DEAD);
  const prevButtons = [];
  // on-screen buttons (phones and tablets): [data-k] elements held down, or tapped (camera, reset,
  // pause). Each button follows its own finger, so steering and the pedals work together.
  const touch = { left: false, right: false, gas: false, brake: false, boost: false, hand: false };
  const tapped = new Set();
  function bindTouch(root) {
    for (const b of root.querySelectorAll('[data-k]')) {
      const k = b.dataset.k;
      const down = (ev) => {
        ev.preventDefault();
        try { b.setPointerCapture(ev.pointerId); } catch (err) { /* a synthetic event */ }
        if (k in touch) touch[k] = true; else tapped.add(k);
        b.classList.add('on');
      };
      const up = () => { if (k in touch) touch[k] = false; b.classList.remove('on'); };
      b.addEventListener('pointerdown', down);
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(t, up);
      b.addEventListener('contextmenu', (ev) => ev.preventDefault());
    }
  }
  window.addEventListener('blur', () => { for (const k in touch) touch[k] = false; });
  // menu steps from the stick: one per flick past 0.6, re-armed once it's back under 0.3
  const armed = [true, true];
  const flick = (i, v) => { if (Math.abs(v) < 0.3) armed[i] = true; else if (Math.abs(v) > 0.6 && armed[i]) { armed[i] = false; return Math.sign(v); } return 0; };
  /* -> { steer, throttle, brake, handbrake, boost, camera, lookBack, reset, pause, start, any, device,
   *      nav: { x, y } (menu steps this poll: -1, 0 or 1; right and down positive) } */
  function poll(dt) {
    const k = (...c) => c.some(x => keys.has(x)), e = (...c) => c.some(x => pressed.has(x));
    // keyboard (and on-screen) steering: ease toward the key's direction, quicker back to centre
    const kt = (k('KeyD', 'ArrowRight') || touch.right ? 1 : 0) - (k('KeyA', 'ArrowLeft') || touch.left ? 1 : 0);
    const rate = (kt === 0 || Math.sign(kt) !== Math.sign(kSteer)) ? 6 : 3.2;
    kSteer += Math.max(-rate * dt, Math.min(rate * dt, kt - kSteer));
    const t = (x) => tapped.has(x);
    const out = {
      steer: kSteer, throttle: k('KeyW', 'ArrowUp') || touch.gas ? 1 : 0, brake: k('KeyS', 'ArrowDown') || touch.brake ? 1 : 0,
      handbrake: k('Space') || touch.hand ? 1 : 0, boost: k('ShiftLeft', 'ShiftRight', 'KeyN') || touch.boost, lookBack: k('KeyB'),
      camera: e('KeyC') || t('camera'), reset: e('KeyR') || t('reset'), pause: e('Escape', 'KeyP') || t('pause'), start: e('Enter', 'Space'),
      any: pressed.size > 0 || tapped.size > 0 || Object.values(touch).some(Boolean), device: Object.values(touch).some(Boolean) ? 'touch' : 'keyboard',
      nav: { x: (e('KeyD', 'ArrowRight') ? 1 : 0) - (e('KeyA', 'ArrowLeft') ? 1 : 0), y: (e('KeyS', 'ArrowDown') ? 1 : 0) - (e('KeyW', 'ArrowUp') ? 1 : 0) },
    };
    tapped.clear();
    // the first connected standard-mapping gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) if (p && p.connected && (p.mapping === 'standard' || !gp)) { gp = p; if (p.mapping === 'standard') break; }
    lastPad = gp;
    if (gp) {
      const b = (i) => gp.buttons[i] ? gp.buttons[i].value : 0, bp = (i) => gp.buttons[i] && gp.buttons[i].pressed;
      const edge = (i) => bp(i) && !prevButtons[i];
      const sx = dz(gp.axes[0] || 0);
      const padUsed = Math.abs(sx) > 0 || b(7) > 0.05 || b(6) > 0.05 || gp.buttons.some(x => x && x.pressed);
      if (Math.abs(sx) > Math.abs(out.steer)) out.steer = Math.sign(sx) * Math.pow(Math.abs(sx), 1.4);
      out.throttle = Math.max(out.throttle, b(7));
      out.brake = Math.max(out.brake, b(6));
      out.handbrake = Math.max(out.handbrake, bp(2) ? 1 : 0);
      out.boost = out.boost || bp(0) || bp(5);
      out.lookBack = out.lookBack || bp(4);
      out.camera = out.camera || edge(3);
      out.reset = out.reset || edge(8);
      out.pause = out.pause || edge(9);
      out.start = out.start || edge(0) || edge(9);
      // menus: the d-pad (12 up, 13 down, 14 left, 15 right) or a flick of the left stick
      const fx = flick(0, gp.axes[0] || 0), fy = flick(1, gp.axes[1] || 0);
      out.nav.x = out.nav.x || (edge(15) ? 1 : edge(14) ? -1 : fx);
      out.nav.y = out.nav.y || (edge(13) ? 1 : edge(12) ? -1 : fy);
      out.any = out.any || gp.buttons.some((x, i) => edge(i));
      if (padUsed) out.device = 'gamepad';
      gp.buttons.forEach((x, i) => { prevButtons[i] = x && x.pressed; });
    }
    pressed.clear();
    return out;
  }
  function rumble(strong, weak, ms) {
    const gp = lastPad, act = gp && gp.vibrationActuator;
    if (act && act.playEffect) act.playEffect('dual-rumble', { duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) }).catch(() => {});
  }
  // a menu's buttons (.btn, shown) in element el: the menu steps of input inp (arrows, d-pad, a stick
  // flick) move the highlight (class 'focus'), Enter or A presses the highlighted one; the highlight
  // starts on the first button each time a menu opens (or after menuReset)
  let menuEl = null, menuIdx = 0;
  function menu(el, inp) {
    const items = [...el.querySelectorAll('.btn')].filter((b) => b.offsetParent !== null);
    if (!items.length) return;
    if (menuEl !== el) { menuEl = el; menuIdx = 0; }
    const step = inp.nav.y || inp.nav.x, ui = typeof FX !== 'undefined' ? FX.ui : () => {};   // the menu sounds (fx.js)
    if (step) { menuIdx = (menuIdx + step + items.length) % items.length; ui('move'); }
    menuIdx = Math.min(menuIdx, items.length - 1);
    items.forEach((b, i) => b.classList.toggle('focus', i === menuIdx));
    if (inp.start) { ui('ok'); items[menuIdx].click(); }
  }
  return { poll, rumble, bindTouch, menu, menuReset() { menuEl = null; }, get pad() { return lastPad ? lastPad.id : padId; } };
})();
