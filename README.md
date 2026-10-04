# Car Crash Simulation

A browser-based car crash simulator. A car drives itself into a barrier, a brick wall, another car or a pole. The crash is computed with a deformable-structure physics model at 0.1 ms steps and replayed in slow motion. You see:

- **the body crumpling:** glass shatters, panels and wheels tear off;
- **a crash-test dummy:** it moves inside the car, and its injury criteria are scored the way crash-test programs score them;
- **the aftermath:** steam, or an engine-bay fire if the crash would start one.

It runs in any modern browser from plain files: no install, no server, no build step needed to use it.

<p>
  <img src="media/shot-rigid.jpg" width="49%" alt="The Lexus pressed into the rigid barrier at maximum crush">
  <img src="media/lab-side.jpg" width="49%" alt="A side-impact barrier trolley pushed into the driver's door">
</p>

There are eight simulations: the two **barrier tests** (a free simulator with full control) and six **crash labs**, each set up like a test protocol:

| | | | |
|---|---|---|---|
| <img src="media/shot-rigid.jpg" width="200" alt="Rigid barrier"><br>**Rigid barrier** | <img src="media/shot-brick.jpg" width="200" alt="Brick wall"><br>**Brick wall** | <img src="media/lab-overlap.jpg" width="200" alt="Frontal overlap"><br>**Frontal overlap** | <img src="media/lab-multi.jpg" width="200" alt="Two-vehicle collision"><br>**Two-vehicle collision** |
| <img src="media/lab-side.jpg" width="200" alt="Side impact"><br>**Side impact** | <img src="media/lab-whiplash.jpg" width="200" alt="Whiplash sled"><br>**Whiplash sled** | <img src="media/lab-restraint.jpg" width="200" alt="Occupant restraints"><br>**Occupant restraints** | <img src="media/lab-pedestrian.jpg" width="200" alt="Pedestrian and braking"><br>**Pedestrian & braking** |

> **A teaching model.** It is not validated against physical crash tests. Use it to compare settings and see trends, not to predict real injuries.

---

## Contents

1. [Getting started](#getting-started)
2. [The simulations](#the-simulations)
3. [Using the simulator](#using-the-simulator)
4. [Technical architecture](#technical-architecture)
5. [How the physics works](#how-the-physics-works)
6. [Occupant and injury models](#occupant-and-injury-models)
7. [How each crash lab works](#how-each-crash-lab-works)
8. [Simulation diagrams](#simulation-diagrams): [rigid barrier](#rigid-barrier), [brick wall](#brick-wall), [frontal overlap](#frontal-overlap-lab), [two vehicles](#two-vehicle-collision-lab), [side impact](#side-impact-lab), [whiplash](#whiplash-sled-lab), [restraints](#occupant-restraint-lab), [pedestrian](#pedestrian-and-emergency-braking-lab)
9. [Rendering the damage](#rendering-the-damage)
10. [Verification](#verification)
11. [Tools: building, recording, exporting models](#tools-building-recording-exporting-models)
12. [Design decisions](#design-decisions)
13. [Limitations](#limitations)
14. [Project structure](#project-structure)
15. [Credits](#credits)

---

## Getting started

**Open `Car Crash Simulation.html`** (the home page) or **`Simulator.html`** (the simulator) in Chrome, Edge, Firefox or Safari. Both are single self-contained files, so they work straight from disk (`file://`) or from any static web host, such as GitHub Pages.

Requirements:
- **WebGL 2.** Any desktop or laptop GPU from the last decade works; phones work but the layout is cramped.
- **An internet connection.** three.js and its Draco decoder load from the jsDelivr CDN; everything else is in the files.
- **Node.js 22 or later**, only for the developer tools (physics check, single-file build, media recording).

Pick a simulation from the home page, or switch between all eight with the **Simulation** menu at the top of the simulator. Settings can also be passed in the URL:

```
Simulator.html?preset=rigid                    56 km/h full-frontal rigid-barrier test
Simulator.html?preset=brick                    64 km/h into a brick wall, Dramatic damage
Simulator.html?vehicle=mustang&speed=100&angle=30
Simulator.html?lab=side&impactor=pole&steel=mild
```

For development, open `index.html` instead. It loads the source files one by one, so edits show on reload. Then rebuild the single files with `node tools/build-standalone.js`.

**Hosting.** The site is static and needs no build step.
- **Vercel:** import the repository with the framework preset *Other*. `vercel.json` serves `home.html` at `/`; it loads the video and pictures from `media/` instead of embedding them, so it opens faster than the single-file home page. `.vercelignore` keeps the docs and tools off the site. It also leaves out `index.html` (the developer page), because Vercel serves a real file at `/` before it applies any rewrite.
- **Other static hosts** (GitHub Pages, Netlify and others) work too: open `home.html` or `Car Crash Simulation.html`.

---

## The simulations

### Barrier tests (the free simulator)

| Setting (URL name) | Options |
|---|---|
| Vehicle (`vehicle`) | Lexus RX 350 (default), Ford Mustang GT500, Lab sedan (a simple procedural car, the physics baseline) |
| Damage (`damage`) | *Realistic*: break limits set so a 56 km/h barrier test keeps its panels and wheels, as real cars do. *Dramatic*: limits about 3× lower, so parts fly off at moderate speeds. |
| Speed (`speed`) | 10–150 km/h |
| Approach angle (`angle`) | −45° to +45°: slider, or drag the blue handle behind the car |
| Mass (`mass`) | Light / Standard / Heavy, around each car's curb mass (0.73×, 1×, 1.47×) |
| Front-structure stiffness (`stiffness`) | Soft (0.6×), Standard, Stiff (1.7×) |
| Barrier (`barrier`, `wall`) | Rigid concrete barrier, or a brick wall with weak, standard or strong mortar |
| Restraints | Seatbelt and airbag, each on or off |

### Crash labs (`Simulator.html?lab=<id>`)

Each lab has its own setup panel, live readouts across the top, results and charts. Speeds are in mph, as in the test protocols they follow, with km/h alongside.

| Lab (`id`) | Controls (URL names) | What it shows |
|---|---|---|
| Frontal overlap (`overlap`) | speed 10–50 mph (`mph`); 40% moderate or 25% small overlap (`overlap=moderate\|small`); rigid or aluminium honeycomb barrier (`barrier=rigid\|honeycomb`) | The Lexus hits a 1 m wide block with the driver's side of its front. Crash pulse; steering-column movement (flagged over 10 cm); brake-pedal, toe-pan and hinge-pillar intrusion (flagged over 15 cm); occupant injury criteria. |
| Two vehicles (`multi`) | for each car: class (`aCls`, `bCls` = `coupe` Mustang, `suv` / `heavy` Lexus, `compact` the simple Lab sedan), mass 800–3,000 kg (`aMass`, `bMass`), speed 0–60 mph (`aMph`, `bMph`); approach angle 0–45° (`angle`) | Two cars collide in one solver. Each driver's speed change (Δv), crash pulse and injuries, momentum before and after (arrows in the scene), and where the kinetic energy went. |
| Side impact (`side`) | a 1,900 kg SUV-height barrier trolley at 37 mph or a rigid 254 mm pole at 20 mph (`impactor=mdb\|pole`); mild or hot-stamped B-pillar steel (`steel=mild\|uhss`); curtain airbag (`curtain`) | B-pillar and door intrusion (flagged over 15 cm), timed against the curtain airbag's deployment; the side-impact dummy's rib deflection, pelvis force and HIC36. |
| Whiplash sled (`whiplash`) | striking-car speed 20–30 mph (`mph`); head-restraint backset 0–12 cm (`backset`) and height −12 to +4 cm (`height`) | A sled pulse pushes the seat and a 24-vertebra spine bends. Head-restraint contact time (70 ms or less passes), upper-spine (T1) acceleration (9.5 g or less), NIC, neck extension. |
| Occupant restraints (`restraint`) | unbelted, plain 3-point belt, or belt with pretensioner, load limiter and airbags (`restraint=none\|belt\|full`) | A 35 mph rigid-barrier crash with its three collisions on a timeline (vehicle, occupant, organs); HIC and chest compression; all three restraint options compared on the same crash; the head's path; brain and heart movement. |
| Pedestrian & braking (`pedestrian`) | speed 12–37 mph (`mph`); adult or child (`target=adult\|child`); rigid steel or energy-absorbing bumper (`bumper=steel\|foam`); automatic emergency braking (`aeb`) | The sensor cone changes colour as the system sees, tracks, warns and brakes. Detection, warning and braking times, impact speed or distance to spare, head, pelvis and leg pulses for both bumpers, knee bending, wrap-around distance and throw. |

---

## Using the simulator

Every simulation runs through the same four stages, shown in the top bar.

1. **Setup.** Choose the settings. Readouts show the kinetic energy, the equivalent drop height and the momentum.
2. **Approach.** The car drives itself onto the approach line: a PID speed controller and pure-pursuit steering. It starts slightly off-line so you can watch the controllers correct. **Emergency stop** cuts the drive and brakes hard; if the car stops short, the test is aborted.
3. **Impact.** The crash is computed in 0.1 ms steps, with the live state on screen: 1–2 s for a rigid barrier, a few seconds for the brick wall or two cars. Emergency stop cancels the computation.
4. **Playback.** A slow-motion replay with a scrubber and speeds from 1/40× to 1×. Space plays or pauses; the arrow keys step 1 ms (10 ms with Shift).

In playback:
- **Cameras.**
  - *Free* is the default: drag to orbit, scroll to zoom, and the view follows the car (or both cars).
  - *Side*, *Front ¾* and *Top* track the car.
  - *Onboard* is fixed to the car.
  - An onboard inset shows the dummy without the car body.
- **Toggles:** strain map on the car, injury map on the dummy, X-ray body.
- **Results panel.** It shows:
  - injury criteria against their limits;
  - vehicle metrics;
  - what came off;
  - charts. Click a chart to jump to that moment.
- **Re-run the dummy.** Change the seatbelt, airbag, curtain airbag or restraint system to replay the same crash with different restraints.
- **After the crash.** If the crash crushed the radiator, steam vents. If it drove the engine back into the firewall, the engine bay catches fire. This plays in real time once the replay reaches its end; **Show the aftermath** in the results jumps there.

---

## Technical architecture

### Principles

- **Offline integration, slow-motion replay.** A crash pulse lasts about 100 ms and needs sub-millisecond steps to resolve; no browser can do that in real time for thousands of springs. So the impact is integrated ahead of time in short time slices, recorded, and then replayed and interpolated at any speed, like high-speed crash-test footage.
- **Physics without the DOM.** The physics, occupant, guidance and fire-rule modules have no dependencies and run identically in the browser and in Node. The headless check runs the same code as the page.
- **Plain classic scripts.** Every module is a classic script that sets one global (e.g. `CrashPhysics`) and also exports itself for Node. Classic scripts load from `file://`, where browsers block ES-module imports, so the app works opened straight from disk. Only three.js is an ES module, loaded from a CDN through an import map.
- **Single-file builds.** `tools/build-standalone.js` inlines every script, and for the home page every picture and the video, into one HTML file each.

### Modules

```mermaid
flowchart TB
  subgraph Data["Generated data"]
    PHYS["models/*.phys.js<br/>CAR_PHYS: sizes, profile, hubs, parts, glass"]
    GLB["models/*.glb.js<br/>CAR_ASSETS: Draco GLB as base64"]
  end
  subgraph Core["Simulation core (no DOM, runs in Node)"]
    VEH["vehicles.js<br/>CrashVehicles: lattice and zone specs"]
    PH["physics.js<br/>CrashPhysics: XPBD lattice, barriers,<br/>contacts, destruction, recording"]
    OCC["occupant.js<br/>CrashOccupant: frontal and side dummies,<br/>organs, SAE J211 filters, criteria"]
    GUI["guidance.js<br/>CrashGuidance: PID + pure pursuit"]
    WL["whiplash.js<br/>CrashWhiplash: sled + 24-vertebra spine"]
    PED["pedestrian.js<br/>CrashPedestrian: AEB + pedestrian chain"]
    FIRE["fire.js<br/>CrashFire: steam/fire rule + effects"]
  end
  subgraph View["Presentation (three.js)"]
    CM["carmodel.js<br/>CarModels: GPU skinning, crumple,<br/>debris, shards, cracks"]
    SC["scene.js<br/>Scene3D: track, barriers, car slots,<br/>interior, dummy, curtain, cameras"]
    LS["labscene.js<br/>LabScene: lab props"]
    FX["fx.js<br/>FX: Web Audio, particles"]
    CH["charts.js<br/>Charts: canvas charts"]
  end
  subgraph Ctl["Controllers (one runs per page)"]
    APP["app.js: barrier tests"]
    LABS["labs.js: six crash labs"]
  end
  PHYS --> VEH --> PH
  GLB --> CM
  PH --> APP & LABS
  OCC & GUI --> APP & LABS
  WL & PED --> LABS
  FIRE --> APP & LABS
  CM --> SC --> APP & LABS
  LS --> LABS
  FX & CH --> APP & LABS
```

`index.html` loads the data and core modules as classic scripts. A small module script then imports three.js (0.170, OrbitControls, GLTFLoader, DRACOLoader), puts it on `window`, and loads the presentation modules and **one** controller: `labs.js` when the URL has `?lab=`, otherwise `app.js`.

### Data flow of one run

```mermaid
sequenceDiagram
  participant UI as Controller (app.js / labs.js)
  participant G as CrashGuidance
  participant P as CrashPhysics
  participant O as CrashOccupant
  participant F as CrashFire
  participant S as Scene3D / CarModels
  UI->>G: createApproach(speed, angle, mass, wheelbase)
  loop Approach, every animation frame
    UI->>G: step(1 ms) x frame time
    UI->>S: setCarRigid(pose, steer, wheel spin)
  end
  UI->>P: createImpactSim(vehicles, barrier, pose, speed)
  loop Impact, every animation frame
    UI->>P: advance(12 ms of wall-clock budget)
    UI->>S: setCarDeformed(live node positions)
  end
  UI->>P: finalize()
  P-->>UI: result: frames, crash pulse, metrics, debris, glass, events
  UI->>O: simulate(crash pulse, restraints)
  UI->>F: assess(result) for each car
  loop Playback
    UI->>S: frame k, k+1, blend s: positions, strain, cabin frame, debris, dummy pose
    UI->>S: fire effects after the replay ends
  end
```

The impact computation is time-sliced. `sim.advance(budgetMs)` runs substeps until its wall-clock budget is spent, then returns, so the page keeps drawing and stays responsive. Emergency stop can cancel it.

### The crash result

`finalize()` returns one object that everything downstream reads:

| Field | Contents |
|---|---|
| `frames` | Recorded snapshots: time, every node's position (Float32), every node's plastic strain (Uint8), the cabin frame (origin, forward, up), brick and debris poses (position + quaternion), crush, intrusion, and the energy breakdown. Recorded every 1 ms for 0.3 s after first contact, every 4 ms to 1 s, then every 10 ms. |
| `pulse` | The cabin's acceleration and velocity resampled onto a uniform 0.1 ms grid and filtered (CFC 60), plus the barrier force. This drives the dummy. |
| `metrics` | Impact speed, speed change (Δv), rebound, peak deceleration, time to stop, maximum and permanent crush, cabin intrusion, initial kinetic energy. |
| `units` | Per vehicle (two in the two-vehicle and side labs): its own pulse, metrics, crush, cabin frames and intrusion measurements. |
| `debris`, `glass`, `bursts` | Parts and wheels that came off (with the lattice state at that moment), panes and lamps that broke (time, origin, velocity), tyres that burst. |
| `events` | First contact, contact impulses, parts detaching, glass breaking: these drive sounds and particles. |

Playback finds the two frames around the playback time and blends between them (positions linearly, rotations by slerp), so any playback speed looks smooth.

### Rendering and loading

- **three.js scene** (`scene.js`):
  - a test track with sky, ground and shadows;
  - an approach-path gizmo;
  - the rigid barrier, or an instanced brick wall;
  - one or more **car slots**, each with its body, interior (seat, dash, steering wheel, airbag, belts), dummy and curtain airbag;
  - cameras, with an onboard picture-in-picture inset.
- **Imported cars** (`carmodel.js`): parsed once from the embedded GLB, then skinned to the physics lattice on the GPU (see [Rendering the damage](#rendering-the-damage)).
- **Single-file build** (`tools/build-standalone.js`):
  - **Simulator:** inlines the model data and core modules as ordinary scripts, and the presentation modules as `text/x-inline` blocks that the loader executes after three.js is ready. It fails if any embedded file doesn't match its source.
  - **Home page:** embeds the pictures as data URLs and the video as base64, which the page turns into a blob URL.

---

## How the physics works

All the vehicle physics is in `js/physics.js`. Units are SI throughout. Car-local axes are x forward, y up, z right, with the ground at y = 0. The rigid barrier's face is at x = 0, and the car approaches from −x.

### 1. The vehicle as a lattice

Each car is a 3D grid of point masses (**nodes**) joined by springs (**distance constraints**), fitted to the car's body:

- **The grid.** Columns run along the car, placed so both axles fall on columns: about 24 cm apart for the imported cars, uniform for the Lab sedan. There are about 29 cm between rows and about 22 cm across the car. Nodes more than one row above the body's roof profile are dropped. The row just above the surface becomes light **ghost nodes** (0.25 kg) that only carry the render mesh.
- **The springs.** Every node connects to 13 neighbours: 3 along the axes, 6 face diagonals and 4 body diagonals, each pair once. The diagonals give the lattice shear and bending stiffness.

  | Vehicle | Nodes (ghost) | Springs |
  |---|---|---|
  | Lab sedan | 672 (96) | 6,506 |
  | Lexus RX 350 | 999 (144) | 9,913 |
  | Ford Mustang GT500 | 774 (144) | 7,563 |
  | Side-impact barrier trolley | 480 | 4,490 |

- **Mass.** The curb mass is spread over the structural nodes. 12% sits on the engine block's nodes, and 20 kg per corner sits on the wheel nodes (imported cars).
- **Zones.** Spring stiffness and yield strain are multiples of a base stiffness *K₀* = 1.1 MN/m (scaled with the lattice spacing, so the material stays as stiff) and a base yield strain *ε_y* = 1.15%:

  | Zone | Stiffness | Yield strain |
  |---|---|---|
  | Front crumple zone (ahead of the firewall) | 1× (× the Soft/Standard/Stiff setting) | 1× |
  | Engine block (inside the crumple zone) | 2.5× | 2.5× |
  | Passenger safety cell | 2.5× | 2.4× |
  | Rear structure | 1.5× | 1.2× |
  | Ghost springs | 0.15× | 1× |

  The zones are placed relative to each car's H-point (the driver's hip point) and rear axle, so every car gets a crumple zone, an engine, a cabin and a rear of the right size.

### 2. The solver: XPBD with plastic flow

The structure is integrated with **XPBD**, extended position-based dynamics (Macklin, Müller & Chentanez, 2016). It uses many small substeps, each with one constraint pass ("small steps" XPBD), which keeps stiff springs stable without a global solve. Each substep:

1. **Predict.** Save each node's position *x\**, add gravity to its velocity, move it: *x ← x + v·Δt*.
2. **Project the springs.** For each spring between nodes *a* and *b*, with inverse masses *w*, rest length *L₀* and compliance *α = 1/k*:

   ```
   C      = |x_b − x_a| − L₀                        (constraint: stretch of the spring)
   γ      = (c · α) / Δt                             (damping weight; c = 2ζ·√(k·m_reduced), ζ = 0.08)
   ẋ_rel  = relative displacement along the spring this substep
   Δλ     = −(C + γ·ẋ_rel) / ((1 + γ)(w_a + w_b) + α/Δt²)
   x_a   −= w_a·Δλ·n,   x_b += w_b·Δλ·n            (n: unit vector from a to b)
   ```

   Stiffness is physical. A spring of stiffness *k* behaves like one, independent of the step size, and each spring carries 8% of critical damping.
3. **Plastic yield.** If the spring's elastic strain after the correction exceeds its yield strain, the excess flows plastically: **the rest length moves**. The steel stays bent instead of springing back. The work done, yield force × plastic flow, is booked as plastic deformation energy, and the accumulated plastic strain is stored per spring. Rest lengths are clamped to 0.25–1.8× their original length, which models crushed structure bottoming out.
4. **Contacts.** Penetrating nodes are pushed out (next section).
5. **Friction.** Coulomb friction at every contact. The kinetic energy it removes, net of what went into springs and height, is booked as friction heat.
6. **Velocities.** *v = (x − x\*) / Δt*, then a velocity pass for contacts with rigid bodies.

**Time step.** 0.1 ms from the start and for 0.3 s after first contact, while the crash pulse runs. Then 0.5 ms for the rebound and debris settling. 1 ms gains energy with the stiff mortar bonds, so it isn't used.

**Duration.** The barrier tests continue 1.2–2.4 s after first contact, depending on the car and barrier, so parts and bricks land.

### 3. Contacts and friction

Every structural node is a sphere of radius 12 cm. Contacts with bricks, debris and the lab obstacles cancel the node's approach in that substep but never push it apart faster than 1 m/s, so deep penetrations can't pump energy in.

| Contact | How |
|---|---|
| Ground | Nodes stay above their floor height. Wheel nodes ride at hub height, so the tyre carries the car: friction 0.8 sideways, rolling resistance 0.015. |
| Rigid barrier | A concrete block (18 m wide, 3 m tall) with its face at x = 0, friction 0.3. The normal forces are summed like a load-cell wall. |
| Brick wall | Bricks are rigid boxes found through a spatial hash. Contacts are solved between the node and the brick's closest surface point, with the brick's own generalised mass and rotation. |
| Offset barrier, pole | A signed-distance function: a block with a 150 mm rounded edge (small-overlap test), or a 254 mm cylinder. |
| Honeycomb face | A 5 cm grid of aluminium cells in front of the offset barrier. A node presses on the cells under its share of the lattice face. Below their crush stress (0.34 MPa, or 1.7 MPa in the front strip) they stop it; above it they crush at constant force and bottom out when nearly flat. A cell's crush per step is capped at the node's forward advance, so sideways sliding can't crush it. The crush work is a separate energy channel. |
| Vehicle against vehicle | All cars' lattices run in one solver. Nodes of different cars meet as spheres, found through a spatial hash of the overlap of their bounding boxes, with friction 0.4. Crushed fronts interlock, so these contacts only cancel approach (at most 2 cm/s of separation); pushing nodes apart would pump energy in. |
| Debris | Parts and wheels that came off are rigid bodies with contact points on their outline, colliding with the ground, barrier and bricks. |

### 4. The brick wall

The wall has 366 bricks (40 × 20 × 25 cm, 2,000 kg/m³) in 12 courses, between two concrete pillars. Each brick is a rigid body: position, quaternion, linear and angular velocity, and the gyroscopic term for free spin.

- **Mortar.** Each joint is two **bond points**, so a joint carries bending as well as tension and shear. A bond is a stiff XPBD point constraint (compliance 2×10⁻⁸ m/N).
- **Failure.** A bond breaks in tension or shear above the mortar strength: weak 8 kN, standard 30 kN, strong 120 kN. Compression raises the shear capacity (Coulomb, factor 0.6). The energy stored in a breaking bond is booked as fracture energy.
- **Sleeping.** Bricks are *dormant* until loaded and go back to sleep when still. Bricks cut off from the footing and pillars lose their support and fall, singly or as clusters.

### 5. Destruction

Imported cars are split into named parts: bumpers, hood, fenders, doors, trunk or tailgate, mirrors, glass panes, lamps and wheels.

- **Panels ride on the lattice** until the springs they're mounted on have yielded far enough (mean plastic strain), then **come off as rigid debris** that keeps its crushed shape.

  | Part | Mass | Comes off at (mean plastic strain of its mounts) |
  |---|---|---|
  | Front / rear bumper | 9 / 7 kg | 16.5% / 15% |
  | Hood | 15 kg | 25% |
  | Fender | 4 kg | 18% |
  | Front / rear door | 24 / 20 kg | 6% |
  | Trunk or tailgate | 14 kg | 15% |
  | Mirror | 1.5 kg | 5%, or when it hits something |

  *Dramatic* damage multiplies every limit by 0.3.
- **Conservation at the break.** A debris body's mass is taken out of the nodes it sat on. Its velocity comes from their momentum. Its angular velocity is *I⁻¹L*, clamped so kinetic energy can't rise; the kinetic energy given up is booked as fracture energy. The headless check fails if a break changes total momentum or energy.
- **Wheels** are lattice nodes until their mount yields (30% mean plastic strain) or the hub is shoved back 45 cm; then they come off as rigid wheels spinning at their rolling speed. A **tyre bursts** when the rim meets an obstacle or the hub is shoved back 20 cm. It then goes flat over 50 ms, keeping 25% of its sidewall height, and its rolling resistance rises.
- **Glass and lamps** are decided after the run, from the recorded strain of the structure around each pane:
  - tempered side and rear windows break at 6% mean plastic strain;
  - the roof glass at 12%;
  - lamps at 10%;
  - any pane or lamp breaks when it touches the barrier or a brick, or when its panel comes off.

  Tempered glass bursts into a few hundred shards. The laminated windshield stays in and cracks instead, at 2.5% or where the dummy's head hits it.

### 6. Measuring the crash

- **The cabin frame.** Its origin is the mass-weighted centre of the passenger-cell nodes; forward runs from the rear to the front cabin nodes, and up from the floor to the roof nodes. The dummy rides in this frame.
- **The crash pulse.** The cabin velocity is resampled onto a uniform 0.1 ms grid, differentiated and filtered with an SAE J211 CFC 60 filter (a phaseless 4-pole Butterworth). It gives the deceleration, Δv, peak g and time to stop.
- **Crush and intrusion.** Crush is how far the front face has moved back relative to the cabin (mean of the front column). Cabin intrusion is how far the dash has moved toward the seat.
- **Lab measurement points.** Steering column, brake pedal, toe pan, hinge pillar, B-pillar and door points are embedded in the lattice. They are measured in a frame fitted (least squares, polar decomposition) to the undamaged rear corner of the cabin, so the car's own rotation doesn't count as intrusion.
- **Energy.** The books hold: car and debris kinetic energy (with wheel spin), elastic, plastic, fracture, friction, gravity and honeycomb crush. Position-based dynamics can't attribute contact, structural damping and numerical losses separately, so they form one residual channel, "contact, damping & solver". The energy chart shows where the initial ½mv² went.

### 7. The approach

`js/guidance.js` drives the car on a kinematic bicycle model:
- a **PID speed controller** sets the drive or brake force;
- **pure-pursuit steering** follows the approach line through the barrier centre at the chosen angle.

The car starts 30–130 m back (3 s at the test speed), 0.6 m off the line with a 4° heading error, so the controllers have something to correct. The impact simulation takes over when the gap is 1 cm plus 4 ms of travel, with the car's exact pose, speed and yaw rate.

### 8. After the crash: steam and fire

`js/fire.js` decides from the recorded crash:

- **Steam.** The front was crushed back to the radiator (25 cm behind the front, or the front of the engine if that's nearer). Hot coolant vents as steam.
- **Engine-bay fire.** The engine block, measured as the mean of its lattice nodes in the cabin frame, was driven **30 cm or more** back toward the firewall. That crushes the fuel rail and the fuel and oil lines against the hot exhaust at the back of the engine.

The fire grows in stages:
- smoke starts at once (0.3 s);
- flames after about a second;
- well alight after about 9 s, with burning fluid spreading under the car.

With the Lexus into the rigid barrier:
- 56 km/h pushes the engine back about 10 cm: steam only;
- 80, 100 and 130 km/h push it back about 43–50 cm: fire.

Rear impacts, which cause most fuel-tank fires, aren't simulated, so there is no fuel-tank rule.

---

## Occupant and injury models

The dummies are **driven by the crash** (one-way coupling, like a sled test). The vehicle simulation produces the cabin's motion, and the dummy reacts to it inside the cabin frame. This keeps the dummy cheap enough to re-run instantly with other restraints on the same crash.

### Frontal dummy (`occupant.js`)

- **Body.** A 2D side-view multibody of seven particles: pelvis, thorax, upper spine (T1), a compliant sternum, the top of the neck, and the front and back of the head. They are joined by stiff links and joint springs, plus a simple two-pendulum model for lateral sway.
- **Three-point belt.** Shoulder and lap belts with elastic webbing. A **pretensioner** takes out up to 8 cm of slack in the first milliseconds, and a **load limiter** pays out webbing at 4.5 kN.
- **Driver airbag.** It fires when the cabin's speed change reaches 2 m/s within 45 ms of contact, inflates, then vents.
- **Contacts.** Steering wheel with a collapsing column, windshield and roof (placed per car from its glass and roof lines), knee bolster, chin to chest. A head strike on the windshield cracks it where the head hit.
- **Injury criteria.** Channels are filtered per SAE J211 (CFC 1000 head, CFC 180 chest, CFC 600 neck) and scored against FMVSS 208-style limits:

  | Criterion | Limit |
  |---|---|
  | HIC15 (head injury criterion, 15 ms window) | 700 |
  | Chest acceleration, 3 ms clip | 60 g |
  | Chest deflection | 63 mm |
  | Nij (neck injury criterion) | 1.0 |
  | Neck tension / compression | 4.17 / 4.0 kN |

### Side-impact dummy

- **Body.** A frontal-plane dummy: pelvis, thorax with struck-side ribs, shoulders, neck and head, in the struck car's frame.
- **Loading.** The car's lateral acceleration, taken from the undamaged far half of the car where the seats are mounted. Also the door's inner surface, taken from the lattice at pelvis, chest and window height. Door padding crushes at a plateau force.
- **Window and curtain.** The window glass breaks at 4 kN or when the intruding door reaches it. A vented curtain airbag fires on a 1 m/s lateral speed change.
- **Criteria.** HIC36 (limit 1,000), rib deflection from a chest potentiometer (44 mm), pelvis force (6 kN).

### Organs: the third collision

The brain and the heart are masses on springs inside the head (50 Hz) and the chest (25 Hz). They keep moving after the body has stopped and then strike the inside of the skull or rib cage: the "third collision". It is why a hard stop can injure the brain or tear the aorta without a mark outside.

### Whiplash dummy (`whiplash.js`)

- **Spine.** A side-view chain of pelvis, 24 vertebrae (5 lumbar, 12 thoracic, 7 cervical) and head. Each joint has a rotational spring and a damper, with an end stop in the neck. The damping is integrated exactly per joint, because explicit damping is unstable on 2 cm vertebrae.
- **Seat.** Foam, a 25° seatback on a recliner that yields above 2.2 kN·m, and a head restraint placed by backset and height.
- **Sled pulse.** A triangular pulse of 91 ms whose speed change is half the striking car's speed: a stationary car struck from behind.
- **Criteria.** Head-restraint contact time (70 ms or less), T1 acceleration (9.5 g or less), NIC (15 m²/s²), neck extension.

### Pedestrian (`pedestrian.js`)

- **Body.** A 2D chain of feet, knees, pelvis, chest, neck and head, for an adult (1.75 m, 75 kg) or a 6-year-old child (1.17 m, 23 kg), struck in the car's plane.
- **The car's front.** Built from the car's real side profile. Its surfaces crush in two stages (elastic, then plastic): the bumper (rigid steel or energy-absorbing foam), the hood's leading edge, the hood (it dents onto the engine), the windshield and the roof edge.
- **Criteria.** HIC15 is scored separately for the head striking the car and the road. Also tibia and pelvis acceleration, knee bending, wrap-around distance and throw.
- **Emergency braking.** A rule-based model of a radar-and-camera system:
  - it sees ±25° to 60 m (45 m for a child), unless a parked car blocks the line of sight (checked with a segment-box test);
  - it confirms a pedestrian after 0.25 s;
  - it warns at 1.8 s to collision;
  - it brakes at 1.1 s (0.85 g, built up over 0.25 s after 0.1 s of latency).

---

## How each crash lab works

| Lab | Setup in the physics |
|---|---|
| Frontal overlap | An `offset` barrier: a rigid block 1 m wide covering 40% or 25% of the Lexus's width, optionally faced with honeycomb (0.54 m deep). The lab gives the cabin's outer front corners (toe pan, hinge pillar) sheet-metal strength instead of safety-cell strength, so a wheel driven back can push them in. Intrusion points are measured in the undamaged-cabin frame. |
| Two vehicles | Two lattices in one solver, placed nose to nose at the chosen angle with a tiny gap, no barrier. Each car gets its own crash pulse, dummy, plastic work and momentum. Mass is set independently of the model. The camera follows the pair's centre of mass, which moves at a nearly steady speed through the crash. |
| Side impact | Two units: the struck Lexus, standing still, and the barrier trolley. The trolley is a lattice with a crushable SUV-height face (0.38–1.14 m, 0.45 m deep) on a rigid body. In the pole test, the car slides sideways on a low-friction carrier (friction 0.03) into a fixed cylinder. The door ring (doors, B-pillar, sill, roof rail) uses the chosen steel: mild 0.6× stiffness and yield, hot-stamped 1.4× stiffness and 1.8× yield. The cabin between floor and roof is hollow, so the door can come in. |
| Whiplash sled | No vehicle physics: the sled pulse drives the seat and spine model directly. |
| Occupant restraints | A 35 mph (56 km/h) full-width rigid-barrier crash of the Lexus. The same crash pulse drives three dummy runs (unbelted, plain belt, full system), and the organ model splits the crash into its three collisions. |
| Pedestrian & braking | The car's motion is planned first: constant speed, sensor detection and braking. The impact is then computed with the pedestrian chain; the pedestrian is too light to change the car's motion. The other bumper is run too, for comparison. |

---

## Simulation diagrams

Each simulation as a pipeline from its settings to what you see, followed by the timing or state logic that drives it. The numbers are the model's actual thresholds and settings.

Colour key for the pipeline charts:
- **blue:** settings;
- **amber:** the model that is built;
- **purple:** computation;
- **red:** decisions;
- **green:** results on screen.

### Rigid barrier

`Simulator.html?preset=rigid`: the free simulator's full-frontal test (preset 56 km/h, Realistic damage).

```mermaid
flowchart TB
  classDef input fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef model fill:#fef3c7,stroke:#d97706,color:#0f172a
  classDef calc fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef decide fill:#fee2e2,stroke:#dc2626,color:#0f172a
  classDef out fill:#dcfce7,stroke:#16a34a,color:#0f172a

  subgraph SET["1 · Setup"]
    direction TB
    S1["Vehicle<br/>Lexus RX 350 · Mustang GT500 · Lab sedan"]
    S2["Speed 10–150 km/h<br/>approach angle −45° to +45°"]
    S3["Mass Light / Standard / Heavy<br/>0.73× · 1× · 1.47× curb mass"]
    S4["Front stiffness<br/>Soft 0.6× · Standard · Stiff 1.7×"]
    S5["Damage<br/>Realistic, or Dramatic: break limits × 0.3"]
    S6["Seatbelt on/off · airbag on/off"]
  end

  subgraph APP["2 · Approach"]
    direction TB
    A1["Start 30–130 m back (3 s at speed)<br/>0.6 m off the line, 4° heading error"]
    A2["PID speed control → drive or brake force"]
    A3["Pure-pursuit steering on a kinematic bicycle model"]
    A4{"Gap ≤ 1 cm + 4 ms of travel?"}
    A1 --> A2 --> A3 --> A4
    A4 -- "no: 1 ms steps" --> A2
  end

  subgraph BUILD["3 · Model"]
    direction TB
    B1["Lattice fitted to the body<br/>Lexus: 999 nodes · 9,913 springs<br/>13 neighbours per node"]
    B2["Zones: crumple zone 1× · engine block 2.5×<br/>safety cell 2.5× k, 2.4× yield · rear 1.5×"]
    B3["Mass: 12% on the engine · 20 kg per wheel corner<br/>ghost nodes 0.25 kg carry the render mesh"]
    B4["Rigid barrier: concrete block, face at x = 0<br/>18 m wide · 3 m tall · friction 0.3"]
    B5["Parts on the lattice: bumpers, hood, fenders,<br/>doors, trunk, mirrors, panes, lamps, wheels"]
  end

  subgraph RUN["4 · One substep, repeated"]
    direction TB
    R1["Predict: gravity, x ← x + v·Δt"]
    R2["XPBD springs with compliance 1/k<br/>and 8% critical damping"]
    R3["Plastic yield: strain beyond yield<br/>moves the rest length (0.25–1.8× L₀)"]
    R4["Contacts: ground, tyres, barrier face<br/>(forces summed like a load-cell wall)"]
    R5["Coulomb friction → friction heat"]
    R6["Velocities v = (x − x*) / Δt"]
    R7["Every 5th substep: damage checks<br/>part off at mean plastic strain of its mounts<br/>wheel off at 30% or 45 cm back · tyre burst at the rim"]
    R1 --> R2 --> R3 --> R4 --> R5 --> R6 --> R7
    R7 -- "Δt = 0.1 ms to T0 + 0.3 s, then 0.5 ms" --> R1
  end

  REC["Record: every node, its plastic strain, cabin frame,<br/>energy · every 1 ms to +0.3 s, 4 ms to +1 s, then 10 ms"]
  STOP{"T0 + 2.0 s<br/>(1.2 s Lab sedan)?"}

  subgraph FIN["5 · finalize()"]
    direction TB
    F1["Crash pulse: cabin velocity on a 0.1 ms grid<br/>CFC 60 filter → deceleration"]
    F2["Metrics: impact speed · Δv · rebound · peak g<br/>time to stop · max and permanent crush · intrusion"]
    F3["Glass and lamps from the recorded strain<br/>tempered 6% · roof 12% · lamps 10% · windshield cracks 2.5%"]
  end

  subgraph DUMMY["6 · Occupant"]
    direction TB
    D1["7-particle side-view dummy<br/>driven by the crash pulse"]
    D2["Belt: pretensioner up to 8 cm · 4.5 kN load limiter<br/>Airbag: fires at Δv 2 m/s within 45 ms"]
    D3["Contacts: wheel and column · windshield · roof<br/>knee bolster · chin to chest"]
    D4["SAE J211 filters → HIC15 · chest 3 ms<br/>deflection · Nij · neck tension and compression"]
    D1 --> D2 --> D3 --> D4
  end

  subgraph HAZ["7 · After the crash"]
    direction TB
    H1{"Front crushed back<br/>to the radiator?"}
    H2{"Engine driven back<br/>≥ 30 cm?"}
    H3["Steam vents"]
    H4["Engine-bay fire<br/>smoke 0.3 s · flames 1.2 s · well alight 9 s"]
    H1 -- yes --> H3
    H2 -- yes --> H4
  end

  subgraph OUT["8 · Playback and results"]
    direction TB
    O1["Slow-motion replay 1/40× to 1×<br/>free camera follows the car"]
    O2["Injury criteria vs FMVSS 208 limits<br/>HIC15 700 · chest 60 g, 63 mm · Nij 1.0"]
    O3["Charts: occupant · vehicle (pulse, force vs crush)<br/>energy: where ½mv² went"]
    O4["Damage list: parts off · panes · tyres"]
    O5["Re-run the dummy with other restraints<br/>on the same crash"]
  end

  SET --> APP --> BUILD --> RUN
  RUN --> REC --> STOP
  STOP -- no --> RUN
  STOP -- yes --> FIN
  FIN --> DUMMY --> OUT
  FIN --> HAZ --> OUT
  D3 -. "head strike cracks the windshield" .-> O1

  S1 ~~~ S4
  S2 ~~~ S5
  S3 ~~~ S6
  B1 ~~~ B4
  B2 ~~~ B5
  O1 ~~~ O4
  O2 ~~~ O5

  class S1,S2,S3,S4,S5,S6 input
  class B1,B2,B3,B4,B5 model
  class A1,A2,A3,R1,R2,R3,R4,R5,R6,R7,REC,F1,F2,F3,D1,D2,D3,D4 calc
  class A4,STOP,H1,H2 decide
  class H3,H4,O1,O2,O3,O4,O5 out
```

The first 150 ms, as the restraints see it (times are relative to the airbag's firing time, *t_fire*):

```mermaid
sequenceDiagram
  autonumber
  participant Car as Car structure (lattice)
  participant Pulse as Cabin pulse
  participant Ctl as Restraint controller
  participant Belt as Seatbelt
  participant Bag as Airbag
  participant Dum as Dummy
  Car->>Car: First node reaches the barrier face (T0)
  Car->>Car: Crumple zone yields, rest lengths shorten
  Car->>Pulse: Cabin decelerates (CFC 60)
  Pulse->>Ctl: Speed change reaches 2 m/s within 45 ms of T0 (t_fire)
  Ctl->>Belt: Pretensioner pulls from t_fire + 1 ms to + 9 ms, up to 8 cm, while belt force is below 1.5 kN
  Ctl->>Bag: Starts inflating at t_fire + 4 ms, full 26 ms later
  Dum->>Belt: Torso loads the shoulder and lap belts
  Belt-->>Dum: Load limiter pays out webbing at 4.5 kN
  Dum->>Bag: Head and chest ride down on the bag
  Note over Bag,Dum: From t_fire + 110 ms the bag vents, its stiffness falling to 25% over 120 ms
  Car->>Car: Maximum crush, then elastic rebound
  Dum->>Dum: Rebounds into the seat
  Note over Dum: Scored over T0 − 5 ms to T0 + 300 ms
```

### Brick wall

`Simulator.html?preset=brick`: the same free simulator into a breakable wall (preset 64 km/h, Dramatic damage).

```mermaid
flowchart TB
  classDef input fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef model fill:#fef3c7,stroke:#d97706,color:#0f172a
  classDef calc fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef decide fill:#fee2e2,stroke:#dc2626,color:#0f172a
  classDef out fill:#dcfce7,stroke:#16a34a,color:#0f172a

  subgraph SET["1 · Setup"]
    direction TB
    S1["Vehicle · speed · angle · mass · stiffness<br/>damage · restraints (as for the rigid barrier)"]
    S2["Mortar strength per joint<br/>weak 8 kN · standard 30 kN · strong 120 kN"]
  end

  subgraph WALL["2 · The wall"]
    direction TB
    W1["366 bricks, 40 × 20 × 25 cm, 2,000 kg/m³<br/>12 courses in running bond, 12 m wide"]
    W2["Each brick a rigid body:<br/>position · quaternion · velocity · spin"]
    W3["Mortar joints: two bond points each,<br/>front and back, so joints carry bending"]
    W4["Anchors: footing under the bottom course<br/>and a pillar at each end, 1.5× strength"]
    W1 --> W2
    W1 --> W3 --> W4
  end

  subgraph CAR["2 · The car"]
    direction TB
    C1["Lattice, zones and parts<br/>as for the rigid barrier"]
  end

  subgraph RUN["3 · One substep, repeated"]
    direction TB
    R1["Predict nodes and awake bricks<br/>(gyroscopic term for free spin)"]
    R2["Car springs: XPBD with plastic yield"]
    R3["Mortar bonds touching an awake brick:<br/>stiff point constraints, compliance 2×10⁻⁸ m/N"]
    R4{"Tension or shear<br/>above the bond's strength?"}
    R5["Bond breaks: stored energy → fracture<br/>break event: sound, dust, chips"]
    R6["Support search from the anchors<br/>through intact bonds: cut-off bricks wake and fall"]
    R7["Node–brick contacts through a spatial hash<br/>brick–brick and brick–ground contacts"]
    R8["Friction · velocities · contact velocity pass<br/>still bricks go to sleep"]
    R1 --> R2 --> R3 --> R4
    R4 -- yes --> R5 --> R6 --> R7
    R4 -- no --> R7
    R7 --> R8
    R8 -- "next substep" --> R1
  end

  subgraph FIN["4 · After the run"]
    direction TB
    F1["Brick poses recorded every frame<br/>(position + quaternion)"]
    F2["Crash pulse, metrics, glass,<br/>dummy and injury criteria as for the rigid barrier"]
    F3["Steam / fire rule"]
  end

  subgraph OUT["5 · Playback and results"]
    direction TB
    O1["Bricks fly, tumble and settle in slow motion"]
    O2["Energy chart includes mortar fracture and<br/>the bricks' gravitational energy"]
    O3["Note: a breaking wall absorbs energy and lengthens<br/>the crash, so injury numbers aren't comparable<br/>with rigid-barrier tests"]
  end

  SET --> WALL & CAR
  WALL --> RUN
  CAR --> RUN
  RUN -- "2.2 s (Lab sedan) or 2.4 s after T0" --> FIN --> OUT

  class S1,S2 input
  class W1,W2,W3,W4,C1 model
  class R1,R2,R3,R5,R6,R7,R8,F1,F2,F3 calc
  class R4 decide
  class O1,O2,O3 out
```

A brick's life, and a mortar bond's:

```mermaid
stateDiagram-v2
  direction LR
  state "Dormant (held by its bonds)" as Dormant
  state "Awake (simulated)" as Awake
  state "Sleeping (loose, at rest)" as Sleeping
  [*] --> Dormant
  Dormant --> Awake: a car node touches it
  Dormant --> Awake: a bond to it reaches 40% of its strength
  Dormant --> Awake: its path to the footing or pillars is cut
  Awake --> Dormant: still for 0.15 s, supported and bonded
  Awake --> Sleeping: still for 0.15 s, loose or unsupported
  Sleeping --> Awake: pushed hard by the car
  note right of Awake
    still means below 0.08 m/s
    and 0.5 rad/s
  end note
```

```mermaid
stateDiagram-v2
  direction LR
  state "Intact" as Intact
  state "Broken" as Broken
  [*] --> Intact
  Intact --> Broken: tension, combined force above its strength
  Intact --> Broken: compression, shear above strength + 0.6 × compression
  Broken --> [*]: stored energy booked as fracture
  note right of Intact
    each joint is two bond points
    sharing the joint's strength
  end note
```

### Frontal overlap lab

`Simulator.html?lab=overlap`: part of the front hits a barrier.

```mermaid
flowchart TB
  classDef input fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef model fill:#fef3c7,stroke:#d97706,color:#0f172a
  classDef calc fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef decide fill:#fee2e2,stroke:#dc2626,color:#0f172a
  classDef out fill:#dcfce7,stroke:#16a34a,color:#0f172a

  subgraph SET["1 · Settings"]
    direction TB
    S1["Speed 10–50 mph (mph)<br/>default 40 mph = 64 km/h"]
    S2["Overlap (overlap)<br/>40% moderate · 25% small"]
    S3["Barrier face (barrier)<br/>aluminium honeycomb · rigid"]
  end

  subgraph BAR["2 · Offset barrier"]
    direction TB
    B1["Rigid block 1 m wide, 1.5 m tall<br/>inner edge at −W/2 + overlap × W"]
    B2{"Honeycomb?"}
    B3["5 cm cell grid: main block 0.20–0.85 m high,<br/>0.45 m deep, crushes at 0.342 MPa"]
    B4["Front strip 0.28–0.61 m high, 0.09 m deep,<br/>1.711 MPa: 0.54 m in front of the block"]
    B5["No honeycomb: block edge rounded<br/>to 150 mm"]
    B1 --> B2
    B2 -- yes --> B3 --> B4
    B2 -- no --> B5
  end

  subgraph CAR["2 · Lexus RX 350"]
    direction TB
    C1["Standard lattice and zones"]
    C2["Footwell option: cabin's outer three node layers,<br/>last 0.55 m before the firewall:<br/>sheet-metal strength 1.1× k, 1× yield"]
    C3["Measurement points: steering column · brake pedal<br/>toe pan · hinge pillar · dash"]
    C1 --> C2
    C1 --> C3
  end

  subgraph APP["3 · Guided approach"]
    direction TB
    A1["Same controllers as the barrier tests<br/>stops 0.54 m earlier with honeycomb"]
  end

  subgraph RUN["4 · Impact substeps"]
    direction TB
    R1["XPBD springs and plastic yield"]
    R2["Node vs barrier: signed-distance contact<br/>(block with rounded edge)"]
    R3["Node vs honeycomb: claims the cells under<br/>its share of the face"]
    R4{"Pressure above<br/>the cell's crush stress?"}
    R5["Cell holds: node stopped"]
    R6["Cell crushes at constant force,<br/>at most the node's forward advance per step<br/>crush work booked separately"]
    R7["Cell bottoms out with 6 cm left"]
    R1 --> R2 --> R3 --> R4
    R4 -- no --> R5
    R4 -- yes --> R6 --> R7
  end

  subgraph ANA["5 · Analysis"]
    direction TB
    N1["Intrusion of each point in a frame fitted<br/>to the undamaged rear cabin (polar decomposition)"]
    N2{"Over the limit?<br/>column 10 cm · pedal, toe pan, hinge 15 cm"}
    N3["Dummy: belt and airbag, scored as<br/>for the barrier tests"]
    N4["Yaw: how far the car turned"]
    N5["Steam / fire rule"]
    N1 --> N2
  end

  subgraph OUT["6 · Results"]
    direction TB
    O1["Live: time · pulse · column vertical and lateral<br/>pedal · toe pan"]
    O2["Intrusion, largest and permanent, flagged"]
    O3["Charts: crash pulse (longitudinal, lateral) · cabin speed<br/>barrier force · column · lower intrusion<br/>head acceleration · chest deflection · energy"]
    O4["Honeycomb crushed (cm), cells drawn crushed"]
  end

  SET --> BAR & CAR
  BAR --> APP
  CAR --> APP
  APP --> RUN --> ANA --> OUT

  O1 ~~~ O3
  O2 ~~~ O4

  class S1,S2,S3 input
  class B1,B3,B4,B5,C1,C2,C3 model
  class A1,R1,R2,R3,R5,R6,R7,N1,N3,N4,N5 calc
  class B2,R4,N2 decide
  class O1,O2,O3,O4 out
```

Why the two overlaps differ (the claim the physics check holds it to):

```mermaid
flowchart LR
  classDef good fill:#dcfce7,stroke:#16a34a,color:#0f172a
  classDef bad fill:#fee2e2,stroke:#dc2626,color:#0f172a
  subgraph M40["40% moderate overlap"]
    direction TB
    a1["Barrier covers 77 cm<br/>of the 192 cm front"]
    a2["Engine block and crumple zone<br/>in the load path"]
    a3["Front crushes progressively<br/>(honeycomb crushes like another car)"]
    a4["Cabin holds: check at 40 mph,<br/>hinge pillar 6.8 cm"]
    a1 --> a2 --> a3 --> a4
  end
  subgraph M25["25% small overlap"]
    direction TB
    b1["Barrier covers 48 cm,<br/>mostly outside the engine block"]
    b2["Wheel and suspension<br/>driven back"]
    b3["Wheel pushes into the hinge pillar<br/>and toe pan (sheet-metal strength)"]
    b4["Footwell and pillar intrude, car yaws:<br/>check at 40 mph rigid, hinge pillar 15.8 cm"]
    b1 --> b2 --> b3 --> b4
  end
  class a4 good
  class b4 bad
```

### Two-vehicle collision lab

`Simulator.html?lab=multi`: two cars crash into each other in one solver.

```mermaid
flowchart TB
  classDef input fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef model fill:#fef3c7,stroke:#d97706,color:#0f172a
  classDef calc fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef out fill:#dcfce7,stroke:#16a34a,color:#0f172a

  subgraph SET["1 · Settings"]
    direction TB
    SA["Car A: class (aCls), mass 800–3,000 kg (aMass),<br/>speed 0–60 mph (aMph)<br/>default: Mustang 1,890 kg at 40 mph"]
    SB["Car B: class (bCls), mass (bMass), speed (bMph)<br/>default: Lexus, heavy, 2,400 kg at 40 mph"]
    SG["Approach angle 0–45° (angle)"]
    SC["Classes: coupe = Mustang · suv / heavy = Lexus<br/>compact = Lab sedan (simple model)"]
  end

  subgraph GEO["2 · Placement"]
    direction TB
    G1["Car A at x below 0, heading 0<br/>Car B nose to nose, heading 180° − angle"]
    G2["Gap 2 cm + (vA + vB) × 4 ms"]
    G3["Approach: both drive at constant speed<br/>for 2.4 s into position"]
  end

  subgraph BUILD["3 · One solver, two units"]
    direction TB
    U1["Both lattices concatenated into one node<br/>and constraint array, each with its own zones"]
    U2["Car-to-car contacts: nodes as 12 cm spheres,<br/>spatial hash over the bounding-box overlap"]
    U3["Approach-only: a contact never separates<br/>faster than 2 cm/s (crushed fronts interlock)"]
    U4["Sheet metal on sheet metal: friction 0.4"]
    U1 --> U2 --> U3 --> U4
  end

  subgraph RUN["4 · Impact, 1.4 s"]
    direction TB
    R1["Same substep: XPBD, plastic yield,<br/>ground and car-to-car contacts, friction"]
    R2["Per car: cabin frame, crush, contact force,<br/>plastic work, momentum and kinetic energy"]
    R3["Per car: crash pulse and metrics"]
    R1 --> R2 --> R3
  end

  subgraph ANA["5 · Analysis"]
    direction TB
    N1["A dummy in each car: belt and airbag"]
    N2["Δv of each driver (vector)"]
    N3["Momentum: before, and 150 ms after<br/>(tyres and road take a little)"]
    N4["Energy: motion of each car · bent metal of each<br/>springback and parts · heat"]
    N5["Steam / fire rule for each car"]
  end

  subgraph OUT["6 · Results"]
    direction TB
    O1["Δv bars: each driver's speed change,<br/>peak g, crush, HIC, chest"]
    O2["Momentum arrows in the scene:<br/>car A, car B, and the total"]
    O3["Charts: Δv of each car · cabin deceleration<br/>force between the cars · energy · drivers"]
    O4["Free camera follows the pair's centre of mass"]
  end

  SET --> GEO --> BUILD --> RUN --> ANA --> OUT

  SA ~~~ SG
  SB ~~~ SC
  N1 ~~~ N4
  N2 ~~~ N5
  O1 ~~~ O3
  O2 ~~~ O4

  class SA,SB,SG,SC input
  class G1,G2,U1,U2,U3,U4 model
  class G3,R1,R2,R3,N1,N2,N3,N4,N5 calc
  class O1,O2,O3,O4 out
```

What the lab teaches, step by step:

```mermaid
sequenceDiagram
  participant A as Car A (mass mA)
  participant I as Contact between the fronts
  participant B as Car B (mass mB)
  A->>I: Fronts meet, both crumple zones crush
  I->>A: Force F pushes A back
  I->>B: Force F pushes B back (Newton's third law)
  Note over A,B: The same force for the same time gives each car the same impulse J
  A->>A: Speed change ΔvA = J / mA
  B->>B: Speed change ΔvB = J / mB
  Note over A,B: The lighter car's speed changes more, so its driver's crash is harder
  Note over A,B: Total momentum is kept, while the kinetic energy becomes bent metal and heat
```

### Side impact lab

`Simulator.html?lab=side`: a barrier trolley or a pole hits the driver's door.

```mermaid
flowchart TB
  classDef input fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef model fill:#fef3c7,stroke:#d97706,color:#0f172a
  classDef calc fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef decide fill:#fee2e2,stroke:#dc2626,color:#0f172a
  classDef out fill:#dcfce7,stroke:#16a34a,color:#0f172a

  subgraph SET["1 · Settings"]
    direction TB
    S1["Striking object (impactor)<br/>barrier trolley at 37 mph · pole at 20 mph"]
    S2["B-pillar and door ring steel (steel)<br/>mild · hot-stamped"]
    S3["Curtain airbag (curtain)"]
  end

  S1 --> K{"Impactor?"}

  subgraph MDB["2a · Barrier trolley"]
    direction TB
    M1["1,900 kg lattice, 480 nodes, 3.6 m long"]
    M2["Crushable face: 0.38–1.14 m high (SUV height),<br/>0.45 m deep, 1.68 m wide · 0.8× k, 0.9× yield"]
    M3["Rigid trolley behind it: 6× k, 30× yield"]
    M4["Heads across the car at 37 mph,<br/>aimed just behind the driver's H-point"]
  end

  subgraph POLE["2b · Pole"]
    direction TB
    P1["Fixed 254 mm cylinder<br/>in line with the driver"]
    P2["The car slides sideways into it at 20 mph<br/>on a low-friction carrier (friction 0.03)"]
  end

  subgraph CAR["2 · Struck Lexus"]
    direction TB
    C1["Door ring (doors, B-pillar, sill, roof rail),<br/>outer two node layers along the cabin:<br/>mild 0.6× k, 0.6× yield · hot-stamped 1.4× k, 1.8× yield"]
    C2["Cabin between floor and roof hollow<br/>(cross springs 0.12×), so the door can come in"]
    C3["Measurement points: B-pillar at three heights<br/>door at pelvis, chest and window height"]
  end

  subgraph RUN["3 · Impact, 0.5 s"]
    direction TB
    R1["Trolley: car-to-car contacts in one solver<br/>Pole: signed-distance contact"]
    R2["Telemetry: velocity of the car's far half<br/>(where the seats are mounted)"]
    R3["Intrusion in a frame fitted to the far side"]
    R1 --> R2 --> R3
  end

  subgraph INPUT["4 · Dummy input"]
    direction TB
    I1["Lateral acceleration of the far half"]
    I2["Door's inner surface: pelvis and chest<br/>(trim 20 cm in) · window (16 cm in)"]
    I3["Striker surface: the trolley face's top edge<br/>or the pole, in the car's frame"]
  end

  subgraph DUM["5 · Side dummy"]
    direction TB
    D1["Pelvis 14 kg · thorax 20 kg · T1 8 kg<br/>neck 1.2 kg · head 4.6 kg · struck-side ribs"]
    D2["Padding: elastic, then a plateau force,<br/>then bottoming out"]
    D3["Window glass breaks at 4 kN<br/>or when the striker reaches it"]
    D4["Curtain: fires at a 1 m/s lateral speed change<br/>within 30 ms · vented, up to 1.2 kN"]
    D5["Scores: HIC36 · rib deflection · pelvis force"]
    D1 --> D2 --> D3 --> D4 --> D5
  end

  subgraph OUT["6 · Results"]
    direction TB
    O1{"B-pillar intrusion over 15 cm?"}
    O2["Dummy vs limits: HIC36 1,000<br/>rib deflection 44 mm · pelvis 6 kN"]
    O3["Charts: intrusion with the curtain's inflation window<br/>rib deflection · pelvis force · head · car lateral g"]
    O4["Re-run the dummy with or without<br/>the curtain on the same crash"]
    O5["3D: crushed door, curtain unrolling inside<br/>the window, honeycomb face crushing"]
  end

  K -- trolley --> MDB
  K -- pole --> POLE
  S2 --> CAR
  MDB --> RUN
  POLE --> RUN
  CAR --> RUN
  RUN --> INPUT --> DUM --> OUT
  S3 --> DUM

  M1 ~~~ M3
  M2 ~~~ M4
  O1 ~~~ O4
  O2 ~~~ O5

  class S1,S2,S3 input
  class M1,M2,M3,M4,P1,P2,C1,C2,C3 model
  class R1,R2,R3,I1,I2,I3,D1,D2,D3,D4,D5 calc
  class K,O1 decide
  class O2,O3,O4,O5 out
```

The race between the door and the curtain airbag:

```mermaid
sequenceDiagram
  autonumber
  participant Str as Trolley or pole
  participant Door as Door ring (lattice)
  participant Car as Struck car (far half)
  participant Ctl as Curtain controller
  participant Cur as Curtain airbag
  participant Glass as Window glass
  participant Dum as Side dummy
  Str->>Door: Contact: face crushes, door ring yields
  Door->>Dum: Door trim reaches the pelvis, ribs and shoulder
  Door->>Car: Load passes through the floor to the far side
  Car->>Ctl: Lateral speed change reaches 1 m/s within 30 ms (t_fire)
  Ctl->>Cur: Inflates from t_fire + 6 ms, full 18 ms later, 12 cm thick
  Dum->>Glass: Head swings toward the window
  alt Glass load above 4 kN, or the striker reaches the window
    Glass-->>Dum: Glass breaks, the striker becomes the hard surface
  end
  Cur-->>Dum: Cushions the head, force levelling off at 1.2 kN as it vents
  Note over Door,Dum: Scored: B-pillar intrusion, HIC36, rib deflection, pelvis force
```

### Whiplash sled lab

`Simulator.html?lab=whiplash`: a seat on a sled is shoved forward, as when a stopped car is hit from behind.

```mermaid
flowchart TB
  classDef input fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef model fill:#fef3c7,stroke:#d97706,color:#0f172a
  classDef calc fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef decide fill:#fee2e2,stroke:#dc2626,color:#0f172a
  classDef out fill:#dcfce7,stroke:#16a34a,color:#0f172a

  subgraph SET["1 · Settings"]
    direction TB
    S1["Striking-car speed 20–30 mph (mph)"]
    S2["Head-restraint backset 0–12 cm (backset)"]
    S3["Head-restraint height −12 to +4 cm<br/>vs the top of the head (height)"]
  end

  subgraph PULSE["2 · Sled pulse"]
    direction TB
    P1["Speed change = half the striking speed<br/>(a stationary car struck from behind)"]
    P2["Triangular, 91 ms long, starting at 10 ms<br/>peak = 2 × Δv / 91 ms (20 mph: about 10 g)"]
    P1 --> P2
  end

  subgraph SEAT["3 · Seat"]
    direction TB
    T1["Seatback 25° from vertical,<br/>surface 13.5 cm behind the H-point"]
    T2["Foam 2,100 N/m per contact point, 12 cm deep"]
    T3["Recliner 12,000 N·m/rad, yields above 2.2 kN·m"]
    T4["Head restraint 24 cm tall,<br/>placed by the backset and height settings"]
  end

  subgraph DUM["4 · Dummy, 26 bodies"]
    direction TB
    D1["Pelvis 15 kg"]
    D2["Lumbar L5–L1: 5 × 1.6 kg<br/>350 N·m/rad per joint"]
    D3["Thoracic T12–T1: 12 × 2.6 kg<br/>600 N·m/rad per joint"]
    D4["Cervical C7–C1: 7 × 0.3 kg<br/>11 N·m/rad, stops at ±0.25 rad"]
    D5["Head 4.5 kg, radius 9.5 cm"]
    D1 --> D2 --> D3 --> D4 --> D5
  end

  subgraph RUN["5 · 0.1 ms steps, 0.3 s"]
    direction TB
    R1["Sled acceleration applied to the seat frame"]
    R2["Joint springs; damping integrated exactly<br/>per joint (stable on 2 cm vertebrae)"]
    R3["Seatback foam and recliner moment"]
    R4{"Head touching the restraint?"}
    R5["Restraint force on the head<br/>contact time recorded"]
    R1 --> R2 --> R3 --> R4
    R4 -- yes --> R5
  end

  subgraph SCORE["6 · Scores"]
    direction TB
    C1{"Contact time ≤ 70 ms?"}
    C2{"T1 peak ≤ 9.5 g?"}
    C3["NIC = 0.2 × a_rel + v_rel², until contact<br/>or 150 ms (limit 15 m²/s²)"]
    C4["Neck extension · restraint force"]
  end

  subgraph OUT["7 · Results"]
    direction TB
    O1["Both seat-design criteria met, or which failed"]
    O2["Charts: sled, T1 and head acceleration<br/>restraint force · neck extension · NIC"]
    O3["3D: spine bends vertebra by vertebra,<br/>restraint turns orange on contact"]
  end

  SET --> PULSE --> RUN
  SET --> SEAT
  SEAT --> RUN
  DUM --> RUN
  RUN --> SCORE --> OUT

  T1 ~~~ T3
  T2 ~~~ T4
  C1 ~~~ C3
  C2 ~~~ C4

  class S1,S2,S3 input
  class P1,P2,T1,T2,T3,T4,D1,D2,D3,D4,D5 model
  class R1,R2,R3,R5,C3,C4 calc
  class R4,C1,C2 decide
  class O1,O2,O3 out
```

The rear-impact sequence:

```mermaid
sequenceDiagram
  autonumber
  participant Sled
  participant Seat as Seat and seatback
  participant Torso as Pelvis, lumbar and thoracic spine
  participant Neck as Cervical spine
  participant Head
  participant HR as Head restraint
  Sled->>Seat: Pulse starts at 10 ms and lasts 91 ms
  Seat->>Torso: Foam pushes the torso forward
  Torso->>Torso: T1 accelerates (scored, 9.5 g or less passes)
  Torso->>Neck: The neck is dragged forward under the head
  Neck->>Head: The head lags and tips back (extension)
  Note over Neck,Head: NIC builds from the motion of T1 relative to the head
  Head->>HR: Head reaches the restraint (70 ms or less passes)
  HR-->>Head: The restraint stops the backward swing
  Seat->>Seat: Recliner yields if the moment passes 2.2 kN·m
  Head->>Torso: Rebound forward
```

### Occupant restraint lab

`Simulator.html?lab=restraint`: one crash, three restraint systems, three collisions.

```mermaid
flowchart TB
  classDef input fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef model fill:#fef3c7,stroke:#d97706,color:#0f172a
  classDef calc fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef out fill:#dcfce7,stroke:#16a34a,color:#0f172a

  subgraph SET["1 · Setting"]
    direction TB
    S1["Restraint system (restraint)<br/>unbelted · plain 3-point belt · belt + limiter + airbags"]
  end

  subgraph CRASH["2 · One crash"]
    direction TB
    C1["Lexus RX 350, 35 mph (56 km/h)<br/>full-width rigid barrier, guided approach"]
    C2["Vehicle physics run once → crash pulse"]
    C1 --> C2
  end

  subgraph RUNS["3 · Three dummy runs"]
    direction TB
    D1["Unbelted<br/>no belt, no airbag"]
    D2["Plain belt<br/>no pretensioner, no load limiter, no airbag"]
    D3["Full system<br/>pretensioner, 4.5 kN limiter, airbag"]
  end

  subgraph ORG["4 · Organs"]
    direction TB
    G1["Brain: mass on a spring in the skull<br/>50 Hz, 30% damping, driven by head acceleration"]
    G2["Heart: mass on a spring in the chest<br/>25 Hz, 25% damping, driven by chest acceleration"]
  end

  subgraph PH["5 · Three collisions"]
    direction TB
    P1["1 · Vehicle: first contact until the cabin stops"]
    P2["2 · Occupant: belt, airbag and interior force<br/>above max(1 kN, 20% of its peak)"]
    P3["3 · Organs: from the peak restraint load until<br/>the organs settle below 20% of their peak movement"]
    P1 --> P2 --> P3
  end

  subgraph OUT["6 · Results"]
    direction TB
    O1["The three collisions as bars, 0–200 ms"]
    O2["Selected system: HIC15 · chest compression<br/>(target under 50 mm) · chest 3 ms"]
    O3["All three compared: HIC15 · chest · peak load<br/>head forward movement"]
    O4["Charts: head path from the side · head acceleration<br/>chest compression · belt and airbag forces<br/>brain and heart movement"]
    O5["3D: head-path trail · onboard inset<br/>switch systems on the same crash"]
  end

  S1 --> CRASH --> RUNS
  RUNS --> ORG --> PH --> OUT
  RUNS --> OUT

  O1 ~~~ O4
  O2 ~~~ O5

  class S1 input
  class C1,G1,G2 model
  class C2,D1,D2,D3,P1,P2,P3 calc
  class O1,O2,O3,O4,O5 out
```

What each system does with the same crash (the physics check's numbers at 56 km/h):

```mermaid
flowchart LR
  classDef bad fill:#fee2e2,stroke:#dc2626,color:#0f172a
  classDef mid fill:#fef3c7,stroke:#d97706,color:#0f172a
  classDef good fill:#dcfce7,stroke:#16a34a,color:#0f172a
  P["Crash pulse:<br/>the cabin stops in about 63 ms"]
  P --> U["Unbelted: the body keeps going at 35 mph<br/>until the wheel, windshield and dash stop it<br/>HIC15 about 2,184"]
  P --> B["Plain belt: stops the torso, but with slack<br/>and no force limit, loading the chest hard<br/>HIC15 about 1,022"]
  P --> F["Full system: pretensioner removes slack,<br/>limiter pays out at 4.5 kN, airbag catches the head<br/>HIC15 about 357"]
  class U bad
  class B mid
  class F good
```

### Pedestrian and emergency braking lab

`Simulator.html?lab=pedestrian`: a pedestrian crosses, and the car may or may not brake in time.

```mermaid
flowchart TB
  classDef input fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef model fill:#fef3c7,stroke:#d97706,color:#0f172a
  classDef calc fill:#ede9fe,stroke:#7c3aed,color:#0f172a
  classDef decide fill:#fee2e2,stroke:#dc2626,color:#0f172a
  classDef out fill:#dcfce7,stroke:#16a34a,color:#0f172a

  subgraph SET["1 · Settings"]
    direction TB
    S1["Speed 12–37 mph (mph)"]
    S2["Pedestrian (target)<br/>adult 1.75 m, 75 kg · child 6 years, 1.17 m, 23 kg"]
    S3["Bumper (bumper)<br/>rigid steel · energy-absorbing foam"]
    S4["Automatic emergency braking (aeb)"]
  end

  subgraph PLAN["2 · Plan, 2 ms steps"]
    direction TB
    L1["Pedestrian walks at 1.39 m/s from the kerb<br/>(3.5 m out, 3.0 m for the child)"]
    L2["Timed so the unbraked car's front meets them"]
    L3["Child: steps out from in front of a parked car"]
    L4["Sensor each step: in the cone, in range,<br/>line of sight clear (segment vs parked car)"]
    L5["AEB state machine (below)"]
    L6{"Contact before the car stops?"}
    L1 --> L2 --> L4
    L3 --> L4
    L4 --> L5 --> L6
  end

  subgraph IMP["3 · Impact, 0.05 ms steps"]
    direction TB
    I1["6-mass chain: feet · knees · pelvis · chest<br/>neck · head, seen from the car's side"]
    I2["Joint springs: knee ligaments give way past 15°<br/>hip stop · damped joints"]
    I3["The car's front from its own side profile:<br/>bumper · hood edge · hood · windshield · roof edge"]
    I4["Surfaces crush in two stages: the chosen bumper,<br/>steel 12 kN then 25 kN, or foam 4 kN then 15 kN"]
    I5["The car's motion is imposed (the pedestrian<br/>is too light to change it)"]
    I6["The road: the body lands on it after the throw"]
    I1 --> I2
    I3 --> I4
  end

  subgraph SC["4 · Scores"]
    direction TB
    C1["HIC15 on the car (limit 1,000), and the surface hit"]
    C2["HIC15 falling onto the road, scored separately"]
    C3["Knee bending (15°) · tibia (170 g) · pelvis (80 g)"]
    C4["Head wrap-around distance · throw distance"]
    C5["The same impact with the other bumper,<br/>for comparison"]
  end

  subgraph OUT["5 · Results"]
    direction TB
    O1["Avoided: distance to spare<br/>or impact speed, and energy taken off"]
    O2["First seen · warning · full braking<br/>(seconds before impact)"]
    O3["Charts: car speed with the braking window<br/>tibia, head and pelvis pulses for both bumpers"]
    O4["3D: sensor cone changes colour by state,<br/>box around a tracked pedestrian"]
    O5["Playback: real time until 0.12 s before impact,<br/>0.06× through the impact, then 0.3×"]
  end

  SET --> PLAN
  L6 -- yes --> IMP --> SC --> OUT
  L6 -- "no: stopped short" --> OUT

  S1 ~~~ S3
  S2 ~~~ S4
  I2 ~~~ I5
  I4 ~~~ I6
  C1 ~~~ C4
  C2 ~~~ C5
  O1 ~~~ O4
  O2 ~~~ O5

  class S1,S2,S3,S4 input
  class L1,L2,L3,I1,I2,I3,I4,I5,I6 model
  class L4,L5,C1,C2,C3,C4,C5 calc
  class L6 decide
  class O1,O2,O3,O4,O5 out
```

The emergency-braking system's states (the colour of the sensor cone in the scene):

```mermaid
stateDiagram-v2
  state "Scanning" as Scan
  state "Pedestrian in view" as View
  state "Tracking (confirmed)" as Track
  state "Warning chime" as Warn
  state "Braking" as Brake
  state "Stopped short" as Stop
  state "Impact" as Hit
  [*] --> Scan
  Scan --> View: in the cone of ±25°, within 60 m (45 m for a child), line of sight clear
  View --> Scan: lost before it is confirmed
  View --> Track: seen for 0.25 s
  Track --> Warn: paths conflict, time to collision below 1.8 s
  Warn --> Brake: time to collision below 1.1 s
  Brake --> Stop: car stops before reaching them
  Brake --> Hit: contact at a lower speed
  Track --> Hit: AEB off, no warning or braking
  Stop --> [*]
  Hit --> [*]
  note right of Brake
    0.1 s latency, then braking builds
    to 0.85 g over 0.25 s
  end note
  note left of Hit
    without AEB the driver brakes
    0.6 s after the impact, at 0.8 g
  end note
```

The impact itself:

```mermaid
sequenceDiagram
  autonumber
  participant Car as Car front (imposed motion)
  participant Leg as Feet and knees
  participant Pel as Pelvis
  participant Up as Chest and neck
  participant Head
  participant Road
  Car->>Leg: Bumper strikes the leg (steel 12 kN plateau, foam 4 kN)
  Note over Leg: Knee bends, ligaments give way past 15°, tibia acceleration scored
  Car->>Pel: Hood edge loads the upper leg and pelvis
  Pel->>Up: Upper body rotates onto the hood
  Up->>Head: Head swings down toward the hood or windshield
  Head->>Car: Head strikes the car, HIC15 on the car and the wrap-around distance
  Car-->>Up: The car brakes or keeps going, and the body is thrown ahead
  Up->>Road: Body lands on the road
  Head->>Road: Head strikes the road, scored as a separate HIC15
```

---

## Rendering the damage

### Skinning the model to the lattice (GPU)

Each vertex of the imported car's mesh is embedded in the lattice cell that contains it: 8 node indices and its position (*t*ₓ, *t*ᵧ, *t*_z) in the cell. Every frame, the node positions and plastic strains are uploaded as a float texture (one RGBA texel per node). The vertex shader then rebuilds each vertex by trilinear interpolation.

Normals aren't recomputed. Each authored normal is turned by the cell's deformation gradient *F* through its cofactor, *n′ = cof(F)·n*. So the model keeps its own smoothing and hard edges while it crumples, and stays exact under rigid motion. A custom depth material skins the shadows the same way. The simple Lab sedan is a subdivided box skinned on the CPU.

### Crumpled metal

The lattice, about 24 cm between nodes, is too coarse for sheet-metal folds, so the shader adds them where the lattice says the metal yielded:

- **Where.** From about 4.5% plastic strain, fully at 18%.
- **Buckles.** Broad buckles move the surface by up to 2.2 cm, along a smoothed normal so hard edges stay closed. Their wavelength is about 20 cm, as the mesh's vertices are 3–8 cm apart.
- **Folds.** Finer folds shade the surface through a screen-space bump, faded with distance so they don't shimmer.
- **Direction.** Where a lattice cell was compressed, the fold pattern blends toward copies squeezed 2.2× along that axis, so the folds run across the crush as on a crushed panel.
- **Paint.** Creases darken, and paint cracks off to grey primer along the sharpest ones.
- **Debris.** A part that comes off keeps its folds: they are baked into its frozen copy on the CPU, with a JavaScript port of the same noise.

This is visual only: intrusion and every number come from the lattice.

### Other effects

- **Debris** is a frozen copy of the part, skinned on the CPU at the moment it came off, following its rigid body's recorded pose.
- **Glass shards** are instanced meshes on precomputed ballistic paths (fall, bounce, settle). They are seeded from the pane name, so scrubbing and replays are consistent.
- **Windshield cracks** are a spider-web pattern drawn on a canvas texture from the break origin and head strikes.
- **Burst tyres** flatten against the ground in the vertex shader.
- **The curtain airbag** is shaped from the car's driver-side window panes: a quilted cushion with sewn chambers that unrolls from the roof rail just inside the glass. Its points ride on the lattice, so the crushed door pushes it in.
- **Fire and steam** are camera-facing instanced sprites: flames (additive), sooty smoke, embers and steam, plus a flickering point light. Each particle's state is a pure function of its index and the time since the crash, so the fire looks the same on every replay.
- **Sound** is synthesised live with Web Audio: structural crunch, metal clank, glass, windshield crackle, tyre pop, airbag, the AEB chime, fire roar and crackle, steam hiss. Point particles show sparks, dust and glass.

---

## Verification

```
node tools/headless-check.js            all scenarios (about two minutes)
node tools/headless-check.js lexus      a subset, by name fragment (rigid56, lab-, fire, ...)
```

The check runs the real modules in Node.

**Scenarios:**
- **Lab sedan:** 13 crashes (30–150 km/h, 30°, mass and stiffness variants, the brick wall at three strengths) and a standing-wall test.
- **Lexus and Mustang:** crashes at 30, 56, 100 and 150 km/h, at 30° and into the brick wall, in both damage modes. Also a parked car, a coasting car, a free wheel spinning at 130 rad/s, a wheel dropped while sliding, the same crash at half the time step, and destruction on vs off.

**It exits non-zero if any of these happens:**
- a run produces NaN, gains energy (more than 3% above the initial kinetic energy) or never reaches the barrier;
- the wall can't stand on its own;
- a part coming off changes total momentum or energy;
- anything comes off at 30 km/h, or at 56 km/h in Realistic mode;
- nothing comes off, or no front tyre bursts, at 150 km/h;
- fewer than 3 parts come off, or no window breaks, in Dramatic mode at 100 km/h;
- a parked car moves or sheds parts; a coasting car slows by more than 5%;
- a free wheel loses spin, or a dropped wheel doesn't end up rolling;
- halving the step changes which parts come off, or their timing by more than 5 ms;
- destruction changes the peak deceleration or HIC by 3% or more.

**Each crash lab is checked for the claim it makes:**
- **Overlap:** the 25% small overlap intrudes more at the hinge pillar than the 40% moderate overlap, and the honeycomb crushes within its depth.
- **Two vehicles:** equal cars get equal Δv. A car of half the mass gets about twice the Δv (1.6–2.4×), while momentum holds over the first 30 ms.
- **Side impact:** the mild-steel B-pillar intrudes more than 15 cm and the hot-stamped one less, and the curtain airbag lowers HIC in the pole test.
- **Whiplash:** a well-placed head restraint passes both criteria, a 10 cm backset doesn't, and T1 acceleration rises with speed.
- **Restraints:** HIC falls from unbelted to plain belt to full restraints.
- **Pedestrian:** emergency braking avoids an adult at 25 mph and cuts a 37 mph impact by more than 40%, and the foam bumper lowers the leg's acceleration.
- **Fire:** a 56 km/h Lexus barrier test vents steam but doesn't catch fire; a 100 km/h one does.

**Results at 56 km/h** (rigid barrier, belt and airbag):

| Car | Crush | Peak (CFC 60) | HIC15 |
|---|---|---|---|
| Lab sedan | about 540 mm | 57 g | about 310 |
| Lexus RX 350 | about 580 mm | 69 g | about 360 |
| Ford Mustang GT500 | about 670 mm (long front overhang) | 36 g | about 210 |

---

## Tools: building, recording, exporting models

### Single-file build

```
node tools/build-standalone.js
```

Writes `Simulator.html` (from `index.html` and every script) and `Car Crash Simulation.html` (from `home.html` and `media/`). Edit the sources, not these two files.

### Recording the home page's video and pictures

```
node tools/record-video.js [shots|video|labs] [--lab <id>]
```

Records the built `Simulator.html` in headless Chrome. It writes:
- `media/crash-reel.mp4`: about a minute of crashes with captions;
- `media/poster.jpg`: the video's poster frame;
- `media/shot-rigid.jpg`, `media/shot-brick.jpg`: the barrier tests;
- `media/lab-<id>.jpg`: one picture per lab.

How it works:
- **Virtual clock.** The page runs on a virtual clock that advances exactly 1/30 s per captured frame, so the video is smooth however long each frame takes to render.
- **Encoding.** Blender's built-in FFmpeg encodes the frames (`tools/encode-video.py`), so no separate ffmpeg install is needed. Use `--chrome <path>` and `--blender <path>` if they aren't in their default folders.
- **Order.** Rebuild before recording, then again afterwards to embed the new media in the home page.
- **No sound.** The app's sounds are synthesised live and aren't captured.

### Rebuilding the car models

```
blender -b -Y --factory-startup --python tools/export-car.py -- tools/cars/lexus.json
```

Needs Blender 4.2 or later (tested with 5.1). `-Y` stops scripts stored in the .blend from running. The exporter:
- strips the rig, the driver, lights and the interior;
- turns the car to x forward and y up, and scales it to the real wheelbase;
- sorts mesh pieces into named parts using the material lists and region boxes in `tools/cars/<car>.json`;
- decimates the meshes;
- writes `models/<car>.glb.js` (a Draco-compressed GLB) and `models/<car>.phys.js` (sizes, roof profile, hubs, tyre size, H-point, part samples, glass panes).

It stops if the wheelbase, axle direction, glass-pane count or H-point come out wrong. Add `--report` to only list the mesh pieces in car coordinates.

Parts follow a naming scheme that carries over to game engines: `DEFORM_` (panels that crumple), `RIGID_Cage_` (body structure), `RIGID_Mech_` (wheels, engine), `BRITTLE_` (glass, lamps) and `BREAKAWAY_` (mirrors).

---

## Design decisions

- **Not real time during the impact.** 60 FPS applies to the approach and playback. The impact is integrated at 0.1 ms, because 30–120 Hz can't resolve a ~100 ms crash pulse or give a valid HIC.
- **Single-threaded plain JavaScript physics.** No WebAssembly, WebGPU compute or SharedArrayBuffer. The impact runs in time-sliced chunks on the main thread, so the page also works from a plain file. Rendering is WebGL (three.js), and the body skinning runs on the GPU.
- **No external physics library.** Destruction follows the node-and-beam approach of BeamNG and Rigs of Rods, built on the same solver:
  - ammo.js soft bodies have no plasticity;
  - a second engine such as Rapier would split the solver and the energy books.
- **Physics on the simulation nodes, not on render vertices.** Material properties live in the lattice and `js/physics.js`; the render mesh only follows it.
- **Two barrier modes.** A rigid barrier, for injury numbers comparable with standard tests, and a breakable brick wall as a demonstration. A breaking wall absorbs energy and lengthens the crash, which lowers every injury number.
- **Mass and stiffness are separate controls.** Changing them together can cancel out.
- **Speed range 10–150 km/h.**
- **Sled-style occupant.** The dummy is driven by the cabin pulse (one-way coupling), not a 3D multibody inside the deforming car. That makes re-running it with other restraints instant.
- **Part-level fracture.** Panels and wheels come off whole; the body structure itself doesn't tear. Bricks break at mortar joints only.
- **Every run is computed.** There are no pre-baked destruction caches.
- **Kill switch per stage.** It brakes during the approach and cancels during the computation. It isn't available during the ~100 ms impact itself.
- **Colour-blind-safe heatmaps, no flashing.** Status is always given as text too.

---

## Limitations

- **Not validated against physical crash tests.** Numbers show trends between settings; they don't predict real injuries.
- **Break limits are judgement calls**, tuned to plausible outcomes:
  - 30–56 km/h: lamps break, no panels or wheels come off;
  - 100 km/h: the bumper, hood, fenders and front wheels come off, depending on the car;
  - 150 km/h: most of the front comes off.
- **Lab settings are judgement calls too.** Steel strengths, honeycomb and trolley-face stiffness, padding, the curtain airbag, seat foam and sensor timings were tuned to give plausible numbers and the right trends. They aren't measured values.
- **The lattice is a box-section approximation of each body.** Its contact surface doesn't follow rounded corners exactly.
- **The "contact, damping & solver" energy share is large**, roughly 20–45%. In a real crash, most of that would be plastic work.
- **Two cars: energy split.** Once the crushed fronts interlock, friction and the solver residual trade energy back and forth. Their total stays right, so the lab shows them together as heat.
- **Debris doesn't collide with the car** after it comes off (it can pass through the body). Bricks don't collide with the interior.
- **Glass shards are visual only.** They don't collide with the car, and on the rigid barrier they stop at its face.
- **Crumple folds and fire are visual.**
  - The folds are drawn where the lattice yielded; they don't add stiffness or change any number.
  - Fire is a rule (engine driven 30 cm into the firewall), not a combustion model. It doesn't weigh how likely ignition is, how much fuel leaked, or fire spreading into the cabin.
  - Real crash fires are much rarer than "every severe crash", so read it as "this crash could start a fire".
- **Hoods and doors don't swing on their hinges** before they come off.
- **The imported interiors are removed.** The app's own seat, wheel, airbag and dash are used, because the occupant model is built around them. The Lexus model has no engine, so a plain block stands in.
- **Lab-only structure.** The overlap lab's weaker cabin corners and the side lab's door-ring steel and hollow cabin are used in those labs only. The barrier tests' cars keep their uniform safety cell.
- **Simplified dummies and braking.**
  - The side-impact dummy works in one plane and leaves out the legs.
  - The whiplash seat is generic.
  - The pedestrian is a single 2D chain, so the arms and far leg only follow it in the 3D view.
  - Emergency braking is a rule-based model of one system, not a particular product.
- **Performance.** The brick-wall computation takes several seconds on a laptop. The phone layout works but is cramped.

---

## Project structure

```
Car Crash Simulation.html   generated single-file home page (edit home.html, then rebuild)
Simulator.html              generated single-file simulator (edit the sources, then rebuild)
home.html                   home page source
index.html                  simulator page source and script loader
css/style.css               layout and theme
js/
  vehicles.js     vehicle specs: lattice grid, zones, interior lines; the side-impact trolley
  physics.js      XPBD lattice, barriers (rigid, brick wall, offset + honeycomb, pole), several
                  vehicles, contacts, destruction, recording, crash pulse, intrusion measurement
  occupant.js     frontal and side-impact dummies, organ model, J211 filters, injury criteria
  guidance.js     PID speed control and pure-pursuit steering for the approach
  whiplash.js     rear-impact sled and the 24-vertebra dummy
  pedestrian.js   emergency braking and the pedestrian impact
  fire.js         steam and fire after the crash: the rule and the effects
  carmodel.js     imported cars: GPU skinning, crumple shading, debris, shards, cracks, flat tyres
  scene.js        three.js scene, the Lab sedan's body, interior, dummy, curtain airbag, cameras
  labscene.js     lab props: offset barrier and honeycomb, pole, barrier trolley, sled and spine,
                  pedestrian, sensor cone, momentum arrows, head trail
  charts.js       canvas line and stacked-area charts with scrub cursors
  fx.js           Web Audio sounds and point particles
  app.js          controller for the barrier tests
  labs.js         controller for the six crash labs (runs instead of app.js with ?lab=)
models/           generated car models (Draco GLB as base64) and physics data
media/            the home page's video, poster and pictures of the eight simulations
tools/
  headless-check.js     physics and lab checks in Node
  build-standalone.js   builds the two single-file pages
  record-video.js       records the home page's media in headless Chrome
  encode-video.py       encodes the video with Blender's FFmpeg
  export-car.py         Blender exporter for the car models
  cars/*.json           per-car part rules for the exporter
```

---

## Credits

- **Lexus RX 350:** "[Lexus RX 350 + rigged (+ rigged driver (human))](https://sketchfab.com/3d-models/lexus-rx-350-rigged-rigged-driver-human-6b9a1994b2dd445c8248270c81eead6b)" by menarzuw, CC BY 4.0.
- **Ford Mustang GT500:** "[Ford Mustang Gt 500 With pro Rig FOR FREE!](https://sketchfab.com/3d-models/ford-mustang-gt-500-with-pro-rig-for-free-f26a29f766844f46910547d6d2cc291d)" by NoOb StUfFs, CC BY 4.0.

Both models are split into parts, re-oriented, scaled and simplified for this app.

**Libraries:**
- [three.js](https://threejs.org/) (MIT), loaded from jsDelivr;
- the Draco decoder (Apache 2.0);
- the simplex noise in the crumple shader, after Ashima Arts and Stefan Gustavson (MIT).

**References:** Macklin, Müller & Chentanez, "XPBD: Position-Based Simulation of Compliant Constrained Dynamics" (2016); Macklin et al., "Small Steps in Physics Simulation" (2019); SAE J211-1 (instrumentation for impact tests); FMVSS 208 (occupant crash protection).
