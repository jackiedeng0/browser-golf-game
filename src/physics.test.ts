import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { Level } from './level';
import type { LevelData } from './levelData';
import { Ball } from './physics';
import { makeData } from './testLevel';

/** A flat fairway, 60 × 200 m, with the tee near one end and wind zones painted by distance along it. */
function flatLevel(extra: Partial<LevelData> = {}, windZone?: (z: number) => number): Level {
  return new Level(
    makeData({ width: 60, length: 200, tee: { x: 30, z: 190 }, cup: { x: 30, z: 10 }, wind: windZone && ((_x, z) => windZone(z)), ...extra }),
  );
}

/** Hits a shot toward -z and simulates it until the ball stops. */
function play(level: Level, speed = 30, loft = 0.3): THREE.Vector3 {
  const ball = new Ball(level);
  ball.strike(new THREE.Vector3(0, 0, -1), speed, loft, 0);
  for (let i = 0; i < 60 * 60 && ball.moving; i++) ball.update(1 / 60);
  return ball.position.clone();
}

describe('ball physics', () => {
  test('a shot through tree canopies lands in exactly the same place every time', () => {
    const objects = [170, 160, 150, 140].map((z) => ({ type: 'tree-oak', x: 30.5, z, y: -4, rotation: 0, scale: 1.5 }));
    const level = flatLevel({ objects });
    const first = play(level);
    // The ball did go through a canopy: it falls short of the same shot with no trees.
    expect(first.z).toBeGreaterThan(play(flatLevel()).z + 1);
    for (let i = 0; i < 5; i++) expect(play(level).toArray()).toEqual(first.toArray());
  });

  test('the ball feels the wind of the zone it is in, not elsewhere', () => {
    // A strong crosswind (toward +x), painted either over the shot's path or only past where it stops (z ≈ 25).
    const winds = [
      { speed: 0, direction: 0 },
      { speed: 9, direction: 0 },
    ];
    const onPath = play(flatLevel({ winds }, (z) => (z > 15 ? 1 : 0)));
    const beyond = play(flatLevel({ winds }, (z) => (z < 15 ? 1 : 0)));
    expect(onPath.x).toBeGreaterThan(31);
    expect(beyond.x).toBeCloseTo(30, 6);
  });
});
