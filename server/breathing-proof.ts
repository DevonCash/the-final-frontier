/**
 * breathing-proof — vacuum is lethal, an O₂ tank buys time. Run: `npm run proof:breathing`.
 *
 * Drives a crew actor headless through three scenarios (mirrors atmos-proof's
 * structure; the crew paces its own real-time driver):
 *   (a) sealed   — in a pressurized room, oxygen and HP stay full
 *   (b) breach   — smash roomB's window: oxygen drains to 0, THEN HP bleeds,
 *                  THEN the actor dies (leaves the timeline). Ordering asserted.
 *   (c) tank     — same breach with an active O₂ tank: oxygen and HP both hold,
 *                  the actor survives (within the tank's duration)
 *
 * Assertions are plain; the script exits non-zero on first failure.
 */
import { tickRealtime, setTileEffect, get, type World } from '../../rlkit/src/index';
import { buildFixtureWorld } from './world';
import { LEVEL_ID } from './station';
import { TILES, spawnCrew } from './content';
import { activateTank } from './breathing';
import { config } from './config';

const CREW = 'crew-1';

interface Pools {
  hp: { current: number };
  oxygen: { current: number };
}

function fresh() {
  const gw = buildFixtureWorld();
  spawnCrew(gw.world, LEVEL_ID, gw.station.mark.roomB, { id: CREW }, config);
  return gw;
}

const pools = (w: World): Pools | undefined => {
  const e = w.state.entities.get(CREW);
  return e && get<{ type: 'resources'; pools: Pools }>(e, 'resources')?.pools;
};
const alive = (w: World): boolean => w.state.timeline.actors.some((a) => a.id === CREW);
const breachWindow = (w: World, cell: number): void => {
  for (const ev of setTileEffect(LEVEL_ID, cell, TILES.space).apply(w)) w.services.bus.emit(ev);
};

// --- tiny assert harness ----------------------------------------------------
let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
}
const near = (a: number, b: number, eps = 0.5) => Math.abs(a - b) <= eps;

// --- (a) sealed: oxygen + HP stay full --------------------------------------
{
  console.log('(a) sealed room: oxygen + HP stay full');
  const { world } = fresh();
  tickRealtime(world, { player: CREW, ticks: config.ticksPerSecond * 10 });
  const p = pools(world)!;
  check('oxygen full', near(p.oxygen.current, config.oxygen.max, 1), `${p.oxygen.current.toFixed(1)}`);
  check('HP full', near(p.hp.current, 100, 0.01), `${p.hp.current.toFixed(1)}`);
  check('alive', alive(world));
}

// --- (b) breach: oxygen → HP → death, in that order -------------------------
{
  console.log('(b) breach: oxygen drains, then HP, then death');
  const { world, station } = fresh();
  breachWindow(world, station.mark.window);

  let o2ZeroAt = -1;
  let hpDropAt = -1;
  let diedAt = -1;
  const step = 100;
  for (let t = 0; t < 40000 && diedAt < 0; t += step) {
    tickRealtime(world, { player: CREW, ticks: step });
    const p = pools(world);
    if (p) {
      if (o2ZeroAt < 0 && p.oxygen.current <= 0) o2ZeroAt = t;
      if (hpDropAt < 0 && p.hp.current < 100) hpDropAt = t;
    }
    if (diedAt < 0 && !alive(world)) diedAt = t;
  }
  check('oxygen depleted', o2ZeroAt >= 0, `at ~${o2ZeroAt} ticks`);
  check('HP only dropped after oxygen gone', hpDropAt >= 0 && o2ZeroAt >= 0 && hpDropAt >= o2ZeroAt,
    `o2Zero@${o2ZeroAt} hpDrop@${hpDropAt}`);
  check('crew died', diedAt >= 0, `at ~${diedAt} ticks`);
}

// --- (c) tank: survives the same breach -------------------------------------
{
  console.log('(c) active O₂ tank: survives the same breach');
  const { world, station } = fresh();
  activateTank(world, CREW, config);
  breachWindow(world, station.mark.window);
  // Run for less than tankDuration so the tank is still active throughout.
  tickRealtime(world, { player: CREW, ticks: config.ticksPerSecond * 60 });
  const p = pools(world)!;
  check('oxygen held', near(p.oxygen.current, config.oxygen.max, 1), `${p.oxygen.current.toFixed(1)}`);
  check('HP held', near(p.hp.current, 100, 0.01), `${p.hp.current.toFixed(1)}`);
  check('alive', alive(world));
}

console.log(failures === 0 ? '\nALL BREATHING PROOFS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
