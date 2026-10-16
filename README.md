# Browser Golf Game

A browser golf game built with TypeScript and [three.js](https://threejs.org/). The whole game is one long, randomly generated par 10: a winding fairway of 1.1–1.4 km that can climb or drop up to 200 m, with bunkers, lakes, creeks, wooded and ridged sides, and its own wind. The ball physics are custom-written and include spin, so you can spin wedges back and shape draws and fades.

## Getting started

You need Node.js 18 or newer.

```sh
npm install
npm run dev      # start the dev server, then open the URL it prints
```

Other scripts:

```sh
npm run build    # typecheck and build a static site into dist/
npm run preview  # serve the built site locally
npm run typecheck
npm test         # run the unit tests
```

The game runs entirely in the browser with no backend, so you can host the contents of `dist/` on any static file host.

## How to play

| Action | Control |
| --- | --- |
| Aim and shoot | Press on the ball, drag back, release. The shot goes opposite your drag; longer drag = more power |
| Draw / fade | Aim right of the dashed target line to draw, left to fade. The curve grows up to 48° off the line |
| Look around | Drag anywhere else, or right-drag |
| Zoom | Scroll wheel |
| Change club | `C` (Driver → Iron → Wedge → Putter) |
| New hole | `N` or the **New hole** button (generating one takes under a second) |
| Cancel a shot | `Esc` while aiming |

- **Pin marker:** the marker level with the wind dial shows the distance left to play (along the fairway) and how far the cup is above or below the ball (e.g. `↑ 2.4 m`). It slides to sit over the pin. When the pin is outside its range, it shows an arrow and how far to turn, e.g. `◀ 62°`.
- **Camera:** after each shot the camera turns to face a point about 180 m down the fairway, or the pin when that's closer.
- The game picks a club for you from your lie and distance to the pin; press `C` to change it.
- **Target line:** the dashed line from the ball shows the direction the camera faces. Aiming off it shapes the shot: an arrow pointing right is an in-to-out path and draws (curves left), and pointing left fades. The power bar names the shape, e.g. *Slight draw* or *Max fade*. The arrow stops turning at the 48° limit. To aim somewhere new, turn the camera. The putter has no sidespin and can aim anywhere.
- **Lie:** for every club except the putter, the slope under the ball changes the shot. The panel's **Slope** row shows it, e.g. `Up 6° · Above feet 3°`.
  - **Uphill** adds to the launch angle and **downhill** takes it away; the aim arrow tilts to show this.
  - **Ball above your feet** (ground rising to the right) gives a draw bias, and **below your feet** a fade bias. This adds to your aim and shows in the shot-shape label.
- **Wind:** the dial under **New hole** shows where the wind blows relative to your view, its speed, and how it plays against the line to the pin (e.g. *Into you* or *Cross, left to right*). The flag on the green also streams downwind.
- **Bunkers:** shots from sand come off 30% slower with 50% more backspin. Near the green the game picks the wedge for you.
- **Putting:** when the ball is on the green, the flagstick lifts out of the cup and hovers above it, so putts can't hit it.
- **Penalties:** water, or going past the out-of-bounds line at the edge of the rough or the top of the banks, costs one stroke and replays the shot from where you hit it.
- **Scoring:** when you hole out you see your strokes and score against par 10. Pressing **New hole** mid-hole gives you a new course without scoring the one you abandoned.

## The course

Each hole comes from a random seed:
- **Length and shape:** 1.1–1.4 km along a fairway that winds through several bends but never doubles back.
- **Elevation:** the green ends up to 200 m above or below the tee, reached in terraces (flatter landing areas joined by steeper slopes), over rolling hills. Fairway on ground steeper than 18% is left as rough, since fairway can't hold a ball there.
- **Fairway width:** varies along the hole, from about 12 m to about 48 m across.
- **Sides:** each side switches every few hundred metres between ridges (banks rising away from the fairway) and flat ground lined with trees that thicken into forest near the out-of-bounds line.
- **Bunkers:** about 15, irregularly shaped and sunk below the ground around them, along the fairway edges and around the green.
- **Water:** 1–3 lakes beside or cutting into the fairway; on some holes a moat around most of the green; on some holes creeks crossing the whole hole.
- **Green:** irregular, with a fringe 0.5–2 m wide, the cup set off-center on level ground.

## How it works

| File | Role |
| --- | --- |
| [`src/level.ts`](src/level.ts) | Generates a hole from a seed: fairway path, terrain height, surfaces (tee, fairway, green, rough, bunker, water), hazards, trees, wind, and the meshes for terrain, water, trees, cup, pin and flag |
| [`src/physics.ts`](src/physics.ts) | Ball simulation: gravity, air drag and lift, wind, spin, bounces, skidding and rolling, and collisions with the cup, rim, pin and trees |
| [`src/main.ts`](src/main.ts) | Clubs, game states, input and aiming, camera, on-screen display, scoring and the frame loop |
| [`src/noise.ts`](src/noise.ts) | Seeded random number generator and gradient noise |

**Terrain:** the ground is defined by `heightAt(x, z)`, a function rather than a stored mesh. The rendered terrain is sampled from it, and the physics calls the same function at the ball's exact position, so what you see always matches what the ball feels. The terrain is drawn as tiles covering only the band around the fairway, and distance-to-fairway lookups check only nearby parts of the path, which keeps a 1+ km hole fast.

**Physics:**
- The simulation runs in fixed steps, 240 per second, so results don't depend on frame rate.
- Gravity is 80% of Earth's.
- Each surface has its own bounce, landing grip and rolling resistance, set in the `SURFACES` table in `level.ts`.
- A rolling ball speeds up on slopes and only stops where the slope is gentle enough to hold it.
- **Spin:** the ball spins, and every contact with the ground applies friction where it touches. Backspin can check a landing ball or spin it back, and a skidding ball slides until its spin matches a clean roll. The putter starts the ball already rolling.
- **Sidespin** curves the ball in flight (the Magnus effect) and doesn't affect it on the ground.
- **Wind** acts through air drag and lift on the ball's speed relative to the air. A rolling ball feels half the wind speed, as wind is slower at the turf.
- The cup is real geometry: a floor, a wall, a rim and the pin. Firm putts that are off center can roll over the edge and stay out.
- **Trees:** trunks are solid and the ball bounces off them. Flying through a canopy slows the ball sharply and knocks it randomly off line.

**Tuning:**
- **Clubs:** the `CLUBS` table in `main.ts` sets each club's launch angle, top speed, backspin and sidespin per degree. `MAX_PATH_ANGLE` sets the draw/fade limit.
- **Lies:** in `main.ts`, `SIDEHILL_PATH_BIAS` sets how much a sideways slope shapes the shot (1.5° of path per degree of slope), and `MIN_LOFT` sets the lowest launch angle a downhill lie can reach.
- **Surfaces:** the `SURFACES` table in `level.ts` sets each surface's bounce, landing grip and rolling resistance. `BUNKER_SPEED` and `BUNKER_SPIN` in `main.ts` set the penalty for shots from sand.
- **Course:** the constants at the top of `level.ts`, e.g. `HOLE_LENGTH_MIN`/`HOLE_LENGTH_MAX`, `MAX_CLIMB`, `TERRACE_HEIGHT`, fairway width, `FAIRWAY_MAX_SLOPE` and tree spacing. `PAR` doesn't adjust to length automatically.
- **Air, spin and trees:** the constants at the top of `physics.ts`, including `CANOPY_DRAG` and `CANOPY_SCATTER`.

The ball and cup are drawn about 5–6× real size so they're visible at course scale, keeping the real cup-to-ball ratio. Because of that, the spin rates in `CLUBS` are lower than real-world rpm would suggest. A larger ball needs less spin for the same speed at its surface.
