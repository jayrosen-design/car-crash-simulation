"""Builds one of the garage's original road cars in Blender from its spec, ready for export-car.py.

    blender -b -Y --factory-startup --python tools/build-vehicle.py -- tools/vehicles/cadence.json
    blender -b -Y --factory-startup --python tools/export-car.py -- tools/cars/cadence.json

The spec (tools/vehicles/<key>.json) is the car's side view in metres, traced from the garage design
video: u runs from the rear bumper (0) to the front (length), y is up. It holds the top and bottom
profiles, the side windows, wheels, lamps, mirror, trim decals and extras (wing, fin, roof rack).

The body is lofted along u: each station's cross-section is a rounded lower body up to the beltline,
a greenhouse leaning in (tumblehome) up to a cambered roof. Wheel arches (and a pickup's bed) are cut
with booleans. The body is then split into the parts the crash solver knows (DEFORM_BumperF/R, Hood,
FenderL/R, DoorFL/FR/RL/RR, Trunk, RIGID_Cage_Body), and the panes are added on top of it: side,
front and rear glass (BRITTLE_Glass*), lamps (BRITTLE_Light*), mirrors (BREAKAWAY_Mirror*) and trim.

Writes tools/out/vehicles/<key>.blend (tools/out/ is not committed) and tools/cars/<key>.json, the
exporter config, so export-car.py turns it into models/<key>.glb.js and models/<key>.phys.js exactly
as it does the photographed cars. Blender axes here: x forward (centred), y left, z up.
"""
import bpy, bmesh, json, math, os, sys
from mathutils import Vector
from mathutils.geometry import tessellate_polygon

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SPEC_PATH = os.path.abspath(args[0])
ROOT = os.path.abspath(os.path.join(os.path.dirname(SPEC_PATH), '..', '..'))
S = json.load(open(SPEC_PATH, encoding='utf-8'))
KEY = S['key']
L, W, H = S['length'], S['width'], S['height']
STYLE = S['style']

# per body style: plan-view rounding at the nose and tail (m), roof width over body width, roof camber
STYLES = {
    'sedan': dict(nose=0.38, tail=0.30, roof=0.80, camber=0.06),
    'coupe': dict(nose=0.45, tail=0.34, roof=0.76, camber=0.06),
    'hatch': dict(nose=0.36, tail=0.22, roof=0.82, camber=0.06),
    'suv': dict(nose=0.26, tail=0.18, roof=0.88, camber=0.05),
    'pickup': dict(nose=0.26, tail=0.10, roof=0.88, camber=0.05),
    'proto': dict(nose=0.62, tail=0.30, roof=0.56, camber=0.08),
}
ST = STYLES[STYLE]


def srgb(h):
    """'#rrggbb' -> linear rgb (Blender base colours are linear)."""
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


def interp(poly, u):
    if u <= poly[0][0]:
        return poly[0][1]
    if u >= poly[-1][0]:
        return poly[-1][1]
    lo, hi = 0, len(poly) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if poly[mid][0] <= u:
            lo = mid
        else:
            hi = mid
    (u0, a), (u1, b) = poly[lo], poly[hi]
    return a + (b - a) * (u - u0) / max(1e-9, u1 - u0)


def smoothed(poly, su=0.035, sy=0.02):
    """Resample at 1 cm and smooth with a bilateral filter: the trace's pixel steps go, real edges such
    as a pickup's cab back stay."""
    poly = sorted(poly)
    us = [poly[0][0] + i * 0.01 for i in range(int((poly[-1][0] - poly[0][0]) / 0.01) + 1)]
    ys = [interp(poly, u) for u in us]
    out = []
    k = int(3 * su / 0.01)
    for i, (u, y) in enumerate(zip(us, ys)):
        wsum = ysum = 0.0
        for j in range(max(0, i - k), min(len(us), i + k + 1)):
            w = math.exp(-((us[j] - u) / su) ** 2 / 2 - ((ys[j] - y) / sy) ** 2 / 2)
            wsum += w
            ysum += w * ys[j]
        out.append((u, ysum / wsum))
    return out


TOP = smoothed(S['top'])
BOT = smoothed(S['bottom'])


def top(u):
    return interp(TOP, u)


def bottom(u):
    return min(interp(BOT, u), top(u) - 0.12)


# the beltline: a straight line fitted through the side windows' bottom edges
pts = [p for g in S['glass'] for p in g['bottom']]
n = len(pts)
su, sy, suu, suy = sum(p[0] for p in pts), sum(p[1] for p in pts), sum(p[0] ** 2 for p in pts), sum(p[0] * p[1] for p in pts)
BELT_B = (n * suy - su * sy) / max(1e-9, n * suu - su * su)
BELT_A = (sy - BELT_B * su) / n


def belt(u):
    return BELT_A + BELT_B * u


HW = W / 2 - 0.005   # the panes stand 5 mm proud, so the exported width comes out at W


def plan_hw(u):
    """Plan-view half-width: full along the middle, rounded at the nose and tail."""
    a = 0.72
    d = L - u
    if d < ST['nose']:
        t = 1 - d / ST['nose']
        return HW * (a + (1 - a) * math.sqrt(max(0.0, 1 - t * t)))
    if u < ST['tail']:
        t = 1 - u / ST['tail']
        return HW * (a + (1 - a) * math.sqrt(max(0.0, 1 - t * t)))
    return HW


def section(u):
    """The cross-section's numbers at station u."""
    yb, yt = bottom(u), top(u)
    hw = plan_hw(u)
    cam = min(ST['camber'], 0.35 * (yt - yb))
    ys = min(belt(u), yt - cam)                   # shoulder: the beltline, or just under the top
    ys = max(ys, yb + 0.5 * (yt - yb))
    yre = max(ys, yt - cam)                       # roof edge
    hwg0 = hw - 0.035                             # the greenhouse starts a little in from the shoulder
    gh = yre - ys
    t = min(1.0, gh / 0.25)
    t = t * t * (3 - 2 * t)
    hwr = hwg0 - (hwg0 - hw * ST['roof']) * t     # roof half-width (tumblehome)
    return dict(yb=yb, yt=yt, hw=hw, ys=ys, yre=yre, hwg0=hwg0, hwr=hwr, cam=yt - yre)


LAMP_Y = sorted(set(round(v, 4) for l in S['lamps'] for v in l['y']))
SIDE_ROWS = sorted(set([round(0.075 * i, 4) for i in range(1, 30)] + LAMP_Y))
RB, RS = 0.05, 0.035     # bottom corner and shoulder radii
LAMP_IN = 0.62           # lamps on the nose and tail reach in to this fraction of the half-width
CAP_COLS = (0.0, 0.3, LAMP_IN, 1.0)   # the end caps' columns, as fractions of the half-width


def half_section(u):
    """(z, y) from the bottom centre round the right side to the top centre; the same count at every u."""
    s = section(u)
    yb, yt, hw, ys, yre, hwg0, hwr = s['yb'], s['yt'], s['hw'], s['ys'], s['yre'], s['hwg0'], s['hwr']
    zb = hw - RB
    out = [(0.0, yb)] + [(f * zb, yb) for f in CAP_COLS[1:]]
    for k in (1, 2):
        th = math.radians(30 * k)
        out.append((hw - RB + RB * math.sin(th), yb + RB - RB * math.cos(th)))
    lo = yb + RB
    hi = max(lo, ys - RS)
    # the side's rows sit at the same absolute heights at every station (clamped into this side's span),
    # so each row runs straight along the car and lamp edges stay level
    for y in [lo] + [min(hi, max(lo, h)) for h in SIDE_ROWS] + [hi]:
        t = (y - lo) / (hi - lo) if hi > lo else 0.5
        out.append((hw * (1 - 0.03 * (2 * t - 1) ** 2), y))
    out.append((hw - 0.012, ys - 0.012))
    out.append((hwg0, ys))
    for i in (1, 2, 3, 4):
        t = i / 4
        out.append((hwg0 + (hwr - hwg0) * t, ys + (yre - ys) * t))
    cam = yt - yre
    for f in (0.96, 0.86, 0.68, 0.4, 0.0):
        z = hwr * f
        out.append((z, yre + cam * (max(0.0, 1 - f ** 3)) ** (1 / 3)))
    return out


def cap_y(u, z):
    """Height of the top surface at station u, lateral offset z (the roof camber)."""
    s = section(u)
    f = min(1.0, abs(z) / max(1e-6, s['hwr']))
    return s['yre'] + s['cam'] * (max(0.0, 1 - f ** 3)) ** (1 / 3)


def side_z(u, y):
    """Half-width of the body at station u and height y."""
    s = section(u)
    if y >= s['yre']:
        c = max(1e-6, s['cam'])
        f = min(1.0, (y - s['yre']) / c)
        return s['hwr'] * (max(0.0, 1 - f ** 3)) ** (1 / 3)
    if y >= s['ys']:
        t = (y - s['ys']) / max(1e-6, s['yre'] - s['ys'])
        return s['hwg0'] + (s['hwr'] - s['hwg0']) * t
    lo = s['yb'] + RB
    hi = max(lo, s['ys'] - RS)
    t = min(1.0, max(0.0, (y - lo) / (hi - lo))) if hi > lo else 0.5
    return s['hw'] * (1 - 0.03 * (2 * t - 1) ** 2)


def bl(u, y, z):
    """Car side view (u, y) plus car lateral z (+ = right) -> Blender coordinates."""
    return Vector((u - L / 2, -z, y))


# ---------------------------------------------------------------- materials
MATS = {}


def material(name, hexcol, metal=0.0, rough=0.5, emit=False):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    if not m.node_tree:
        m.use_nodes = True
    nt = m.node_tree
    col = srgb(hexcol)
    m.diffuse_color = (col[0], col[1], col[2], 1)
    bsdf = next((nd for nd in nt.nodes if nd.type == 'BSDF_PRINCIPLED'), None)
    if emit:
        if bsdf:
            nt.nodes.remove(bsdf)
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Color'].default_value = (col[0], col[1], col[2], 1)
        out = next(nd for nd in nt.nodes if nd.type == 'OUTPUT_MATERIAL')
        nt.links.new(em.outputs[0], out.inputs[0])
    else:
        bsdf.inputs['Base Color'].default_value = (col[0], col[1], col[2], 1)
        bsdf.inputs['Metallic'].default_value = metal
        bsdf.inputs['Roughness'].default_value = rough
    MATS[name] = m
    return m


M_PAINT = material('paint', S['paint']['hex'], 0.3, 0.35)
M_UNDER = material('under', '#17181b', 0, 0.9)
M_ARCH = material('arch', '#0c0d0f', 0, 0.95)
M_CABIN = material('cabin', '#1d1e22', 0, 0.8)
M_STRIP = material('strip', '#2f3134', 0, 0.7)
M_GLASS = material('glass', '#382a61', 0, 0.05)
TRIM_NAMES = ['under', 'arch', 'cabin', 'strip']


def trim_material(hexcol):
    name = 'trim_' + hexcol[1:]
    if name not in TRIM_NAMES:
        TRIM_NAMES.append(name)
    return material(name, hexcol, 0.2, 0.6)


CHROME_NAMES = []


def decal_material(hexcol):
    c = [int(hexcol[i:i + 2], 16) for i in (1, 3, 5)]
    if max(c) >= 85:   # the video's light grey strips and bumpers: chrome
        name = 'chrome_' + hexcol[1:]
        if name not in CHROME_NAMES:
            CHROME_NAMES.append(name)
        return material(name, hexcol, 1.0, 0.2)
    return trim_material(hexcol)


# ---------------------------------------------------------------- the lofted body
def loft():
    du = 0.03
    nst = max(2, int(math.ceil(L / du)))
    us = [L * i / nst for i in range(nst + 1)]
    rings = []
    for u in us:
        h = half_section(u)
        full = h + [(-z, y) for (z, y) in h[-2:0:-1]]
        rings.append([(u, y, z) for (z, y) in full])
    bm = bmesh.new()
    vr = [[bm.verts.new(bl(u, y, z)) for (u, y, z) in r] for r in rings]
    m = len(vr[0])
    for i in range(len(vr) - 1):
        a, b = vr[i], vr[i + 1]
        for k in range(m):
            q = (a[k], a[(k + 1) % m], b[(k + 1) % m], b[k])
            if len(set(q)) == 4:
                try:
                    bm.faces.new(q)
                except ValueError:
                    pass
    # end caps: rows across the width between the section's points (they rise monotonically up the side),
    # split into columns at CAP_COLS, so the cap is a grid and lamp edges on it are straight
    nb = len(CAP_COLS) - 1          # index of the outermost bottom point in the half-section
    nh = (m + 2) // 2               # half-section length
    for ring, flip in ((vr[0], True), (vr[-1], False)):
        right = ring[:nh]                                  # bottom centre .. top centre, right side
        left = [ring[0]] + ring[m - 1:nh - 1:-1] + [ring[nh - 1]]   # the mirror points, same order
        rows = []
        for k in range(nb, nh):
            pr, pl = right[k].co, left[k].co
            row = [left[k]]
            for f in [-c for c in reversed(CAP_COLS[1:-1])] + [0.0] + list(CAP_COLS[1:-1]):
                if k == nb:
                    j = CAP_COLS.index(abs(f))
                    row.append(left[j] if f < 0 else right[j])
                else:
                    t = (f + 1) / 2
                    row.append(bm.verts.new(pl.lerp(pr, t)))
            row.append(right[k])
            rows.append(row)
        for r0, r1 in zip(rows, rows[1:]):
            for c in range(len(r0) - 1):
                q = (r0[c], r0[c + 1], r1[c + 1], r1[c])
                if flip:
                    q = tuple(reversed(q))
                if len(set(q)) == 4:
                    try:
                        bm.faces.new(q)
                    except ValueError:
                        pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new('body')
    bm.to_mesh(me)
    bm.free()
    me.materials.append(M_PAINT)
    return me


scn = bpy.context.scene
for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob)
body = bpy.data.objects.new('src.body', loft())
scn.collection.objects.link(body)

# ---------------------------------------------------------------- wheel arches (and a pickup's bed) by boolean
WH = S['wheels']
R, RIM, TW = WH['radius'], WH['rim'], WH['width']
HUB_Z = HW - TW / 2 - 0.03            # hub's lateral offset (car z)
ARCH_R = R + 0.045


def cutter():
    bm = bmesh.new()
    for uw in (WH['rear'], WH['front']):
        for side in (-1, 1):
            z0, z1 = HUB_Z - TW / 2 - 0.05, HW + 0.4
            zc = side * (z0 + z1) / 2
            c = bl(uw, R, zc)
            from mathutils import Matrix
            mat = Matrix.Translation(c) @ Matrix.Rotation(math.pi / 2, 4, 'X')
            bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=48, radius1=ARCH_R, radius2=ARCH_R, depth=z1 - z0, matrix=mat)
    if 'bed' in S:
        b = S['bed']
        u0, u1 = b['u'][0] + 0.07, b['u'][1] - 0.04
        y0, y1 = b['rail'] - b['depth'], b['rail'] + 1.0
        zh = HW - 0.075
        from mathutils import Matrix
        mat = Matrix.Translation(bl((u0 + u1) / 2, (y0 + y1) / 2, 0)) @ Matrix.Diagonal((u1 - u0, 2 * zh, y1 - y0, 1))
        # a fine grid on the bed's floor: the exporter reads the profile from vertices near the centre line
        bm2 = bmesh.new()
        bmesh.ops.create_cube(bm2, size=1.0, matrix=mat)
        bmesh.ops.subdivide_edges(bm2, edges=bm2.edges[:], cuts=24, use_grid_fill=True)
        for f in bm2.faces:
            f.material_index = 1
        tmp = bpy.data.meshes.new('bed')
        bm2.to_mesh(tmp)
        bm2.free()
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    me = bpy.data.meshes.new('cutter')
    bm.to_mesh(me)
    bm.free()
    me.materials.append(M_ARCH)
    me.materials.append(material('bedliner', '#26272b', 0, 0.85))
    ob = bpy.data.objects.new('cutter', me)
    scn.collection.objects.link(ob)
    return ob


cut = cutter()
md = body.modifiers.new('cut', 'BOOLEAN')
md.operation = 'DIFFERENCE'
md.object = cut
md.solver = 'EXACT'
md.material_mode = 'TRANSFER'
dg = bpy.context.evaluated_depsgraph_get()
dg.update()
new = bpy.data.meshes.new_from_object(body.evaluated_get(dg), depsgraph=dg)
body.modifiers.clear()
old = body.data
body.data = new
bpy.data.meshes.remove(old)
bpy.data.objects.remove(cut)
for nm in ('arch', 'bedliner', 'under', 'cabin', 'strip'):
    if MATS[nm].name not in [m.name for m in body.data.materials]:
        body.data.materials.append(MATS[nm])
MI = {m.name: i for i, m in enumerate(body.data.materials)}

# ---------------------------------------------------------------- landmarks along the car
def scan(u0, u1, step, pred):
    k = int(abs(u1 - u0) / step)
    for i in range(k + 1):
        u = u0 + (u1 - u0) * i / max(1, k)
        if pred(u):
            return u
    return None


gh = lambda u: top(u) - belt(u) > 0.05
G0 = min(p[0] for g in S['glass'] for p in g['bottom'])
G1 = max(p[0] for g in S['glass'] for p in g['bottom'])
def slope(u):
    return (top(u + 0.04) - top(u - 0.04)) / 0.08


# the windshield's foot: forward from the side windows' front edge, where the windshield's steep slope
# levels out onto the hood (the hood can stand above the beltline, as on the SUV)
U_COWL = scan(G1, L, 0.005, lambda u: top(u) - belt(u) < 0.05 or (u > G1 + 0.08 and slope(u) > -0.3)) or G1
# the rear window's foot: back from the side windows' rear edge, where the slope levels out onto the deck
U_GH_REAR = scan(G0, 0, 0.005, lambda u: top(u) - belt(u) < 0.05 or (u < G0 - 0.08 and slope(u) < 0.3))
U_GH_REAR = 0.0 if U_GH_REAR is None else U_GH_REAR
ROOF = max(top(u / 100) for u in range(int(U_GH_REAR * 100), int(U_COWL * 100) + 1))

U_WS_TOP = scan(U_COWL, U_GH_REAR, 0.005, lambda u: slope(u) > -0.4 and top(u) > ROOF - 0.12) or (U_COWL - 0.6)
U_RW_TOP = scan(U_GH_REAR, U_COWL, 0.005, lambda u: slope(u) < 0.4 and top(u) > ROOF - 0.12) or (U_GH_REAR + 0.5)
if 'screens' in S:   # where the profile alone can't place them (the prototype's canopy)
    U_WS_TOP, U_COWL = S['screens'].get('ws', (U_WS_TOP, U_COWL))
    U_GH_REAR, U_RW_TOP = S['screens'].get('rear', (U_GH_REAR, U_GH_REAR))
D_BF, D_BR = 0.30, 0.26                     # bumper depths
U_WF = WH['front'] - ARCH_R - 0.02          # rear edge of the front arch
U_DOOR_F = min(U_COWL + 0.03, U_WF)         # the front doors' front edge
# door cuts from the spec (rear edges); with none, the doors end at the back of the front side window
CUTS = sorted(S.get('doorCuts', [])) or [min(p[0] for p in max(S['glass'], key=lambda g: g['bottom'][-1][0])['bottom'])]
if S['doors'] == 4:
    DOOR_F = (CUTS[-1], U_DOOR_F)
    DOOR_R = (CUTS[0], CUTS[-1])
else:
    DOOR_F = (CUTS[-1], U_DOOR_F)
    DOOR_R = None
Y_BUMP_F = bottom(L - D_BF) + 0.55 * (top(L - D_BF) - bottom(L - D_BF))
Y_BUMP_R = bottom(D_BR) + 0.5 * (top(D_BR) - bottom(D_BR))
print('=== landmarks: cowl %.2f ws-top %.2f gh-rear %.2f rw-top %.2f roof %.2f belt %.3f+%.3fu doorF %s doorR %s' % (
    U_COWL, U_WS_TOP, U_GH_REAR, U_RW_TOP, ROOF, BELT_A, BELT_B, DOOR_F, DOOR_R))

# side window outlines in (u, y), bottoms on the beltline
WINDOWS = []
for g in S['glass']:
    tp = smoothed(g['top'], 0.03, 0.015)
    us = [p[0] for p in tp][::2]
    WINDOWS.append([(u, belt(u) + 0.004, min(interp(tp, u), section(u)['yre'] + 0.01)) for u in us])


def in_window(u, y):
    for w in WINDOWS:
        if w[0][0] <= u <= w[-1][0]:
            lo = interp([(p[0], p[1]) for p in w], u)
            hi = interp([(p[0], p[2]) for p in w], u)
            if lo + 0.01 <= y <= hi - 0.01:   # well inside, so the dark faces stay under the glass
                return True
    return False


def in_screen(u, y, z):
    """Under the windshield or rear window (the top surface between the pillars)."""
    s = section(u)
    if abs(z) > s['hwr'] - 0.07 or y < belt(u) + 0.02:
        return False
    if U_WS_TOP <= u <= U_COWL:
        return True
    if U_GH_REAR <= u <= U_RW_TOP and y > belt(u) + 0.05 and y < ROOF - 0.04:
        return True
    return False


# ---------------------------------------------------------------- parts by face
def part_of(c, nrm):
    """Part name for a body face with centre c and normal nrm (car coords: u, y, z; n_u, n_y, n_z)."""
    u, y, z = c
    nu, ny, nz = nrm
    side = 'L' if z < 0 else 'R'
    if ny < -0.6:
        return 'RIGID_Cage_Body'                       # underbody: keeps the body's x extent bumper to bumper
    s = section(u)
    if u > L - D_BF and (y < Y_BUMP_F or nu > 0.55):
        return 'DEFORM_BumperF'
    if u < D_BR and (y < Y_BUMP_R or (nu < -0.55 and y < belt(u) - 0.02 and 'bed' not in S)) and not (nu < -0.55 and y > Y_BUMP_R):
        return 'DEFORM_BumperR'
    if u < D_BR + 0.02 and nu < -0.55 and y >= Y_BUMP_R and y < belt(u) + 0.02:
        return 'DEFORM_Trunk'                          # a tailgate or bootlid's back face
    if ny > 0.45 and U_COWL - 0.02 <= u <= L - D_BF + 0.03 and abs(z) < s['hw'] - 0.05 and y >= Y_BUMP_F - 0.02:
        return 'DEFORM_Hood'
    if ny > 0.45 and D_BR - 0.02 <= u <= U_GH_REAR - 0.02 and abs(z) < s['hw'] - 0.05 and 'bed' not in S:
        return 'DEFORM_Trunk'
    if abs(nz) > 0.35 and y > s['yb'] + 0.02 and y <= s['yre'] + 0.01:
        if DOOR_F[0] <= u <= DOOR_F[1]:
            return 'DEFORM_DoorF' + side
        if DOOR_R and DOOR_R[0] <= u <= DOOR_R[1]:
            return 'DEFORM_DoorR' + side
        if U_DOOR_F < u <= L - D_BF + 0.02 and y < s['ys'] + 0.01:
            return 'DEFORM_Fender' + side
    return 'RIGID_Cage_Body'


me = body.data
labels = []
for f in me.polygons:
    c = f.center
    cc = (c.x + L / 2, c.z, -c.y)
    nn = (f.normal.x, f.normal.z, -f.normal.y)
    mname = me.materials[f.material_index].name
    if mname in ('arch', 'bedliner'):
        labels.append('RIGID_Cage_Body')
        continue
    p = part_of(cc, nn)
    labels.append(p)
    u, y, z = cc
    if nn[1] < -0.6:
        f.material_index = MI['under']
    elif abs(nn[2]) > 0.3 and in_window(u, y):
        f.material_index = MI['cabin']
    elif in_screen(u, y, z):
        f.material_index = MI['cabin']
    elif y < section(u)['yb'] + RB and nn[1] < 0.3:
        f.material_index = MI['strip']


def split_by_label(src, labels):
    out = {}
    for name in sorted(set(labels)):
        bm = bmesh.new()
        bm.from_mesh(src.data)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if labels[f.index] != name], context='FACES')
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
        me2 = bpy.data.meshes.new(name)
        bm.to_mesh(me2)
        bm.free()
        for m in src.data.materials:
            me2.materials.append(m)
        ob = bpy.data.objects.new('src.' + name, me2)
        scn.collection.objects.link(ob)
        out[name] = ob
    return out


# lamps: copies of the body faces under each lamp, 4 mm proud
def lamp_faces():
    res = {}
    for lp in S['lamps']:
        head = lp['kind'] == 'head'
        mat = material('lamp_head' if head else 'lamp_tail', lp['color'] if not lp.get('slit') else '#ec8c34', emit=head)
        for f in me.polygons:
            c = f.center
            u, y, z = c.x + L / 2, c.z, -c.y
            vy = [me.vertices[vi].co.z for vi in f.vertices]
            if not (lp['y'][0] - 0.004 <= min(vy) and max(vy) <= lp['y'][1] + 0.004) or abs(f.normal.z) > 0.6:
                continue                                     # wholly in the lamp's band, not on the hood or deck
            if head and u < lp['u'][0] - 0.005 or not head and u > lp['u'][1] + 0.005:
                continue
            hw_end = plan_hw(L if head else 0)
            if abs(z) < LAMP_IN * hw_end - 0.005:
                continue
            nm = ('BRITTLE_LightH' if head else 'BRITTLE_LightT') + ('L' if z < 0 else 'R')
            res.setdefault(nm, []).append((f.index, mat))
    objs = {}
    for nm, lst in res.items():
        bm = bmesh.new()
        idx = {}
        for fi, mat in lst:
            f = me.polygons[fi]
            vs = []
            for vi in f.vertices:
                if vi not in idx:
                    v = me.vertices[vi]
                    idx[vi] = bm.verts.new(v.co + v.normal * 0.004)
                vs.append(idx[vi])
            try:
                bm.faces.new(vs)
            except ValueError:
                pass
        me2 = bpy.data.meshes.new(nm)
        bm.to_mesh(me2)
        bm.free()
        me2.materials.append(lst[0][1])
        ob = bpy.data.objects.new('src.' + nm, me2)
        scn.collection.objects.link(ob)
        objs[nm] = ob
    return objs


me.calc_normals_split() if hasattr(me, 'calc_normals_split') else None
lamps = lamp_faces()
parts = split_by_label(body, labels)
bpy.data.objects.remove(body)


# ---------------------------------------------------------------- panes on the body
def mesh_object(name, verts, faces, mats):
    me2 = bpy.data.meshes.new(name)
    me2.from_pydata([tuple(v) for v in verts], [], faces)
    me2.update()
    for m in mats:
        me2.materials.append(m)
    ob = bpy.data.objects.new('src.' + name, me2)
    scn.collection.objects.link(ob)
    return ob


def side_pane(cols, side, off=0.005):
    """A pane on the body side from columns [(u, y_bottom, y_top)], 3 rows high; side -1 left, +1 right."""
    verts, faces = [], []
    rows = 4
    for (u, y0, y1) in cols:
        for r in range(rows):
            y = y0 + (y1 - y0) * r / (rows - 1)
            verts.append(bl(u, y, side * (side_z(u, y) + off)))
    for i in range(len(cols) - 1):
        for r in range(rows - 1):
            a, b = i * rows + r, (i + 1) * rows + r
            faces.append((a, b, b + 1, a + 1) if side > 0 else (a, a + 1, b + 1, b))
    return verts, faces


def poly_pane(outline, side, off=0.004):
    """A flat-ish pane from a polygon outline [(u, y)] on the body side."""
    loop = [Vector((u, y, 0)) for (u, y) in outline]
    tris = tessellate_polygon([loop])
    verts = [bl(u, y, side * (side_z(u, y) + off)) for (u, y) in outline]
    faces = [tuple(t) if side > 0 else tuple(reversed(t)) for t in tris]
    return verts, faces


def screen_pane(u_a, u_b, y_min, y_max, off=0.005):
    """Windshield or rear window: the top surface between the pillars, from u_a to u_b."""
    us = [u_a + (u_b - u_a) * i / 200 for i in range(201)]
    pts = [(u, top(u)) for u in us]
    acc = [0.0]
    for i in range(1, len(pts)):
        acc.append(acc[-1] + math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
    rows, cols = 12, 9
    verts, faces = [], []
    grid = []
    for r in range(rows):
        s = acc[-1] * r / (rows - 1)
        j = min(range(len(acc)), key=lambda k: abs(acc[k] - s))
        u = us[j]
        row = []
        zr = section(u)['hwr'] - 0.07
        for c in range(cols):
            z = -zr + 2 * zr * c / (cols - 1)
            y = cap_y(u, z)
            if y < y_min or y > y_max:
                row.append(None)
                continue
            du = 0.01
            fu = (cap_y(u + du, z) - cap_y(u - du, z)) / (2 * du)
            fz = (cap_y(u, z + du) - cap_y(u, z - du)) / (2 * du) if zr > 0.02 else 0
            nn = Vector((-fu, 1, -fz)).normalized()
            p = Vector((u, y, z)) + nn * off
            row.append(len(verts))
            verts.append(bl(p.x, p.y, p.z))
        grid.append(row)
    for r in range(rows - 1):
        for c in range(cols - 1):
            q = (grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c])
            if None not in q:
                faces.append(q)
    return verts, faces


panes = {}
# side windows: front to back, F, then R (four doors) or Q, then Q
order = sorted(range(len(WINDOWS)), key=lambda i: -WINDOWS[i][0][0])
names = ['F', 'R', 'Q'] if S['doors'] == 4 else ['F', 'Q', 'Q2']
for k, wi in enumerate(order):
    tag = names[min(k, len(names) - 1)]
    for side, sl in ((-1, 'L'), (1, 'R')):
        v, f = side_pane([(u, y0, y1) for (u, y0, y1) in WINDOWS[wi] if y1 - y0 > 0.01], side)
        panes['BRITTLE_Glass' + tag + sl] = mesh_object('BRITTLE_Glass' + tag + sl, v, f, [M_GLASS])
v, f = screen_pane(U_COWL, U_WS_TOP, belt(U_COWL) + 0.02, ROOF + 0.05)
panes['BRITTLE_GlassWS'] = mesh_object('BRITTLE_GlassWS', v, f, [M_GLASS])
v, f = screen_pane(U_RW_TOP, U_GH_REAR, 0, ROOF - 0.04)
f = [t for t in f if min(v[i].z for i in t) > belt(U_GH_REAR) + 0.05]
if f:
    panes['BRITTLE_GlassRear'] = mesh_object('BRITTLE_GlassRear', v, f, [M_GLASS])

# decals: trim shapes from the video on both sides; each joins the part its middle sits on
decal_objs = []
for d in S.get('decals', []):
    mat = decal_material(d['color'])
    cu = sum(p[0] for p in d['outline']) / len(d['outline'])
    cy = sum(p[1] for p in d['outline']) / len(d['outline'])
    for side, sl in ((-1, 'L'), (1, 'R')):
        v, f = poly_pane(d['outline'], side)
        ob = mesh_object('decal', v, f, [mat])
        nz = side * 1.0
        decal_objs.append((ob, part_of((cu, cy, side * side_z(cu, cy)), (0, 0, nz))))


def box(name, c, size, mat, rot=None):
    bm = bmesh.new()
    from mathutils import Matrix
    m = Matrix.Translation(c) @ Matrix.Diagonal((size[0], size[1], size[2], 1))
    bmesh.ops.create_cube(bm, size=1.0, matrix=m)
    me2 = bpy.data.meshes.new(name)
    bm.to_mesh(me2)
    bm.free()
    me2.materials.append(mat)
    ob = bpy.data.objects.new('src.' + name, me2)
    scn.collection.objects.link(ob)
    return ob


# mirrors: a housing on a short arm at the front of the side windows (where the video shows none, at the
# windshield's foot)
mr = S.get('mirror') or {'u': [U_COWL - 0.2, U_COWL - 0.04], 'y': [belt(U_COWL) + 0.02, belt(U_COWL) + 0.12], 'color': '#6c6c70'}
if mr:
    um, ym = (mr['u'][0] + mr['u'][1]) / 2, (mr['y'][0] + mr['y'][1]) / 2
    zs = side_z(um, ym)
    mat = trim_material(mr.get('color', '#6c6c70'))
    for side, sl in ((-1, 'L'), (1, 'R')):
        hz = bl(um, ym, side * (zs + 0.10))
        a = box('mirror', hz, (0.16, 0.13, 0.11), mat)
        b = box('arm', bl(um + 0.02, ym - 0.03, side * (zs + 0.035)), (0.06, 0.07, 0.03), mat)
        bm = bmesh.new()
        for o in (a, b):
            bm.from_mesh(o.data)
        me2 = bpy.data.meshes.new('BREAKAWAY_Mirror' + sl)
        bm.to_mesh(me2)
        bm.free()
        me2.materials.append(mat)
        for o in (a, b):
            bpy.data.objects.remove(o)
        ob = bpy.data.objects.new('src.BREAKAWAY_Mirror' + sl, me2)
        scn.collection.objects.link(ob)
        panes['BREAKAWAY_Mirror' + sl] = ob

# extras: a wing, its struts and a fin (the prototype), roof rails (the SUV); part of the body
extra_objs = []
for e in S.get('extras', []):
    mat = trim_material(e['color'])
    u0, u1, y0, y1 = e['u'][0], e['u'][1], e['y'][0], e['y'][1]
    uc, yc = (u0 + u1) / 2, (y0 + y1) / 2
    if e['width'] == 'full':
        extra_objs.append(box('wing', bl(uc, yc, 0), (u1 - u0, W - 0.08, y1 - y0), mat))
        for side in (-1, 1):   # end plates
            extra_objs.append(box('plate', bl(uc, yc - 0.02, side * (W / 2 - 0.05)), (u1 - u0 + 0.04, 0.015, y1 - y0 + 0.08), mat))
    elif e['width'] == 'struts':
        yb = top(uc) - 0.04
        for side in (-1, 1):
            extra_objs.append(box('strut', bl(uc, (yb + y1) / 2, side * 0.32 * W), (u1 - u0, 0.02, y1 - yb), mat))
    elif e['width'] == 'fin':
        yb = min(top(u0), top(u1)) - 0.04
        extra_objs.append(box('fin', bl(uc, (yb + y1) / 2, 0), (u1 - u0, 0.025, y1 - yb), mat))
    elif e['width'] == 'rails':
        for side in (-1, 1):
            zr = section(uc)['hwr'] - 0.06
            yr = max(cap_y(uc, zr), y0)
            extra_objs.append(box('rail', bl(uc, yr + (y1 - y0) / 2, side * zr), (u1 - u0, 0.035, y1 - y0 + 0.01), mat))
            for uu in (u0 + 0.05, u1 - 0.05):
                extra_objs.append(box('foot', bl(uu, yr - 0.01, side * zr), (0.06, 0.04, 0.04), mat))


def join_into(target, objs):
    bm = bmesh.new()
    bm.from_mesh(target.data)
    mats = [m.name for m in target.data.materials]
    for o in objs:
        base = len(bm.faces)
        omats = [m.name for m in o.data.materials]
        for m in o.data.materials:
            if m.name not in mats:
                target.data.materials.append(m)
                mats.append(m.name)
        bm2 = bmesh.new()
        bm2.from_mesh(o.data)
        for f in bm2.faces:
            f.material_index = mats.index(omats[f.material_index])
        tmp = bpy.data.meshes.new('tmp')
        bm2.to_mesh(tmp)
        bm2.free()
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
        bpy.data.objects.remove(o)
    bm.to_mesh(target.data)
    bm.free()


join_into(parts['RIGID_Cage_Body'], extra_objs)
for part in sorted(set(p for _, p in decal_objs)):
    join_into(parts[part], [o for o, p in decal_objs if p == part])


# ---------------------------------------------------------------- wheels
def wheel(name, uw, side):
    """Tyre (revolved profile) plus rim disc and hub; the rim faces outboard."""
    seg = 36
    prof = [(RIM, -TW / 2 + 0.012), (R - 0.05, -TW / 2), (R - 0.012, -TW / 2 + 0.014), (R, -TW / 2 + 0.045),
            (R, TW / 2 - 0.045), (R - 0.012, TW / 2 - 0.014), (R - 0.05, TW / 2), (RIM, TW / 2 - 0.012)]
    verts, faces, mats = [], [], []
    c = bl(uw, R, side * HUB_Z)
    for k in range(seg):
        a = 2 * math.pi * k / seg
        for (r, w) in prof:
            verts.append(c + Vector((r * math.cos(a), side * -w, r * math.sin(a))))
    np_ = len(prof)
    for k in range(seg):
        k2 = (k + 1) % seg
        for j in range(np_ - 1):
            faces.append((k * np_ + j, k2 * np_ + j, k2 * np_ + j + 1, k * np_ + j + 1))
            mats.append(0)
    # rim: a disc recessed 1.5 cm from the outer face, and a hub boss
    def disc(radius, w_out, w_in, mi):
        base = len(verts)
        for k in range(seg):
            a = 2 * math.pi * k / seg
            verts.append(c + Vector((radius * math.cos(a), side * -w_out, radius * math.sin(a))))
            verts.append(c + Vector((radius * math.cos(a), side * -w_in, radius * math.sin(a))))
        faces.append(tuple(base + 2 * k for k in range(seg)))
        mats.append(mi)
        faces.append(tuple(base + 2 * k + 1 for k in reversed(range(seg))))
        mats.append(mi)
        for k in range(seg):
            k2 = (k + 1) % seg
            faces.append((base + 2 * k, base + 2 * k + 1, base + 2 * k2 + 1, base + 2 * k2))
            mats.append(mi)
    disc(RIM, TW / 2 - 0.015, -TW / 2 + 0.015, 1)
    disc(0.36 * RIM, TW / 2 - 0.003, TW / 2 - 0.02, 2)
    me2 = bpy.data.meshes.new(name)
    me2.from_pydata([tuple(v) for v in verts], [], faces)
    for f, mi in zip(me2.polygons, mats):
        f.material_index = mi
    me2.materials.append(material('tire', '#4d4e52', 0, 0.9))
    me2.materials.append(material('rim', '#e6e6ea', 0.8, 0.3))
    me2.materials.append(material('hub', '#86868c', 0.8, 0.35))
    bm = bmesh.new()
    bm.from_mesh(me2)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me2)
    bm.free()
    ob = bpy.data.objects.new(name, me2)
    scn.collection.objects.link(ob)
    return ob


wheels = {'FL': wheel('wheel.FL', WH['front'], -1), 'FR': wheel('wheel.FR', WH['front'], 1),
          'RL': wheel('wheel.RL', WH['rear'], -1), 'RR': wheel('wheel.RR', WH['rear'], 1)}

# ---------------------------------------------------------------- checks, then save the .blend and the exporter config
allp = dict(parts)
allp.update(panes)
allp.update(lamps)
need = ['RIGID_Cage_Body', 'DEFORM_BumperF', 'DEFORM_BumperR', 'DEFORM_Hood', 'DEFORM_FenderL', 'DEFORM_FenderR',
        'DEFORM_DoorFL', 'DEFORM_DoorFR', 'DEFORM_Trunk', 'BRITTLE_GlassWS',
        'BRITTLE_LightHL', 'BRITTLE_LightHR', 'BRITTLE_LightTL', 'BRITTLE_LightTR']
if S['doors'] == 4:
    need += ['DEFORM_DoorRL', 'DEFORM_DoorRR']
missing = [p for p in need if p not in allp or len(allp[p].data.polygons) == 0]
assert not missing, 'parts missing or empty: %s' % missing
for p, ob in allp.items():
    assert len(ob.data.polygons) > 0, 'empty part %s' % p
# export-car.py centres the car on the body part's length: give the H-point in that frame
bx = [v.co.x for v in parts['RIGID_Cage_Body'].data.vertices]
XC = (min(bx) + max(bx)) / 2
zs = [v.co.z for ob in allp.values() for v in ob.data.vertices]
assert abs(max(zs) - H) < 0.03 * H, 'height %.3f, spec %.3f' % (max(zs), H)

out_dir = os.path.join(ROOT, 'tools', 'out', 'vehicles')
os.makedirs(out_dir, exist_ok=True)
blend = os.path.join(out_dir, KEY + '.blend').replace('\\', '/')
for ob in list(scn.collection.objects):
    pass
bpy.ops.wm.save_as_mainfile(filepath=blend, compress=True)

uH = U_COWL - 1.0
yH = max(bottom(uH) + 0.25, belt(uH) - 0.42)
cfg = {
    'name': KEY, 'title': S['title'],
    'credit': {'title': S['title'], 'author': 'Car Crash Simulation', 'license': 'original design',
               'url': 'tools/vehicles/%s.json, generated by tools/build-vehicle.py' % KEY},
    'blend': blend,
    'wheelbase': round(WH['front'] - WH['rear'], 4),
    'body': ['src.RIGID_Cage_Body'],
    'objects': {('src.' + p): p for p in sorted(allp) if p != 'RIGID_Cage_Body'},
    'wheels': {k: ob.name for k, ob in wheels.items()},
    'materials': {
        'glass': ['glass'], 'light': ['lamp_head', 'lamp_tail'], 'tire': ['tire'], 'rim': ['rim', 'hub'],
        'trim': sorted(set(TRIM_NAMES + ['bedliner'])), 'chrome': sorted(CHROME_NAMES),
    },
    'regions': [],
    'decimate': {'': 1.0, 'wheel': 1.0},
    'hPoint': [round(uH - L / 2 - XC, 3), round(yH, 3), round(-0.37 * W / 1.9, 3)],
    'expectGlass': sum(1 for p in allp if p.startswith('BRITTLE_Glass')),
}
cfg_path = os.path.join(ROOT, 'tools', 'cars', KEY + '.json')
with open(cfg_path, 'w', encoding='utf-8', newline='\n') as fo:
    json.dump(cfg, fo, indent=1)
    fo.write('\n')
tris = sum(len(p.vertices) - 2 for ob in allp.values() for p in ob.data.polygons)
print('=== BUILT %s: %d parts, %d tris, %s; wrote %s and %s' % (KEY, len(allp), tris, ', '.join(sorted(allp)), blend, cfg_path))
