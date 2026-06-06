/**
 * world — assembles a game world: engine + station content + atmosphere + breathing.
 *
 * Two distinct configs by design: the ENGINE `Config` (passed to `createWorld`)
 * and the GAME `config` (atmos/oxygen/round tunables the game systems read). We
 * disable the engine's default bump→attack so combat is intent-based (a bump is
 * a swap/block; strikes are explicit `useOn` — game-design §7, R7).
 *
 * `buildGameWorld` assembles the FULL production station; `buildFixtureWorld`
 * assembles the minimal two-room fixture the atmos/breathing system proofs drive
 * (so growing the real station never perturbs those regressions).
 */
import { createWorld, defaultConfig, type World } from '../../rlkit/src/index';
import { registerContent } from './content';
import { buildStation, buildFixtureStation, type Station, type FixtureStation } from './station';
import { registerAtmos } from './atmos';
import { registerBreathing } from './breathing';
import { registerItems } from './items';
import { registerOpenable } from './openable';
import { registerUseOn } from './useon';
import { config, type Config } from './config';

export interface GameWorld {
  world: World;
  station: Station;
}

export interface FixtureWorld {
  world: World;
  station: FixtureStation;
}

/** Shared assembly: engine world → content → a station → atmosphere → breathing. */
function assemble<S>(seed: number, build: (world: World, config: Config) => S): { world: World; station: S } {
  const engineConfig = {
    ...defaultConfig,
    movement: {
      ...defaultConfig.movement,
      bumpToAttack: false, // intent-based combat: a bump is a swap/block, never an attack (R7)
      passable: [...defaultConfig.movement.passable, 'walkover'], // open doors are walkable
    },
  };
  const world = createWorld({ config: engineConfig, rng: seed });

  registerItems(world); // component schemas (tags/tool) before any entity carries them
  registerOpenable(world); // openable component + on:bump rule + handler
  registerUseOn(world); // useOn handler + tool rules (crowbar, emag)
  registerContent(world);
  const station = build(world, config);
  registerAtmos(world, config);
  registerBreathing(world, config);

  return { world, station };
}

/** The full production station — what the server runs. */
export function buildGameWorld(seed = 1): GameWorld {
  return assemble(seed, buildStation);
}

/** The minimal two-room fixture — what the atmos/breathing proofs drive. */
export function buildFixtureWorld(seed = 1): FixtureWorld {
  return assemble(seed, buildFixtureStation);
}
