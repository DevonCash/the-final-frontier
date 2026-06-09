/**
 * breach — window smashing and breach repair as first-class effects (Epic F, §5).
 *
 * A wrench smashes a window over `windowHits` blows; a welder reseals a breach over
 * `repairUses` passes (no channeled-action machinery in v0 — each use is a discrete
 * step, design §5). Both ride `setTileEffect` (R2) so the swap reaches every system
 * at once (sight, pathing, and the atmos stepper's airtight channel) the moment it
 * lands. The window→space swap opens the room to vacuum; the space→window swap
 * reseals it (and the vents repressurize from there).
 *
 * Per R2 the game owns "what stood here originally": this module keeps a small
 * per-world registry of in-progress damage and open breaches (the origin tile to
 * restore). It's a SERVICE-style side table, not serialized — v0 doesn't persist a
 * half-smashed window across save/load (noted in the Epic F checklist).
 */
import { setTileEffect, type World, type Effect, type GameEvent } from '../../rlkit/src/index';
import { TILES } from './content';
import { config, type Config } from './config';

interface BreachState {
  /** cell → blows landed on an intact window (cleared when it smashes). */
  readonly windowDamage: Map<number, number>;
  /** cell → an open breach: the original tile to restore, and repair passes so far. */
  readonly breaches: Map<number, { original: string; repair: number }>;
}

// Keyed by `world.state`, NOT `world`: an effect's `validate` receives a frozen
// `{state, services}` view (a fresh object), but its `.state` is the same shared
// reference as the live world's — so this hits in both `validate` and `apply`.
const STATE = new WeakMap<object, BreachState>();
function stateFor(world: World): BreachState {
  const key = world.state;
  let s = STATE.get(key);
  if (!s) STATE.set(key, (s = { windowDamage: new Map(), breaches: new Map() }));
  return s;
}

/** The tile id at a cell on a level (via the raw `tiles` layer + the tile registry). */
function tileIdAt(world: World, levelId: string, cell: number): string | undefined {
  const level = world.state.levels.get(levelId);
  const tiles = level && (level.layers.get('tiles') as Uint16Array | undefined);
  if (!level || !tiles || cell < 0 || cell >= tiles.length) return undefined;
  return world.services.tiles.byIndex(tiles[cell]!).id;
}

/** True if `cell` is currently an open breach this module is tracking. */
export function isBreach(world: World, cell: number): boolean {
  return stateFor(world).breaches.has(cell);
}

/**
 * An effect: land one wrench blow on a window. After `windowHits` it swaps to space
 * (the breach) and records the origin tile so a welder can restore it.
 */
export function smashWindowEffect(levelId: string, cell: number, cfg: Config = config): Effect {
  return {
    kind: 'window:smash',
    validate: (world) => tileIdAt(world as World, levelId, cell) === TILES.window,
    apply: (world) => {
      const st = stateFor(world);
      const hits = (st.windowDamage.get(cell) ?? 0) + 1;
      if (hits < cfg.windowHits) {
        st.windowDamage.set(cell, hits);
        return [{ type: 'window:hit', levelId, cell, hits, of: cfg.windowHits }];
      }
      st.windowDamage.delete(cell);
      st.breaches.set(cell, { original: TILES.window, repair: 0 });
      const events: GameEvent[] = setTileEffect(levelId, cell, TILES.space).apply(world);
      events.push({ type: 'window:smashed', levelId, cell });
      return events;
    },
  };
}

/**
 * An effect: make one welder pass over a tracked breach. After `repairUses` it
 * restores the original tile (reseals the hull) and drops the breach record.
 */
export function repairBreachEffect(levelId: string, cell: number, cfg: Config = config): Effect {
  return {
    kind: 'breach:repair',
    validate: (world) => stateFor(world as World).breaches.has(cell),
    apply: (world) => {
      const st = stateFor(world);
      const b = st.breaches.get(cell)!;
      b.repair += 1;
      if (b.repair < cfg.repairUses) {
        return [{ type: 'breach:weld', levelId, cell, progress: b.repair, of: cfg.repairUses }];
      }
      st.breaches.delete(cell);
      const events: GameEvent[] = setTileEffect(levelId, cell, b.original).apply(world);
      events.push({ type: 'breach:repaired', levelId, cell, to: b.original });
      return events;
    },
  };
}

/** Forget a world's breach/damage tracking (test teardown / level swap). */
export function resetBreaches(world: World): void {
  STATE.delete(world.state);
}
