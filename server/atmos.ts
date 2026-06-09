/**
 * atmos — the conservative pressure-diffusion stepper (game logic; R1 slot).
 *
 * Registered via the engine's `registerStepper` (the sanctioned per-world-tick
 * bulk-step slot). Each sweep moves a fraction of every airflow-connected
 * neighbor pair's pressure differential, then pins space cells to 0 (the void is
 * an infinite sink — this is what makes a breach vent a room). Airflow is blocked
 * by the composed `airtight` flag: hull, intact windows, and CLOSED doors all
 * carry it, so air only moves where it should.
 *
 * Mass is conserved everywhere except space sinks. No RNG → fully deterministic.
 * The math lives here, not in the engine, per the headless-core boundary.
 */
import { registerStepper, neighbors4, type World } from '../../rlkit/src/index';
import { FLAGS, TILES } from './content';
import { isPowered } from './power';
import type { Config } from './config';

/**
 * Register the atmosphere simulation on `world`. Call after the station is built,
 * and AGAIN after `loadWorld` (the stepper's function isn't serialized; the
 * bootstrap is idempotent, so re-registering re-attaches without double-running).
 */
export function registerAtmos(world: World, config: Config): void {
  const rate = config.atmos.diffusionRate;
  const spaceIdx = world.services.tiles.index(TILES.space);

  registerStepper(world, {
    id: 'atmos',
    layer: 'pressure',
    cadence: config.atmos.cadence,
    step: (w, level, pressure) => {
      const flagIndex = w.services.flagIndex.forLevel(level.id);
      const flags = flagIndex.layer();
      const airtight = 1 << w.services.flags.bit(FLAGS.airtight);
      const n = level.width * level.height;

      // Double-buffer so flow is computed from this sweep's start state.
      const next = Float32Array.from(pressure);
      for (let c = 0; c < n; c++) {
        for (const nb of neighbors4(c, level.width, level.height)) {
          if (nb <= c) continue; // visit each undirected pair once
          if ((flags[c]! & airtight) || (flags[nb]! & airtight)) continue;
          const flow = (pressure[c]! - pressure[nb]!) * rate;
          next[c]! -= flow;
          next[nb]! += flow;
        }
      }
      pressure.set(next);

      // The void is a sink: any pressure that reached a space cell is lost.
      for (let c = 0; c < n; c++) {
        if (tileIsSpace(w, level, c, spaceIdx)) pressure[c] = 0;
      }
      return [];
    },
  });
}

function tileIsSpace(w: World, level: { id: string }, cell: number, spaceIdx: number): boolean {
  const lvl = w.state.levels.get(level.id)!;
  const tiles = lvl.layers.get('tiles') as Uint16Array;
  return tiles[cell] === spaceIdx;
}

/**
 * Register the powered-vent stepper: each atmos sweep, every vent cell that reads
 * `powered` (wire-connected to the running generator) pushes its own cell toward
 * `nominalPressure` by `ventRate` kPa/s (the diffusion stepper then spreads it into
 * the room). An UNPOWERED vent does nothing — cutting the wire stops repressurization
 * (Epic E proof). Shares the atmos cadence so vents and diffusion stay in lockstep.
 *
 * Idempotent (override on re-register), like `registerAtmos`. Call with the station's
 * vent cells; an empty list registers an inert stepper (fixtures without vents).
 */
export function registerVents(world: World, config: Config, ventCells: readonly number[]): void {
  const cells = [...ventCells];
  const perSweep = config.atmos.ventRate * (config.atmos.cadence / config.ticksPerSecond);
  const nominal = config.atmos.nominalPressure;

  registerStepper(world, {
    id: 'vents',
    layer: 'pressure',
    cadence: config.atmos.cadence,
    step: (w, _level, pressure) => {
      for (const cell of cells) {
        if (!isPowered(w, cell)) continue;
        const next = pressure[cell]! + perSweep;
        pressure[cell] = next > nominal ? nominal : next;
      }
      return [];
    },
  });
}
