"""Exports a car from a .blend file for Crash Lab: split into named parts, decimated, oriented to
car axes (x forward, y up, z right, metres, ground at y = 0), with physics data.

    blender -b -Y --factory-startup --python tools/export-car.py -- tools/cars/lexus.json [--report]

-Y keeps any scripts stored in the .blend from running. --report only prints the mesh islands in
car coordinates (for writing the region rules in the config) and exports nothing.

Writes models/<name>.glb.js (Draco GLB as base64 in a classic script, so the page works from
file://) and models/<name>.phys.js (physics data for the browser and Node: size, profile, hubs,
tyre size, H-point, and per part its surface samples, plus pane corners for the glass). It stops
with an error if the wheelbase, axle direction, glass-pane count or H-point come out wrong.
"""
import bpy, bmesh, json, math, os, sys, base64, random
from collections import defaultdict, Counter
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
CFG_PATH = args[0]
REPORT = '--report' in args
ROOT = os.path.abspath(os.path.join(os.path.dirname(CFG_PATH), '..', '..'))
cfg = json.load(open(CFG_PATH, encoding='utf-8'))
NAME = cfg['name']

bpy.ops.wm.open_mainfile(filepath=cfg['blend'], load_ui=False, use_scripts=False)
dg = bpy.context.evaluated_depsgraph_get()


def world_verts(ob):
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, depsgraph=dg)
    me.transform(ob.matrix_world)
    return me


# ---------------------------------------------------------------- car frame from the wheels
hub = {}
for key, obname in cfg['wheels'].items():
    me = world_verts(bpy.data.objects[obname])
    vs = [v.co for v in me.vertices]
    lo = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
    hi = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    hub[key] = ((lo + hi) / 2, lo, hi)
    bpy.data.meshes.remove(me)
front = (hub['FL'][0] + hub['FR'][0]) / 2
rear = (hub['RL'][0] + hub['RR'][0]) / 2
f = (front - rear); f.z = 0
wb_model = f.length
f.normalize()
up = Vector((0, 0, 1))
right = f.cross(up)
S = cfg['wheelbase'] / wb_model
ground_z = min(h[1].z for h in hub.values())
mid = (front + rear) / 2
lat0 = sum(((h[0] - mid).dot(right) for h in hub.values())) / 4


def car(p):
    d = p - mid
    return Vector((S * d.dot(f), S * (p.z - ground_z), S * (d.dot(right) - lat0)))


# ---------------------------------------------------------------- collect source meshes in car coords
def car_mesh(ob):
    me = world_verts(ob)
    for v in me.vertices:
        v.co = car(v.co)
    return me


def mat_names(ob):
    return [s.material.name if s.material else '' for s in ob.material_slots]


def classify_material(name):
    for cls, names in cfg['materials'].items():
        if name in names:
            return cls
    return 'paint'


sources = []   # (mesh, material names, fixed part or None)
for obname in cfg['body']:
    ob = bpy.data.objects[obname]
    sources.append((car_mesh(ob), mat_names(ob), None))
for obname, part in cfg.get('objects', {}).items():
    ob = bpy.data.objects[obname]
    sources.append((car_mesh(ob), mat_names(ob), part))

# body x extent (for centring) from the main body only
xs = [v.co.x for v in sources[0][0].vertices]
xc = (min(xs) + max(xs)) / 2
for me, _, _ in sources:
    for v in me.vertices:
        v.co.x -= xc
hub_car = {k: car(h[0]) - Vector((xc, 0, 0)) for k, h in hub.items()}


# ---------------------------------------------------------------- islands
def islands(me):
    n = len(me.vertices)
    par = list(range(n))

    def find(a):
        while par[a] != a:
            par[a] = par[par[a]]
            a = par[a]
        return a
    for e in me.edges:
        a, b = find(e.vertices[0]), find(e.vertices[1])
        if a != b:
            par[a] = b
    return [find(i) for i in range(n)]


def in_box(c, box):
    return all(box[k][0] <= c[k] <= box[k][1] for k in range(3) if box[k] is not None)


def fits(lo, hi, box, tol=0.15):
    return all(box[k][0] - tol <= lo[k] and hi[k] <= box[k][1] + tol for k in range(3) if box[k] is not None)


DROP = '-'


def region_for(c, mcls, mname, lo=None, hi=None, tris=0, override=False):
    """First matching region rule; DROP for a rule whose part is null."""
    for r in cfg['regions']:
        if override and not r.get('override'):
            continue
        if tris < r.get('minTris', 0):
            continue
        if 'mats' in r and mcls not in r['mats'] and mname not in r['mats']:
            continue
        if 'notMats' in r and (mcls in r['notMats'] or mname in r['notMats']):
            continue
        box = (r.get('x'), r.get('y'), r.get('z'))
        if in_box(c, box) and (lo is None or fits(lo, hi, box)):
            return r['part'] or DROP
    return None


face_part = []   # per source: list of part names per polygon (None = dropped)
report = []
for si, (me, mats, fixed) in enumerate(sources):
    root = islands(me)
    groups = defaultdict(list)
    for p in me.polygons:
        groups[root[p.vertices[0]]].append(p.index)
    parts = [None] * len(me.polygons)
    for g, polys in groups.items():
        mc = Counter()
        lo = Vector((1e9, 1e9, 1e9)); hi = -lo
        area = 0
        for pi in polys:
            p = me.polygons[pi]
            mc[mats[p.material_index] if p.material_index < len(mats) else ''] += p.area
            area += p.area
            for vi in p.vertices:
                co = me.vertices[vi].co
                lo = Vector((min(lo[k], co[k]) for k in range(3)))
                hi = Vector((max(hi[k], co[k]) for k in range(3)))
        mname = mc.most_common(1)[0][0]
        mcls = classify_material(mname)
        c = (lo + hi) / 2
        split = cfg.get('splitPolygons') and mcls in cfg['splitPolygons'] and max(hi - lo) > cfg.get('splitSize', 0.6)
        ntri = sum(len(me.polygons[pi].vertices) - 2 for pi in polys)
        if mcls == 'drop' or max(hi - lo) < cfg.get('dropTiny', 0):
            part = None
        elif fixed:
            part = region_for(c, mcls, mname, lo, hi, ntri, override=True) or fixed
        elif mcls in ('tire', 'rim'):
            part = None
        else:
            part = region_for(c, mcls, mname, lo, hi, ntri) or 'RIGID_Cage_Body'
        if part == DROP:
            part = None
        if split and not fixed:
            for pi in polys:
                p = me.polygons[pi]
                pm = mats[p.material_index] if p.material_index < len(mats) else ''
                pp = region_for(p.center, classify_material(pm), pm) or 'RIGID_Cage_Body'
                parts[pi] = None if pp == DROP else pp
        else:
            for pi in polys:
                parts[pi] = part
        report.append((sum(len(me.polygons[pi].vertices) - 2 for pi in polys), c, hi - lo, mname, mcls, 'split' if split and not fixed else part, si))
    face_part.append(parts)

if REPORT:
    print('=== hubs (car coords):', {k: tuple(round(x, 3) for x in v) for k, v in hub_car.items()})
    print('=== scale %.4f  body x extent %.3f' % (S, (max(xs) - min(xs)) * 1))
    report.sort(key=lambda r: -r[0])
    for tri, c, size, mname, mcls, part, si in report:
        if tri < cfg.get('reportMin', 150):
            continue
        print('tri=%6d c=(%6.2f %5.2f %6.2f) size=(%5.2f %5.2f %5.2f) %-22s %-8s -> %s%s' % (
            tri, c.x, c.y, c.z, size.x, size.y, size.z, mname[:22], mcls, part, '' if si == 0 else ' [obj %d]' % si))
    tot = Counter()
    for (me, _, _), parts in zip(sources, face_part):
        for p, pt in zip(me.polygons, parts):
            tot[pt] += len(p.vertices) - 2
    print('=== tris per part:', sorted(tot.items(), key=lambda kv: -kv[1]))
    sys.exit(0)


# ---------------------------------------------------------------- materials: simple PBR stand-ins
def sample_material(name):
    """(base rgb, metallic, roughness, emissive) read from the source shader, best effort."""
    mt = bpy.data.materials.get(name)
    col, metal, rough, emit = (0.6, 0.6, 0.6), 0.0, 0.5, False
    if mt is None:
        return col, metal, rough, emit
    col = tuple(mt.diffuse_color[:3])
    if mt.node_tree:
        for nd in mt.node_tree.nodes:
            if nd.type == 'BSDF_PRINCIPLED':
                bc = nd.inputs['Base Color']
                col = tuple(bc.default_value[:3])
                if bc.is_linked:
                    ramps = [n for n in mt.node_tree.nodes if n.type == 'VALTORGB']
                    if ramps:
                        col = tuple(ramps[0].color_ramp.evaluate(0.5)[:3])
                metal = nd.inputs['Metallic'].default_value
                rough = nd.inputs['Roughness'].default_value
                break
            if nd.type == 'EMISSION':
                col = tuple(nd.inputs['Color'].default_value[:3]); emit = True
            if nd.type == 'BSDF_GLASS':
                col = tuple(nd.inputs['Color'].default_value[:3])
    return col, metal, rough, emit


mat_table = {}
stand_in = {}


def stand_in_material(name):
    if name in stand_in:
        return stand_in[name]
    cls = classify_material(name)
    col, metal, rough, emit = sample_material(name)
    ov = cfg.get('colors', {}).get(name)
    if ov:
        col = tuple(ov[:3])
    m = bpy.data.materials.new('%s:%s' % (cls, name))
    if not m.node_tree:
        m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (col[0], col[1], col[2], 1)
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    mat_table[m.name] = {'cls': cls, 'color': [round(x, 4) for x in col], 'metal': round(metal, 3), 'rough': round(rough, 3), 'emit': emit}
    stand_in[name] = m
    return m


# ---------------------------------------------------------------- build part meshes
def extract(me, mats, labels, part):
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    kill = [fc for fc in bm.faces if labels[fc.index] != part]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    out = bpy.data.meshes.new(part)
    bm.to_mesh(out)
    bm.free()
    for name in mats:
        out.materials.append(stand_in_material(name))
    return out


def ratio_for(part):
    d = cfg['decimate']
    for key in sorted(d, key=len, reverse=True):
        if part.startswith(key):
            return d[key]
    return 0.5


scn = bpy.data.scenes.new('export')
coll = scn.collection
part_objs = {}
for (me, mats, fixed), labels in zip(sources, face_part):
    for part in sorted(set(l for l in labels if l)):
        pm = extract(me, mats, labels, part)
        ob = bpy.data.objects.new(part, pm)
        coll.objects.link(ob)
        part_objs.setdefault(part, []).append(ob)


def join(objs):
    if len(objs) == 1:
        return objs[0]
    with bpy.context.temp_override(scene=scn, view_layer=scn.view_layers[0], active_object=objs[0], object=objs[0], selected_objects=objs, selected_editable_objects=objs):
        bpy.ops.object.join()
    return objs[0]


def decimate(ob, ratio):
    if ratio < 0.999:
        md = ob.modifiers.new('dec', 'DECIMATE')
        md.ratio = ratio
        md.use_collapse_triangulate = True
        with bpy.context.temp_override(scene=scn, view_layer=scn.view_layers[0]):
            dg2 = bpy.context.evaluated_depsgraph_get()
            dg2.update()
            new = bpy.data.meshes.new_from_object(ob.evaluated_get(dg2), depsgraph=dg2)
        ob.modifiers.clear()
        old = ob.data
        ob.data = new
        bpy.data.meshes.remove(old)
    me = ob.data
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(cfg.get('sharpAngle', 40)))


parts = {}
for part, objs in part_objs.items():
    ob = join(objs)
    ob.name = part
    ob.data.name = part
    decimate(ob, ratio_for(part))
    parts[part] = ob

# wheel: one right-side wheel in its own frame (hub at the origin, axle along +z = outboard)
wsrc = bpy.data.objects[cfg['wheels']['FR']]
wme = car_mesh(wsrc)
hfr = hub_car['FR']
for v in wme.vertices:
    v.co.x -= xc
    v.co -= hfr
for i, name in enumerate(mat_names(wsrc)):
    wme.materials[i] = stand_in_material(name)   # in place: clear() would reset the face material indices
wob = bpy.data.objects.new('RIGID_Mech_Wheel', wme)
coll.objects.link(wob)
decimate(wob, cfg['decimate'].get('wheel', 0.1))
parts['RIGID_Mech_Wheel'] = wob
wmats = mat_names(wsrc)
rad_t = rad_r = 0.0
zmin = zmax = 0.0
wme = wob.data
for p in wme.polygons:
    cls = classify_material(wmats[p.material_index]) if p.material_index < len(wmats) else 'paint'
    for vi in p.vertices:
        co = wme.vertices[vi].co
        r = math.hypot(co.x, co.y)
        if cls == 'tire':
            rad_t = max(rad_t, r)
        elif cls == 'rim':
            rad_r = max(rad_r, r)
        zmin = min(zmin, co.z); zmax = max(zmax, co.z)
# objects are still in car coordinates (x fwd, y up, z right) inside Blender's xyz


# ---------------------------------------------------------------- physics data
def verts_of(ob):
    return [v.co.copy() for v in ob.data.vertices]


def fps(points, k):
    """Farthest-point samples: well spread, the first few span the part."""
    if not points:
        return []
    k = min(k, len(points))
    c = sum(points, Vector()) / len(points)
    first = max(range(len(points)), key=lambda i: (points[i] - c).length)
    chosen = [first]
    d = [(p - points[first]).length for p in points]
    while len(chosen) < k:
        i = max(range(len(points)), key=lambda j: d[j])
        chosen.append(i)
        q = points[i]
        for j, p in enumerate(points):
            dj = (p - q).length
            if dj < d[j]:
                d[j] = dj
    return [points[i] for i in chosen]


def r3(v):
    return [round(v[0], 4), round(v[1], 4), round(v[2], 4)]


def plane_frame(ob):
    me = ob.data
    n = Vector()
    area = 0
    c = Vector()
    for p in me.polygons:
        n += p.normal * p.area
        c += p.center * p.area
        area += p.area
    c /= max(area, 1e-9)
    # outward: away from a point inside the cabin
    if n.dot(c - Vector((0, 0.9, 0))) < 0:
        n = -n
    n.normalize()
    a1 = n.cross(Vector((0, 1, 0)))
    if a1.length < 1e-3:
        a1 = n.cross(Vector((1, 0, 0)))
    a1.normalize()
    a2 = n.cross(a1)
    return c, n, a1, a2, area


phys = {'name': NAME, 'title': cfg.get('title', NAME), 'credit': cfg.get('credit'), 'parts': [], 'materials': mat_table}
all_body = []
for part, ob in sorted(parts.items()):
    if part == 'RIGID_Mech_Wheel':
        continue
    vs = verts_of(ob)
    area = sum(p.area for p in ob.data.polygons)
    lo = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
    hi = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    entry = {'name': part, 'tris': sum(len(p.vertices) - 2 for p in ob.data.polygons), 'area': round(area, 4),
             'lo': r3(lo), 'hi': r3(hi), 'samples': [r3(p) for p in fps(vs, 48)]}
    if part.startswith('BRITTLE_Glass'):
        c, n, a1, a2, _ = plane_frame(ob)
        corners = []
        for s1, s2 in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            corners.append(max(vs, key=lambda v: s1 * (v - c).dot(a1) + s2 * (v - c).dot(a2)))
        entry.update({'centre': r3(c), 'normal': r3(n), 'corners': [r3(p) for p in corners], 'laminated': part == 'BRITTLE_GlassWS'})
        strip = [v for v in vs if abs(v.z - c.z) < 0.15] or vs
        entry['centreLine'] = [r3(min(strip, key=lambda v: v.y)), r3(max(strip, key=lambda v: v.y))]
    phys['parts'].append(entry)
    if not part.startswith('BREAKAWAY_Mirror'):
        all_body += vs

xs2 = [v.x for v in all_body]
L = max(xs2) - min(xs2)
x0 = min(xs2)
prof_top, prof_bot, prof_hw = [], [], []
for i in range(int(L / 0.1) + 1):
    xa, xb = x0 + i * 0.1, x0 + (i + 1) * 0.1
    col = [v for v in all_body if xa <= v.x < xb]
    top = [v.y for v in col if abs(v.z) < 0.35]
    bot = [v.y for v in col if abs(v.z) < 0.6 and v.y > 0.05]
    side = [abs(v.z) for v in col if 0.45 < v.y < 1.0]
    u = round(xa - x0 + 0.05, 3)
    if top:
        prof_top.append([u, round(max(top), 4)])
    if bot:
        prof_bot.append([u, round(min(bot), 4)])
    if side:
        prof_hw.append([u, round(max(side), 4)])
hp = cfg.get('hPoint')
if 'hipBone' in cfg:
    arm = bpy.data.objects[cfg['hipBone']['armature']]
    pb = arm.pose.bones[cfg['hipBone']['bone']]
    hw = arm.matrix_world @ pb.head
    hp = r3(car(hw) - Vector((xc, 0, 0)))
phys.update({
    'length': round(L, 4), 'xMin': round(x0, 4),
    'width': round(2 * max(abs(v.z) for v in all_body if 0.3 < v.y < 1.2), 4),
    'height': round(max(v.y for v in all_body), 4),
    'hubs': {k: r3(v) for k, v in hub_car.items()},
    'tireRadius': round(rad_t, 4), 'rimRadius': round(rad_r, 4), 'tireWidth': round(zmax - zmin, 4),
    'profileTop': prof_top, 'profileBottom': prof_bot, 'profileHalfWidth': prof_hw,
    'hPoint': hp,
})

# ---------------------------------------------------------------- checks that fail the export
wb = hub_car['FL'].x - hub_car['RL'].x
assert abs(wb - cfg['wheelbase']) < 0.01 * cfg['wheelbase'], 'wheelbase %.3f' % wb
assert hub_car['FL'].x > hub_car['RL'].x and hub_car['FL'].z < 0 < hub_car['FR'].z, 'front axle must be +x, left wheels at -z'
nglass = sum(1 for p in phys['parts'] if p['name'].startswith('BRITTLE_Glass'))
assert nglass == cfg.get('expectGlass', nglass), 'glass panes %d, expected %d' % (nglass, cfg.get('expectGlass'))
assert hp is not None, 'no H-point'
assert rad_t > rad_r > 0, 'tyre radius %.3f must exceed rim radius %.3f' % (rad_t, rad_r)

# ---------------------------------------------------------------- export (car axes -> Blender, so glTF comes out x fwd, y up, z right)
from mathutils import Matrix
TO_BL = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
for ob in parts.values():
    ob.data.transform(TO_BL)
    ob.data.update()
tmp = os.path.join(os.environ.get('TEMP', '.'), 'crashlab-%s.glb' % NAME)
with bpy.context.temp_override(scene=scn):
    bpy.ops.export_scene.gltf(filepath=tmp, export_format='GLB', use_active_scene=True, use_selection=False,
                              export_texcoords=False, export_normals=True, export_materials='EXPORT',
                              export_yup=True, export_apply=False, export_animations=False, export_skins=False,
                              export_morph=False, export_cameras=False, export_lights=False,
                              export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
                              export_draco_position_quantization=14, export_draco_normal_quantization=10)
glb = open(tmp, 'rb').read()
os.makedirs(os.path.join(ROOT, 'models'), exist_ok=True)
cr = cfg.get('credit') or {}
head = '/* Generated by tools/export-car.py from %s. Do not edit; re-run the exporter.\n * Model: "%s" by %s, %s, %s */\n' % (
    os.path.basename(cfg['blend']), cr.get('title', ''), cr.get('author', ''), cr.get('license', ''), cr.get('url', ''))
with open(os.path.join(ROOT, 'models', NAME + '.glb.js'), 'w', encoding='utf-8') as fo:
    fo.write(head + "(window.CAR_ASSETS = window.CAR_ASSETS || {})['%s'] = '%s';\n" % (NAME, base64.b64encode(glb).decode('ascii')))
with open(os.path.join(ROOT, 'models', NAME + '.phys.js'), 'w', encoding='utf-8') as fo:
    fo.write(head + "(function (root) {\nconst data = " + json.dumps(phys, separators=(',', ':')) +
             ";\n(root.CAR_PHYS = root.CAR_PHYS || {})['%s'] = data;\nif (typeof module === 'object' && module.exports) module.exports = data;\n})(typeof window !== 'undefined' ? window : globalThis);\n" % NAME)

tot = sum(p['tris'] for p in phys['parts'])
wt = sum(len(p.vertices) - 2 for p in parts['RIGID_Mech_Wheel'].data.polygons)
print('=== EXPORT %s: %d parts, %d body tris + %d wheel tris, GLB %.0f KB, tyre R %.3f rim R %.3f width %.3f, L %.3f W %.3f H %.3f, H-point %s' % (
    NAME, len(phys['parts']), tot, wt, len(glb) / 1024, rad_t, rad_r, zmax - zmin, phys['length'], phys['width'], phys['height'], hp))
for p in phys['parts']:
    print('   %-20s tris %6d area %.2f' % (p['name'], p['tris'], p['area']))
