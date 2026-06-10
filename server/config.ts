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
  /** Engineer slots filled after the single captain; the rest are crew. */
  readonly engineerCount: number;
}

/** Starting tool kits by job — item `kind`s resolved to `spawn*` factories in round.ts. */
export interface KitsConfig {
  readonly engineer: readonly string[];
  readonly traitor: readonly string[];
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
}

/** A glyph + foreground color (the config-vs-logic pillar keeps both here). */
export interface Glyph {
  readonly glyph: string;
  readonly fg: string;
}

/** An openable's color plus its open/closed glyph pair. */
export interface OpenableGlyph {
  readonly fg: string;
  readonly open: string;
  readonly closed: string;
}

export interface RenderConfig {
  /** Render layer (draw order) per entity class; higher draws on top. */
  readonly layers: { readonly corpse: number; readonly item: number; readonly openable: number; readonly actor: number };
  readonly crew: Glyph;
  /** Tile palette glyph+color (registered into the engine in content.ts). */
  readonly tiles: { readonly hull: Glyph; readonly space: Glyph; readonly window: Glyph };
  /** Carried-item glyphs; `default.fg` is the fallback color for an unspecified item. */
  readonly items: {
    readonly default: { readonly fg: string };
    readonly id: Glyph;
    readonly crowbar: Glyph;
    readonly emag: Glyph;
    readonly welder: Glyph;
    readonly wrench: Glyph;
    readonly wirecutters: Glyph;
    readonly cable: Glyph;
    readonly knife: Glyph;
    readonly o2tank: Glyph;
    readonly disk: Glyph;
  };
  readonly openable: { readonly door: OpenableGlyph; readonly locker: OpenableGlyph };
  /** The generator (a powered station fixture, drawn at the openable layer). */
  readonly generator: Glyph;
  /** The corpse an actor leaves on death (Epic F loot, drawn below the living). */
  readonly corpse: Glyph;
}

export interface Config {
  readonly ticksPerSecond: number;
  readonly atmos: AtmosConfig;
  readonly oxygen: OxygenConfig;
  readonly round: RoundConfig;
  readonly power: PowerConfig;
  /** Actor stats (authored content; oxygen max lives under `oxygen`). */
  readonly stats: { readonly maxHp: number };
  /** Server loop tunables. */
  readonly server: { readonly maxTickCatchup: number };
  /** Render glyphs, colors, and draw layers (config-vs-logic pillar). */
  readonly render: RenderConfig;
  /** Bump-interaction priority for the openable on:bump rule (above the absent attack rule). */
  readonly openableBumpPriority: number;
  /** Melee damage by weapon class (game-design §4.1). */
  readonly weaponDamage: Readonly<Record<string, number>>;
  /** Access tags a door/locker may require, and the tag set each job's ID grants. */
  readonly access: {
    readonly doors: Readonly<Record<string, string>>;
    readonly ids: Readonly<Record<'captain' | 'engineer' | 'crew', readonly string[]>>;
  };
  /** Starting tool kits by job. */
  readonly kits: KitsConfig;
  /** Seconds a door stays open before auto-closing. */
  readonly doorAutoClose: number;
  /** Melee hits to smash a window; welder uses to cut a wall / repair a breach. */
  readonly windowHits: number;
  readonly wallCutUses: number;
  readonly repairUses: number;
  /** Relays a single cable item can lay before it's spent (game-design §4.1, cable ×10). */
  readonly cableLength: number;
  /** Local-say hearing radius in cells (distance, not line-of-sight). */
  readonly hearingRadius: number;
  /** Local chat tunables (Epic I). */
  readonly chat: { readonly maxLength: number };
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
    engineerCount: 1,
  },
  power: {
    fuelCapacity: 600, // ~roundLength seconds at burnPerSecond = 1
    burnPerSecond: 1,
    burnCadence: TICKS_PER_SECOND, // drain once per second
    startsOn: true,
  },
  stats: { maxHp: 100 },
  server: { maxTickCatchup: 8 },
  render: {
    layers: { corpse: 2, item: 3, openable: 4, actor: 5 },
    crew: { glyph: '@', fg: '#fff' },
    tiles: {
      hull: { glyph: '#', fg: '#8af' },
      space: { glyph: ' ', fg: '#000' },
      window: { glyph: '%', fg: '#9cf' },
    },
    items: {
      default: { fg: '#ddd' },
      id: { glyph: 'i', fg: '#fc6' },
      crowbar: { glyph: '/', fg: '#c44' },
      emag: { glyph: '!', fg: '#f4f' },
      welder: { glyph: 'w', fg: '#fa3' },
      wrench: { glyph: 'r', fg: '#bbb' },
      wirecutters: { glyph: 'x', fg: '#fc4' },
      cable: { glyph: '-', fg: '#e22' },
      knife: { glyph: 'k', fg: '#dde' },
      o2tank: { glyph: 'O', fg: '#6cf' },
      disk: { glyph: '*', fg: '#ff4' }, // the intel disk (round objective, Epic H)
    },
    openable: {
      door: { fg: '#b85', open: "'", closed: '+' },
      locker: { fg: '#9b7', open: 'l', closed: 'L' },
    },
    generator: { glyph: 'G', fg: '#fd5' },
    corpse: { glyph: '%', fg: '#a55' },
  },
  openableBumpPriority: 5,
  weaponDamage: { fist: 5, tool: 12, knife: 25 },
  access: {
    doors: { bridge: 'bridge', engineering: 'engineering', maintenance: 'maintenance' },
    ids: {
      captain: ['bridge', 'engineering', 'maintenance'], // all access
      engineer: ['engineering', 'maintenance'],
      crew: [], // basic: a plain ID with no special access (still loseable/lootable)
    },
  },
  kits: {
    engineer: ['welder', 'wrench', 'crowbar', 'wirecutters', 'cable', 'o2tank'],
    traitor: ['emag', 'knife'], // on top of the job kit; emag uses config.emagCharges
  },
  doorAutoClose: 4,
  windowHits: 3,
  wallCutUses: 5,
  repairUses: 3,
  cableLength: 10,
  hearingRadius: 7,
  chat: { maxLength: 200 },
  emagCharges: 3,
};
