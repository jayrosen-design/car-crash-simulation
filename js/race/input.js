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
 * Keyboard steering eases in and out (a key is all or nothing; a stick isn't). Rumble, where the
 * browser and controller support it, through the gamepad's vibrationActuator.
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
  // menu steps from the stick: one per flick past 0.6, re-armed once it's back under 0.3
  const armed = [true, true];
  const flick = (i, v) => { if (Math.abs(v) < 0.3) armed[i] = true; else if (Math.abs(v) > 0.6 && armed[i]) { armed[i] = false; return Math.sign(v); } return 0; };
  /* -> { steer, throttle, brake, handbrake, boost, camera, lookBack, reset, pause, start, any, device,
   *      nav: { x, y } (menu steps this poll: -1, 0 or 1; right and down positive) } */
  function poll(dt) {
    const k = (...c) => c.some(x => keys.has(x)), e = (...c) => c.some(x => pressed.has(x));
    // keyboard steering: ease toward the key's direction, quicker back to centre
    const kt = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0);
    const rate = (kt === 0 || Math.sign(kt) !== Math.sign(kSteer)) ? 6 : 3.2;
    kSteer += Math.max(-rate * dt, Math.min(rate * dt, kt - kSteer));
    const out = {
      steer: kSteer, throttle: k('KeyW', 'ArrowUp') ? 1 : 0, brake: k('KeyS', 'ArrowDown') ? 1 : 0,
      handbrake: k('Space') ? 1 : 0, boost: k('ShiftLeft', 'ShiftRight', 'KeyN'), lookBack: k('KeyB'),
      camera: e('KeyC'), reset: e('KeyR'), pause: e('Escape', 'KeyP'), start: e('Enter', 'Space'),
      any: pressed.size > 0, device: 'keyboard',
      nav: { x: (e('KeyD', 'ArrowRight') ? 1 : 0) - (e('KeyA', 'ArrowLeft') ? 1 : 0), y: (e('KeyS', 'ArrowDown') ? 1 : 0) - (e('KeyW', 'ArrowUp') ? 1 : 0) },
    };
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
  return { poll, rumble, get pad() { return lastPad ? lastPad.id : padId; } };
})();
