/**
 * breathing — per-actor oxygen, suffocation, and O₂ tanks (Epic A, game-design §5).
 *
 * A breach is only a threat if something breathes. Each actor turn, the `breather`
 * mixin samples the pressure at the actor's own cell (the `pressure` layer the
 * atmos stepper maintains): in breathable air it regens oxygen, in thin air it
 * drains. At zero oxygen it bleeds HP (`cause:'suffocation'`); HP at zero fires
 * the engine's core `died` threshold, which unschedules the actor. An active O₂
 * tank forces the breathing branch regardless of pressure for `tankDuration`.
 *
 * Rates live in `config` as honest per-SECOND values; the hook scales them by the
 * world-ticks elapsed since the actor's last turn (`dt`), so they hold regardless
 * of actor speed. This rides the engine's `Mixin.onActorTick` seam (R8) — the one
 * mixin hook that may mutate, sharing `tickActor`'s mutation context, so it calls
 * `changeResource` directly rather than going through the effect pipeline.
 */
import { z } from 'zod';
import {
  cellOf,
  get,
  changeResource,
  ensureFloatLayer,
  type World,
  type EntityId,
  type Position,
  type GameEvent,
  type Mixin,
  type MixinRegistry,
  type ResourceDefRegistry,
  type ComponentRegistry,
} from '../../rlkit/src/index';
import { seconds, type Config } from './config';

/** Schema for the breathing state component so save/load (`parseComponent`) validates it (Epic H rejoin). */
const BreathingSchema = z.object({
  type: z.literal('breathing'),
  last: z.number(),
  tankUntil: z.number(),
});

/** Per-actor breathing state: last-ticked world clock (for dt) + tank expiry. */
export interface BreathingState {
  type: 'breathing';
  /** World clock at the actor's previous breath tick — the dt baseline. */
  last: number;
  /** World clock before which the drain is paused by an active O₂ tank. */
  tankUntil: number;
  [key: string]: unknown;
}

interface ResourcesComponent {
  type: 'resources';
  pools: Record<string, { current: number }>;
  [key: string]: unknown;
}

/** Pressure (kPa) at the actor's current cell, or undefined if off-level. */
function pressureAt(world: World, pos: Position): number | undefined {
  const level = world.state.levels.get(pos.levelId);
  if (!level) return undefined;
  const pressure = ensureFloatLayer(level, 'pressure');
  return pressure[cellOf({ x: pos.x, y: pos.y }, level.width)];
}

/**
 * Register the oxygen resource and the `breather` mixin on `world`. Call after the
 * station is built (so levels carry the `pressure` layer), and AGAIN after
 * `loadWorld` — `override` keeps it idempotent, re-attaching the mixin closure.
 */
export function registerBreathing(world: World, config: Config): void {
  // Register the breathing state component so a loaded save validates it.
  (world.services.registries.components as ComponentRegistry).override('breathing', {
    type: 'breathing',
    schema: BreathingSchema,
  });

  // Oxygen pool, capped by the `max-oxygen` stat. Depletion is handled in the
  // hook (→ HP damage), so no threshold here; HP's core `at:0 → died` does the rest.
  (world.services.registries.resources as ResourceDefRegistry).override('oxygen', {
    id: 'oxygen',
    max: 'max-oxygen',
  });

  const breather: Mixin = {
    name: 'breather',
    requires: ['position', 'resources'],
    onActorTick(self, w): GameEvent[] {
      const pos = get<Position>(self, 'position');
      const res = get<ResourcesComponent>(self, 'resources');
      const breath = get<BreathingState>(self, 'breathing');
      if (!pos || !res?.pools.oxygen || !breath) return [];

      const p = pressureAt(w, pos);
      if (p === undefined) return [];

      const now = w.services.timeline.worldClock;
      const dt = Math.max(0, (now - breath.last) / config.ticksPerSecond);
      breath.last = now;
      if (dt === 0) return [];

      const events: GameEvent[] = [];
      const breathing = breath.tankUntil > now || p >= config.atmos.breathThreshold;
      if (breathing) {
        events.push(...changeResource(w, self.id, 'oxygen', config.oxygen.regenPerSecond * dt, 'breathe'));
        return events;
      }

      // Vacuum: drain oxygen, then suffocate for only the portion of this window
      // spent at zero O₂ (no sub-tick over-damage on the tick O₂ runs out). `o2` is
      // the reserve before draining; `drain<=0` means it never empties (Infinity).
      const o2 = res.pools.oxygen.current;
      const drain = config.oxygen.drainPerSecond;
      events.push(...changeResource(w, self.id, 'oxygen', -drain * dt, 'vacuum'));
      const timeToEmpty = drain > 0 ? o2 / drain : Infinity;
      const suffocatingDt = dt - Math.min(dt, timeToEmpty);
      if (suffocatingDt > 0) {
        // HP hitting 0 fires the core `died` threshold → death reactor unschedules.
        events.push(...changeResource(w, self.id, 'hp', -config.oxygen.suffocationDps * suffocatingDt, 'suffocation'));
      }
      return events;
    },
  };
  (world.services.registries.mixins as MixinRegistry).override('breather', breather);
}

/**
 * Activate an O₂ tank on an actor: pause oxygen drain for `tankDuration` seconds.
 * v0 seam — the tank as a real carried/equipped item lands in Epic F (items).
 */
export function activateTank(world: World, id: EntityId, config: Config): void {
  const e = world.state.entities.get(id);
  const breath = e && get<BreathingState>(e, 'breathing');
  if (breath) breath.tankUntil = world.services.timeline.worldClock + seconds(config.oxygen.tankDuration);
}
