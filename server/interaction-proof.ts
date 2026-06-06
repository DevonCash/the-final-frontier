/**
 * interaction-proof — doors, access, and the `useOn` tool economy (Epic D, §7).
 * Run: `npm run proof:interaction`.
 *
 *   - right ID bumps a bridge-access door open; wrong ID is blocked (free) + a
 *     denied event; the door holds shut
 *   - an unpowered door resists a bump but a crowbar pries it open
 *   - an emag breaks ANY openable open and spends a charge
 *   - the same rules generalize to a locker (access bump + crowbar pry)
 *
 * Built on the two-room fixture: its single airlock is the test door; a locker and
 * an actor are placed beside it. Assertions are plain; exit non-zero on failure.
 */
import { perform, get, pointOf, type World, type EntityId } from '../../rlkit/src/index';
import { buildFixtureWorld } from './world';
import { LEVEL_ID } from './station';
import { spawnCrew } from './content';
import { spawnIdCard, spawnCrowbar, spawnEmag, giveItem } from './items';
import { placeLocker, type Openable } from './openable';
import { config } from './config';

// --- tiny assert harness ----------------------------------------------------
let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const openableOf = (w: World, id: EntityId) => get<Openable>(w.state.entities.get(id)!, 'openable')!;
const toolCharges = (w: World, id: EntityId) =>
  (get<{ type: 'tool'; charges?: number }>(w.state.entities.get(id)!, 'tool')!.charges);

/** A fresh fixture world with the airlock as the test door and an actor west of it. */
function scene() {
  const { world, station } = buildFixtureWorld();
  const doorId = station.doors[0]!.id;
  const doorCell = station.doors[0]!.cell;
  const { x, y } = pointOf(doorCell, station.level.width);
  spawnCrew(world, LEVEL_ID, doorCell - 1, { id: 'actor' }, config); // west neighbor (x-1, y)
  void x;
  void y;
  return { world, doorId, doorCell };
}
const bumpEast = (w: World) => perform(w, { type: 'move', actor: 'actor', dir: { x: 1, y: 0 } });

// --- (1) ID access on bump --------------------------------------------------
{
  console.log('(1) bridge-access door: right ID opens, wrong ID is blocked');

  const a = scene();
  openableOf(a.world, a.doorId).access = 'bridge';
  giveItem(a.world, 'actor', spawnIdCard(a.world, 'id-bridge', ['bridge']));
  const out = bumpEast(a.world);
  check('right ID → door opens', openableOf(a.world, a.doorId).open, `status=${out.status}`);

  const b = scene();
  openableOf(b.world, b.doorId).access = 'bridge';
  giveItem(b.world, 'actor', spawnIdCard(b.world, 'id-eng', ['engineering'])); // wrong area
  const outB = bumpEast(b.world);
  const denied = outB.status !== 'rejected' && outB.events.some((e) => e.type === 'access:denied');
  check('wrong ID → door holds shut', !openableOf(b.world, b.doorId).open);
  check('wrong ID → denied event (free bump)', denied, `cost=${outB.status === 'done' ? outB.cost : '—'}`);
}

// --- (2) power: unpowered door pries, powered door resists -------------------
{
  console.log('(2) crowbar pries an unpowered door; a powered door resists');
  const a = scene();
  giveItem(a.world, 'actor', spawnCrowbar(a.world, 'bar'));

  const resist = perform(a.world, { type: 'useOn', actor: 'actor', item: 'bar', target: { kind: 'entity', id: a.doorId } });
  check('powered door resists crowbar', !openableOf(a.world, a.doorId).open && resist.status === 'rejected');

  openableOf(a.world, a.doorId).powered = false; // cut power (Epic E does this for real)
  perform(a.world, { type: 'useOn', actor: 'actor', item: 'bar', target: { kind: 'entity', id: a.doorId } });
  check('unpowered door pries open', openableOf(a.world, a.doorId).open);
}

// --- (3) emag breaks any openable -------------------------------------------
{
  console.log('(3) emag breaks the door open and spends a charge');
  const a = scene();
  openableOf(a.world, a.doorId).access = 'bridge'; // even a locked, powered door
  giveItem(a.world, 'actor', spawnEmag(a.world, 'emag', config.emagCharges));
  const out = perform(a.world, { type: 'useOn', actor: 'actor', item: 'emag', target: { kind: 'entity', id: a.doorId } });
  const o = openableOf(a.world, a.doorId);
  check('emag opens the door', o.open, `status=${out.status}`);
  check('emag breaks it (access destroyed)', o.broken);
  check('emag spent a charge', toolCharges(a.world, 'emag') === config.emagCharges - 1, `${toolCharges(a.world, 'emag')} left`);
}

// --- (4) the same rules generalize to a locker ------------------------------
{
  console.log('(4) locker: access bump + crowbar pry (same system)');
  const a = scene();
  placeLocker(a.world, LEVEL_ID, a.doorCell - 2, { id: 'locker', access: 'bridge' }); // (x-2, y), west of actor
  // Actor bumps WEST into the locker without access → blocked.
  const denied = perform(a.world, { type: 'move', actor: 'actor', dir: { x: -1, y: 0 } });
  check('locker without access stays shut', !openableOf(a.world, 'locker').open);
  check('locker bump denied', denied.status !== 'rejected' && denied.events.some((e) => e.type === 'access:denied'));

  // A crowbar pries the (unpowered-by-default? no — locker) locker. Lockers are
  // always pryable regardless of power.
  giveItem(a.world, 'actor', spawnCrowbar(a.world, 'bar2'));
  perform(a.world, { type: 'useOn', actor: 'actor', item: 'bar2', target: { kind: 'entity', id: 'locker' } });
  check('crowbar pries the locker', openableOf(a.world, 'locker').open);
}

// --- (5) authoritative: useOn rejects unowned tools and non-adjacent targets ---
{
  console.log('(5) anti-cheat: useOn needs a carried tool and an adjacent target');
  const a = scene();

  // Ownership: an emag exists but the actor does not carry it.
  spawnEmag(a.world, 'loose-emag', config.emagCharges);
  const unowned = perform(a.world, { type: 'useOn', actor: 'actor', item: 'loose-emag', target: { kind: 'entity', id: a.doorId } });
  check('useOn with an uncarried tool is rejected', unowned.status === 'rejected' && !openableOf(a.world, a.doorId).open);

  // Adjacency: a carried crowbar can't reach a far locker (roomB).
  giveItem(a.world, 'actor', spawnCrowbar(a.world, 'bar3'));
  placeLocker(a.world, LEVEL_ID, a.doorCell + 5, { id: 'far-locker' }); // deep in the other room
  const far = perform(a.world, { type: 'useOn', actor: 'actor', item: 'bar3', target: { kind: 'entity', id: 'far-locker' } });
  check('useOn on a non-adjacent target is rejected', far.status === 'rejected' && !openableOf(a.world, 'far-locker').open);
}

console.log(failures === 0 ? '\nALL INTERACTION PROOFS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
