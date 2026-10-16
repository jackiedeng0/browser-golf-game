# Level editor and stored levels

Holes are currently generated entirely from a seed (`new Level(seed)` in `src/level.ts`). Getting specific hole designs out of the generator by trial and error is too slow, so levels become authored data, built in an in-game editor and stored as files.

This is a prototype. The file format is expected to change as the game loop and mechanics settle, so nothing here aims for backwards compatibility.

## Goals

- Author specific hole designs precisely, by hand.
- Store official levels in the repo and personal levels in a gitignored folder.
- Keep levels fully deterministic, so holes can be speedrun in future.

## Non-goals (for now)

- Courses (multi-hole sequences). Each file is one hole.
- Multiple tee boxes or pin positions per hole.
- Schema versioning or migrations.
- Recording shot inputs or replays.
- Floating-point determinism across machines. Plain TypeScript determinism is enough.

## Level model

Each level is a **raster** over a rectangular area that the author sizes when creating it (e.g. 300 × 1,400 m).

### Grid

A single grid with **0.8 m spacing**. Its points are exactly the terrain mesh vertices. Each point holds three layers:

| Layer | Type | Notes |
|---|---|---|
| height | float | metres |
| surface | u8 id | index into the surface table |
| wind zone | u8 id | index into `winds`; 0 = global default |

Lookups:

- **Height** is interpolated across the same triangles the terrain mesh is drawn with (each cell split along one diagonal), so the ball plays on exactly the surface you see.
- **Surface** and **wind zone** come from the nearest point. With vertex-colour blending, the visual 50/50 edge falls at the same place the nearest-point switch happens, so what you see matches what the ball feels.

Nothing is added at runtime: no noise and no auto-carving. The terrain is exactly what's stored.

> The shared 0.8 m grid for wind zones is simple but wasteful; it's a likely candidate for optimisation later.

### Surfaces

`tee`, `fairway`, `green`, `rough`, `bunker`, `water`, `oob`, defined in a data-driven table (physics properties and colour per id), so adding a type later is one entry. The green fringe is just painted `fairway`.

### Water

Water is painted `water` cells. Each connected water region has its own surface level, so ponds on different terraces work. The heightmap holds the lake bed. A region with no level given fills to 0.1 m below the lowest ground around it.

### Wind

`winds` is a list of `{ speed, direction }` entries with fixed values. Entry 0 is the global default, and painted wind-zone ids point into the list. The ball feels the wind at its current position, blended over about 10 m across zone borders so there are no mid-air kinks. The HUD shows the wind at the ball. Because of the blend, a zone narrower than about 10 m (or the tip of a sharp corner) never reaches its full wind.

### Objects

A generic list, so obstacles other than trees can be added later:

```json
{ "type": "tree-pine", "x": 120.5, "z": -40.2, "y": 0, "rotation": 45, "scale": 1.1 }
```

- `type` names both the kind and the variant (`tree-pine`, `tree-oak`, …). Each type has a code-side definition: mesh plus collider.
- `y` is optional: an offset from the ground. When omitted, the object sits on the terrain.
- `rotation` is in degrees.
- Unknown types are skipped with a console warning.

### Markers

- **Tee** and **cup** positions, exactly one of each.
- **Line of play** (optional): a few points the hole bends through, between the tee and the pin (which aren't repeated in the list). When present, it drives the camera's aim-ahead and the distance-remaining readout. Without it, both use the pin and straight-line distance.

### Out of bounds

The ball is out of bounds on painted `oob` cells or anywhere outside the map rectangle.

## File format

One `.json` file per level, with no version field.

```jsonc
{
  "name": "Dogleg Left",
  "par": 4,
  "width": 300,          // metres
  "length": 1400,        // metres
  "tee": { "x": 0, "z": 0 },
  "cup": { "x": -80, "z": 410 },
  "lineOfPlay": [{ "x": 10, "z": 250 }],
  "winds": [{ "speed": 3, "direction": 90 }, { "speed": 7, "direction": 120 }],
  "waterLevels": [{ "x": 40, "z": 300, "level": 12.5 }],  // one seed point per connected region
  "objects": [ /* see Objects */ ],
  "grids": {
    "height": "<gzip+base64 Float32Array>",
    "surface": "<gzip+base64 Uint8Array>",
    "wind": "<gzip+base64 Uint8Array>"
  }
}
```

The metadata stays readable. The grids are compressed with the browser's `CompressionStream('gzip')` and are only edited in the game, never by hand. Exact field names and encodings can change during implementation.

## Storage

| Folder | Git | Loaded by |
|---|---|---|
| `levels/official/` | committed | `import.meta.glob`, bundled into every build |
| `levels/user/` | gitignored | `import.meta.glob`, **dev only** (`import.meta.env.DEV`), so personal levels never end up in a build |

- There's no backend or middleware. `import.meta.glob` is resolved by Vite at build time.
- **Save** downloads the `.json`. **Open file…** loads any level file from disk without moving it.
- Promoting a user level to official is done by hand (moving the file), by the repo owner only.

## Rendering

The terrain mesh vertices are the grid points. Colour comes from vertex colours per surface, blended across triangles. There's no surface texture.

## Physics changes

- Height, normal, surface and out-of-bounds lookups read the grid instead of the procedural functions.
- Wind is looked up per position (see Wind).
- **Canopy scatter randomness is removed** (`Math.random()` in `src/physics.ts`). Canopies apply deterministic drag only.
- Physics already uses a fixed timestep with an accumulator, so that stays as it is.

## Procedural generator

The generator is kept for one purpose only: **New level → From random**. It runs as today (optionally with a given seed), then its output is rasterized into level data by sampling height and surface at each grid point, placing trees as objects, and deriving tee, cup, line of play (from the centerline), wind and water levels. Play always goes through level data.

## Editor

A top-down 2D canvas, available in all builds.

- **View:** height-shaded map with a surface overlay; pan and zoom.
- **Terrain brushes:** raise/lower, smooth, flatten (to the height where the stroke starts), set height (typed value).
- **Paint:** surface (including `oob`), wind zone. Painting never changes height.
- **Water fill:** click a painted water region to set its level.
- **Objects:** place, move, rotate, delete; scatter brush for any type.
- **Markers:** tee, cup, line-of-play points.
- **Brush controls:** radius, strength, falloff.
- **Undo/redo** (Ctrl+Z / Ctrl+Shift+Z) by snapshotting the grid tiles each stroke touches.
- **Level settings:** name, par, wind list.
- **New level:** choose a size, then blank (flat rough, tee and cup at either end) or from random.
- **Play test:** drops into 3D at the tee; Esc returns to the editor.

## Game flow

Start screen → level list (official, then user) · **Open file…** · **Editor**.

## Build order

Each step leaves the game playable.

1. **Level data and loading.** ✅ Define the level data type, make `Level` build from data, and make the generator produce data. The random hole keeps working through the new path. This also brought in grid lookups, the line of play, painted OOB and water regions, since a level built from data needs them to play.
2. **Gameplay on the grid.** ✅ Wind zones and blending, deterministic canopy.
3. **Files and folders.** JSON encode/decode with gzipped grids, the `levels/` folders plus `.gitignore` entry, `import.meta.glob` loading, start screen, Open file.
4. **Editor.** Canvas and navigation → terrain brushes → surface paint → markers → objects → wind and water tools → undo/redo → play test.
