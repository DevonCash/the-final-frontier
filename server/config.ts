/**
 * config — every tunable for The Final Frontier in one place (game-design §9).
 *
 * Per the config-vs-logic pillar: numbers, rates, thresholds, glyphs, and
 * content tables live here; the systems in `server/` read from here and never
 * hardcode a value. `ticksPerSecond` is the server's fixed logical timestep — it
 * is *our* constant (the engine has none), and it couples wall-clock durations to
 * world-ticks and to the action economy (see game-design §9 calibration).
 */

export const TICKS_PER_SECOND = 25;

/** Convert a wall-clock seconds value to whole world-ticks. */
export const seconds = (s: number): number => Math.round(s * TICKS_PER_SECOND);

export interface AtmosConfig {
  /** World-ticks between diffusion sweeps (cadence in the stepper). */
  readonly cadence: number;
  /** Fraction of a neighbor pressure differential that flows per sweep (0..0.25 stable for 4-neighbor). */
  readonly diffusionRate: number;
  /** Sealed-room starting pressure, kPa. */
  readonly nominalPressure: number;
  /** Below this kPa at an actor's cell, it starts losing oxygen. */
  readonly breathThreshold: number;
  /** kPa a powered vent adds at its cell per second. */
  readonly ventRate: number;
}

export interface OxygenConfig {
  readonly max: number;
  /** Oxygen lost per second while below the breath threshold (no tank). */
  readonly drainPerSecond: number;
  /** Oxygen regained per second while breathing. */
  readonly regenPerSecond: number;
  /** HP lost per second once oxygen hits 0. */
  readonly suffocationDps: number;
  /** Seconds an O2 tank pauses the drain. */
  readonly tankDuration: number;
}

export interface RoundConfig {
  readonly minPlayers: number;
  /** Total shift length, seconds, before the round ends. */
  readonly roundLength: number;
  /** When the shuttle is called / arrivals unlocks, seconds. */
  readonly shuttleAt: number;
}

export interface PowerConfig {
  /** Generator fuel tank size (units); also the `max-fuel` stat base. */
  readonly fuelCapacity: number;
  /** Fuel units burned per second while the generator runs. */
  readonly burnPerSecond: number;
  /** World-ticks between fuel-drain steps (the generator's world-tick clock). */
  readonly burnCadence: number;
  /** Whether the generator is switched on at round start. */
  readonly startsOn: boolean;
  /** Generator entity glyph + colour (single colour — no gradients). */
  readonly glyph: string;
  readonly fg: string;
}

export interface Config {
  readonly ticksPerSecond: number;
  readonly atmos: AtmosConfig;
  readonly oxygen: OxygenConfig;
  readonly round: RoundConfig;
  readonly power: PowerConfig;
  /** Melee damage by weapon class (game-design §4.1). */
  readonly weaponDamage: Readonly<Record<string, number>>;
  /** Access tags a door/locker may require; an ID grants a subset. */
  readonly access: { readonly doors: Readonly<Record<string, string>> };
  /** Seconds a door stays open before auto-closing. */
  readonly doorAutoClose: number;
  /** Melee hits to smash a window; welder uses to cut a wall / repair a breach. */
  readonly windowHits: number;
  readonly wallCutUses: number;
  readonly repairUses: number;
  /** Local-say hearing radius in cells (distance, not line-of-sight). */
  readonly hearingRadius: number;
  readonly emagCharges: number;
}

export const config: Config = {
  ticksPerSecond: TICKS_PER_SECOND,
  atmos: {
    cadence: 5,
    diffusionRate: 0.2,
    nominalPressure: 101,
    breathThreshold: 50,
    ventRate: 8,
  },
  oxygen: {
    max: 100,
    drainPerSecond: 5,
    regenPerSecond: 10,
    suffocationDps: 5,
    tankDuration: 120,
  },
  round: {
    minPlayers: 4,
    roundLength: 600,
    shuttleAt: 480,
  },
  power: {
    fuelCapacity: 600, // ~roundLength seconds at burnPerSecond = 1
    burnPerSecond: 1,
    burnCadence: TICKS_PER_SECOND, // drain once per second
    startsOn: true,
    glyph: 'G',
    fg: '#fd5',
  },
  weaponDamage: { fist: 5, tool: 12, knife: 25 },
  access: {
    doors: { bridge: 'bridge', engineering: 'engineering', maintenance: 'maintenance' },
  },
  doorAutoClose: 4,
  windowHits: 3,
  wallCutUses: 5,
  repairUses: 3,
  hearingRadius: 7,
  emagCharges: 3,
};
