# Claude Golf Game

A browser golf game built with TypeScript and [three.js](https://threejs.org/). Every hole is randomly generated, with hilly terrain, a fairway that bends, rough, an irregularly shaped green, and a cup with a flag. The ball physics are custom-written.

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
| Look around | Drag anywhere else, or right-drag |
| Zoom | Scroll wheel |
| Change club | `C` (Driver → Iron → Wedge → Putter) |
| New hole | `N` or the **New hole** button |
| Cancel a shot | `Esc` while aiming |

- The game picks a club for you from your lie and distance to the pin; press `C` to change it.
- A round is 9 holes. The panel shows your strokes on the current hole and your running round total. After each hole you get a scorecard.
- Leaving the course costs a one-stroke penalty and puts the ball back where you hit from.
- Pressing **New hole** in the middle of a hole gives you a different hole without scoring the one you abandoned.

## How it works

| File | Role |
| --- | --- |
| [`src/level.ts`](src/level.ts) | Generates a hole from a seed: terrain height, surface types (tee, fairway, green, rough), green shape, and the meshes for terrain, cup, pin and flag |
| [`src/physics.ts`](src/physics.ts) | Ball simulation: gravity, air drag, bounces, rolling, and collisions with the cup, rim and pin |
| [`src/main.ts`](src/main.ts) | Game states, input and aiming, camera, on-screen display, scoring and the frame loop |
| [`src/noise.ts`](src/noise.ts) | Seeded random number generator and gradient noise |

**Terrain:** the ground is defined by `heightAt(x, z)`, a function rather than a stored mesh. The rendered terrain is sampled from it, and the physics calls the same function at the ball's exact position, so what you see always matches what the ball feels.

**Physics:**
- The simulation runs in fixed steps, 240 per second, so results don't depend on frame rate.
- Gravity is 80% of Earth's.
- Each surface has its own bounce, landing grip and rolling resistance, set in the `SURFACES` table in `level.ts`.
- A rolling ball speeds up on slopes and only stops where the slope is gentle enough to hold it.
- The cup is real geometry: a floor, a wall, a rim and the pin. Firm putts that are off center can roll over the edge and stay out.

The ball and cup are drawn about 5–6× real size so they're visible at course scale, keeping the real cup-to-ball ratio. Ball spin isn't modelled, so clubs use higher launch angles to make up for the missing lift.
