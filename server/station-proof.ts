/**
 * station-proof — the full station is airtight by construction. Run: `npm run proof:station`.
 *
 * Three invariants on the production map (game-design §3):
 *   (1) hull-enclosed — no open floor cell is 4-adjacent to a space tile (the
 *       hull, windows, and CLOSED doors always sit between floor and the void).
 *   (2) sealed at spawn — a flood-fill from every space cell across non-airtight
 *       cells (airtight = hull / intact window / CLOSED door) never reaches a
 *       floor cell, so no room's air is open to space at round start.
 *   (3) connected — every floor cell is reachable across the floor graph (doors
 *       are floor tiles, so they count as doorways); catches a walled-off room or
 *       a door authored into a wall, which (1) and (2) would both miss.
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
  // Flood-fill (DFS) outward from the void; airtight cells (hull / window /
  // closed door) are the walls. Reaching a floor cell means air can escape.
  const seen = new Uint8Array(n);
  const open: number[] = [];
  for (let c = 0; c < n; c++) {
    if (tiles[c] === spaceIdx) {
      seen[c] = 1;
      open.push(c);
    }
  }
  let leak = -1;
  while (open.length > 0 && leak < 0) {
    const c = open.pop()!;
    for (const nb of neighbors4(c, W, H)) {
      if (seen[nb] || flagIndex.hasFlagAt(nb, FLAGS.airtight)) continue;
      seen[nb] = 1;
      if (tiles[nb] === floorIdx) {
        leak = nb;
        break;
      }
      open.push(nb);
    }
  }
  check('sealed at spawn (no room leaks to space)', leak < 0, leak < 0 ? '' : `air escapes at floor ${xy(leak)}`);
}

// --- (3) connected ----------------------------------------------------------
{
  // Flood-fill (DFS) over the floor graph from any floor cell; doors are floor
  // tiles, so they count as doorways. Any floor not reached is a walled-off room.
  const floor: number[] = [];
  for (let c = 0; c < n; c++) if (tiles[c] === floorIdx) floor.push(c);
  const seen = new Uint8Array(n);
  const open = [floor[0]!];
  seen[floor[0]!] = 1;
  let reached = 1;
  while (open.length > 0) {
    const c = open.pop()!;
    for (const nb of neighbors4(c, W, H)) {
      if (seen[nb] || tiles[nb] !== floorIdx) continue;
      seen[nb] = 1;
      reached++;
      open.push(nb);
    }
  }
  const orphan = floor.find((c) => !seen[c]);
  check(
    'connected (every floor cell reachable)',
    reached === floor.length,
    orphan === undefined ? `${floor.length} floor cells` : `${floor.length - reached} unreachable, e.g. ${xy(orphan)}`,
  );
}

// --- (4) wire on floor ------------------------------------------------------
{
  // Every wire cell must be floor — the power network (Epic E) only powers floor
  // consumers, so a wire glyph drifting onto a wall/space would be dead.
  const wire = level.layers.get('wire') as Uint8Array | undefined;
  let count = 0;
  let stray = -1;
  for (let c = 0; c < n; c++) {
    if (wire?.[c]) {
      count++;
      if (tiles[c] !== floorIdx) stray = c;
    }
  }
  check('wire spine on floor', count > 0 && stray < 0, stray < 0 ? `${count} wire cells` : `wire off floor at ${xy(stray)}`);
}

console.log(failures === 0 ? '\nALL STATION PROOFS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
