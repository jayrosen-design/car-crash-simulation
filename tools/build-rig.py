"""Builds one of the garage's rigs (the motorcycle, the drone, the tank) in Blender and exports it.

    blender -b -Y --factory-startup --python tools/build-rig.py -- tools/vehicles/kestrel.json

The rigs aren't on the crash lattice (they crash as rigid bodies), so they skip export-car.py. Their
spec (tools/vehicles/<key>.json, type 'bike', 'hover' or 'tracked') is a list of parts ("nodes"), each
made of simple shapes (box, prism: a side-view polygon given a width, cylinder, tube, sphere, wheel)
in car coordinates (x forward, y up, z right, metres, ground at y = 0, the middle of the length at
x = 0), with its pivot (where it turns or breaks off) and its parent. Names tell the game what a part
does: WHEEL_ spins (STEER_ turns, a wheel under it steers), ROTOR_ spins about its axis, TURRET_ and
GUN_ aim, BREAK_ comes off in a crash, RIDER_ is thrown.

Writes models/<key>.glb.js (Draco GLB as base64, window.CAR_ASSETS[key], one glTF node per part with
its origin at the pivot) and models/<key>.phys.js (window.RIG_PHYS[key]: size, hubs, the parts' pivots,
axes, masses and break-off speeds, lamps, the side silhouette for the garage screen). It stops with an
error if the size is off the spec by more than 2%, the vehicle doesn't stand on the ground, a bike's
wheels aren't on its centre line, the drone's rotors aren't all as far out, the tank's two sides
don't mirror, or the parts weigh more than the vehicle.
"""
import bpy, bmesh, json, math, os, sys, base64
from mathutils import Vector, Matrix, Euler
from mathutils.geometry import tessellate_polygon

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SPEC_PATH = os.path.abspath(args[0])
ROOT = os.path.abspath(os.path.join(os.path.dirname(SPEC_PATH), '..', '..'))
S = json.load(open(SPEC_PATH, encoding='utf-8'))
KEY = S['key']


def bl(p):
    """car coordinates (x forward, y up, z right) -> Blender (x forward, y left, z up)"""
    return Vector((p[0], -p[2], p[1]))


def srgb(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob)
scn = bpy.context.scene

MATS = {}


def material(name):
    if name in MATS:
        return MATS[name]
    hexcol = S['materials'][name]
    m = bpy.data.materials.new(name)
    if not m.node_tree:
        m.use_nodes = True
    col = srgb(hexcol)
    bsdf = next(nd for nd in m.node_tree.nodes if nd.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (col[0], col[1], col[2], 1)
    metal = name in ('metal', 'rim', 'hub', 'gun')
    bsdf.inputs['Metallic'].default_value = 0.8 if metal else 0.15 if name.startswith('paint') else 0.0
    bsdf.inputs['Roughness'].default_value = 0.3 if metal else 0.4 if name.startswith('paint') else 0.1 if name in ('glass',) else 0.75
    if name.startswith('lamp_'):
        bsdf.inputs['Emission Color'].default_value = (col[0], col[1], col[2], 1)
        bsdf.inputs['Emission Strength'].default_value = 0.6 if name == 'lamp_head' else 0.3
    MATS[name] = m
    return m


# ---------------------------------------------------------------- shapes (each built in a bmesh of its own, in car coordinates)
def shape(bm, sh):
    """Builds one shape into the empty bmesh bm, in Blender coordinates."""
    k = sh['kind']
    if k == 'box':
        bmesh.ops.create_cube(bm, size=1.0)
        s = sh['s']
        for v in bm.verts:
            v.co = Vector((v.co.x * s[0], v.co.y * s[2], v.co.z * s[1]))
        if sh.get('bevel'):
            bmesh.ops.bevel(bm, geom=bm.edges[:] + bm.verts[:], offset=sh['bevel'], segments=2, affect='EDGES', profile=0.5)
        rot = sh.get('rot')
        if rot:   # about the car's x, y, z axes = Blender x, -y, z
            R = Euler((rot[0], -rot[2], rot[1]), 'XYZ').to_matrix()
            for v in bm.verts:
                v.co = R @ v.co
        c = bl(sh['c'])
        for v in bm.verts:
            v.co += c
    elif k == 'prism':
        side = sh['side']
        zc = sh.get('zc', 0.0)
        z0, z1 = (sh['z'] if 'z' in sh else (zc - sh['w'] / 2, zc + sh['w'] / 2))
        ring0 = [bm.verts.new(bl((x, y, z0))) for x, y in side]
        ring1 = [bm.verts.new(bl((x, y, z1))) for x, y in side]
        for t in tessellate_polygon([[Vector((x, y, 0)) for x, y in side]]):
            bm.faces.new([ring0[i] for i in t])
            bm.faces.new([ring1[i] for i in reversed(t)])
        n = len(side)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((ring0[i], ring0[j], ring1[j], ring1[i]))
    elif k in ('cyl', 'tube'):
        if k == 'cyl':
            ax = {'x': Vector((1, 0, 0)), 'y': Vector((0, 1, 0)), 'z': Vector((0, 0, 1))}[sh['axis']]
            c = Vector(sh['c'])
            a, b = c - ax * sh['len'] / 2, c + ax * sh['len'] / 2
        else:
            a, b = Vector(sh['a']), Vector(sh['b'])
        A, B = bl(a), bl(b)
        d = B - A
        m = Matrix.Translation((A + B) / 2) @ d.normalized().to_track_quat('Z', 'Y').to_matrix().to_4x4()
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=sh.get('segments', 20), radius1=sh['r'], radius2=sh['r'], depth=d.length, matrix=m)
    elif k == 'sphere':
        bmesh.ops.create_uvsphere(bm, u_segments=18, v_segments=10, radius=sh['r'], matrix=Matrix.Translation(bl(sh['c'])))
    else:
        raise ValueError('unknown shape ' + k)


def merge(dst, src):
    """Appends bmesh src (material indices kept) to bmesh dst."""
    tmp = bpy.data.meshes.new('tmp')
    src.to_mesh(tmp)
    dst.from_mesh(tmp)
    bpy.data.meshes.remove(tmp)


def wheel(bm, sh, mats):
    """A tyre (revolved profile), rim disc and hub boss about the car's z axis (lateral); the rim on the
    outboard face (both faces for a wheel on the centre line)."""
    R, RIM, TW = sh['r'], sh['rim'], sh['w']
    c = Vector(sh['c'])
    out = sh.get('outboard', 0)
    seg = 32
    prof = [(RIM, -TW / 2 + 0.012), (R - 0.05, -TW / 2), (R - 0.012, -TW / 2 + 0.014), (R, -TW / 2 + 0.04),
            (R, TW / 2 - 0.04), (R - 0.012, TW / 2 - 0.014), (R - 0.05, TW / 2), (RIM, TW / 2 - 0.012)]
    rings = []
    for kk in range(seg):
        a = 2 * math.pi * kk / seg
        rings.append([bm.verts.new(bl((c.x + r * math.cos(a), c.y + r * math.sin(a), c.z + w))) for (r, w) in prof])
    for kk in range(seg):
        r0, r1 = rings[kk], rings[(kk + 1) % seg]
        for j in range(len(prof) - 1):
            f = bm.faces.new((r0[j], r1[j], r1[j + 1], r0[j + 1]))
            f.material_index = mats['tire']

    def disc(radius, z0, z1, mi):
        top = [bm.verts.new(bl((c.x + radius * math.cos(2 * math.pi * kk / seg), c.y + radius * math.sin(2 * math.pi * kk / seg), c.z + z1))) for kk in range(seg)]
        bot = [bm.verts.new(bl((c.x + radius * math.cos(2 * math.pi * kk / seg), c.y + radius * math.sin(2 * math.pi * kk / seg), c.z + z0))) for kk in range(seg)]
        bm.faces.new(top).material_index = mi
        bm.faces.new(list(reversed(bot))).material_index = mi
        for kk in range(seg):
            bm.faces.new((bot[kk], bot[(kk + 1) % seg], top[(kk + 1) % seg], top[kk])).material_index = mi
    disc(RIM, -TW / 2 + 0.015, TW / 2 - 0.015, mats['rim'])
    for sgn in ([out] if out else [1, -1]):
        z0 = TW / 2 - 0.02 if sgn > 0 else -TW / 2 + 0.003
        disc(0.36 * RIM, z0, z0 + 0.017, mats['hub'])


# ---------------------------------------------------------------- the parts
objs = {}
for nd in S['nodes']:
    bm = bmesh.new()
    names = []
    for sh in nd['shapes']:
        for mn in (['tire', 'rim', 'hub'] if sh['kind'] == 'wheel' else [sh['mat']]):
            if mn not in names:
                names.append(mn)
    mi = {n: i for i, n in enumerate(names)}
    for sh in nd['shapes']:
        part = bmesh.new()
        if sh['kind'] == 'wheel':
            wheel(part, sh, mi)
        else:
            shape(part, sh)
            for f in part.faces:
                f.material_index = mi[sh['mat']]
        merge(bm, part)
        part.free()
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    piv = bl(nd['pivot'])
    for v in bm.verts:
        v.co -= piv
    me = bpy.data.meshes.new(nd['name'])
    bm.to_mesh(me)
    bm.free()
    for n in names:
        me.materials.append(material(n))
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(35))
    ob = bpy.data.objects.new(nd['name'], me)
    scn.collection.objects.link(ob)
    ob.location = piv
    objs[nd['name']] = (ob, nd)
for name, (ob, nd) in objs.items():
    if nd.get('parent'):
        par = objs[nd['parent']][0]
        ob.parent = par
        ob.location = bl(nd['pivot']) - bl(objs[nd['parent']][1]['pivot'])

# ---------------------------------------------------------------- measurements (car coordinates)
dg = bpy.context.evaluated_depsgraph_get()
allv = []
for name, (ob, nd) in objs.items():
    mw = ob.matrix_world
    for v in ob.data.vertices:
        p = mw @ v.co
        allv.append((p.x, p.z, -p.y))
lo = [min(p[i] for p in allv) for i in range(3)]
hi = [max(p[i] for p in allv) for i in range(3)]
size = [hi[i] - lo[i] for i in range(3)]
L, H, W = size[0], size[1], size[2]
problems = []
for got, want, what in ((L, S['length'], 'length'), (W, S['width'], 'width'), (H, S['height'], 'height')):
    if abs(got / want - 1) > 0.02:
        problems.append('%s %.3f m, the design %.3f (more than 2%% off)' % (what, got, want))
if abs(lo[1]) > 0.005:
    problems.append('stands at %.4f m, not on the ground' % lo[1])
wheels = [nd for nd in S['nodes'] if nd['name'].startswith('WHEEL_')]
if S['type'] == 'bike':
    for nd in wheels:
        if abs(nd['pivot'][2]) > 1e-6:
            problems.append('%s off the centre line' % nd['name'])
if S['type'] == 'hover':
    rr = [math.hypot(nd['pivot'][0], nd['pivot'][2]) for nd in S['nodes'] if nd['name'].startswith('ROTOR_')]
    if len(rr) != 6 or max(rr) - min(rr) > 1e-3:
        problems.append('rotors at %s, not six all as far out' % rr)
if S['type'] == 'tracked':
    L_ = sorted((round(nd['pivot'][0], 4), round(nd['pivot'][1], 4), round(-nd['pivot'][2], 4)) for nd in wheels if nd['name'].startswith('WHEEL_L'))
    R_ = sorted((round(nd['pivot'][0], 4), round(nd['pivot'][1], 4), round(nd['pivot'][2], 4)) for nd in wheels if nd['name'].startswith('WHEEL_R'))
    if L_ != R_:
        problems.append('the two sides\' wheels don\'t mirror')
for nd in S['nodes']:
    if nd['name'].split('_')[0] in ('WHEEL', 'STEER', 'ROTOR', 'TURRET', 'GUN', 'BREAK', 'RIDER') and 'pivot' not in nd:
        problems.append('%s has no pivot' % nd['name'])
total = sum(nd.get('mass', 0) for nd in S['nodes'])
if total > S['massKg'] + S.get('riderKg', 0) + 1e-6:
    problems.append('parts weigh %.0f kg, more than the %.0f kg vehicle' % (total, S['massKg'] + S.get('riderKg', 0)))
assert not problems, '; '.join(problems)

# the side silhouette, for the garage screen: the highest and lowest point of the surface at the middle
# of each 4 cm slice along x (from the triangles: a big flat face has no vertices in between)
nsl = int(L / 0.04) + 1
stop, sbot = [None] * nsl, [None] * nsl
for name, (ob, nd) in objs.items():
    mw = ob.matrix_world
    me = ob.data
    me.calc_loop_triangles()
    P = [(lambda q: (q.x, q.z))(mw @ v.co) for v in me.vertices]
    for tri in me.loop_triangles:
        a, b, c = (P[i] for i in tri.vertices)
        x0, x1 = min(a[0], b[0], c[0]), max(a[0], b[0], c[0])
        for i in range(max(0, int((x0 - lo[0]) / 0.04 - 0.5)), min(nsl, int((x1 - lo[0]) / 0.04 + 0.5) + 1)):
            xc = lo[0] + (i + 0.5) * 0.04
            ys = []
            for p, q in ((a, b), (b, c), (c, a)):
                if (p[0] - xc) * (q[0] - xc) <= 0 and p[0] != q[0]:
                    ys.append(p[1] + (xc - p[0]) / (q[0] - p[0]) * (q[1] - p[1]))
            if ys:
                stop[i] = max(ys) if stop[i] is None else max(stop[i], max(ys))
                sbot[i] = min(ys) if sbot[i] is None else min(sbot[i], min(ys))
prof_top = [[round((i + 0.5) * 0.04, 3), round(stop[i], 4)] for i in range(nsl) if stop[i] is not None]
prof_bot = [[round((i + 0.5) * 0.04, 3), round(sbot[i], 4)] for i in range(nsl) if sbot[i] is not None]

hubs = {}
if S['type'] == 'bike':
    f = next(nd for nd in wheels if nd['name'] == 'WHEEL_F')['pivot']
    r = next(nd for nd in wheels if nd['name'] == 'WHEEL_R')['pivot']
    hubs = {'FL': [f[0], f[1], 0], 'FR': [f[0], f[1], 0], 'RL': [r[0], r[1], 0], 'RR': [r[0], r[1], 0]}
    wheel_r = next(sh for nd in wheels for sh in nd['shapes'] if sh['kind'] == 'wheel')['r']
elif S['type'] == 'tracked':
    xs = sorted(set(nd['pivot'][0] for nd in wheels))
    zr = max(nd['pivot'][2] for nd in wheels)
    y = wheels[0]['pivot'][1]
    hubs = {'FL': [xs[-1], y, -zr], 'FR': [xs[-1], y, zr], 'RL': [xs[0], y, -zr], 'RR': [xs[0], y, zr]}
    wheel_r = y
else:   # the drone's handling uses a virtual wheelbase between its front and rear arms
    hubs = {'FL': [0.75, 0, -0.5], 'FR': [0.75, 0, 0.5], 'RL': [-0.75, 0, -0.5], 'RR': [-0.75, 0, 0.5]}
    wheel_r = 0.3

phys = {
    'name': KEY, 'title': S['title'], 'type': S['type'],
    'credit': {'title': S['title'], 'author': 'Car Crash Simulation', 'license': 'original design', 'url': 'tools/vehicles/%s.json, built by tools/build-rig.py' % KEY},
    'length': round(L, 4), 'width': round(W, 4), 'height': round(H, 4), 'xMin': round(lo[0], 4),
    'lo': [round(v, 4) for v in lo], 'hi': [round(v, 4) for v in hi],
    'hubs': {k: [round(c, 4) for c in v] for k, v in hubs.items()}, 'wheelRadius': wheel_r,
    'massKg': S['massKg'], 'riderKg': S.get('riderKg', 0),
    'parts': [{'name': nd['name'], 'parent': nd.get('parent'), 'pivot': nd['pivot'], 'axis': nd.get('axis'), 'mass': nd.get('mass', 0),
               'breakDv': nd.get('breakDv'),
               'lo': [round(min(p[i] for p in [(lambda q: (q.x, q.z, -q.y))(objs[nd['name']][0].matrix_world @ v.co) for v in objs[nd['name']][0].data.vertices]), 4) for i in range(3)],
               'hi': [round(max(p[i] for p in [(lambda q: (q.x, q.z, -q.y))(objs[nd['name']][0].matrix_world @ v.co) for v in objs[nd['name']][0].data.vertices]), 4) for i in range(3)]}
              for nd in S['nodes']],
    'lamps': S.get('lamps'), 'hover': S.get('hover'),
    'profileTop': prof_top, 'profileBottom': prof_bot,
}

# ---------------------------------------------------------------- export: glTF axes are the car's (y up, z right)
tmp = os.path.join(os.environ.get('TEMP', '.'), 'crashlab-rig-%s.glb' % KEY)
bpy.ops.export_scene.gltf(filepath=tmp, export_format='GLB', use_selection=False,
                          export_texcoords=False, export_normals=True, export_materials='EXPORT',
                          export_yup=True, export_apply=False, export_animations=False, export_skins=False,
                          export_morph=False, export_cameras=False, export_lights=False,
                          export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
                          export_draco_position_quantization=14, export_draco_normal_quantization=10)
glb = open(tmp, 'rb').read()
head = '/* Generated by tools/build-rig.py from tools/vehicles/%s.json. Do not edit; re-run the builder.\n * Model: "%s", an original design for Car Crash Simulation. */\n' % (KEY, S['title'])
with open(os.path.join(ROOT, 'models', KEY + '.glb.js'), 'w', encoding='utf-8', newline='\n') as fo:
    fo.write(head + "(window.CAR_ASSETS = window.CAR_ASSETS || {})['%s'] = '%s';\n" % (KEY, base64.b64encode(glb).decode('ascii')))
with open(os.path.join(ROOT, 'models', KEY + '.phys.js'), 'w', encoding='utf-8', newline='\n') as fo:
    fo.write(head + "(function (root) {\nconst data = " + json.dumps(phys, separators=(',', ':')) +
             ";\n(root.RIG_PHYS = root.RIG_PHYS || {})['%s'] = data;\nif (typeof module === 'object' && module.exports) module.exports = data;\n})(typeof window !== 'undefined' ? window : globalThis);\n" % KEY)
tris = sum(len(p.vertices) - 2 for ob, _ in objs.values() for p in ob.data.polygons)
print('=== RIG %s: %d parts, %d tris, GLB %.0f KB, L %.3f W %.3f H %.3f, hubs %s' % (KEY, len(objs), tris, len(glb) / 1024, L, W, H, phys['hubs']))
