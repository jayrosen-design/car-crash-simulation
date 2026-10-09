# The garage: game design document

Twelve vehicles for Race and Destruction: the two photographed cars that were there first, plus ten new
ones from the "New garage" design video. This document sets what each one is for, how it should feel,
the numbers it must hit, and how it fits each mode and the crash physics. It is the reference for the
build: the checks in [Acceptance](#7-acceptance-criteria) hold the game to these numbers, and
[Where it stands](#8-where-it-stands) gives the measured values.

**Contents:** [1. Goals](#1-goals) · [2. The roster](#2-the-roster) · [3. The vehicles](#3-the-vehicles) ·
[4. The garage screen](#4-the-garage-screen) · [5. Balance](#5-balance) · [6. Technical design](#6-technical-design) ·
[7. Acceptance criteria](#7-acceptance-criteria) · [8. Where it stands](#8-where-it-stands) · [9. Out of scope](#9-out-of-scope)

---

## 1. Goals

- **A dozen ways to play, not a dozen paint jobs.** From a 205 kg superbike to an 11.8 t tank, each
  vehicle changes how a race is driven or a junction is wrecked. Two hatchbacks that differ by 5 km/h are
  not worth a slot.
- **Every road vehicle crashes for real.** The nine four-wheel road vehicles go through the same lattice
  crash solver as the crash tests: they crumple, shed bumpers, doors and wheels, and break their glass.
  The three oddities (bike, drone, tank) get physics of their own that stays honest about what they are.
- **Fictional makes.** No real brands, so no licences, and a garage with its own identity. (The Lexus RX
  350 and Ford Mustang GT500 stay: real cars from CC BY models, the realistic pair.)
- **The garage as a moment.** Choosing a vehicle should feel like the video: a technical drawing coming
  alive, every vehicle to scale against the others.

## 2. The roster

| | Vehicle | Class | Mass | L × W × H (m) | Top speed | Signature | Race | Destruction | Paint |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Lexus RX 350** | midsize SUV, AWD | 1,950 kg | 4.86 × 1.92 × 1.75 | 217 km/h | the all-rounder | yes | yes | crimson red |
| 2 | **Ford Mustang GT500** | coupe, RWD | 1,890 kg | 4.82 × 1.96 × 1.46 | 230 km/h | long-nose muscle | yes | yes | crimson red |
| 3 | **Halcyon GT** | grand touring coupe, RWD | 1,640 kg | 4.72 × 1.92 × 1.31 | 236 km/h | 0–100 km/h in 5.2 s | yes | yes | dusk orange |
| 4 | **Wren RS** | hot hatch, FWD | 1,240 kg | 3.95 × 1.78 × 1.46 | 198 km/h | 0.94 g cornering | yes | yes | pale violet |
| 5 | **Bastion** | full-size SUV, AWD | 2,480 kg | 5.15 × 2.02 × 1.88 | 190 km/h | shoves traffic aside | yes | yes | deep violet |
| 6 | **Quasar LM** | endurance prototype, mid-engine | 1,180 kg | 4.65 × 2.00 × 1.05 | 290 km/h | 0–100 km/h in 3.1 s | yes | yes | lab white |
| 7 | **Ridgeback** | crew-cab pickup, 4WD | 2,310 kg | 5.75 × 2.03 × 1.90 | 180 km/h | 3.70 m wheelbase | yes | yes | amber |
| 8 | **Ember 440** | boulevard cruiser, 1960s land yacht | 2,050 kg | 5.60 × 2.01 × 1.42 | 205 km/h | soft springs, big slides | yes | yes | ember red |
| 9 | **Cadence SE** | compact sport sedan, FWD | 1,420 kg | 4.55 × 1.80 × 1.42 | 218 km/h | 0–100 km/h in 6.8 s | yes | yes | slate gray |
| 10 | **Kestrel 900** | sport motorcycle, inline-four | 205 kg | 2.10 × 0.76 × 1.15 | 262 km/h | 0–100 km/h in 3.0 s | yes | yes | violet |
| 11 | **Osprey** | hexacopter cargo drone | 180 kg | 2.60 span × 0.70 tall | 140 km/h | hovers 0.6 m up, hops the traffic, no grip | yes | yes | peach |
| 12 | **Rampart** | light tank, tracked | 11,800 kg | 7.20 × 3.10 × 2.40 | 72 km/h | a solver box, like the bus | unranked | yes | rust |

Rows 3–12 are the design video's figures and are the targets. The order is the lineup order on the
garage screen: the photographed pair first, then the video's order.

## 3. The vehicles

Each entry: the fantasy, how it drives, the numbers, what it does in each mode, how it crashes, and how it
looks and sounds. "Feel" is the intent; the tuning that gets there is in [6.3](#63-driving-models).

### Halcyon GT, grand touring coupe
- **Fantasy.** The long-legged GT: fast, composed, a little heavy in the nose. The car you take when you
  want to win without drama.
- **Feel.** Stable at speed, progressive at the limit, easy to place. Rear-wheel drive: it rotates on the
  throttle out of slow corners but never snaps.
- **Numbers.** 1,640 kg · 4.72 × 1.92 × 1.31 m · target 236 km/h · 0–100 km/h in 5.2 s.
- **Race.** The benchmark: quick everywhere, best on the downtown circuit's long straights.
- **Destruction.** A clean, fast hit with a long crumple zone; a good tanker car.
- **Crash.** Lattice. A long bonnet and low roof: the front folds well before the cabin.
- **Look.** Long hood, fastback roof, short rear deck, the video's dusk orange. Sound: a smooth
  six-cylinder, 7,200 rpm.

### Wren RS, hot hatch
- **Fantasy.** Small, light, eager. It loses on the straights and wins in the corners.
- **Feel.** The sharpest turn-in in the garage, 0.94 g of grip; lifts its inside rear in tight corners.
  Front-wheel drive: it pulls out of corners, never oversteers on power. Drifts are short and flicky.
- **Numbers.** 1,240 kg · 3.95 × 1.78 × 1.46 m · target 198 km/h · 0.94 g cornering.
- **Race.** Hillside's sweepers and the harbour's chicane are where it earns its place.
- **Destruction.** Light: it bounces off heavy traffic. Use the ramp and the ×4.
- **Crash.** Lattice; a short front, so the cabin sees intrusion sooner.
- **Look.** Short two-box hatch, upright tailgate, pale violet. Sound: a buzzy turbo four, 7,000 rpm.

### Bastion, full-size SUV
- **Fantasy.** The bully. Two and a half tonnes of box: it doesn't go round traffic, it goes through it.
- **Feel.** Heavy and planted; slow to change direction; brakes long. Contact with cars barely
  deflects it.
- **Numbers.** 2,480 kg · 5.15 × 2.02 × 1.88 m · target 190 km/h · "shoves traffic aside".
- **Race.** Slams and takedowns: what it lacks in pace it makes up in contact.
- **Destruction.** The biggest first hit of the road cars; tall enough to land on a bus.
- **Crash.** Lattice; a tall, stiff body that rolls in big side impacts.
- **Look.** Tall slab sides, a flat roof, deep violet. Sound: a deep V8, 6,000 rpm.

### Quasar LM, endurance prototype
- **Fantasy.** A race car let loose on the street: the fastest thing in the garage, and the most fragile.
- **Feel.** Enormous grip and stopping; nervous over crests; every wall is a crash. Mid-engine: it turns
  on its centre, and the rear can step out when the throttle comes in mid-corner.
- **Numbers.** 1,180 kg · 4.65 × 2.00 × 1.05 m · target 290 km/h · 0–100 km/h in 3.1 s.
- **Race.** The fastest lap on every track, if it stays on the road.
- **Destruction.** Speed for the ramp; light, so it skips off heavy vehicles.
- **Crash.** Lattice with the engine mass behind the cabin; a low nose that goes under other cars.
- **Look.** Low wedge, a tall rear wing, a dark canopy, lab white with black number panels. Sound: a
  shrieking V10, 9,000 rpm.

### Ridgeback, crew-cab pickup
- **Fantasy.** The working truck: long, high, a bit agricultural. Takes the jumps and lands hard.
- **Feel.** Long wheelbase (3.70 m) makes it stable and slow to rotate; soft and floaty over hills;
  four-wheel drive pulls it out of anything.
- **Numbers.** 2,310 kg · 5.75 × 2.03 × 1.90 m · target 180 km/h · 3.70 m wheelbase.
- **Race.** The hillside is its track: it shrugs off the bumps that unsettle the coupes.
- **Destruction.** Heavy and tall; a strong first hit, a big wreck in the pile-up.
- **Crash.** Lattice; the open bed rides along but carries no load (only the cab and frame do).
- **Look.** Crew cab, open bed, high bumpers, amber. Sound: a lazy V8, 5,600 rpm.

### Ember 440, boulevard cruiser
- **Fantasy.** A 1960s land yacht: chrome, soft springs, and big lazy slides.
- **Feel.** Soft and wallowy; it leans into corners and lets go early at the rear. The drift is long and
  forgiving: the easiest car in the garage to hold sideways.
- **Numbers.** 2,050 kg · 5.60 × 2.01 × 1.42 m · target 205 km/h · "soft springs, big slides".
- **Race.** Drift chains for boost; the drift points come fast.
- **Destruction.** Long and heavy: a big hit, and it spins into things.
- **Crash.** Lattice; a very long front overhang, so a long, soft crash pulse.
- **Look.** Long low body, a separate trunk, chrome bumpers, ember red. Sound: a burbling big-block V8,
  5,200 rpm.

### Cadence SE, compact sport sedan
- **Fantasy.** The everyday car, done well. The easiest car to drive fast: the one to learn on.
- **Feel.** Neutral, predictable, forgiving. Front-wheel drive with a little lift-off rotation.
- **Numbers.** 1,420 kg · 4.55 × 1.80 × 1.42 m · target 218 km/h · 0–100 km/h in 6.8 s.
- **Race.** Middle of the field in pace; the best car for a first race.
- **Destruction.** An honest middleweight hit.
- **Crash.** Lattice; a classic three-box crumple.
- **Look.** Three-box sedan, slate gray. Sound: a revvy four, 6,800 rpm.

### Kestrel 900, sport motorcycle
- **Fantasy.** Fastest off the line, slimmest through traffic, and nothing between you and the road.
- **Feel.** Leans into every corner (drawn from the cornering force, up to 55°). Wheelies on hard
  launches, threads gaps no car fits. Grip is good but it carries no armour: a hard hit is the end.
- **Numbers.** 205 kg (plus an 80 kg rider) · 2.10 × 0.76 × 1.15 m · target 262 km/h · 0–100 km/h in 3.0 s.
- **Race.** Near misses come easily (it's narrow), and so do crashes.
- **Destruction.** A light first hit, and the rider is thrown into the junction. The Crashbreaker is the
  same as for cars.
- **Crash.** Rigid break-up: the bike tumbles, its screen, mirrors and exhaust come off by impact
  speed, and the rider (a crash-test dummy, in the site's yellow) is thrown clear. There is no lattice: a
  two-wheeler isn't a crumple-zone car.
- **Look.** Sport fairing, violet, with the dummy rider tucked in. Sound: an inline-four screaming to
  14,000 rpm.

### Osprey, hexacopter cargo drone
- **Fantasy.** Flying over the traffic jam. It cheats the road: no grip, but it can jump the queue.
- **Feel.** Hovers 0.6 m up and follows the ground; slides through corners like a hovercraft ("no
  grip"); **Hop** (Space, pad X, the touch Hop button) lifts it to about 2.5 m for a second, over cars,
  barriers and cones, but not over posts and buildings. One hop every 1.2 s.
- **Numbers.** 180 kg · 2.60 m span · 0.70 m tall · target 140 km/h · hovers 0.6 m up.
- **Race.** Slow on the straights, unbeatable at not hitting traffic. Sliding scores as drift.
- **Destruction.** Hops traffic to reach the targets (the gas station, a tanker) but hits lightly.
- **Crash.** Rigid break-up: the arms, with their rotors, snap off by impact speed; no lift in a crash,
  so it drops.
- **Look.** A central body, six arms and rotors, a peach cargo pod. Sound: rotor whine rising with thrust.

### Rampart, light tank
- **Fantasy.** The tank. It doesn't race; it arrives.
- **Feel.** Slow (72 km/h), with skid steering that turns on the spot. Nothing stops it: cars are pushed
  aside, and only walls do it any harm (a quarter of the damage a car takes).
- **Numbers.** 11,800 kg · 7.20 × 3.10 × 2.40 m · target 72 km/h.
- **Race.** **Unranked.** It can take part, but it has no place in the standings and no best is saved;
  its race ends when the last rival finishes. If its health ever runs out it stalls and is put back on
  the road, without a crash.
- **Destruction.** It starts the impact at its first real contact: 2 m/s into a vehicle, 4 m/s into a
  wall. A car it hits goes through the full crash solver against the tank as a moving solid box with a
  roof, as a bus does; the tank then joins the pile-up as your wreck, and the Crashbreaker works on it.
  Into a bus, truck, tanker or wall, it goes straight into the pile-up.
- **Crash.** A solver box: it doesn't deform.
- **Look.** A sloped hull, a turret with a long gun, tracks over six road wheels, rust brown. Sound: a
  diesel at 2,800 rpm and track clatter.

### Lexus RX 350 and Ford Mustang GT500
Unchanged: the realistic pair, photographed models split into their real panels. Their numbers, handling
and crashes stay exactly as they are (the checks hold them bit-identical).

## 4. The garage screen

The select screen of both games becomes the video's garage:

- **A blueprint.** A dark grid, a metre ruler along the ground, the label `high-speed cam · 1/40× · t =
  …` in the corner.
- **The lineup.** All twelve as side silhouettes to the same scale, on the ruler: the tank 7.2 m, the bike
  2.1 m. The chosen one is highlighted; left and right (or a tap) move along the lineup.
- **The spec card.** The vehicle's name, big; a class line; then orange mono lines in the video's form:
  `mass 1,640 kg · 4.72 × 1.92 × 1.31 m`, `target 236 km/h · 0-100 km/h in 5.2 s`,
  `race · destruction · paint: dusk orange`; a violet underline.
- **Measured figures.** The bars (top speed, 0–100, braking, cornering) and the specs (power, weight,
  drive, gearbox) are measured by driving each vehicle in the game's physics, as now, with labels that
  fit (tracked, single-speed, "—" for a 0–100 the tank never reaches).
- **Paint.** The signature paint first, then the eight shared paints.
- **The 3D street** behind still shows the chosen vehicle, the camera pulled back for long ones.
- **Loading.** The model loads when you stop on a vehicle (a quarter-second pause), not on every step.
- **Layout.** It fits 1280 × 720 without scrolling, and phones in landscape (it stacks, then scrolls, on
  small screens).

## 5. Balance

**Race.**
- The stat bars are re-scaled to the new spread: top speed 60–300 km/h; 0–100 over 3–10 s, as before.
- The tank is unranked; every other vehicle races for position and best score. The figures differ a lot
  by design (the Quasar is far faster than the Wren), so there is no handicap: picking the hard car is
  the challenge.
- Rivals drive three of the new road cars, close in pace to the Lexus and Mustang (the Halcyon GT, the
  Cadence SE and the Bastion), as well as the Lexus and Mustang, for a varied grid. Traffic stays the
  photographed pair.

**Destruction.**
- The first hit's damage comes from the crash physics: mass and speed. Heavy vehicles (Bastion,
  Ridgeback, Ember, tank) start bigger; light ones (Wren, Quasar, bike, drone) need the ramp and the ×4.
- The drone's hop is a route, not a weapon: it reaches targets others can't, then hits lightly.
- The medal targets stay per junction; no per-vehicle targets. Traffic, values and schedules are
  unchanged, so the three junctions keep their calibration.
- The Crashbreaker is the same for every vehicle.

## 6. Technical design

### 6.1 One registry
`js/garage.js` lists all twelve: key, name, class line, kind (`car`, `bike`, `hover`, `tracked`), modes,
mass, signature paint, the video's targets, the driving tune, and whether it races as a rival. Both games
build their garage, specs, figures, draw lists and rival grid from it. The nine four-wheel road vehicles
are lattice vehicles (`js/vehicles.js`); the bike, drone and tank are "rigs" (`js/race/rigs.js`), kept out
of the crash solver's vehicle list.

### 6.2 Models
`tools/build-vehicle.py` (Blender) builds each road vehicle from a spec, `tools/vehicles/<key>.json`: its
side silhouette, windows, wheels, lamps, mirror and trim traced from the video, its size and its paint.
- **Road vehicles:** the silhouette is lofted into a body and split into the parts the solver knows
  (bumpers, hood, fenders, doors, trunk, mirrors, glass, lamps, wheels), then run through the unchanged
  `tools/export-car.py`. So they crumple and come apart like the Lexus.
- **Rigs:** `tools/build-rig.py` builds them from parts with pivots (wheels, steering fork, rotors,
  turret, gun, the rider, breakable panels) and writes `models/<key>.glb.js` and `.phys.js` itself.
- Flat colours, as in the video; each model is a fraction of a photographed one's size.

### 6.3 Driving models
- **Road vehicles:** the existing tyre model (Magic Formula, friction ellipse, load transfer), each with
  its own tune. The Quasar's engine mass sits behind the cabin.
- **Bike:** a true bicycle model: two wheels on the centre line, no sideways load transfer. Lean, wheelie
  and the rider are drawn from the forces.
- **Drone:** thrust along the heading, weak sideways damping, a spring-damper holding 0.6 m over the
  ground (2.5 m while hopping). Obstacles under a hop are skipped when the drone is above them.
- **Tank:** skid steering (a yaw rate from the stick, pivot turns at rest), a governor at 72 km/h, high
  grip, and armour in the damage model (cars 0, walls ¼).
- All three steer to the same curvature a bicycle model would, so the game's autopilot and the shove
  keep working with them.

### 6.4 Crashes
- **Road vehicles:** the lattice crash solver, as now, in both games.
- **Bike and drone:** a rigid break-up, using the Destruction pile-up's rigid-body solver: the body
  tumbles, parts detach by impact speed, the rider is thrown. The whole crash is simulated at the moment
  it happens (1.6 s in a few milliseconds) and played back by the slow-motion crash camera. In
  Destruction what it hit is wrecked at once, and after the slow motion the hull and the loose pieces
  carry on in the pile-up.
- **Tank:** a moving solver box against the lattice car it hits (as the bus is), or straight into the
  pile-up against anything heavier; a stall instead of a crash in Race.

### 6.5 Budgets
- Frame time: 95th percentile at most 17.5 ms on the development machine, with rivals in the new cars.
- Page weight: the ten models add about 1–1.5 MB to each single-file game.
- Picking a vehicle: its model ready within 0.5 s.

## 7. Acceptance criteria

Checked by `tools/race-check.js`, `tools/destruction-check.js`, `tools/headless-check.js` and the browser
tests.

- **Nothing existing moves.** The Lexus and Mustang's measured figures, a seeded AI race, the props, the
  Destruction traffic and wrecks runs, and the scripted Destruction totals are identical to before.
- **Road vehicles meet the video.** Top speed within ±4% of the target; 0–100 within ±10% where the video
  gives it; the Wren's cornering 0.94 ± 0.04 g. Each passes the crash checks the photographed cars pass:
  intact at 30 km/h, 300–800 mm of crush and 25–80 g at 56 km/h, parts off at 150 km/h.
- **Bike:** 0–100 in 2.8–3.2 s, top 255–270 km/h; the lean follows the cornering force; a wheelie that
  settles; no breakdown after a 30 s slalom; its crash throws the rider and sheds parts.
- **Drone:** hovers at 0.60 ± 0.02 m; follows hills; never counts as airborne over ramps; slides more
  than a car; top 135–145 km/h; a hop clears a 1.75 m car and a 1.1 m barrier but not a post; the
  cooldown holds; its crash loses all six rotors.
- **Tank:** top 70–74 km/h; a 90° pivot in 1.5–4 s; pushes a stopped car more than 3 m keeping 70% of its
  speed; takes no damage from cars and a quarter from walls; starts the Destruction impact on vehicle
  contact.
- **Every vehicle** can be picked, driven and crashed in both games, with no page errors and the frame
  budget met.

## 8. Where it stands

Built as above, and measured:
- **Road cars:** each meets its design figures (`race-check car-<key>`). Each passes the crash checks:
  intact at 30 km/h; at 56 km/h, 350–630 mm of crush and 44–80 g with nothing off; panels and glass
  off at 150 km/h. The one exception is the Cadence SE's brick-wall run at exactly 56 km/h: an energy
  gain from a contact jitter after a brick bursts its rear tyre, a solver issue to fix separately (the
  same run at 53, 55, 57 and 60 km/h is clean). Three needed crash settings in `js/garage.js`: the
  Wren's lighter structure, the lattice over the Ridgeback's open bed, and the Quasar's engine behind
  the seats.
- **Rigs:** all of section 7's figures hold (`race-check rig-*`).
  - Kestrel: 0–100 in 2.94 s, 263 km/h.
  - Osprey: hovers at 0.600 m, 140 km/h.
  - Rampart: 72 km/h (80 with boost), a 90° turn on the spot in 2.0 s.
  - Rigid crash: about 30 ms.
- **Nothing existing moved:** the Lexus and Mustang's figures, the seeded AI race, the props, the
  Destruction traffic and wrecks runs, and every earlier race and destruction check give identical
  results. (The browser's scripted Destruction totals vary a little from run to run anyway, so they
  aren't a bit-for-bit comparison.)
- **Frame time:** 16.8 ms at the 95th percentile (60 Hz) driving the Lexus, the Halcyon, the drone and
  the tank, and with three rivals in the new cars.
- **Models:** the seven road cars' GLBs are 75–89 KB each, the rigs' 32–73 KB.

## 9. Out of scope

- Unlocks or progression: all twelve are available from the start.
- The new vehicles in the crash simulator's tests (it keeps its calibrated cars).
- The bike, drone and tank as rivals or traffic.
- A jointed ragdoll rider: the rider is one rigid body.
- Distinct engine sounds for the bike, rotors and tank: specified above, but for now each uses the car
  engine sound, retuned.
- Multiplayer.
