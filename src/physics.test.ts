import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { Level } from './level';
import { Ball, type BallEvent } from './physics';
import { makeData } from './testLevel';

/** A flat fairway, 60 × 200 m, with the tee near one end; `opts` paints anything else on it (see makeData). */
function flatLevel(opts: Parameters<typeof makeData>[0] = {}): Level {
  return new Level(makeData({ width: 60, length: 200, tee: { x: 30, z: 190 }, cup: { x: 30, z: 10 }, ...opts }));
}

/** Hits a 30 m/s shot from the tee (toward -z by default) and simulates it until it ends: how it ended, and where. */
function shoot(level: Level, direction = new THREE.Vector3(0, 0, -1)): { event: BallEvent | null; position: THREE.Vector3 } {
  const ball = new Ball(level);
  ball.strike(direction, 30, 0.3, 0);
  let event: BallEvent | null = null;
  for (let i = 0; i < 60 * 60 && !event; i++) event = ball.update(1 / 60);
  return { event, position: ball.position.clone() };
}

/** Round crowns low enough to catch a 30 m/s shot from the tee early in its flight. */
const canopies = [170, 160, 150, 140].map((z) => ({ type: 'tree-oak', x: 30.5, z, y: -4, rotation: 0, scale: 1.5 }));

describe('ball physics', () => {
  test('a shot through tree canopies lands in exactly the same place every time', () => {
    const level = flatLevel({ objects: canopies });
    const first = shoot(level).position;
    // The ball did go through a canopy: it falls short of the same shot with no trees.
    expect(first.z).toBeGreaterThan(shoot(flatLevel()).position.z + 1);
    for (let i = 0; i < 5; i++) expect(shoot(level).position.toArray()).toEqual(first.toArray());
  });

  test('tree canopies take spin off the ball as well as speed', () => {
    // Backspin and a draw, checked 2 s into the flight: with the trees the ball has been in a
    // crown since about 0.7 s, and it's still in the air either way.
    const spinAfterTrees = (level: Level) => {
      const ball = new Ball(level);
      ball.strike(new THREE.Vector3(0, 0, -1), 30, 0.3, 120, 20);
      for (let i = 0; i < 120; i++) ball.update(1 / 60);
      expect(ball.position.y).toBeGreaterThan(1);
      return ball.spin.clone();
    };
    const open = spinAfterTrees(flatLevel());
    const trees = spinAfterTrees(flatLevel({ objects: canopies }));
    expect(trees.length()).toBeLessThan(open.length() * 0.8);
    // Both kinds of spin are reduced, so the draw curves less too.
    expect(Math.abs(trees.y)).toBeLessThan(Math.abs(open.y) * 0.8);
  });

  test('the ball feels the wind of the zone it is in, not elsewhere', () => {
    // A strong crosswind (toward +x), painted either over the shot's path or only past where it stops (z ≈ 25).
    const winds = [
      { speed: 0, direction: 0 },
      { speed: 9, direction: 0 },
    ];
    const onPath = shoot(flatLevel({ winds, wind: (_x, z) => (z > 15 ? 1 : 0) })).position;
    const beyond = shoot(flatLevel({ winds, wind: (_x, z) => (z < 15 ? 1 : 0) })).position;
    expect(onPath.x).toBeGreaterThan(31);
    expect(beyond.x).toBeCloseTo(30, 6);
  });
});

describe('out of bounds', () => {
  // The straight shot from the tee lands around z = 120 and rolls out to about z = 25.
  test('flying over painted out-of-bounds ground is fine if the ball stops in play', () => {
    const level = flatLevel({ surface: (_x, z) => (z > 140 && z < 170 ? 'oob' : 'fairway') });
    const { event, position } = shoot(level);
    expect(event).toBe('stopped');
    expect(position.z).toBeLessThan(60);
  });

  test('a ball that comes to rest on out-of-bounds ground is out', () => {
    const level = flatLevel({ surface: (_x, z) => (z < 50 ? 'oob' : 'fairway') });
    const { event, position } = shoot(level);
    expect(event).toBe('out');
    expect(position.z).toBeLessThan(50);
  });

  test('a ball leaving the map is out straight away, wherever it would have stopped', () => {
    const { event, position } = shoot(flatLevel(), new THREE.Vector3(1, 0, 0));
    expect(event).toBe('out');
    expect(position.x).toBeGreaterThan(60);
    expect(position.x).toBeLessThan(61);
  });
});
