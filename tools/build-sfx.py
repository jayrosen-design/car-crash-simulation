"""The games' recorded sound effects (js/fx.js, "recorded sounds"), cut from the sound-effect
recordings in media/audio (licensed from Envato Elements) into one script, media/sfx/sounds.js:

    blender -b --factory-startup --python tools/build-sfx.py

Each clip is a stretch of one recording, mixed to mono, its loudness set and its ends faded. A loop
(an engine, rotors, tracks) is crossfaded into itself, then written with a little of itself before
and after, so any window of its length repeats without a seam, whatever delay the MP3 decoder adds;
the page loops from `pad` for `len` seconds. Some engine stretches are recorded as the car comes
closer: their loudness is evened out first (flatten). Encoded as MP3 (mono, 96 kb/s) with Blender's
built-in FFmpeg, and wrapped as base64 in a classic script, so the pages load it from file:// too.
The MP3s are also left in tools/out/sfx/ to listen to.

Which clip goes with which vehicle or event is in js/garage.js (each vehicle's `sound`) and js/fx.js.
"""
import os
import sys
import struct
import wave
import base64
import tempfile
import numpy as np
import bpy

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SRC = os.path.join(ROOT, 'media', 'audio')
OUT_JS = os.path.join(ROOT, 'media', 'sfx', 'sounds.js')
OUT_MP3 = os.path.join(ROOT, 'tools', 'out', 'sfx')
SR = 44100
PAD = 0.12   # s of the loop written before and after it

# name: (folder (its name starts so), file (its name contains), start s, end s, kind, options)
#   loop: rpm = the engine speed it was recorded at (from its firing frequency: 0 for the tracks, which
#         follow the speed), level = RMS dBFS, xfade = s crossfaded at the seam, flatten = even out the loudness
#   shot: level = RMS dBFS while it sounds (where its 50 ms loudness is within 20 dB of its loudest; -18 if
#         not given), its peaks kept under -1 dBFS; fade_in / fade_out s
CLIPS = {
    # ---- engines: idling
    'idle-petrol': ('petrol-car-engine-idle-loop', '.wav', 0.05, 2.58, 'loop', dict(rpm=800, xfade=0.25)),
    'idle-impala': ('1966-chevy-impala', '.wav', 9.10, 10.40, 'loop', dict(rpm=790, xfade=0.18)),
    'idle-lotus': ('1990-lotus-esprit', '.wav', 7.65, 9.35, 'loop', dict(rpm=1130, xfade=0.2)),
    'idle-diesel': ('diesel-truck-engine-idling', '.wav', 4.0, 8.0, 'loop', dict(rpm=560, xfade=0.3)),
    'idle-bike': ('transportation-motorcycle-sport-bike-start', '.wav', 0.78, 1.62, 'loop', dict(rpm=1270, xfade=0.16)),
    # ---- engines: under way
    'drive-muscle': ('muscle-car-engine-loop', '.wav', 0.0, 4.0, 'loop', dict(rpm=2000, xfade=0.2)),
    'drive-porsche': ('european-sports-car-drives-by', '.wav', 5.0, 7.6, 'loop', dict(rpm=1380, xfade=0.25, flatten=True)),
    'drive-fox': ('volkswagen-fox-car', '.wav', 3.85, 4.75, 'loop', dict(rpm=6060, xfade=0.2, flatten=True)),
    'drive-bike': ('transportation-motorcycle-sport-bike-accelerate', '.wav', 10.0, 11.6, 'loop', dict(rpm=7800, xfade=0.2)),
    'drone': ('large-drone-flying', '.wav', 2.0, 7.0, 'loop', dict(rpm=6000, xfade=0.3)),
    'tank-engine': ('military-tank-engine-runs', '.wav', 6.0, 12.0, 'loop', dict(rpm=650, xfade=0.3)),
    'tank-tracks': ('military-tank-moving-tracks', '.wav', 10.0, 18.0, 'loop', dict(rpm=0, xfade=0.4)),
    # ---- the garage: an engine starting or revving when it's picked
    'rev-v8': ('loud-deep-v8-engine-revs', '.wav', 0.15, 6.6, 'shot', dict(fade_out=0.3)),
    'rev-impala': ('1966-chevy-impala', '.wav', 5.15, 9.4, 'shot', dict(fade_out=0.3)),
    'start-lotus': ('1990-lotus-esprit', '.wav', 0.9, 7.4, 'shot', dict(fade_out=0.4)),
    'rev-lotus': ('1990-lotus-esprit', '.wav', 9.8, 16.6, 'shot', dict(fade_out=0.4)),
    'start-bike': ('transportation-motorcycle-sport-bike-start', '.wav', 0.1, 1.65, 'shot', dict(fade_out=0.15)),
    'rev-tank': ('military-tank-engine-runs', '.wav', 22.6, 29.5, 'shot', dict(fade_in=0.3, fade_out=0.4)),
    # ---- the countdown: a beep for 3, 2, 1, then the start
    'count': ('game-start-countdown', '.wav', 0.0, 0.6, 'shot', dict(fade_out=0.05)),
    'go': ('game-start-countdown', '.wav', 4.0, 7.0, 'shot', dict(fade_out=0.3)),
    # ---- menus
    'menu-move': ('game-menu-select-pack', 'Select 05', 0.0, 0.4, 'shot', dict(fade_out=0.05)),
    'menu-pick': ('game-menu-select-pack', 'Select 01', 0.0, 0.4, 'shot', dict(fade_out=0.05)),
    'menu-ok': ('game-menu-select-pack', 'Select 07', 0.0, 0.42, 'shot', dict(fade_out=0.05)),
    'menu-back': ('game-menu-select-pack', 'Select 04', 0.0, 0.42, 'shot', dict(fade_out=0.05)),
    # ---- a car flying past (a near miss), the loudest moment 0.3 s in
    'passby': ('turbo-engine-pass-by', '.wav', 1.75, 4.4, 'shot', dict(fade_in=0.06, fade_out=0.3)),
    # ---- the motorcycle's and the drone's crashes, the first impact near the start
    'crash-bike': ('motorcycle-slide-crash-impact', '.wav', 0.5, 4.6, 'shot', dict(fade_out=0.4)),
    'crash-drone': ('drone-crash-landing', '.wav', 1.85, 5.1, 'shot', dict(fade_in=0.04, fade_out=0.3)),
}


def find(folder, part):
    for d in sorted(os.listdir(SRC)):
        if not d.startswith(folder):
            continue
        for dp, _, files in os.walk(os.path.join(SRC, d)):
            for f in sorted(files):
                if part.lower() in f.lower() and f.lower().endswith('.wav'):
                    return os.path.join(dp, f)
    raise SystemExit('no recording for %s / %s in media/audio' % (folder, part))


def read_wav(p):
    """16- or 24-bit PCM WAV (plain or extensible) -> (samples x channels float32, rate)"""
    b = open(p, 'rb').read()
    pos, fmt, data = 12, None, None
    while pos < len(b) - 8:
        cid = b[pos:pos + 4]
        n = struct.unpack('<I', b[pos + 4:pos + 8])[0]
        if cid == b'fmt ':
            _, ch, sr = struct.unpack('<HHI', b[pos + 8:pos + 16])
            fmt = (ch, sr, struct.unpack('<H', b[pos + 22:pos + 24])[0])
        elif cid == b'data':
            data = b[pos + 8:pos + 8 + n]
        pos += 8 + n + (n & 1)
    ch, sr, bits = fmt
    if bits == 16:
        x = np.frombuffer(data[:len(data) // 2 * 2], '<i2').astype(np.float32) / 32768
    elif bits == 24:
        a = np.frombuffer(data[:len(data) // 3 * 3], np.uint8).reshape(-1, 3).astype(np.int32)
        v = a[:, 0] | (a[:, 1] << 8) | (a[:, 2] << 16)
        x = (np.where(v >= 1 << 23, v - (1 << 24), v)).astype(np.float32) / (1 << 23)
    else:
        raise SystemExit('%s: %d-bit audio' % (p, bits))
    return x[:len(x) // ch * ch].reshape(-1, ch), sr


def rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)


def smooth(x, n):
    k = np.ones(n) / n
    return np.convolve(np.pad(x, (n // 2, n - n // 2 - 1), mode='edge'), k, 'valid')


def make(name, folder, part, t0, t1, kind, o):
    x, sr = read_wav(find(folder, part))
    assert sr == SR, '%s: %d Hz' % (name, sr)
    m = x.mean(1).astype(np.float64)
    assert t1 * sr <= len(m) + 1, '%s: ends after the recording (%.2f s)' % (name, len(m) / sr)
    seg = m[int(t0 * sr):int(t1 * sr)]
    seg = seg - seg.mean()
    info = None
    if kind == 'loop':
        if o.get('flatten'):   # even out the loudness (a car coming closer): divide by a 0.15 s RMS
            env = np.sqrt(smooth(seg ** 2, int(0.15 * sr)))
            seg = seg / np.maximum(env, env.max() * 0.05) * env.mean()
        X = int(o['xfade'] * sr)
        L = len(seg) - X
        w = np.sin(np.linspace(0, np.pi / 2, X)) ** 2   # 0 -> 1 over the seam
        loop = seg[:L].copy()
        loop[:X] = seg[:X] * np.sqrt(w) + seg[L:L + X] * np.sqrt(1 - w)   # the end runs on into the start
        loop *= 10 ** ((o.get('level', -20) - rms_db(loop)) / 20)
        P = int(PAD * sr)
        out = np.concatenate([loop[-P:], loop, loop[:P]])
        info = [round(P / sr, 5), round(L / sr, 5), o['rpm']]
        # the seam: the step across it no bigger than the loop's usual sample-to-sample step
        step = abs(loop[0] - loop[-1]); typ = np.percentile(np.abs(np.diff(loop)), 99)
        assert step <= typ * 1.5, '%s: a step of %.4f at the seam (usually under %.4f)' % (name, step, typ)
    else:
        fi, fo = int(o.get('fade_in', 0.005) * sr), int(o.get('fade_out', 0.05) * sr)
        seg[:fi] *= np.linspace(0, 1, fi)
        seg[len(seg) - fo:] *= np.linspace(1, 0, fo) ** 2
        env = np.sqrt(smooth(seg ** 2, int(0.05 * sr)))
        on = seg[env > env.max() * 0.1]   # while it sounds
        gain = min(10 ** ((o.get('level', -18) - rms_db(on)) / 20), 10 ** (-1 / 20) / np.abs(seg).max())
        out = seg * gain
    assert np.abs(out).max() < 1, '%s: clips' % name
    return out, info


def encode(name, x):
    """mono float -> MP3 bytes, with Blender's FFmpeg (a sound strip mixed down)"""
    tmp = os.path.join(tempfile.gettempdir(), 'sfx-%s.wav' % name)
    with wave.open(tmp, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes())
    scn = bpy.context.scene
    se = scn.sequence_editor_create()
    strips = se.strips if hasattr(se, 'strips') else se.sequences
    for s in list(strips):
        strips.remove(s)
    scn.render.fps, scn.render.fps_base = 100, 1
    strips.new_sound(name='s', filepath=tmp, channel=1, frame_start=1)
    scn.frame_start, scn.frame_end = 1, int(np.ceil(len(x) / SR * 100))
    scn.render.ffmpeg.audio_channels = 'MONO'
    scn.render.ffmpeg.audio_mixrate = SR
    path = os.path.join(OUT_MP3, name + '.mp3')
    bpy.ops.sound.mixdown(filepath=path, check_existing=False, container='MP3', codec='MP3', format='S16', bitrate=96)
    os.remove(tmp)
    return open(path, 'rb').read()


os.makedirs(OUT_MP3, exist_ok=True)
os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
data, loops, total = {}, {}, 0
for name, (folder, part, t0, t1, kind, o) in CLIPS.items():
    x, info = make(name, folder, part, t0, t1, kind, o)
    mp3 = encode(name, x)
    data[name] = base64.b64encode(mp3).decode('ascii')
    if info:
        loops[name] = info
    total += len(mp3)
    print('%-14s %-4s %5.2f s  %5.1f KB' % (name, kind, len(x) / SR, len(mp3) / 1024))
js = ('/* Generated by tools/build-sfx.py from the recordings in media/audio (sound effects licensed from\n'
      ' * Envato Elements). Do not edit; re-run the tool. clips: name -> base64 MP3; loops: name -> [pad s, len s, rpm]. */\n'
      'window.SFX_DATA = {\n  loops: %s,\n  clips: {\n%s\n  },\n};\n') % (
    '{ ' + ', '.join("'%s': [%s, %s, %d]" % (k, v[0], v[1], v[2]) for k, v in loops.items()) + ' }',
    '\n'.join("    '%s': '%s'," % (k, v) for k, v in data.items()))
open(OUT_JS, 'w', newline='\n').write(js)
print('wrote media/sfx/sounds.js: %d clips, %.0f KB of MP3, %.0f KB of script' % (len(data), total / 1024, len(js) / 1024))
