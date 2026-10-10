"""Renders each garage vehicle's side view for the select screens' lineup, from its exported model.

    blender -b --factory-startup --python tools/render-sides.py

Reads js/garage.js's keys and signature paints (through Node), loads models/<key>.glb.js and .phys.js,
paints the paint, puts the wheels on (a road car's model holds one wheel), and renders its right side
in an orthographic camera, framed to the model, on a transparent background. Writes models/sides.js:
window.CAR_SIDES[key] = { src (a WebP data URL), L, H (the picture's size in metres), x0 (its left
edge, measured from the rear of the profile js/garageui.js draws) }, for js/garageui.js.
"""
import bpy, json, os, re, base64, subprocess, math
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PPM = 64                     # pixels per metre
CRIMSON = 0xa3161f           # the Lexus and Mustang's starting paint (js/race/game.js PAINTS[0])
garage = json.loads(subprocess.check_output(['node', '-e',
    "const G = require('./js/garage.js'); console.log(JSON.stringify(G.LIST.filter(v => v.race || v.destruction).map(v => ({ key: v.key, paint: v.paint ? v.paint.hex : null }))))"],
    cwd=ROOT).decode())


def lin(h):
    c = [((h >> s) & 255) / 255 for s in (16, 8, 0)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


def data_of(path, var):
    t = open(path, encoding='utf-8').read()
    return t, re.search(r"= '([A-Za-z0-9+/=]+)';", t) if var == 'glb' else json.loads(re.search(r'const data = (\{.*\});', t).group(1))


out = {}
for g in garage:
    key = g['key']
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn = bpy.context.scene
    _, m = data_of(os.path.join(ROOT, 'models', key + '.glb.js'), 'glb')
    tmp = os.path.join(os.environ.get('TEMP', '.'), 'side-%s.glb' % key)
    open(tmp, 'wb').write(base64.b64decode(m.group(1)))
    bpy.ops.import_scene.gltf(filepath=tmp)
    os.remove(tmp)
    _, phys = data_of(os.path.join(ROOT, 'models', key + '.phys.js'), 'phys')
    paint = lin(g['paint'] if g['paint'] is not None else CRIMSON)
    for mt in bpy.data.materials:
        b = next((n for n in mt.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None) if mt.node_tree else None
        if not b:
            continue
        if mt.name.startswith('paint'):   # 'paint:<source>' on a road car, 'paint' on a rig
            b.inputs['Base Color'].default_value = (*paint, 1)
            b.inputs['Metallic'].default_value = 0.35
            b.inputs['Roughness'].default_value = 0.32
            b.inputs['Coat Weight'].default_value = 1.0
        elif mt.name.startswith('glass'):
            b.inputs['Base Color'].default_value = (0.012, 0.016, 0.022, 1)
            b.inputs['Roughness'].default_value = 0.05
        elif mt.name.startswith('chrome'):
            b.inputs['Metallic'].default_value = 1.0
            b.inputs['Roughness'].default_value = 0.15
    obs = [o for o in scn.objects if o.type == 'MESH']
    wheel = next((o for o in obs if o.name.startswith('RIGID_Mech_Wheel')), None)
    if wheel:   # the four wheels from the one (glTF y up -> Blender z up: car z is Blender -y)
        for k, h in phys['hubs'].items():
            w = wheel.copy(); w.data = wheel.data; scn.collection.objects.link(w)
            w.location = (h[0], -h[2], h[1])
            if k in ('FL', 'RL'):
                w.scale = (1, -1, 1)
        bpy.data.objects.remove(wheel)
    bpy.context.view_layer.update()
    lo = Vector((1e9,) * 3); hi = -lo
    for o in scn.objects:
        if o.type != 'MESH':
            continue
        for c in o.bound_box:
            p = o.matrix_world @ Vector(c)
            lo = Vector((min(lo[i], p[i]) for i in range(3))); hi = Vector((max(hi[i], p[i]) for i in range(3)))
    L, H = hi.x - lo.x, hi.z - min(0.0, lo.z)
    # light: a soft sky and a key light from the front and above, on the camera's side
    scn.world = bpy.data.worlds.new('w'); scn.world.use_nodes = True
    bg = scn.world.node_tree.nodes['Background']; bg.inputs['Color'].default_value = (0.55, 0.58, 0.64, 1); bg.inputs['Strength'].default_value = 1.0
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(55), math.radians(-20), math.radians(-30)); scn.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); scn.collection.objects.link(cam); scn.camera = cam
    cam.data.type = 'ORTHO'
    cx, cz = (lo.x + hi.x) / 2, min(0.0, lo.z) + H / 2
    cam.location = (cx, -30, cz); cam.rotation_euler = (math.radians(90), 0, 0)   # looking along +y at the right side
    W_px, H_px = max(8, round(L * PPM)), max(8, round(H * PPM))
    cam.data.ortho_scale = max(L, H)
    cam.data.sensor_fit = 'HORIZONTAL' if L >= H else 'VERTICAL'
    scn.render.resolution_x, scn.render.resolution_y = W_px, H_px
    scn.render.engine = 'BLENDER_EEVEE'
    scn.render.film_transparent = True
    scn.view_settings.view_transform = 'Standard'
    scn.render.image_settings.file_format = 'WEBP'
    scn.render.image_settings.color_mode = 'RGBA'
    scn.render.image_settings.quality = 88
    path = os.path.join(os.environ.get('TEMP', '.'), 'side-%s.webp' % key)
    scn.render.filepath = path
    bpy.ops.render.render(write_still=True)
    src = 'data:image/webp;base64,' + base64.b64encode(open(path, 'rb').read()).decode('ascii')
    os.remove(path)
    out[key] = {'src': src, 'L': round(L, 3), 'H': round(H, 3), 'x0': round(lo.x - phys['xMin'], 3)}
    print('=== SIDE %s %dx%d px, %.1f KB' % (key, W_px, H_px, len(src) * 3 / 4 / 1024))

with open(os.path.join(ROOT, 'models', 'sides.js'), 'w', encoding='utf-8', newline='\n') as fo:
    fo.write('/* Generated by tools/render-sides.py from the models in models/. Do not edit; re-run it.\n'
             ' * The garage lineup\'s side views: window.CAR_SIDES[key] = { src, L, H (m), x0 (m from the profile\'s rear) } */\n')
    fo.write('window.CAR_SIDES = ' + json.dumps(out, separators=(',', ':')) + ';\n')
print('=== wrote models/sides.js, %.0f KB' % (os.path.getsize(os.path.join(ROOT, 'models', 'sides.js')) / 1024))
