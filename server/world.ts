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
import {
  buildStation,
  buildFixtureStation,
  buildPowerFixture,
  type Station,
  type FixtureStation,
  type PowerFixtureStation,
} from './station';
import { registerAtmos, registerVents } from './atmos';
import { registerBreathing } from './breathing';
import { registerItems } from './items';
import { registerOpenable } from './openable';
import { registerUseOn } from './useon';
import { registerCorpses } from './corpse';
import { registerPower } from './power';
import { config, type Config } from './config';

export interface GameWorld {
  world: World;
  station: Station;
}

export interface FixtureWorld {
  world: World;
  station: FixtureStation;
}

export interface PowerFixtureWorld {
  world: World;
  station: PowerFixtureStation;
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

  registerItems(world); // component schemas (tags/tool) + activate verb (O₂ tank)
  registerOpenable(world); // openable component + on:bump rule + handler
  registerCorpses(world); // corpse component + died→corpse reactor + loot bump rule
  registerUseOn(world); // useOn handler + tool rules (crowbar/emag + welder/wrench/cutters/cable)
  registerContent(world);
  const station = build(world, config);
  registerAtmos(world, config);
  registerBreathing(world, config);

  return { world, station };
}

/** The full production station — what the server runs. */
export function buildGameWorld(seed = 1): GameWorld {
  const { world, station } = assemble(seed, buildStation);
  registerPower(world, config, station.mark.generator);
  registerVents(world, config, station.mark.vents);
  return { world, station };
}

/** The minimal two-room fixture — what the atmos/breathing proofs drive. */
export function buildFixtureWorld(seed = 1): FixtureWorld {
  return assemble(seed, buildFixtureStation);
}

/** The power fixture — what the Epic-E power proof drives. */
export function buildPowerFixtureWorld(seed = 1): PowerFixtureWorld {
  const { world, station } = assemble(seed, buildPowerFixture);
  registerPower(world, config, station.mark.generator);
  registerVents(world, config, [station.mark.vent]);
  return { world, station };
}
