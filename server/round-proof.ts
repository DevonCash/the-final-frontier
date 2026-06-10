/**
 * round-proof — the round loop, traitor, and objective, proven headless (Epic H, §2).
 * Run: `npm run proof:round`.
 *
 *   (1) traitor wins — setup draws jobs + one secret traitor, kits each crew; the
 *       traitor loots the disk from the bridge locker, boards the shuttle, and the
 *       round ends with the traitor escaping the disk (traitorWin).
 *   (2) crew wins — the disk never leaves the station → crewWin, !traitorWin.
 *   (3) death — a crew member killed before reveal is not aboard, not survived, and
 *       leaves a corpse (the Epic-F reactor still fires under the round).
 *
 * Drives the `Round` controller directly (no WebSockets). Spatial setup is done by
 * direct position-set (movement/pickup are proven elsewhere; this proof is the
 * outcome FSM). Assertions are plain; exit non-zero on first failure.
 */
import {
  perform,
  changeResource,
  runReactions,
  pointOf,
  cellOf,
  get,
  type World,
  type EntityId,
  type Position,
} from '../../rlkit/src/index';
import { createRound } from './round';
import { roleOf } from './role';
import { setOpen, type Openable } from './openable';
import { LEVEL_ID } from './station';
import { carries, hasAccess, findTool } from './items';

// --- tiny assert harness ----------------------------------------------------
let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const SEATS = ['p1', 'p2', 'p3', 'p4'];
const widthOf = (w: World) => w.state.levels.get(LEVEL_ID)!.width;
const cellOfEntity = (w: World, id: EntityId): number => {
  const pos = get<Position>(w.state.entities.get(id)!, 'position')!;
  return cellOf({ x: pos.x, y: pos.y }, widthOf(w));
};
/** Move an entity's position component to a cell (enough for pickup + outcome eval). */
function teleport(w: World, id: EntityId, cell: number): void {
  const pos = get<Position>(w.state.entities.get(id)!, 'position')!;
  const { x, y } = pointOf(cell, widthOf(w));
  pos.x = x;
  pos.y = y;
  w.services.queries.place(id, LEVEL_ID, cell);
}
const openableAt = (w: World, cell: number): Openable | undefined => {
  for (const id of w.services.queries.at(cell, LEVEL_ID)) {
    const o = get<Openable>(w.state.entities.get(id)!, 'openable');
    if (o) return o;
  }
  return undefined;
};
const freshRound = () => {
  const r = createRound({ seed: 1 });
  for (const s of SEATS) r.addPlayer(s, s.toUpperCase());
  return r;
};

// --- (1) traitor wins --------------------------------------------------------
{
  console.log('(1) traitor loots the disk, boards the shuttle → traitor wins');
  const r = freshRound();
  r.forceSetup({ traitor: 'p1' });
  check('setup → shift', r.phase() === 'shift');

  const w = r.world()!;
  const roles = SEATS.map((s) => roleOf(w.state.entities.get(r.seatToEntity(s)!)!)!);
  check('exactly one traitor drawn', roles.filter((x) => x.traitor).length === 1);
  check('forced traitor is p1', roleOf(w.state.entities.get(r.seatToEntity('p1')!)!)!.traitor);
  check('exactly one captain', roles.filter((x) => x.job === 'captain').length === 1);

  const capSeat = SEATS.find((s) => roleOf(w.state.entities.get(r.seatToEntity(s)!)!)!.job === 'captain')!;
  check('captain ID grants bridge access', hasAccess(w, r.seatToEntity(capSeat)!, 'bridge'));

  const traitor = r.seatToEntity('p1')!;
  check('traitor pocketed an emag', findTool(w, traitor, 'emag') !== undefined);
  check('traitor pocketed a knife', findTool(w, traitor, 'knife') !== undefined);

  // Shuttle airlock starts bolted (locked until departure).
  const shuttleCell = r.marks()!.shuttleDoor!;
  check('shuttle airlock bolted at setup', openableAt(w, shuttleCell)?.bolted === true);

  // Open the bridge locker → the disk spills to the floor.
  setOpen(w, r.lockerId(), true);
  const diskId = [...w.services.queries.byTag('objective:disk')][0]!;
  const diskCell = cellOfEntity(w, diskId);
  check('disk spilled out of the locker onto the floor', Number.isInteger(diskCell));

  // Traitor steps onto the disk and pockets it.
  teleport(w, traitor, diskCell);
  const pick = perform(w, { type: 'pickup', actor: traitor, item: diskId });
  check('traitor picks up the disk', pick.status === 'done' && carries(w, traitor, diskId));

  // Departure unlocks the shuttle; the traitor boards.
  r.advanceTo('departure');
  check('departure → shuttle airlock unbolted', r.phase() === 'departure' && openableAt(w, shuttleCell)?.bolted === false);
  teleport(w, traitor, r.marks()!.shuttleZone[0]!);

  r.advanceTo('reveal');
  const o = r.outcome()!;
  check('round ended at reveal with an outcome', r.phase() === 'reveal' && !!o);
  check('disk escaped with the traitor', o.disk.location === 'aboard-with-traitor' && o.disk.holder === traitor);
  check('traitor wins', o.traitorWin && !o.crewWin);
  check('traitor counted as survived', o.players.find((p) => p.entityId === traitor)!.survived);
}

// --- (2) crew wins (disk never leaves) ---------------------------------------
{
  console.log('(2) the disk never leaves the station → crew wins');
  const r = freshRound();
  r.forceSetup({ traitor: 'p1' });
  const w = r.world()!;
  // Board the traitor with NO disk (it stays sealed in the bridge locker).
  teleport(w, r.seatToEntity('p1')!, r.marks()!.shuttleZone[0]!);

  r.advanceTo('departure');
  r.advanceTo('reveal');
  const o = r.outcome()!;
  check('disk still on station', o.disk.location === 'on-station');
  check('crew wins, traitor fails', o.crewWin && !o.traitorWin);
  check('traitor survived but failed the objective', o.players.find((p) => p.traitor)!.survived);
}

// --- (3) death → not survived, leaves a corpse -------------------------------
{
  console.log('(3) a crew member killed before reveal is not survived and leaves a corpse');
  const r = freshRound();
  r.forceSetup({ traitor: 'p1' });
  const w = r.world()!;
  const victim = r.seatToEntity('p2')!; // a non-traitor crew member

  runReactions(w, changeResource(w, victim, 'hp', -999, 'test')); // hp→0 → died → corpse
  check('victim is a corpse', !!w.state.entities.get(victim)?.components.has('corpse'));

  r.advanceTo('reveal');
  const me = r.outcome()!.players.find((p) => p.entityId === victim)!;
  check('dead crew member is not alive', !me.alive);
  check('dead crew member did not survive', !me.survived);
}

console.log(failures === 0 ? '\nALL ROUND PROOFS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
