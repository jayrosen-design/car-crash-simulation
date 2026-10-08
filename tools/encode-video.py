"""Encodes a folder of numbered JPEG frames into an H.264 MP4 with Blender's built-in FFmpeg
(used by tools/record-video.js, so no separate ffmpeg install is needed), optionally with a
soundtrack (AAC) and scaled to another size.

    blender -b --factory-startup --python tools/encode-video.py -- <frames dir> <out.mp4> <fps> [HIGH|MEDIUM|LOW] [audio=<file.wav>] [size=<w>x<h>]
"""
import bpy, glob, os, shutil, sys, tempfile

args = sys.argv[sys.argv.index('--') + 1:]
frames_dir, out, fps = args[:3]
opts = dict(a.split('=', 1) for a in args[3:] if '=' in a)
plain = [a for a in args[3:] if '=' not in a]
quality = plain[0] if plain else 'MEDIUM'   # Blender's CRF presets: HIGH, MEDIUM, LOW, ...
width, height = (int(v) for v in opts.get('size', '1280x720').split('x'))
files = sorted(f for f in os.listdir(frames_dir) if f.lower().endswith('.jpg'))
if not files:
    raise SystemExit('no frames in ' + frames_dir)

scn = bpy.context.scene
scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage = width, height, 100
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
# frames of another size are scaled to the output (the sequencer would otherwise crop them)
img = bpy.data.images.load(os.path.join(frames_dir, files[0]))
src_w, src_h = img.size
bpy.data.images.remove(img)
if (src_w, src_h) != (width, height):
    strip.transform.scale_x, strip.transform.scale_y = width / src_w, height / src_h
    strip.transform.filter = 'CUBIC_MITCHELL'
scn.frame_start, scn.frame_end = 1, len(files)
if 'audio' in opts:
    strips.new_sound(name='sound', filepath=opts['audio'], channel=2, frame_start=1)

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
if 'audio' in opts:
    r.ffmpeg.audio_codec = 'AAC'
    r.ffmpeg.audio_bitrate = 192
    r.ffmpeg.audio_channels = 'STEREO'
    r.ffmpeg.audio_mixrate = 48000
else:
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
