/**
 * hud-proof — the Epic J HUD payload, proven headless. Run: `npm run proof:hud`.
 *
 *   (1) self surfacing — a viewer's own `extra` carries its role + held item, so the
 *       HUD has real data to paint.
 *   (2) NO extra leak under hidden fog — one player's `extra` never carries another
 *       player's role/held/identity. `viewExtra` is called per-viewer with the
 *       viewer's own id, so the payload must reflect only that entity (the security
 *       contract flagged in the Epic I review).
 *   (3) adjacent targets — a viewer standing next to a door gets that door in
 *       `extra.targets` (the useOn prompt); a viewer with no adjacent openable gets none.
 *
 * Drives a real hidden-fog `GameServer` (the default host hands each join a crew role
 * + ID, so the HUD fields are populated). Plain asserts; exits non-zero on failure.
 */
import {
  computeVisibilityFor,
  get,
  pointOf,
  cellOf,
  neighbors4,
  type EntityId,
  type Position,
} from '../../rlkit/src/index';
import { createStationServer } from './server';
import { setRole } from './role';
import { LEVEL_ID } from './station';
import { TILES } from './content';

// --- tiny assert harness ----------------------------------------------------
let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const ss = createStationServer({ fog: 'hidden', seed: 1 });
const { game, world, viewport } = ss;
const a = game.join();
const b = game.join();

const level = world.state.levels.get(LEVEL_ID)!;
const width = level.width;
const tiles = level.layers.get('tiles') as Uint16Array;
const floorIdx = world.services.tiles.index(TILES.floor);

/** Move an actor to a cell and refresh its hidden FOV (mirrors perception-proof). */
const place = (id: EntityId, cell: number): void => {
  const pos = get<Position>(world.state.entities.get(id)!, 'position')!;
  const { x, y } = pointOf(cell, width);
  pos.x = x;
  pos.y = y;
  world.services.queries.place(id, LEVEL_ID, cell);
  computeVisibilityFor(world, id);
};

const cellOfId = (id: EntityId): number => {
  const pos = get<Position>(world.state.entities.get(id)!, 'position')!;
  return cellOf({ x: pos.x, y: pos.y }, width);
};

/** Any openable occupant of `cell`, if one is there (door/locker). */
const openableAt = (cell: number): EntityId | undefined => {
  for (const occId of world.services.queries.at(cell, LEVEL_ID)) {
    if (world.state.entities.get(occId)?.components.has('openable')) return occId;
  }
  return undefined;
};

// --- (1) self surfacing ------------------------------------------------------
// Make A a distinctive role (traitor captain) so a leak into B's payload is unambiguous.
console.log('(1) a viewer\'s own extra carries its role + held item');
setRole(world.state.entities.get(a)!, 'captain', true);
const extraA = game.viewFor(a, viewport).extra;
check('A.role is its own job', extraA?.role?.job === 'captain', String(extraA?.role?.job));
check('A.role flags its traitor status', extraA?.role?.traitor === true);
check('A.held carries the starter ID', !!extraA?.held && /id/i.test(extraA.held.name), extraA?.held?.name);

// --- (2) no extra leak under hidden fog --------------------------------------
console.log('(2) no other player\'s extra leaks into a viewer\'s payload');
const extraB = game.viewFor(b, viewport).extra;
check('B.role reflects only B (plain crew, not A\'s captain)', extraB?.role?.job === 'crew' && extraB?.role?.traitor === false);
const bJson = JSON.stringify(extraB);
check('B.extra does not leak A\'s captain role', !bJson.includes('captain'));
check('B.extra does not leak A\'s identity', !bJson.includes(a));
check('B.extra does not leak A\'s held item id', !bJson.includes('id-1'));

// --- (3) adjacent useOn targets ----------------------------------------------
console.log('(3) an adjacent door appears as a useOn target; an empty cell yields none');
// Find a door and a free floor cell beside it; stand A there.
let door: EntityId | undefined;
let beside: number | undefined;
for (const [id, e] of world.state.entities) {
  const open = e.components.get('openable') as { kind?: string } | undefined;
  if (!open || !e.components.has('position')) continue;
  const dc = cellOfId(id);
  for (const nb of neighbors4(dc, width, level.height)) {
    if (tiles[nb] === floorIdx && !openableAt(nb)) {
      door = id;
      beside = nb;
      break;
    }
  }
  if (door) break;
}
if (door === undefined || beside === undefined) throw new Error('hud-proof: no door with a free floor neighbor');
place(a, beside);
const tBeside = game.viewFor(a, viewport).extra?.targets ?? [];
check('a door beside the viewer is a target', tBeside.some((t) => t.id === door), `${tBeside.length} target(s)`);

// A floor cell whose four neighbors hold no openable → no targets.
let empty: number | undefined;
for (let c = 0; c < tiles.length; c++) {
  if (tiles[c] !== floorIdx) continue;
  if (neighbors4(c, width, level.height).some((nb) => openableAt(nb))) continue;
  empty = c;
  break;
}
if (empty === undefined) throw new Error('hud-proof: no floor cell free of adjacent openables');
place(a, empty);
const tEmpty = game.viewFor(a, viewport).extra?.targets ?? [];
check('a cell with no adjacent openable has no targets', tEmpty.length === 0);

console.log(failures === 0 ? '\nALL HUD PROOFS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
