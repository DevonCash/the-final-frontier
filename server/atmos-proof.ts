/**
 * atmos-proof — the slice's heart, proven headless. Run: `npm run proof`.
 *
 * Mirrors the engine's R1 acceptance, but on the game's own station with an
 * ENTITY door (the `invalidateCell` path the game depends on, not a tile-swap):
 *   (a) sealed     — total pressure conserved over a long run
 *   (b) open door  — roomA + roomB equalize through the opened airlock
 *   (c) breach     — smash roomB's window: roomB vents to ~0, roomA holds behind
 *                    the CLOSED airtight door
 *   (d) determinism — two seeded runs are byte-identical
 *
 * A bystander actor paces the real-time driver (no players in this headless
 * proof). Assertions are plain; the script exits non-zero on first failure.
 */
import {
  tickRealtime,
  ensureFloatLayer,
  setTileEffect,
  type World,
} from '../../rlkit/src/index';
import { buildGameWorld } from './world';
import { LEVEL_ID } from './station';
import { TILES } from './content';

const OBS = 'obs';

function fresh(seed = 1) {
  const gw = buildGameWorld(seed);
  gw.world.services.timeline.addActor(OBS, 100); // something for the driver to pace
  return gw;
}

const pressure = (w: World) => ensureFloatLayer(w.state.levels.get(LEVEL_ID)!, 'pressure');
const total = (w: World) => Array.from(pressure(w)).reduce((a, b) => a + b, 0);
const run = (w: World, ticks: number) => tickRealtime(w, { player: OBS, ticks });

// --- tiny assert harness ----------------------------------------------------
let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
}
const near = (a: number, b: number, eps = 0.5) => Math.abs(a - b) <= eps;

// --- (a) sealed conservation ------------------------------------------------
{
  console.log('(a) sealed: pressure conserved, rooms internally mixed');
  const { world, station } = fresh();
  const before = total(world);
  run(world, 1000);
  const p = pressure(world);
  check('total conserved', near(total(world), before, 1), `${before.toFixed(1)} → ${total(world).toFixed(1)}`);
  check('roomB holds (door closed)', p[station.mark.roomB]! > 0, `${p[station.mark.roomB]!.toFixed(1)} kPa`);
}

// --- (b) open door equalizes ------------------------------------------------
{
  console.log('(b) open airlock: roomA + roomB equalize');
  const { world, station } = fresh();
  // Drain roomB a bit first so equalization is visible, then open the door.
  const p0 = pressure(world);
  p0[station.mark.roomB] = 20;
  const beforeTotal = total(world);
  station.doors[0]!.open(world); // entity door → invalidateCell → atmos sees it
  run(world, 3000);
  const p = pressure(world);
  check('total conserved', near(total(world), beforeTotal, 1));
  check('roomA ≈ roomB after equalize', near(p[station.mark.roomA]!, p[station.mark.roomB]!, 1),
    `A=${p[station.mark.roomA]!.toFixed(1)} B=${p[station.mark.roomB]!.toFixed(1)}`);
}

// --- (c) breach vents the connected room; sealed room holds -----------------
{
  console.log('(c) breach roomB window: roomB vents to ~0, roomA holds');
  const { world, station } = fresh();
  // Door stays closed. Smash the window → it becomes space (the breach).
  for (const ev of setTileEffect(LEVEL_ID, station.mark.window, TILES.space).apply(world)) {
    world.services.bus.emit(ev); // emit so the flag index drops the window's airtight bit
  }
  // A single-cell (pinhole) breach drains a 27-cell room slowly — realistic.
  run(world, 12000);
  const p = pressure(world);
  check('roomB vented', near(p[station.mark.roomB]!, 0, 1), `${p[station.mark.roomB]!.toFixed(2)} kPa`);
  check('roomA held behind closed door', p[station.mark.roomA]! > 50, `${p[station.mark.roomA]!.toFixed(1)} kPa`);
}

// --- (d) determinism --------------------------------------------------------
{
  console.log('(d) determinism: two seeded runs are byte-identical');
  const a = fresh(7);
  const b = fresh(7);
  run(a.world, 200);
  run(b.world, 200);
  const eq = Array.from(pressure(a.world)).every((v, i) => v === pressure(b.world)[i]);
  check('identical pressure layers', eq);
}

console.log(failures === 0 ? '\nALL ATMOS PROOFS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
