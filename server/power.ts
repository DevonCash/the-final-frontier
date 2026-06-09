/**
 * power — the station's electrical network (Epic E, game-design §6, engine R3).
 *
 * A fuel-burning GENERATOR entity feeds a wire grid; a cell is `powered` iff it is
 * wire-connected to the generator AND the generator is running:
 *   `powered(cell) = running && sameNetwork(cell, genCell)`.
 *
 * The wire grid is the level's `wire` u8 layer (authored in `station.ts`); we index
 * its connected components with the engine's `createNetworkManager` via the R3
 * raw-layer escape hatch (`{ id:'power', layer:'wire' }`). The descriptor is
 * raw-layer, so it does not auto-invalidate — `setWire` (the cut/relay seam Epic F's
 * wirecutters/cable drive) marks the index dirty by hand and re-syncs consumers.
 *
 * Consumers read power two ways: doors/lockers carry a cached `openable.powered`
 * field (kept in sync here, so `openable.ts`/`useon.ts` need no power import); vents
 * call `isPowered` live each atmos sweep. Power is re-derived only on the events that
 * change it — a wire edit, or the generator's `running` flipping (fuel runs out /
 * switched off) — never per tick.
 *
 * A SERVICE (the network manager + the per-world generator reference) — not
 * serialized; the generator itself is a normal entity that persists. `registerPower`
 * is idempotent (re-callable after `loadWorld`, like `registerAtmos`): it reuses an
 * existing generator entity and `override`s the burn timer.
 */
import { z } from 'zod';
import {
  createEntity,
  get,
  cellOf,
  pointOf,
  changeResource,
  ensureU8Layer,
  type World,
  type EntityId,
  type Cell,
  type Position,
  type GameEvent,
  type NetworkManager,
  type TimerEffect,
  type Registry,
  type ComponentRegistry,
  type ResourceDefRegistry,
} from '../../rlkit/src/index';
import { createNetworkManager } from '../../rlkit/src/index';
import { LEVEL_ID } from './station';
import type { Openable } from './openable';
import type { Config } from './config';

/** Network id for the power grid (an index key on the shared network manager). */
const POWER_NET = 'power';
const GEN_ID = 'generator';
const BURN_EFFECT = 'generator:burn';

/** Generator runtime state: switch position + whether it is actually producing. */
const GeneratorSchema = z.object({
  type: z.literal('generator'),
  on: z.boolean(), // switch position
  running: z.boolean(), // on && fuel > 0 (the power-producing state)
});
export type Generator = z.infer<typeof GeneratorSchema> & { [key: string]: unknown };

interface ResourcesComponent {
  type: 'resources';
  pools: Record<string, { current: number }>;
  [key: string]: unknown;
}

interface PowerState {
  network: NetworkManager;
  genId: EntityId | undefined;
  genCell: Cell | undefined;
}

// Per-world state — proofs build many worlds, so never share across them.
const STATE = new WeakMap<World, PowerState>();

function stateOf(world: World): PowerState {
  let s = STATE.get(world);
  if (!s) STATE.set(world, (s = { network: createNetworkManager(world), genId: undefined, genCell: undefined }));
  return s;
}

/** The generator entity (if any), or undefined. */
function generator(world: World): Generator | undefined {
  const s = STATE.get(world);
  const e = s?.genId ? world.state.entities.get(s.genId) : undefined;
  return e && get<Generator>(e, 'generator');
}

/** Whether the generator is currently producing power. */
export function generatorRunning(world: World): boolean {
  return generator(world)?.running ?? false;
}

/** Remaining generator fuel (units), or 0 if there is no generator. */
export function generatorFuel(world: World): number {
  const s = STATE.get(world);
  const e = s?.genId ? world.state.entities.get(s.genId) : undefined;
  return (e && get<ResourcesComponent>(e, 'resources')?.pools.fuel?.current) ?? 0;
}

/**
 * `powered(cell)` — the one power predicate: the cell is wire-connected to the
 * generator and the generator is running. A non-member cell (`networkOf = -1`)
 * is never `sameNetwork`, so unwired cells read unpowered for free.
 */
export function isPowered(world: World, cell: Cell): boolean {
  const s = STATE.get(world);
  if (!s || s.genCell === undefined || !generatorRunning(world)) return false;
  return s.network.forLevel(LEVEL_ID).sameNetwork(POWER_NET, cell, s.genCell);
}

/** Cell of an entity on the station level, or undefined if it has no position. */
function cellOfEntity(world: World, id: EntityId): Cell | undefined {
  const e = world.state.entities.get(id);
  const pos = e && get<Position>(e, 'position');
  if (!pos) return undefined;
  const level = world.state.levels.get(pos.levelId);
  return level ? cellOf({ x: pos.x, y: pos.y }, level.width) : undefined;
}

/** Recompute every door/locker's cached `openable.powered` from the live network. */
export function syncConsumers(world: World): void {
  for (const e of world.state.entities.values()) {
    const o = get<Openable>(e, 'openable');
    if (!o) continue;
    const cell = cellOfEntity(world, e.id);
    o.powered = cell !== undefined && isPowered(world, cell);
  }
}

/**
 * Cut (`on=false`) or relay (`on=true`) the wire at a cell, then re-derive power.
 * The Epic-F wirecutters/cable tools call this through `useOn`; the proof drives it
 * directly. Marks the raw-layer index dirty (it has no auto-invalidation) and emits
 * `wire:changed` for perception/UI.
 */
export function setWire(world: World, cell: Cell, on: boolean): void {
  const level = world.state.levels.get(LEVEL_ID);
  if (!level) return;
  const wire = ensureU8Layer(level, 'wire');
  const next = on ? 1 : 0;
  if (wire[cell] === next) return;
  wire[cell] = next;
  stateOf(world).network.forLevel(LEVEL_ID).markDirty(POWER_NET);
  syncConsumers(world);
  world.services.bus.emit({ type: 'wire:changed', levelId: LEVEL_ID, cell });
}

/** Recompute `running` from switch + fuel; re-sync consumers if it changed. */
function refreshRunning(world: World): void {
  const gen = generator(world);
  if (!gen) return;
  const running = gen.on && generatorFuel(world) > 0;
  if (running === gen.running) return;
  gen.running = running;
  syncConsumers(world);
}

/** Flip the generator's switch and re-derive power. */
export function setGenerator(world: World, on: boolean): void {
  const gen = generator(world);
  if (!gen) return;
  gen.on = on;
  refreshRunning(world);
}

/** Create the generator entity at `cell` (idempotent — reuse on reload). */
function ensureGenerator(world: World, cell: Cell, config: Config): EntityId {
  const existing = world.state.entities.get(GEN_ID);
  if (existing) return GEN_ID;
  const level = world.state.levels.get(LEVEL_ID)!;
  const { x, y } = pointOf(cell, level.width);
  const cap = config.power.fuelCapacity;
  const e = createEntity(GEN_ID, [
    { type: 'position', x, y, levelId: LEVEL_ID },
    {
      type: 'renderable',
      glyph: config.render.generator.glyph,
      fg: config.render.generator.fg,
      layer: config.render.layers.openable,
    },
    { type: 'info', name: 'generator' },
    { type: 'generator', on: config.power.startsOn, running: false },
    { type: 'stats', base: { 'max-fuel': cap } },
    { type: 'resources', pools: { fuel: { current: cap } } },
  ]);
  world.state.entities.set(GEN_ID, e);
  world.services.queries.index(e);
  world.services.queries.place(GEN_ID, LEVEL_ID, cell);
  return GEN_ID;
}

/**
 * Register the power network on `world`. Call after the station + doors are built,
 * and AGAIN after `loadWorld` (idempotent: reuses the generator entity, `override`s
 * the burn timer). No-op if the station has no generator cell (the atmos/breathing
 * fixtures): the network is simply never indexed and `isPowered` returns false.
 */
export function registerPower(world: World, config: Config, genCell?: Cell): void {
  const s = stateOf(world);

  // The `generator` state component, so a loaded save validates it.
  (world.services.registries.components as ComponentRegistry).override('generator', {
    type: 'generator',
    schema: GeneratorSchema,
  });
  // Fuel pool, capped by `max-fuel`; depletion is observed via `running`.
  (world.services.registries.resources as ResourceDefRegistry).override('fuel', {
    id: 'fuel',
    max: 'max-fuel',
    thresholds: [{ at: 0, emit: 'generator:depleted' }],
  });

  if (genCell === undefined) return; // fixture without a generator

  s.genCell = genCell;
  s.network.forLevel(LEVEL_ID).ensure({ id: POWER_NET, layer: 'wire' });
  s.genId = ensureGenerator(world, genCell, config);

  // Fuel burn on the WORLD clock (a global rate → world-tick stepper, per the
  // two-clocks pillar). A recurring timer-effect drains fuel each cadence and flips
  // `running` when the tank empties; `override` keeps re-registration idempotent.
  const burnPerStep = config.power.burnPerSecond * (config.power.burnCadence / config.ticksPerSecond);
  const burn: TimerEffect = (w) => {
    const gen = generator(w);
    const events: GameEvent[] = [];
    if (gen?.on && generatorFuel(w) > 0) {
      events.push(...changeResource(w, GEN_ID, 'fuel', -burnPerStep, 'burn'));
    }
    refreshRunning(w);
    w.services.timeline.schedule(config.power.burnCadence, BURN_EFFECT);
    return events;
  };
  (world.services.registries.timerEffects as Registry<TimerEffect>).override(BURN_EFFECT, burn);
  if (!world.state.timeline.timers.some((t) => t.effectId === BURN_EFFECT)) {
    world.services.timeline.schedule(config.power.burnCadence, BURN_EFFECT);
  }

  refreshRunning(world); // set initial `running` + sync consumers
}
