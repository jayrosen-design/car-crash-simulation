# The garage: game design document

Twelve vehicles for Race and Destruction, all from downloaded 3D models of real vehicles (the Lexus and
Mustang from Sketchfab under CC BY 4.0, the rest free models from CGTrader under its Royalty Free
License), plus the camera crew's drone. This document sets what each one is for, the numbers it must hit, and how it fits
each mode and the crash physics. The checks in [Acceptance](#7-acceptance-criteria) hold the game to
these numbers, and [Where it stands](#8-where-it-stands) gives the measured values.

(The first version of the garage had ten original placeholder designs, generated from the "New garage"
design video. They were replaced by these models; their build tools are still in `tools/`.)

**Contents:** [1. Goals](#1-goals) · [2. The roster](#2-the-roster) · [3. The vehicles](#3-the-vehicles) ·
[4. The garage screen](#4-the-garage-screen) · [5. Balance](#5-balance) · [6. Technical design](#6-technical-design) ·
[7. Acceptance criteria](#7-acceptance-criteria) · [8. Where it stands](#8-where-it-stands) · [9. Out of scope](#9-out-of-scope)

---

## 1. Goals

- **Real vehicles, realistic models.** Every vehicle in the select screens is a detailed model of a real
  one, in its real size, tuned to its real top speed and acceleration.
- **Every road vehicle crashes for real.** The ten cars go through the same lattice crash solver as the
  crash tests: they crumple, shed bumpers, hoods, fenders and wheels, and break their glass. The two
  oddities (the motorcycle and the armoured car) get physics of their own that stays honest about what
  they are.
- **A spread of ways to play.** From a 204 kg supermoto to a 15 t armoured car, and from a 1,000 PS
  hybrid hypercar to a 2.9 t pickup.
- **The garage as a moment.** A technical drawing: every vehicle to scale against the others.

## 2. The roster

| | Vehicle | Class | Mass | L × W × H (m) | Top speed | 0–100 km/h | Race | Destruction | Paint |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Lexus RX 350** | midsize SUV, AWD | 1,950 kg | 4.86 × 1.92 × 1.75 | 217 km/h | 5.9 s | yes | yes | crimson red |
| 2 | **Ford Mustang GT500** | coupe, RWD | 1,890 kg | 4.82 × 1.96 × 1.46 | 230 km/h | 5.7 s | yes | yes | crimson red |
| 3 | **Honda Civic Type R** (FK8) | hot hatch, FWD | 1,380 kg | 4.57 × 1.91 × 1.48 | 272 km/h | 5.8 s | yes | yes | rallye red |
| 4 | **Toyota GR Supra** (A90) | sports coupe, RWD | 1,540 kg | 4.38 × 1.81 × 1.23 | 250 km/h | 4.3 s | yes | yes | nitro yellow |
| 5 | **Nissan 350Z** | sports coupe, RWD | 1,450 kg | 4.32 × 1.86 × 1.31 | 250 km/h | 5.8 s | yes | yes | sunset orange |
| 6 | **Nissan GT-R Nismo** | twin-turbo coupe, AWD | 1,720 kg | 4.81 × 2.15 × 1.40 | 315 km/h | 2.7 s | yes | yes | pearl white |
| 7 | **Chevrolet Corvette Stingray** (C7) | V8 sports coupe, RWD | 1,500 kg | 4.49 × 1.89 × 1.26 | 290 km/h | 3.9 s | yes | yes | laguna blue |
| 8 | **Ferrari SF90 Stradale** | plug-in hybrid, mid-engine, AWD | 1,750 kg | 4.73 × 2.01 × 1.27 | 340 km/h | 2.5 s | yes | yes | rosso corsa |
| 9 | **Ford Crown Victoria Police Interceptor** | full-size police sedan, RWD | 1,870 kg | 5.42 × 1.95 × 1.57 | 208 km/h | 8.5 s | yes | yes | police black |
| 10 | **Ram 1500 TRX** | supercharged crew-cab pickup, 4WD | 2,900 kg | 5.94 × 2.24 × 2.14 | 190 km/h (limited) | 3.7 s | yes | yes | sandblast |
| 11 | **Ducati Hypermotard** | supermoto, L-twin | 204 kg + 80 kg rider | 2.11 × 0.82 × 1.57 | 230 km/h | 3.3 s | yes | yes | ducati red |
| 12 | **Type 87 Reconnaissance Vehicle** | six-wheeled armoured car | 15,000 kg | 6.22 × 3.17 × 2.88 | 100 km/h | — | unranked | yes | digital camo |
| | *Osprey* | *hexacopter camera drone* | | | | | *no* | *no* | |

Rows 3–12's top speed and 0–100 are the real vehicles' figures and the targets. Sizes are the models'
(with mirrors, light bar and wing; the GT-R's model is wider than the real car, 2.15 m against 1.90 m). The
order is the lineup order on the garage screen.

## 3. The vehicles

- **Honda Civic Type R.** The light, eager one: the hot hatch, front-wheel drive, quick through corners.
  A slightly softer structure (`stiffness` 0.85), as for a light car.
- **Toyota GR Supra.** A short, nimble sports coupe; rear-wheel drive.
- **Nissan 350Z.** The classic V6 coupe: less power, a lower drag; slower off the line than the Supra.
- **Nissan GT-R Nismo.** All-wheel-drive launch (2.7 s to 100 km/h) and 315 km/h; carbon hood and roof
  stay black whatever the paint.
- **Chevrolet Corvette Stingray.** The C7: long hood, front V8, 290 km/h.
- **Ferrari SF90 Stradale.** The fastest: 340 km/h, 2.5 s. Mid-engine: its engine mass sits behind the
  cabin, so the nose has no engine block to stop it; a stiffer crush zone (`frontK`) stands in for its
  crash structure.
- **Ford Crown Victoria Police Interceptor.** Body-on-frame V8 sedan: soft springs, big slides, slow off
  the line. Its LAPD livery is kept: the black panels take the paint, the white ones stay white, the
  light bar is red and blue.
- **Ram 1500 TRX.** 2.9 t of supercharged pickup: 3.7 s to 100 km/h and a 190 km/h limiter (`vlimit`).
  The lattice fills over the open bed up to the rails (`bedTop`).
- **Ducati Hypermotard.** Leans into every corner (from the cornering force, up to 55°), wheelies on hard
  launches, threads gaps no car fits. Its rider is a real human figure posed on the bike. The crash is a
  rigid break-up: mirrors and exhaust come off by impact speed and the rider is thrown.
- **Type 87 Reconnaissance Vehicle.** It doesn't race; it arrives. Governed to 100 km/h (110 with boost),
  it turns on the spot and shoves cars aside; cars don't hurt it and walls only a quarter as much. In Race
  it is **unranked** and stalls instead of crashing; in Destruction a car it hits goes through the crash
  solver against it as a moving box with a roof (as a bus does).
- **Lexus RX 350 and Ford Mustang GT500.** As before: their numbers, handling and crashes are unchanged
  (the checks hold them bit-identical).
- **Osprey drone.** Not driven: the camera crew's. (A replay mode filmed from it is the next step.)

## 4. The garage screen

- **A blueprint.** A dark grid, a metre ruler along the ground, the label `high-speed cam · 1/40× · t =
  …` in the corner.
- **The lineup.** All twelve as side silhouettes to the same scale, on the ruler: the armoured car 6.2 m,
  the bike 2.1 m. The chosen one is outlined; left and right (or a tap) move along it. A near-black
  paint (the police car's) gets a light outline on the dark strip.
- **The spec card.** The name, big; a class line; then orange mono lines: mass and size, the real top
  speed and a note, the modes and the paint.
- **Measured figures.** The bars (top speed, 0–100, braking, cornering) and the specs (power, weight,
  drive, gearbox) are measured by driving each vehicle in the game's physics.
- **Paint.** One palette for every vehicle, in one order: the eight shared paints, then the signature
  paints. Each vehicle starts in its own (the Lexus and Mustang in crimson red).
- **Layout.** It fits 1280 × 720 without scrolling.

## 5. Balance

**Race.**
- The figures differ a lot by design (the SF90 is far faster than the Crown Victoria), so there is no
  handicap: picking the slow car is the challenge.
- The armoured car is unranked; every other vehicle races for position and best score.
- Rivals drive three of the new road cars (the GR Supra, the Civic Type R and the Ram TRX) as well as the
  Lexus and Mustang. Traffic stays the Lexus and Mustang.

**Destruction.**
- The first hit's damage comes from the crash physics: mass and speed. The TRX and the armoured car start
  big; the light ones (the Civic, the bike) need the ramp and the ×4.
- The medal targets stay per junction; traffic, values and schedules are unchanged.
- The box trucks' cabs and the tankers' tractors are the downloaded cabover semi.

## 6. Technical design

### 6.1 One registry
`js/garage.js` lists every vehicle: key, name, class line, type (`car`, `bike`, `tracked`; the drone
`hover`), modes, mass, signature paint, the real targets, the driving tune, the crash settings, and
whether it races as a rival. Both games build their garage, specs, figures, draw lists and rival grid from
it. The road cars are lattice vehicles (`js/vehicles.js`); the bike, armoured car and drone are "rigs"
(`js/race/rigs.js`). The armoured car keeps the type `tracked` (it is driven as the tank was: heavy,
armoured, turning on the spot); its six wheels turn with the left and right "tracks".

### 6.2 Models
- **Road cars:** `tools/export-car.py`, one config each (`tools/cars/<key>.json`), as for the Lexus: the
  download's objects or region boxes become the parts the solver knows (bumpers, hood, fenders, doors,
  trunk, mirrors, each window, the four lamps, the wheel). Interiors and engine-bay detail are dropped;
  each car is decimated to about 40–50k triangles, a 230–490 KB GLB. The exporter gained: FBX and OBJ
  sources, a wheel from several objects (`wheelExtra`), rim and tyre materials of the wheel alone
  (`wheelRim`, `wheelTire`), texture liveries split into flat colours (`textureSplit`), a pane's facing
  from its thinnest axis when both of its faces are modelled, and profiles sampled across big triangles.
- **Rigs and the semi:** `tools/export-rig.py` (`tools/rigs/<key>.json`): the parts are lists of the
  download's objects (or the pieces of them inside a box), each a glTF node with its origin at its pivot,
  named as `tools/build-rig.py` names them. Colours from the textures (an average, or per face from a
  palette: the armoured car's camouflage). The bike's rider is the human figure from the Lexus download,
  posed with IK onto the pegs and bars. The semi has three parts (cab, frame, drive axles) that
  `js/destruction/look.js` builds the trucks around.
- **Materials:** flat colours per material class (paint, glass, chrome, trim, light, tyre, rim), as for
  the Lexus; the paint class takes the player's colour.

### 6.3 Driving models
- **Road cars:** the existing tyre model (Magic Formula, friction ellipse, load transfer), each with its
  own tune: power, drag area, drive split, grip, centre-of-gravity height, gears, and where needed the
  launch traction, a softer rear (the Crown Victoria) or a speed limiter (the TRX).
- **Bike:** a bicycle model: two wheels on the centre line, no sideways load transfer; lean, wheelie and
  rider drawn from the forces.
- **Armoured car:** skid steering (a yaw rate from the stick, pivot turns at rest), a governor at 100 km/h,
  high grip, and armour in the damage model (cars 0, walls ¼).

### 6.4 Crashes
- **Road cars:** the lattice crash solver, in both games. Two per-car settings tune it where a model
  needs them: `frontK` stiffens the crush zone ahead of the firewall (the Supra, GT-R, Corvette, SF90 and
  Crown Victoria), and `partLimit` raises a part's break-off strain (the GT-R's and SF90's front
  bumpers). Neither is set on the Lexus or Mustang, so their crashes don't change.
- **Bike:** a rigid break-up (the Destruction pile-up's rigid-body solver), simulated at once and played
  back by the slow-motion crash camera.
- **Armoured car:** a moving solver box against the car it hits, or straight into the pile-up against
  anything heavier; a stall instead of a crash in Race.

### 6.5 Sound

Recorded sound effects (licensed from Envato Elements, in `media/audio`), cut into clips by
`tools/build-sfx.py` and played by `js/fx.js`. Each vehicle's choice is its `sound` in `js/garage.js`.
The synthesized sounds stay, a button away ("Sound effects" on the select screen, or `?sfx=synth`).

| Recording | Used for |
|---|---|
| Muscle car engine loop | under way: the Mustang, the Corvette, the Crown Victoria and the TRX (the last two lower) |
| 1966 Chevy Impala, big engine revs | idling: the Mustang, the Corvette, the Crown Victoria, the TRX; the Crown Victoria's rev in the garage |
| Loud deep V8 revs | the Mustang's, the Corvette's and the TRX's rev in the garage |
| European sports car drives by (Porsche 928) | under way: the Lexus, the Supra, the 350Z, the GT-R |
| 1990 Lotus Esprit Turbo SE, start and revs | idling: the Supra, the GT-R, the SF90; the SF90 starting and the Supra and GT-R revving in the garage |
| Volkswagen Fox, four-cylinder | under way: the Civic Type R |
| Petrol car engine idle loop | idling: the Lexus, the Civic, the 350Z |
| Diesel truck idling loop | lorries, buses and tankers idling at a Destruction junction |
| Sport bike, start engine | the Ducati's idle, and its start in the garage |
| Sport bike, accelerate and decelerate | the Ducati and the SF90 under way |
| Motorcycle slide, crash, impact | the Ducati's crash |
| Military tank engine | the Type 87's engine, and its rev in the garage |
| Large drone flying, drone crash landing | the drone (kept for the replay) |
| Turbo engine pass-by | a near miss in Race |
| Game start countdown | the countdown in both games |
| Game menu select pack | the select screen, the pause menu and the results menu |

### 6.6 Budgets
- Frame time: 95th percentile at most 17.5 ms on the development machine, with rivals in the new cars.
- Page weight: the single-file games grow by about 4 MB with the realistic models.
- Picking a vehicle: its model ready within 0.5 s.

## 7. Acceptance criteria

Checked by `tools/race-check.js`, `tools/destruction-check.js`, `tools/headless-check.js` and the browser
tests.

- **Nothing existing moves.** The Lexus and Mustang's measured figures and crash checks, the props, the
  Destruction traffic and wrecks runs give the same results.
- **Road cars meet the real cars.** Top speed within ±4% and 0–100 within ±10% (`race-check car-<key>`).
  Each passes the crash checks the photographed cars pass: intact at 30 km/h; at 56 km/h into a rigid
  barrier, 300–800 mm of crush and 25–80 g with nothing off; parts off at 150 km/h.
- **Bike:** 0–100 in 3.0–3.6 s, top 221–239 km/h; the lean follows the cornering force; a wheelie that
  settles; no breakdown after a hard slalom; its crash throws the rider and sheds parts.
- **Armoured car:** top 96–104 km/h; a 90° pivot in 1.5–4 s; pushes a stopped car more than 3 m keeping
  70% of its speed; no damage from cars and a quarter from walls.
- **Every vehicle** can be picked, driven and crashed in both games, with every part found by name in
  the model (wheels drawn, panels and glass breaking), no page errors and the frame budget met.

## 8. Where it stands

Built as above, and measured:
- **Figures** (top speed, 0–100): Civic 268 km/h, 6.1 s · Supra 255, 4.3 · 350Z 243, 5.5 · GT-R 312, 2.9 ·
  Corvette 288, 4.0 · SF90 337, 2.6 · Crown Victoria 204, 8.1 · TRX 190, 3.8 · Ducati 229, 3.3 ·
  Type 87 100 km/h, a 90° turn on the spot in 2.4 s.
- **Crashes** (56 km/h, rigid barrier, crush and peak): Civic 589 mm, 61 g · Supra 427, 61 · 350Z 606,
  40 · GT-R 607, 56 · Corvette 570, 49 · SF90 745, 77 · Crown Victoria 655, 53 · TRX 600, 48; nothing off.
  All eight pass every scenario of the crash checks (30 to 150 km/h, angled, brick wall, Dramatic, parked,
  coasting, the free and dropped wheel).
- **Frame time:** 16.8 ms at the 95th percentile (60 Hz) in a race in the GT-R against the full grid.
- **Models:** the road cars' GLBs are 229–485 KB, the Ducati's 478 KB (with its rider), the Type 87's
  376 KB, the semi's 61 KB.
- **A fix on the way:** the game read a part's name from its mesh name, which Blender exports as
  `DEFORM_Hood.001`; `js/carmodel.js` now strips that suffix, so the Lexus's and Mustang's broken
  panels and windows are drawn as they come off too.

## 9. Out of scope

- The replay mode filmed from the drone (next).
- A bus model: the Destruction buses are still built in code.
- The Audi A7 download: one 1-million-triangle mesh with no real materials to split it by.
- Unlocks or progression: all twelve are available from the start.
- The new vehicles in the crash simulator's tests (it keeps its calibrated cars).
- The bike and armoured car as rivals or traffic.
- A jointed ragdoll rider: the rider is one rigid body.
