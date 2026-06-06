/**
 * station-proof — the full station is airtight by construction. Run: `npm run proof:station`.
 *
 * Two invariants on the production map (game-design §3):
 *   (1) hull-enclosed — no floor cell is 4-adjacent to a space tile (the hull,
 *       windows, and doors always sit between floor and the void).
 *   (2) sealed at spawn — flood from every space cell across non-airtight cells
 *       (airtight = hull / intact window / CLOSED door) never reaches a floor
 *       cell, so no room's air is open to space at round start.
 * A violation prints the offending (x,y). Also reports the map's vital stats.
 *
 * An observer actor ticks once so the composed `airtight` flag layer is current
 * before the seal flood reads it.
 */
import { tickRealtime, neighbors4, pointOf, type World } from '../../rlkit/src/index';
import { buildGameWorld } from './world';
import { LEVEL_ID } from './station';
import { TILES, FLAGS } from './content';

const OBS = 'obs';

function build(): World {
  const { world } = buildGameWorld();
  world.services.timeline.addActor(OBS, 100);
  tickRealtime(world, { player: OBS, ticks: 1 }); // compose the flag layer
  return world;
}

// --- tiny assert harness ----------------------------------------------------
let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const world = build();
const level = world.state.levels.get(LEVEL_ID)!;
const W = level.width;
const H = level.height;
const n = W * H;
const tiles = level.layers.get('tiles') as Uint16Array;
const floorIdx = world.services.tiles.index(TILES.floor);
const spaceIdx = world.services.tiles.index(TILES.space);
const flagIndex = world.services.flagIndex.forLevel(LEVEL_ID);
const xy = (c: number) => {
  const p = pointOf(c, W);
  return `(${p.x},${p.y})`;
};

console.log(`station: ${W}×${H}`);

// --- (1) hull-enclosed ------------------------------------------------------
{
  // Open floor (not a sealing door/window) must never sit against the void; a
  // closed airlock cell (airtight) IS the sanctioned boundary, e.g. the EVA hatch.
  let breach = -1;
  for (let c = 0; c < n && breach < 0; c++) {
    if (tiles[c] !== floorIdx || flagIndex.hasFlagAt(c, FLAGS.airtight)) continue;
    for (const nb of neighbors4(c, W, H)) {
      if (tiles[nb] === spaceIdx) {
        breach = c;
        break;
      }
    }
  }
  check('hull-enclosed (open floor never touches space)', breach < 0, breach < 0 ? '' : `floor ${xy(breach)} touches space`);
}

// --- (2) sealed at spawn ----------------------------------------------------
{
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  for (let c = 0; c < n; c++) {
    if (tiles[c] === spaceIdx) {
      seen[c] = 1;
      stack.push(c);
    }
  }
  let leak = -1;
  while (stack.length > 0 && leak < 0) {
    const c = stack.pop()!;
    for (const nb of neighbors4(c, W, H)) {
      if (seen[nb] || flagIndex.hasFlagAt(nb, FLAGS.airtight)) continue; // walls/windows/closed doors block
      seen[nb] = 1;
      if (tiles[nb] === floorIdx) {
        leak = nb;
        break;
      }
      stack.push(nb);
    }
  }
  check('sealed at spawn (no room leaks to space)', leak < 0, leak < 0 ? '' : `air escapes at floor ${xy(leak)}`);
}

console.log(failures === 0 ? '\nALL STATION PROOFS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
