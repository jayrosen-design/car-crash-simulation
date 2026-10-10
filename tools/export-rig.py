"""Exports a downloaded model as one of the garage's rigs (the motorcycle, the armoured car): the
vehicles that crash as rigid bodies instead of on the crash lattice (js/race/rigs.js).

    blender -b -Y --factory-startup --python tools/export-rig.py -- tools/rigs/ducati.json [--report]

-Y keeps any scripts stored in the .blend from running. --report prints the source objects' mesh
islands in car coordinates (for writing the part boxes in the config) and exports nothing.

The config (tools/rigs/<key>.json) names the source file, the real wheelbase (it sets the scale), the
wheel objects that fix the frame (front and rear), and the parts: each a list of source objects,
optionally only the islands whose centre is inside a box (car coordinates: x forward, y up, z right,
metres, ground at y = 0, the middle of the length at x = 0), with a parent, a pivot (where it turns or
breaks off; WHEEL_ parts pivot on their hub), a mass and a break-off speed. Names tell the game what a
part does, as for tools/build-rig.py: WHEEL_ spins (a wheel under STEER_ steers), STEER_ turns about its
axis, TURRET_ and GUN_ hold, BREAK_ comes off in a crash, RIDER_ is thrown. Materials keep their
colour (a texture's average colour, or the palette colour nearest the texture for each face, or the
config's), and the ones listed as paint become the one material named 'paint' that the game repaints.
A part can be grafted from another rig's model (the crash-test-dummy rider).

Writes models/<key>.glb.js (Draco GLB as base64, window.CAR_ASSETS[key], one glTF node per part with
its origin at the pivot) and models/<key>.phys.js (window.RIG_PHYS[key], the same data as build-rig.py
writes). It stops with an error if the vehicle doesn't stand on the ground, a bike's wheels aren't on its
centre line, or the parts weigh more than the vehicle.
"""
import bpy, bmesh, json, math, os, sys, re, base64
from collections import defaultdict, Counter
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
CFG_PATH = os.path.abspath(args[0])
REPORT = '--report' in args
ROOT = os.path.abspath(os.path.join(os.path.dirname(CFG_PATH), '..', '..'))
cfg = json.load(open(CFG_PATH, encoding='utf-8'))
KEY = cfg['key']
J = lambda x: os.path.join(ROOT, x)   # (a path in the config may be relative to the project folder)
cfg['source'] = J(cfg['source'])
if cfg.get('textures'):
    cfg['textures'] = J(cfg['textures'])
cfg['textureFiles'] = {k: J(v) for k, v in (cfg.get('textureFiles') or {}).items()}
for pt in cfg['parts']:
    g = pt.get('graft')
    if g and 'blend' in g:
        g['blend'] = J(g['blend'])
        g['images'] = {k: J(v) for k, v in g.get('images', {}).items()}

ext = os.path.splitext(cfg['source'])[1].lower()
if ext == '.blend':
    bpy.ops.wm.open_mainfile(filepath=cfg['source'], load_ui=False, use_scripts=False)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=cfg['source']) if ext == '.fbx' else bpy.ops.wm.obj_import(filepath=cfg['source'])
for ob in bpy.data.objects:   # rigs in their rest pose (a door posed open stays shut)
    if ob.type == 'ARMATURE' and cfg.get('restPose'):
        ob.data.pose_position = 'REST'
dg = bpy.context.evaluated_depsgraph_get()
dg.update()


def world_mesh(ob):
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), depsgraph=dg)
    me.transform(ob.matrix_world)
    return me


# ---------------------------------------------------------------- the frame, from the wheels
def bbox(names):
    lo = Vector((1e9,) * 3); hi = -lo
    for n in names:
        me = world_mesh(bpy.data.objects[n])
        for v in me.vertices:
            lo = Vector((min(lo[i], v.co[i]) for i in range(3))); hi = Vector((max(hi[i], v.co[i]) for i in range(3)))
        bpy.data.meshes.remove(me)
    return (lo + hi) / 2, lo, hi


Fc, Flo, Fhi = bbox(cfg['frame']['front'])
Rc, Rlo, Rhi = bbox(cfg['frame']['rear'])
f = Fc - Rc; f.z = 0
S = cfg['wheelbase'] / f.length
f.normalize()
right = f.cross(Vector((0, 0, 1)))
ground = min(Flo.z, Rlo.z, bbox(cfg['frame']['ground'])[1].z) if cfg['frame'].get('ground') else min(Flo.z, Rlo.z)   # (the lowest of all the wheels)
mid = (Fc + Rc) / 2


def car(p):
    d = p - mid
    return Vector((S * d.dot(f), S * (p.z - ground), S * d.dot(right)))


def bl(p):
    """car coordinates (x forward, y up, z right) -> Blender (x forward, y left, z up)"""
    return Vector((p[0], -p[2], p[1]))


# ---------------------------------------------------------------- source meshes in car coordinates, centred on the length
used = []
for pt in cfg['parts']:
    for n in pt.get('objects', []):
        if n not in used:
            used.append(n)
src = {}
for n in used:
    me = world_mesh(bpy.data.objects[n])
    for v in me.vertices:
        v.co = car(v.co)
    src[n] = me
xs = [v.co.x for me in src.values() for v in me.vertices]
xc = (min(xs) + max(xs)) / 2
for me in src.values():
    for v in me.vertices:
        v.co.x -= xc


def islands(me):
    par = list(range(len(me.vertices)))

    def find(a):
        while par[a] != a:
            par[a] = par[par[a]]
            a = par[a]
        return a
    for e in me.edges:
        a, b = find(e.vertices[0]), find(e.vertices[1])
        if a != b:
            par[a] = b
    groups = defaultdict(list)
    for p in me.polygons:
        groups[find(p.vertices[0])].append(p.index)
    out = []
    for polys in groups.values():
        vs = [me.vertices[vi].co for pi in polys for vi in me.polygons[pi].vertices]
        lo = Vector((min(v[i] for v in vs) for i in range(3))); hi = Vector((max(v[i] for v in vs) for i in range(3)))
        mc = Counter(me.polygons[pi].material_index for pi in polys)
        out.append({'polys': polys, 'c': (lo + hi) / 2, 'size': hi - lo, 'tris': sum(len(me.polygons[pi].vertices) - 2 for pi in polys), 'mat': mc.most_common(1)[0][0]})
    return out


def in_box(c, box):
    return all(lo <= c[i] <= hi for i, (lo, hi) in ((0, box.get('x', (-1e9, 1e9))), (1, box.get('y', (-1e9, 1e9))), (2, box.get('z', (-1e9, 1e9)))))


# which part each source polygon goes to: the first part listing its object whose box holds its island's centre
assign = {n: [None] * len(me.polygons) for n, me in src.items()}
boxed = set(n for pt in cfg['parts'] if pt.get('box') for n in pt.get('objects', []))
report = []
for n, me in src.items():
    isl = islands(me) if (n in boxed or REPORT or cfg.get('dropTiny')) else [{'polys': list(range(len(me.polygons))), 'c': None}]
    mats = [s.material.name if s.material else '' for s in bpy.data.objects[n].material_slots]
    for g in isl:
        part = None
        for pt in (cfg['parts'] if g['c'] is None or max(g['size']) >= cfg.get('dropTiny', 0) else []):   # specks (bolts) left out
            if n in pt.get('objects', []) and (not pt.get('box') or in_box(g['c'], pt['box'])):
                part = pt['name']
                break
        for pi in g['polys']:
            assign[n][pi] = part
        if REPORT:
            report.append((g['tris'], g['c'], g['size'], mats[g['mat']] if g['mat'] < len(mats) else '', n, part))
print('=== frame: scale %.4f, x centre %.3f; front hub %s rear hub %s' % (S, xc, tuple(round(x, 3) for x in car(Fc) - Vector((xc, 0, 0))), tuple(round(x, 3) for x in car(Rc) - Vector((xc, 0, 0)))))
if REPORT:
    report.sort(key=lambda r: -r[0])
    for tri, c, size, mname, n, part in report:
        if tri >= cfg.get('reportMin', 300):
            print('tri=%7d c=(%6.2f %5.2f %6.2f) size=(%5.2f %5.2f %5.2f) %-18s %-20s -> %s' % (tri, c.x, c.y, c.z, size.x, size.y, size.z, mname[:18], n[:20], part))
    tot = Counter()
    for n, me in src.items():
        for p, pt in zip(me.polygons, assign[n]):
            tot[pt] += len(p.vertices) - 2
    print('=== tris per part:', sorted(tot.items(), key=lambda kv: -kv[1]))
    sys.exit(0)


# ---------------------------------------------------------------- materials: flat colours
def srgb_to_lin(c):
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


def hex_rgb(h):
    return [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]


IMG = {}


def image_pixels(mname):
    """the source material's base-colour texture as an (h, w, 3) sRGB array, from the config's textures folder"""
    import numpy as np
    if mname in IMG:
        return IMG[mname]
    px = None
    path = (cfg.get('textureFiles') or {}).get(mname)
    if not path:
        mt = bpy.data.materials.get(mname)
        nodes = mt.node_tree.nodes if mt and mt.node_tree else []
        bsdf = next((nd for nd in nodes if nd.type == 'BSDF_PRINCIPLED'), None)
        tex = None
        if bsdf and bsdf.inputs['Base Color'].is_linked:
            nd = bsdf.inputs['Base Color'].links[0].from_node
            while nd and nd.type != 'TEX_IMAGE':   # through a mix or colour node or two
                ins = [i for i in nd.inputs if i.is_linked]
                nd = ins[0].links[0].from_node if ins else None
            tex = nd
        if tex and tex.image and cfg.get('textures'):
            cand = os.path.join(cfg['textures'], os.path.basename(bpy.path.abspath(tex.image.filepath) or tex.image.name))
            path = cand if os.path.exists(cand) else None
    if path:
        img = bpy.data.images.load(path, check_existing=True)
        if img.size[0] > 512:
            img.scale(512, max(1, 512 * img.size[1] // img.size[0]))
        w, h = img.size
        a = np.empty(w * h * 4, np.float32)
        img.pixels.foreach_get(a)
        px = a.reshape(h, w, 4)[:, :, :3]
    IMG[mname] = px
    return px


OUT = {}


def out_material(name, rgb_lin, metal=0.0, rough=0.6, emit=0.0):
    if name in OUT:
        return OUT[name]
    m = bpy.data.materials.new(name)
    if not m.node_tree:
        m.use_nodes = True
    b = next(nd for nd in m.node_tree.nodes if nd.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (*rgb_lin, 1)
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if emit:
        b.inputs['Emission Color'].default_value = (*rgb_lin, 1)
        b.inputs['Emission Strength'].default_value = emit
    OUT[name] = m
    return m


def material_for(mname):
    """the output material for a source material (or a texture-split palette entry 'mname#entry')"""
    look = cfg.get('look', {})
    if mname in cfg.get('paint', []):
        return out_material('paint', srgb_to_lin(hex_rgb(cfg.get('paintHex', '#b01818'))), 0.35, 0.38)
    L = look.get(mname, {})
    if 'hex' in L:
        rgb = srgb_to_lin(hex_rgb(L['hex']))
    else:
        px = image_pixels(mname)
        if px is not None:
            rgb = srgb_to_lin([float(x) for x in px.reshape(-1, 3).mean(0)])
        else:
            mt = bpy.data.materials.get(mname)
            rgb = list(mt.diffuse_color[:3]) if mt else [0.5, 0.5, 0.5]
            bsdf = next((nd for nd in mt.node_tree.nodes if nd.type == 'BSDF_PRINCIPLED'), None) if mt and mt.node_tree else None
            if bsdf:
                rgb = list(bsdf.inputs['Base Color'].default_value[:3])
    safe = L.get('name') or re.sub(r'[^A-Za-z0-9_]', '_', mname)   # (look name: the material's name in the model)
    return out_material(safe, rgb, L.get('metal', 0.1), L.get('rough', 0.6), L.get('emit', 0.0))


def graft_rigged(name, g):
    """A rigged character appended from another .blend (g.blend: its armature, its meshes, and two of
    that vehicle's wheels with their real wheelbase for the scale), its limbs aimed by IK: g.ik
    {bone: where the bone's tail goes, car coordinates} with g.pole {bone: the knee's or elbow's side},
    its hips at g.at, facing g.forward (the source's world direction it faces). Colours: g.palette
    {material: [[name, hex], ...]} per face from g.images {material: texture}, else g.look."""
    import numpy as np
    want = [g['armature']] + g['objects'] + g['scale']['wheels']
    with bpy.data.libraries.load(g['blend'], link=False) as (lib, dst):
        dst.objects = [n for n in lib.objects if n in want]
    sc0 = bpy.context.scene
    got = {}
    for o in dst.objects:
        sc0.collection.objects.link(o)
        got[o.name] = o
    d0 = bpy.context.evaluated_depsgraph_get()
    d0.update()
    wc = []
    for n in g['scale']['wheels']:
        vs = [got[n].matrix_world @ Vector(c) for c in got[n].bound_box]
        wc.append(sum(vs, Vector()) / 8)
    s = g['scale']['wheelbase'] / (wc[0] - wc[1]).length
    arm = got[g['armature']]
    Hw = arm.matrix_world @ arm.pose.bones[g['hips']].head
    fw = Vector(g['forward']).normalized(); up = Vector((0, 0, 1)); rt = fw.cross(up)
    at = Vector(g['at'])

    def to_car(w):
        d = w - Hw
        return at + s * Vector((d.dot(fw), d.dot(up), d.dot(rt)))

    def to_world(c):
        d = (Vector(c) - at) / s
        return Hw + fw * d.x + up * d.y + rt * d.z

    def empty(p):
        e = bpy.data.objects.new('ik', None)
        sc0.collection.objects.link(e)
        e.location = to_world(p)
        return e
    for bone, p in g.get('ik', {}).items():   # where the bone's tail goes, or {to, chain}: a longer chain (the spine)
        con = arm.pose.bones[bone].constraints.new('IK')
        con.target = empty(p['to'] if isinstance(p, dict) else p)
        con.chain_count = p.get('chain', 2) if isinstance(p, dict) else 2
        if bone in g.get('pole', {}):
            con.pole_target = empty(g['pole'][bone])
            con.pole_angle = math.radians(g.get('poleAngle', -90))
    d0 = bpy.context.evaluated_depsgraph_get()
    d0.update()
    out = []
    for n in g['objects']:
        ob = got[n]
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(d0), depsgraph=d0)
        me.transform(ob.matrix_world)
        for v in me.vertices:
            v.co = to_car(v.co)
        mats = [sl.material.name if sl.material else '' for sl in ob.material_slots]
        if g.get('dropMats'):   # faces of these materials left out (the seat belt)
            bm = bmesh.new(); bm.from_mesh(me)
            bmesh.ops.delete(bm, geom=[fc for fc in bm.faces if fc.material_index < len(mats) and mats[fc.material_index] in g['dropMats']], context='FACES')
            bm.to_mesh(me); bm.free()
        names = list(mats)
        for mi, mname in enumerate(mats):
            pal = g.get('palette', {}).get(mname)
            if not pal or not me.uv_layers:
                continue
            img = bpy.data.images.load(g['images'][mname], check_existing=True)
            if img.size[0] > 1024:
                img.scale(1024, 1024 * img.size[1] // img.size[0])
            w, h = img.size
            px = np.empty(w * h * 4, np.float32)
            img.pixels.foreach_get(px)
            px = px.reshape(h, w, 4)[:, :, :3]
            prgb = np.array([hex_rgb(e[1]) for e in pal], np.float32)
            base = len(names)
            for e in pal:
                names.append('%s_%s' % (name, e[0]))
                cfg.setdefault('look', {})[names[-1]] = {'hex': e[1], 'rough': 0.7}
            uv = me.uv_layers.active.data
            for p in me.polygons:
                if p.material_index != mi:
                    continue
                u = sum(uv[li].uv.x for li in p.loop_indices) / p.loop_total
                vv = sum(uv[li].uv.y for li in p.loop_indices) / p.loop_total
                c = px[int((vv % 1) * (h - 1)), int((u % 1) * (w - 1))]
                p.material_index = base + int(np.argmin(((prgb - c) ** 2).sum(1)))
        for i, mname in enumerate(names):   # in place: clear() would reset the faces' material indices
            if i < len(me.materials):
                me.materials[i] = material_for(mname)
            else:
                me.materials.append(material_for(mname))
        o2 = bpy.data.objects.new(name, me)
        coll.objects.link(o2)
        out.append(o2)
    return out


# ---------------------------------------------------------------- the parts
def ratio_for(part):
    d = cfg.get('decimate', {})
    for k in sorted(d, key=len, reverse=True):
        if part.startswith(k):
            return d[k]
    return d.get('', 0.1)


scn = bpy.data.scenes.new('rig')
coll = scn.collection
geo = {}   # part -> Blender object in car coordinates (not yet pivoted)
for pt in cfg['parts']:
    name = pt['name']
    pieces = []
    for n in pt.get('objects', []):
        me = src[n]
        if not any(a == name for a in assign[n]):
            continue
        mats = [s.material.name if s.material else '' for s in bpy.data.objects[n].material_slots]
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[fc for fc in bm.faces if assign[n][fc.index] != name], context='FACES')
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
        # texture split: faces of these materials take the nearest palette colour of their texture
        split = cfg.get('textureSplit', {})
        uvl = bm.loops.layers.uv.active
        out_names = list(mats)
        for mi, mname in enumerate(mats):
            if mname not in split or uvl is None:
                continue
            import numpy as np
            px = image_pixels(mname)
            if px is None:
                continue
            h, w = px.shape[:2]
            pal = split[mname]
            pal_rgb = np.array([hex_rgb(e[1]) for e in pal], np.float32)
            base = len(out_names)
            for e in pal:
                full = '%s#%s' % (mname, e[0])
                out_names.append(full)
                if e[0] == cfg.get('paintEntry', {}).get(mname):
                    cfg.setdefault('paint', []).append(full)
                else:
                    cfg.setdefault('look', {})[full] = {'hex': e[1], 'metal': 0.1, 'rough': 0.6}
            for fc in bm.faces:
                if fc.material_index != mi:
                    continue
                u = sum(l[uvl].uv.x for l in fc.loops) / len(fc.loops)
                v = sum(l[uvl].uv.y for l in fc.loops) / len(fc.loops)
                c = px[int((v % 1) * (h - 1)), int((u % 1) * (w - 1))]
                fc.material_index = base + int(np.argmin(((pal_rgb - c) ** 2).sum(1)))
        out = bpy.data.meshes.new(name)
        bm.to_mesh(out)
        bm.free()
        for mname in out_names:
            out.materials.append(material_for(mname))
        ob = bpy.data.objects.new(name, out)
        coll.objects.link(ob)
        pieces.append(ob)
    if pt.get('graft') and 'blend' in pt['graft']:   # a rigged character from another .blend, posed by IK onto the vehicle
        pieces += graft_rigged(name, pt['graft'])
    elif pt.get('graft'):   # a part from another rig's model (models/<key>.glb.js), moved by offset
        g = pt['graft']
        txt = open(os.path.join(ROOT, g['from']), encoding='utf-8').read()
        tmp = os.path.join(os.environ.get('TEMP', '.'), 'crashlab-graft.glb')
        open(tmp, 'wb').write(base64.b64decode(re.search(r"= '([A-Za-z0-9+/=]+)';", txt).group(1)))
        before = set(bpy.data.objects)
        with bpy.context.temp_override(scene=scn):
            bpy.ops.import_scene.gltf(filepath=tmp)
        new = [o for o in bpy.data.objects if o not in before]
        node = next(o for o in new if o.name.startswith(g['node']))
        kids = [o for o in [node] + list(node.children_recursive) if o.type == 'MESH']
        off = Vector(g.get('offset', (0, 0, 0)))
        for o in kids:
            me = o.data.copy()
            me.transform(o.matrix_world)
            for v in me.vertices:   # Blender (z up) -> car coordinates, then the offset
                v.co = Vector((v.co.x, v.co.z, -v.co.y)) * g.get('scale', 1) + off
            ob = bpy.data.objects.new(name, me)
            coll.objects.link(ob)
            pieces.append(ob)
        for o in new:
            bpy.data.objects.remove(o)
    if not pieces:
        raise SystemExit('part %s: no geometry' % name)
    if len(pieces) > 1:
        with bpy.context.temp_override(scene=scn, view_layer=scn.view_layers[0], active_object=pieces[0], object=pieces[0], selected_objects=pieces, selected_editable_objects=pieces):
            bpy.ops.object.join()
    ob = pieces[0]
    ob.name = ob.data.name = name
    if pt.get('weld'):   # welded first: some unwelded meshes won't decimate (others decimate worse welded)
        bm = bmesh.new(); bm.from_mesh(ob.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=pt['weld'])
        bm.to_mesh(ob.data); bm.free()
    r = ratio_for(name) if not pt.get('graft') else pt['graft'].get('decimate', 1.0)
    ntri = lambda: sum(len(p.vertices) - 2 for p in ob.data.polygons)
    target = r * ntri()
    for _ in range(4):   # a collapse can stop short (many small islands): go again until near the target
        if ntri() < 1.25 * target or r >= 0.999:
            break
        md = ob.modifiers.new('dec', 'DECIMATE')
        md.ratio = max(0.02, target / ntri())
        md.use_collapse_triangulate = True
        with bpy.context.temp_override(scene=scn, view_layer=scn.view_layers[0]):
            d2 = bpy.context.evaluated_depsgraph_get()
            d2.update()
            new = bpy.data.meshes.new_from_object(ob.evaluated_get(d2), depsgraph=d2)
        ob.modifiers.clear()
        old = ob.data
        ob.data = new
        bpy.data.meshes.remove(old)
    geo[name] = ob

# ---------------------------------------------------------------- pivots, the hierarchy, Blender axes
nodes = {pt['name']: pt for pt in cfg['parts']}


def extent(ob):
    vs = [v.co for v in ob.data.vertices]
    return Vector((min(v[i] for v in vs) for i in range(3))), Vector((max(v[i] for v in vs) for i in range(3)))


pivot = {}
for name, ob in geo.items():
    pt = nodes[name]
    lo, hi = extent(ob)
    if 'pivot' in pt:
        p = Vector(pt['pivot'])
    else:   # a wheel's hub, else the part's centre
        p = (lo + hi) / 2
        if name.startswith('WHEEL_') and cfg['type'] == 'bike':
            p.z = 0
    pivot[name] = p
for name, ob in geo.items():
    me = ob.data
    for v in me.vertices:   # car coordinates about the pivot -> Blender axes
        v.co = bl(v.co - pivot[name])
    me.update()
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(cfg.get('sharpAngle', 35)))
    ob.location = bl(pivot[name])
for name, ob in geo.items():
    par = nodes[name].get('parent')
    if par:
        ob.parent = geo[par]
        ob.location = bl(pivot[name]) - bl(pivot[par])

# ---------------------------------------------------------------- measurements (car coordinates) and checks
with bpy.context.temp_override(scene=scn, view_layer=scn.view_layers[0]):
    bpy.context.view_layer.update()
allv = []
per = {}
for name, ob in geo.items():
    mw = ob.matrix_world
    P = [(lambda q: (q.x, q.z, -q.y))(mw @ v.co) for v in ob.data.vertices]
    per[name] = ([min(p[i] for p in P) for i in range(3)], [max(p[i] for p in P) for i in range(3)])
    allv += P
lo = [min(p[i] for p in allv) for i in range(3)]
hi = [max(p[i] for p in allv) for i in range(3)]
L, H, W = hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]
problems = []
if abs(lo[1]) > 0.01:
    problems.append('stands at %.4f m, not on the ground (lowest: %s)' % (lo[1], min(per, key=lambda n: per[n][0][1])))
wheels = [n for n in geo if n.startswith('WHEEL_')]
if cfg['type'] == 'bike':
    for n in wheels:
        if abs(pivot[n].z) > 1e-6:
            problems.append('%s off the centre line' % n)
total = sum(pt.get('mass', 0) for pt in cfg['parts'])
if total > cfg['massKg'] + cfg.get('riderKg', 0) + 1e-6:
    problems.append('parts weigh %.0f kg, more than the %.0f kg vehicle' % (total, cfg['massKg'] + cfg.get('riderKg', 0)))
assert not problems, '; '.join(problems)

# the side silhouette, for the garage screen (as build-rig.py)
nsl = int(L / 0.04) + 1
stop, sbot = [None] * nsl, [None] * nsl
for name, ob in geo.items():
    mw = ob.matrix_world
    me = ob.data
    me.calc_loop_triangles()
    P = [(lambda q: (q.x, q.z))(mw @ v.co) for v in me.vertices]
    for tri in me.loop_triangles:
        a, b, c = (P[i] for i in tri.vertices)
        x0, x1 = min(a[0], b[0], c[0]), max(a[0], b[0], c[0])
        for i in range(max(0, int((x0 - lo[0]) / 0.04 - 0.5)), min(nsl, int((x1 - lo[0]) / 0.04 + 0.5) + 1)):
            xq = lo[0] + (i + 0.5) * 0.04
            ys = []
            for p, q in ((a, b), (b, c), (c, a)):
                if (p[0] - xq) * (q[0] - xq) <= 0 and p[0] != q[0]:
                    ys.append(p[1] + (xq - p[0]) / (q[0] - p[0]) * (q[1] - p[1]))
            if ys:
                stop[i] = max(ys) if stop[i] is None else max(stop[i], max(ys))
                sbot[i] = min(ys) if sbot[i] is None else min(sbot[i], min(ys))
prof_top = [[round((i + 0.5) * 0.04, 3), round(stop[i], 4)] for i in range(nsl) if stop[i] is not None]
prof_bot = [[round((i + 0.5) * 0.04, 3), round(sbot[i], 4)] for i in range(nsl) if sbot[i] is not None]


def r4(v):
    return [round(float(x), 4) for x in v]


def radius(n):
    return max(math.hypot(v.co.x, v.co.z) for v in geo[n].data.vertices)   # about the axle (Blender y)


if cfg['type'] == 'bike':
    fp, rp = pivot['WHEEL_F'], pivot['WHEEL_R']
    hubs = {'FL': [fp.x, fp.y, 0], 'FR': [fp.x, fp.y, 0], 'RL': [rp.x, rp.y, 0], 'RR': [rp.x, rp.y, 0]}
    wheel_r = radius('WHEEL_F')
elif cfg['type'] == 'heavy':   # a traffic vehicle's model (the Destruction mode's lorries): no wheels of its own to drive
    hubs, wheel_r = {}, 0
else:   # tracked (and the six-wheeled armoured car, driven like one): the outer wheels
    xs_ = sorted(set(round(pivot[n].x, 4) for n in wheels))
    zr = max(abs(pivot[n].z) for n in wheels)
    y = sum(pivot[n].y for n in wheels) / len(wheels)
    hubs = {'FL': [xs_[-1], y, -zr], 'FR': [xs_[-1], y, zr], 'RL': [xs_[0], y, -zr], 'RR': [xs_[0], y, zr]}
    wheel_r = y
cr = cfg.get('credit') or {}
phys = {
    'name': KEY, 'title': cfg['title'], 'type': cfg['type'], 'credit': cr,
    'length': round(L, 4), 'width': round(W, 4), 'height': round(H, 4), 'xMin': round(lo[0], 4),
    'lo': r4(lo), 'hi': r4(hi),
    'hubs': {k: r4(v) for k, v in hubs.items()}, 'wheelRadius': round(wheel_r, 4),
    'massKg': cfg['massKg'], 'riderKg': cfg.get('riderKg', 0),
    'parts': [{'name': pt['name'], 'parent': pt.get('parent'), 'pivot': r4(pivot[pt['name']]), 'axis': pt.get('axis'), 'mass': pt.get('mass', 0),
               'breakDv': pt.get('breakDv'), 'lo': r4(per[pt['name']][0]), 'hi': r4(per[pt['name']][1])} for pt in cfg['parts']],
    'lamps': cfg.get('lamps'), 'hover': None,
    'profileTop': prof_top, 'profileBottom': prof_bot,
}

# ---------------------------------------------------------------- export: glTF axes are the car's (y up, z right)
tmp = os.path.join(os.environ.get('TEMP', '.'), 'crashlab-rig-%s.glb' % KEY)
with bpy.context.temp_override(scene=scn):
    bpy.ops.export_scene.gltf(filepath=tmp, export_format='GLB', use_active_scene=True, use_selection=False,
                              export_texcoords=False, export_normals=True, export_materials='EXPORT', export_vertex_color='NONE',
                              export_yup=True, export_apply=False, export_animations=False, export_skins=False,
                              export_morph=False, export_cameras=False, export_lights=False,
                              export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
                              export_draco_position_quantization=14, export_draco_normal_quantization=10)
glb = open(tmp, 'rb').read()
head = '/* Generated by tools/export-rig.py from %s. Do not edit; re-run the exporter.\n * Model: "%s" by %s, %s, %s */\n' % (
    os.path.basename(cfg['source']), cr.get('title', ''), cr.get('author', ''), cr.get('license', ''), cr.get('url', ''))
with open(os.path.join(ROOT, 'models', KEY + '.glb.js'), 'w', encoding='utf-8', newline='\n') as fo:
    fo.write(head + "(window.CAR_ASSETS = window.CAR_ASSETS || {})['%s'] = '%s';\n" % (KEY, base64.b64encode(glb).decode('ascii')))
with open(os.path.join(ROOT, 'models', KEY + '.phys.js'), 'w', encoding='utf-8', newline='\n') as fo:
    fo.write(head + "(function (root) {\nconst data = " + json.dumps(phys, separators=(',', ':')) +
             ";\n(root.RIG_PHYS = root.RIG_PHYS || {})['%s'] = data;\nif (typeof module === 'object' && module.exports) module.exports = data;\n})(typeof window !== 'undefined' ? window : globalThis);\n" % KEY)
tris = sum(len(p.vertices) - 2 for ob in geo.values() for p in ob.data.polygons)
print('=== RIG %s: %d parts, %d tris, GLB %.0f KB, L %.3f W %.3f H %.3f, wheel R %.3f, hubs %s' % (KEY, len(geo), tris, len(glb) / 1024, L, W, H, wheel_r, phys['hubs']))
for name, ob in geo.items():
    print('   %-16s tris %6d pivot %s' % (name, sum(len(p.vertices) - 2 for p in ob.data.polygons), r4(pivot[name])))
