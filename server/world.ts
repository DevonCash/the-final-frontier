/**
 * world — assembles a game world: engine + station content + atmosphere.
 *
 * Two distinct configs by design: the ENGINE `Config` (passed to `createWorld`)
 * and the GAME `config` (atmos/oxygen/round tunables the game systems read). We
 * disable the engine's default bump→attack so combat is intent-based (a bump is
 * a swap/block; strikes are explicit `useOn` — game-design §7, R7).
 */
import { createWorld, defaultConfig, type World } from '../../rlkit/src/index';
import { registerContent } from './content';
import { buildStation, type Station } from './station';
import { registerAtmos } from './atmos';
import { registerBreathing } from './breathing';
import { config } from './config';

export interface GameWorld {
  world: World;
  station: Station;
}

export function buildGameWorld(seed = 1): GameWorld {
  const engineConfig = {
    ...defaultConfig,
    movement: { ...defaultConfig.movement, bumpToAttack: false },
  };
  const world = createWorld({ config: engineConfig, rng: seed });

  registerContent(world);
  const station = buildStation(world, config);
  registerAtmos(world, config);
  registerBreathing(world, config);

  return { world, station };
}
