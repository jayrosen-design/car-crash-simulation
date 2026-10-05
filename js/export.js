/* Saving a replay as an MP4 video in the browser (WebCodecs).
 *
 * The replay is drawn frame by frame at a fixed rate and size, however fast the computer is, so no
 * frame is dropped, and its sounds are rendered offline on the same clock (fx.js capture). Frames
 * are encoded as H.264 (VP9 if the browser has no H.264 encoder) and the sound as AAC (or Opus),
 * and both go into an MP4 file with mp4-muxer (MIT licence), loaded from the CDN the first time a
 * video is saved. */
const VideoExport = (() => {
  'use strict';
  const MUXER = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.mjs';
  const supported = typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // the first video encoder setting this browser supports: 1080p H.264, then 720p, then VP9
  async function videoConfig(w, h, fps) {
    const tries = [['avc', 'avc1.640028', w, h], ['avc', 'avc1.4d0028', w, h], ['avc', 'avc1.42001f', 1280, 720], ['vp9', 'vp09.00.40.08', w, h], ['vp9', 'vp09.00.31.08', 1280, 720]];
    for (const [kind, codec, cw, ch] of tries) {
      const cfg = { codec, width: cw, height: ch, bitrate: cw * ch * fps * 0.19, framerate: fps };
      if (kind === 'avc') cfg.avc = { format: 'avc' };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return { kind, cfg }; } catch (e) { /* try the next */ }
    }
    return null;
  }
  async function audioConfig(sampleRate) {
    if (typeof AudioEncoder !== 'function') return null;
    for (const [kind, codec] of [['aac', 'mp4a.40.2'], ['opus', 'opus']]) {
      const cfg = { codec, sampleRate, numberOfChannels: 2, bitrate: 160000 };
      try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { kind, cfg }; } catch (e) { /* try the next */ }
    }
    return null;
  }

  // the title and the replay clock over the picture, and a label over the onboard camera's inset
  function caption(g, W, H, cap) {
    if (!cap) return;
    const s = H / 1080, pad = 40 * s;
    g.save();
    g.textBaseline = 'top'; g.shadowColor = 'rgba(0, 0, 0, 0.65)'; g.shadowBlur = 8 * s; g.fillStyle = '#fff';
    g.font = `600 ${Math.round(34 * s)}px system-ui, "Segoe UI", sans-serif`;
    g.fillText(cap.title || '', pad, pad);
    g.font = `500 ${Math.round(28 * s)}px ui-monospace, Consolas, monospace`;
    g.fillText(cap.time || '', pad, pad + 48 * s);
    if (cap.pip) {
      g.font = `${Math.round(20 * s)}px system-ui, "Segoe UI", sans-serif`;
      g.textBaseline = 'bottom';
      g.fillText('Onboard high-speed camera', cap.pip.left, cap.pip.top - 6 * s);
    }
    g.restore();
  }

  // opts: { frames, fps, width, height,
  //   size(w, h)        draw at this size (null: back to the page's),
  //   step(i)           advance the replay to frame i, render()  draw it into canvas,
  //   canvas            the WebGL canvas,  caption(i) -> { title, time, pip }  (optional),
  //   progress(f, text) (0..1),  cancelled() -> true to stop }
  // Resolves to a Blob (video/mp4).
  async function record(opts) {
    const { frames, fps } = opts;
    opts.progress(0, 'Loading the video muxer');
    const { Muxer, ArrayBufferTarget } = await import(MUXER);
    const vid = await videoConfig(opts.width, opts.height, fps);
    if (!vid) throw new Error('this browser has no H.264 or VP9 video encoder');
    const W = vid.cfg.width, H = vid.cfg.height;
    const sound = FX.beginCapture(frames / fps);
    const aud = sound ? await audioConfig(FX.sampleRate) : null;
    let failure = null;
    const muxer = new Muxer(Object.assign({ target: new ArrayBufferTarget(), fastStart: 'in-memory', firstTimestampBehavior: 'offset',
      video: { codec: vid.kind, width: W, height: H, frameRate: fps } }, aud ? { audio: { codec: aud.kind, numberOfChannels: 2, sampleRate: FX.sampleRate } } : {}));
    const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
    venc.configure(vid.cfg);
    const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
    const g = c2.getContext('2d');
    try {
      opts.size(W, H);
      for (let i = 0; i < frames; i++) {
        if (failure) throw failure;
        if (opts.cancelled()) throw new Error('cancelled');
        FX.captureClock(i / fps);
        opts.step(i);
        opts.render();
        g.drawImage(opts.canvas, 0, 0, W, H);
        caption(g, W, H, opts.caption && opts.caption(i));
        const vf = new VideoFrame(c2, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
        venc.encode(vf, { keyFrame: i % (2 * fps) === 0 });
        vf.close();
        while (venc.encodeQueueSize > 4) await sleep(2);
        if (i % 4 === 0) { opts.progress(0.9 * i / frames, `Recording frame ${i + 1} of ${frames}`); await sleep(0); }
      }
      await venc.flush();
      if (failure) throw failure;
      // the sound, rendered on the same clock
      opts.progress(0.92, 'Mixing the sound');
      const buf = sound ? await FX.endCapture() : null;
      if (aud && buf) {
        const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { failure = e; } });
        aenc.configure(aud.cfg);
        const n = buf.length, sr = buf.sampleRate, L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
        for (let s = 0; s < n; s += 4800) {
          const len = Math.min(4800, n - s), data = new Float32Array(2 * len);
          data.set(L.subarray(s, s + len), 0); data.set(R.subarray(s, s + len), len);
          const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round(s * 1e6 / sr), data });
          aenc.encode(ad); ad.close();
        }
        await aenc.flush();
        if (failure) throw failure;
      }
      muxer.finalize();
      opts.progress(1, 'Done');
      return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), width: W, height: H, codec: vid.cfg.codec, audio: aud ? aud.cfg.codec : null };
    } finally {
      if (venc.state !== 'closed') venc.close();
      FX.endCapture(false);   // if it stopped early: back to live sound, nothing rendered
      opts.size(null);
    }
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  // Saves a page's replay: from its start, at the playback speed chosen (bullet-time included), and a
  // second past its end. page: { play (the playback state), step(dt) (the page's own playback step),
  // resetEvents(), title, fileName, toast(text) }. While it runs the page must not step or draw
  // (VideoExport.busy).
  let busy = false, cancel = false;
  async function saveReplay(page) {
    if (busy || !page.play) return;
    if (!supported) { page.toast('Saving a video needs a browser with WebCodecs: a recent Chrome, Edge, Safari or Firefox.'); return; }
    const play = page.play, fps = 30, dt = 1 / fps;
    const speedAt = (t) => play.auto ? play.auto(t) : play.speed;
    let t = play.tStart, n = 0;
    while (t < play.tEnd && n < fps * 600) { t = Math.min(play.tEnd, t + dt * speedAt(t)); n++; }
    const frames = n + fps;
    busy = true; cancel = false;
    const box = document.createElement('div');
    box.className = 'panel center export-box';
    box.innerHTML = '<h3>Saving the video</h3><div class="bar"><div></div></div><div class="comp-text"></div><button class="small">Cancel</button>';
    box.querySelector('button').addEventListener('click', () => { cancel = true; });
    document.querySelector('#computing').parentElement.appendChild(box);
    const clock = () => {
      if (play.after > 0) return `+${((play.t - play.t0) + play.after).toFixed(1)} s  ·  real time`;
      const ms = (play.t - play.t0) * 1000, sp = speedAt(play.t);
      return `${ms >= 0 ? '+' : ''}${ms.toFixed(1)} ms  ·  ${sp >= 0.995 ? '1×' : '1/' + Math.round(1 / sp) + '×'}`;
    };
    play.t = play.tStart; play.playing = true; play.after = 0;
    page.resetEvents(); Scene3D.particles.clear();
    try {
      const res = await record({ frames, fps, width: 1920, height: 1080, canvas: Scene3D.renderer.domElement,
        size: (w, h) => Scene3D.setFixedSize(w, h),
        step: () => page.step(dt), render: () => Scene3D.render(dt, page.pip !== false, 0),
        caption: () => ({ title: page.title, time: clock(), pip: Scene3D.pipRect }),
        progress: (f, text) => { box.querySelector('.bar > div').style.width = `${(100 * f).toFixed(0)}%`; box.querySelector('.comp-text').textContent = text; },
        cancelled: () => cancel });
      download(res.blob, page.fileName);
      page.toast(`Saved ${page.fileName}: ${(frames / fps).toFixed(1)} s at ${res.width}×${res.height}, ${(res.blob.size / 1048576).toFixed(1)} MB${res.audio ? '' : ', without sound'}.`);
      return res;
    } catch (e) {
      page.toast(e.message === 'cancelled' ? 'The video was not saved.' : 'Could not save the video: ' + e.message);
      return null;
    } finally {
      busy = false; box.remove();
      play.playing = false;
    }
  }

  return { supported, record, download, saveReplay, get busy() { return busy; } };
})();
