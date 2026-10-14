# Claude Golf Game

A browser golf game built with TypeScript and [three.js](https://threejs.org/). Every hole is randomly generated, with hilly terrain, a fairway that bends, rough, an irregularly shaped green with a fringe, a cup with a flag, and its own wind. The ball physics are custom-written and include spin, so you can spin wedges back and shape draws and fades.

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
| New hole | `N` or the **New hole** button |
| Cancel a shot | `Esc` while aiming |

- The game picks a club for you from your lie and distance to the pin; press `C` to change it.
- **Target line:** the dashed line from the ball shows the direction the camera faces. Aiming off it shapes the shot: an arrow pointing right is an in-to-out path and draws (curves left), and pointing left fades. The power bar names the shape, e.g. *Slight draw* or *Max fade*. The arrow stops turning at the 48° limit. To aim somewhere new, turn the camera. The putter has no sidespin and can aim anywhere.
- **Lie:** for every club except the putter, the slope under the ball changes the shot. The panel's **Slope** row shows it, e.g. `Up 6° · Above feet 3°`.
  - **Uphill** adds to the launch angle and **downhill** takes it away; the aim arrow tilts to show this.
  - **Ball above your feet** (ground rising to the right) gives a draw bias, and **below your feet** a fade bias. This adds to your aim and shows in the shot-shape label.
- **Wind:** the dial under **New hole** shows where the wind blows relative to your view, its speed, and how it plays against the line to the pin (e.g. *Into you* or *Cross, left to right*). The flag on the green also streams downwind.
- A round is 9 holes. The panel shows your strokes on the current hole and your running round total. After each hole you get a scorecard.
- Leaving the course costs a one-stroke penalty and puts the ball back where you hit from.
- Pressing **New hole** in the middle of a hole gives you a different hole without scoring the one you abandoned.

## How it works

| File | Role |
| --- | --- |
| [`src/level.ts`](src/level.ts) | Generates a hole from a seed: terrain height, surface types (tee, fairway, green, rough), green shape and fringe, wind, and the meshes for terrain, cup, pin and flag |
| [`src/physics.ts`](src/physics.ts) | Ball simulation: gravity, air drag and lift, wind, spin, bounces, skidding and rolling, and collisions with the cup, rim and pin |
| [`src/main.ts`](src/main.ts) | Clubs, game states, input and aiming, camera, on-screen display, scoring and the frame loop |
| [`src/noise.ts`](src/noise.ts) | Seeded random number generator and gradient noise |

**Terrain:** the ground is defined by `heightAt(x, z)`, a function rather than a stored mesh. The rendered terrain is sampled from it, and the physics calls the same function at the ball's exact position, so what you see always matches what the ball feels.

**Physics:**
- The simulation runs in fixed steps, 240 per second, so results don't depend on frame rate.
- Gravity is 80% of Earth's.
- Each surface has its own bounce, landing grip and rolling resistance, set in the `SURFACES` table in `level.ts`.
- A rolling ball speeds up on slopes and only stops where the slope is gentle enough to hold it.
- **Spin:** the ball spins, and every contact with the ground applies friction where it touches. Backspin can check a landing ball or spin it back, and a skidding ball slides until its spin matches a clean roll. The putter starts the ball already rolling.
- **Sidespin** curves the ball in flight (the Magnus effect) and doesn't affect it on the ground.
- **Wind** acts through air drag and lift on the ball's speed relative to the air. A rolling ball feels half the wind speed, as wind is slower at the turf.
- The cup is real geometry: a floor, a wall, a rim and the pin. Firm putts that are off center can roll over the edge and stay out.

**Tuning:**
- **Clubs:** the `CLUBS` table in `main.ts` sets each club's launch angle, top speed, backspin and sidespin per degree. `MAX_PATH_ANGLE` sets the draw/fade limit.
- **Lies:** in `main.ts`, `SIDEHILL_PATH_BIAS` sets how much a sideways slope shapes the shot (1.5° of path per degree of slope), and `MIN_LOFT` sets the lowest launch angle a downhill lie can reach.
- **Surfaces:** the `SURFACES` table in `level.ts` sets each surface's bounce, landing grip and rolling resistance.
- **Air and spin:** the constants at the top of `physics.ts`.

The ball and cup are drawn about 5–6× real size so they're visible at course scale, keeping the real cup-to-ball ratio. Because of that, the spin rates in `CLUBS` are lower than real-world rpm would suggest. A larger ball needs less spin for the same speed at its surface.
