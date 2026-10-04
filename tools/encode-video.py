"""Encodes a folder of numbered JPEG frames into an H.264 MP4 with Blender's built-in FFmpeg
(used by tools/record-video.js, so no separate ffmpeg install is needed).

    blender -b --factory-startup --python tools/encode-video.py -- <frames dir> <out.mp4> <fps> [HIGH|MEDIUM|LOW]
"""
import bpy, glob, os, shutil, sys, tempfile

args = sys.argv[sys.argv.index('--') + 1:]
frames_dir, out, fps = args[:3]
quality = args[3] if len(args) > 3 else 'MEDIUM'   # Blender's CRF presets: HIGH, MEDIUM, LOW, ...
files = sorted(f for f in os.listdir(frames_dir) if f.lower().endswith('.jpg'))
if not files:
    raise SystemExit('no frames in ' + frames_dir)

scn = bpy.context.scene
scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage = 1280, 720, 100
scn.render.fps, scn.render.fps_base = int(fps), 1.0
# show the frames exactly as captured (no filmic tone mapping)
scn.view_settings.view_transform = 'Standard'
scn.view_settings.look = 'None'
scn.display_settings.display_device = 'sRGB'
scn.sequencer_colorspace_settings.name = 'sRGB'

se = scn.sequence_editor_create()
strips = se.strips if hasattr(se, 'strips') else se.sequences   # renamed in Blender 4.4
strip = strips.new_image(name='frames', filepath=os.path.join(frames_dir, files[0]), channel=1, frame_start=1)
for f in files[1:]:
    strip.elements.append(f)
scn.frame_start, scn.frame_end = 1, len(files)

r = scn.render
r.use_sequencer = True
if hasattr(r.image_settings, 'media_type'):   # Blender 5: pick video output first
    r.image_settings.media_type = 'VIDEO'
r.image_settings.file_format = 'FFMPEG'
r.ffmpeg.format = 'MPEG4'
r.ffmpeg.codec = 'H264'
r.ffmpeg.constant_rate_factor = quality
r.ffmpeg.ffmpeg_preset = 'BEST'
r.ffmpeg.gopsize = int(fps)
r.ffmpeg.audio_codec = 'NONE'
# Blender appends the frame range to a movie's name, so render into a temp folder and move it
tmp = tempfile.mkdtemp(prefix='ccs-encode-')
r.filepath = os.path.join(tmp, 'reel')
bpy.ops.render.render(animation=True)
made = glob.glob(os.path.join(tmp, 'reel*.mp4'))
if not made:
    raise SystemExit('Blender wrote no video')
shutil.move(made[0], out)
shutil.rmtree(tmp, ignore_errors=True)
print('encoded %d frames to %s' % (len(files), out))
