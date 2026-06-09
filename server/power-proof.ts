/**
 * power-proof — the power network, proven headless. Run: `npm run proof:power`.
 *
 * Drives the power fixture (gen → wire → door → wire → vent, single-width):
 *   (1) intact   — generator runs, fuel drains on the world clock, the door reads
 *                  powered, and the powered vent repressurizes the sealed pocket
 *   (2) cut      — snip the gen-side wire: the downstream door reads unpowered
 *                  (a bump is denied, a crowbar pries it), and the vent stalls
 *   (3) relay    — re-lay the cable: power + repressurization return
 *   (4) blackout — drain the tank: `running` drops and consumers go dark even
 *                  though the wire is intact
 *
 * Assertions are plain; the script exits non-zero on first failure.
 */
import {
  perform,
  tickRealtime,
  ensureFloatLayer,
  get,
  type World,
  type EntityId,
} from '../../rlkit/src/index';
import { buildPowerFixtureWorld } from './world';
import { LEVEL_ID } from './station';
import { spawnCrew } from './content';
import { spawnCrowbar, giveItem } from './items';
import { setWire, isPowered, generatorRunning, generatorFuel } from './power';
import type { Openable } from './openable';
import { config } from './config';

// --- tiny assert harness ----------------------------------------------------
let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const openableOf = (w: World, id: EntityId) => get<Openable>(w.state.entities.get(id)!, 'openable')!;
const pressure = (w: World) => ensureFloatLayer(w.state.levels.get(LEVEL_ID)!, 'pressure');
/** Total pressure in the sealed vent pocket (cols 6–11, row 2) — the vent's output. */
const pocketTotal = (w: World) => {
  const width = w.state.levels.get(LEVEL_ID)!.width;
  const p = pressure(w);
  let t = 0;
  for (let x = 6; x <= 11; x++) t += p[2 * width + x]!;
  return t;
};

/** A fresh power fixture with a crew actor (also the realtime pacer) west of the door, carrying a crowbar. */
function scene() {
  const { world, station } = buildPowerFixtureWorld();
  spawnCrew(world, LEVEL_ID, station.mark.door - 1, { id: 'actor' }, config); // (4,2), west of the door
  giveItem(world, 'actor', spawnCrowbar(world, 'bar'));
  return { world, mark: station.mark };
}
const run = (w: World, ticks: number) => tickRealtime(w, { player: 'actor', ticks });
const bumpEast = (w: World) => perform(w, { type: 'move', actor: 'actor', dir: { x: 1, y: 0 } });
const crowbar = (w: World, doorId: string) =>
  perform(w, { type: 'useOn', actor: 'actor', item: 'bar', target: { kind: 'entity', id: doorId } });

// --- (1) intact: running, fuel burns, door powered, vent repressurizes -------
{
  console.log('(1) intact: generator runs, fuel drains, door powered, vent repressurizes');
  const { world, mark } = scene();
  check('generator running at start', generatorRunning(world));
  check('door reads powered', openableOf(world, mark.doorId).powered && isPowered(world, mark.door));

  const fuel0 = generatorFuel(world);
  const pocket0 = pocketTotal(world);
  run(world, 200); // 8 s
  check('fuel drained on the world clock', generatorFuel(world) < fuel0,
    `${fuel0.toFixed(1)} → ${generatorFuel(world).toFixed(1)}`);
  check('powered vent repressurizes the pocket', pocketTotal(world) > pocket0 + 1,
    `${pocket0.toFixed(1)} → ${pocketTotal(world).toFixed(1)} kPa`);
}

// --- (2) cut: downstream door unpowered (pry-only), vent stalls --------------
{
  console.log('(2) cut a wire: door goes unpowered (bump denied → crowbar pries), vent stalls');
  const { world, mark } = scene();
  const resist = crowbar(world, mark.doorId);
  check('powered door resists the crowbar', resist.status === 'rejected' && !openableOf(world, mark.doorId).open);

  setWire(world, mark.cutWire, false); // snip the gen-side cable
  check('door now reads unpowered', !openableOf(world, mark.doorId).powered && !isPowered(world, mark.door));
  check('generator itself still running', generatorRunning(world));

  const denied = bumpEast(world);
  const deniedEvent = denied.status !== 'rejected' && denied.events.some((e) => e.type === 'access:denied');
  check('bump into the unpowered door is denied', !openableOf(world, mark.doorId).open && deniedEvent);

  const pocketBefore = pocketTotal(world);
  run(world, 200);
  check('unpowered vent stalls (pocket flat)', Math.abs(pocketTotal(world) - pocketBefore) < 0.5,
    `${pocketBefore.toFixed(1)} → ${pocketTotal(world).toFixed(1)} kPa`);

  crowbar(world, mark.doorId);
  check('crowbar pries the unpowered door', openableOf(world, mark.doorId).open);
}

// --- (3) relay: re-lay the cable → power + repressurization return -----------
{
  console.log('(3) relay the cable: power and repressurization return');
  const { world, mark } = scene();
  setWire(world, mark.cutWire, false);
  check('unpowered after cut', !isPowered(world, mark.door));

  setWire(world, mark.cutWire, true); // re-lay
  check('door powered again after relay', openableOf(world, mark.doorId).powered && isPowered(world, mark.door));

  const pocket0 = pocketTotal(world);
  run(world, 200);
  check('vent resumes repressurizing', pocketTotal(world) > pocket0 + 1,
    `${pocket0.toFixed(1)} → ${pocketTotal(world).toFixed(1)} kPa`);
}

// --- (4) blackout: empty tank → not running → consumers dark (wire intact) ---
{
  console.log('(4) fuel depletion: generator stops, consumers go dark with the wire intact');
  const { world, mark } = scene();
  // Drain the tank to a sliver; one burn step on the world clock empties it.
  const pool = get<{ type: 'resources'; pools: Record<string, { current: number }> }>(
    world.state.entities.get('generator')!,
    'resources',
  )!.pools.fuel!;
  pool.current = config.power.burnPerSecond / 2;
  run(world, config.power.burnCadence + 5);
  check('generator stops when fuel hits 0', !generatorRunning(world) && generatorFuel(world) === 0);
  check('door dark despite intact wire', !openableOf(world, mark.doorId).powered && !isPowered(world, mark.door));
}

console.log(failures === 0 ? '\nALL POWER PROOFS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
