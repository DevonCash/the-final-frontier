/**
 * station — hand-authored station prefabs: ASCII art → a `Level`.
 *
 * Two maps share one decoder:
 *  - `buildStation` lays the FULL game-design §3 station (the production map the
 *    server runs): bridge+windows+locker, engineering+generator, storage, dorms,
 *    bar, arrivals+shuttle airlock, a corridor spine, and an external airlock,
 *    with vents per room and a wire spine through the corridors.
 *  - `buildFixtureStation` lays the original minimal two-room world, kept as a
 *    controlled fixture for the atmos/breathing SYSTEM proofs so growing the real
 *    station never perturbs those regressions (the epics are independent).
 *
 * Legend (full map):
 *   '~' space      '#' hull        '.' floor       '%' window (breakable)
 *   '+' airlock    'A' shuttle airlock   'E' external (EVA) airlock
 *   '=' floor carrying the power wire (the corridor spine)
 *   'v' vent       's' crew spawn  'C' captain spawn   'L' locker   'G' generator
 * Every glyph but space/hull/window decodes to a floor tile; the rest are marks,
 * wire, or entities placed on that floor (one source of truth — the map).
 */
import {
  createLevel,
  ensureFloatLayer,
  ensureU8Layer,
  levelCell,
  setTile,
  type World,
  type Level,
} from '../../rlkit/src/index';
import { TILES } from './content';
import { placeDoor, type Door } from './openable';
import type { Config } from './config';

export const LEVEL_ID = 'station';

/** Glyph → tile id. Marks/entities (door, vent, spawn, …) all sit on a floor tile. */
const CHAR_TILE: Record<string, string> = {
  '~': TILES.space,
  '#': TILES.hull,
  '%': TILES.window,
  '.': TILES.floor,
  '+': TILES.floor,
  '=': TILES.floor,
  A: TILES.floor,
  E: TILES.floor,
  v: TILES.floor,
  s: TILES.floor,
  C: TILES.floor,
  L: TILES.floor,
  G: TILES.floor,
};
const DOOR_CHARS = new Set(['+', 'A', 'E']);

/** Validate a map is rectangular and lay its tiles + pressure; return the level. */
function layTiles(world: World, config: Config, map: readonly string[]): Level {
  const height = map.length;
  const width = map[0]!.length;
  for (let y = 0; y < height; y++) {
    if (map[y]!.length !== width) {
      throw new Error(`station map row ${y} is ${map[y]!.length} wide, expected ${width}`);
    }
  }
  const floorIdx = world.services.tiles.index(TILES.floor);
  const level = createLevel(LEVEL_ID, width, height, floorIdx);
  world.state.levels.set(LEVEL_ID, level);

  const pressure = ensureFloatLayer(level, 'pressure');
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = map[y]![x]!;
      const tileId = CHAR_TILE[ch] ?? TILES.floor;
      const cell = levelCell(level, x, y);
      setTile(level, cell, world.services.tiles.index(tileId));
      if (tileId === TILES.floor) pressure[cell] = config.atmos.nominalPressure;
    }
  }
  return level;
}

/** Place a door for every door glyph; return them with the special doors flagged. */
function placeDoors(
  world: World,
  level: Level,
  map: readonly string[],
): { doors: Door[]; shuttle?: number; external?: number } {
  const doors: Door[] = [];
  let shuttle: number | undefined;
  let external: number | undefined;
  let n = 0;
  for (let y = 0; y < map.length; y++) {
    for (let x = 0; x < level.width; x++) {
      const ch = map[y]![x]!;
      if (!DOOR_CHARS.has(ch)) continue;
      const cell = levelCell(level, x, y);
      doors.push(placeDoor(world, LEVEL_ID, cell, { id: `door-${n++}` }));
      if (ch === 'A') shuttle = cell;
      if (ch === 'E') external = cell;
    }
  }
  return { doors, ...(shuttle !== undefined ? { shuttle } : {}), ...(external !== undefined ? { external } : {}) };
}

// ===========================================================================
// Full station (production)
// ===========================================================================

// 48×20. Corridor spine: vertical cols 21–22 crossed by a horizontal run (rows
// 9–10). Rooms hang off the spine; the bridge's north hull carries the windows; the
// external airlock (E) is the EVA route through the south hull. Single-width wire
// branches (`=`) thread from the spine into each room to reach its vent, plus the
// generator and locker, so every powered consumer is a literal member of one wire
// network (Epic E, `powered = sameNetwork(cell, genCell)`).
const STATION_MAP: readonly string[] = [
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~#########################%%%%%%%##############~',
  '~#...................#==#.........#...........#~',
  '~#...v...............#==#....v....#.....v.....#~',
  '~#...================+==+=======..#..s.s=s.s..#~',
  '~#......G............#==#..C...L..#.....=.....#~',
  '~#...................#==#.........#..s.s=.....#~',
  '~#...................#==#.........#.....=.....#~',
  '~#####################==################+######~',
  '~#============================================#~',
  '~#============================================#~',
  '~#########+###########==######+############A###~',
  '~#........=..........#==#.....=.........#..=..#~',
  '~#........=..........#==#.....=.........#..=..#~',
  '~#........=..........#==#.....=.........#..=..#~',
  '~#...v=====..........#==#.....v.........#..v..#~',
  '~#...................#==#...............#.....#~',
  '~#...................#==#...............#.....#~',
  '~#####################E########################~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
];

/** Named cells/sites for spawns, tests, and downstream epics (power/round). */
export interface StationMarks {
  readonly spawns: number[]; // crew spawn cells (dorms)
  readonly captainSpawn?: number; // bridge
  readonly vents: number[]; // one per room
  readonly generator?: number; // engineering
  readonly locker?: number; // bridge
  readonly shuttleDoor?: number; // arrivals airlock
  readonly externalAirlock?: number; // EVA airlock through the south hull
}

export interface Station {
  readonly level: Level;
  readonly doors: Door[];
  readonly mark: StationMarks;
}

/** Build the full production station: tiles, pressure, doors, marks, wire spine. */
export function buildStation(world: World, config: Config): Station {
  const level = layTiles(world, config, STATION_MAP);
  const { doors, shuttle, external } = placeDoors(world, level, STATION_MAP);

  // Collect marks and the wire layer from the glyphs (one source of truth — the
  // map). The power network (Epic E) reads `wire`; every powered consumer's own cell
  // is a wire member (`=` branches plus the cell under the generator/vent/locker/door
  // glyphs), so `powered = sameNetwork(cell, genCell)` holds.
  const wire = ensureU8Layer(level, 'wire');
  const spawns: number[] = [];
  const vents: number[] = [];
  let captainSpawn: number | undefined;
  let generator: number | undefined;
  let locker: number | undefined;
  for (let y = 0; y < STATION_MAP.length; y++) {
    for (let x = 0; x < level.width; x++) {
      const cell = levelCell(level, x, y);
      const ch = STATION_MAP[y]![x]!;
      switch (ch) {
        case 's': spawns.push(cell); break;
        case 'v': vents.push(cell); break;
        case 'C': captainSpawn = cell; break;
        case 'G': generator = cell; break;
        case 'L': locker = cell; break;
      }
      // Wire members: the spine/branches AND the consumer cells they feed (vents,
      // locker, generator, doors) — so each consumer reads its own cell's network.
      if (ch === '=' || ch === 'v' || ch === 'L' || ch === 'G' || DOOR_CHARS.has(ch)) wire[cell] = 1;
    }
  }

  const mark: StationMarks = {
    spawns,
    vents,
    ...(captainSpawn !== undefined ? { captainSpawn } : {}),
    ...(generator !== undefined ? { generator } : {}),
    ...(locker !== undefined ? { locker } : {}),
    ...(shuttle !== undefined ? { shuttleDoor: shuttle } : {}),
    ...(external !== undefined ? { externalAirlock: external } : {}),
  };
  return { level, doors, mark };
}

// ===========================================================================
// Minimal fixture (atmos / breathing system proofs)
// ===========================================================================

// Two sealed rooms joined by an airlock; roomB's outer hull carries a window to
// space (the breach test). Door at (8,3) divides roomA (x2..7) from roomB (x9..17).
const FIXTURE_MAP: readonly string[] = [
  '~~~~~~~~~~~~~~~~~~~~',
  '~##################~',
  '~#......#.........#~',
  '~#......+.........%~',
  '~#......#.........#~',
  '~##################~',
  '~~~~~~~~~~~~~~~~~~~~',
];

export interface FixtureMarks {
  readonly roomA: number;
  readonly roomB: number;
  readonly door: number;
  readonly window: number;
  readonly spaceOutsideWindow: number;
}

export interface FixtureStation {
  readonly level: Level;
  readonly doors: Door[];
  readonly mark: FixtureMarks;
}

/** Build the minimal two-room fixture used by the atmos/breathing proofs. */
export function buildFixtureStation(world: World, config: Config): FixtureStation {
  const level = layTiles(world, config, FIXTURE_MAP);
  const { doors } = placeDoors(world, level, FIXTURE_MAP);
  const mark: FixtureMarks = {
    roomA: levelCell(level, 4, 3),
    roomB: levelCell(level, 13, 3),
    door: levelCell(level, 8, 3),
    window: levelCell(level, 18, 3),
    spaceOutsideWindow: levelCell(level, 19, 3),
  };
  return { level, doors, mark };
}

// ===========================================================================
// Power fixture (Epic E proof)
// ===========================================================================

// A single corridor: generator → wire → door → wire → vent. The closed door seals
// the right pocket (cols 6–10), which starts depressurized so a powered vent visibly
// repressurizes it. The wire is single-width, so cutting the gen-side cell (3,2)
// disconnects BOTH the door and the vent from the generator in one snip.
const POWER_FIXTURE_MAP: readonly string[] = [
  '~~~~~~~~~~~~~~',
  '~############~',
  '~#G==+===v..#~',
  '~############~',
  '~~~~~~~~~~~~~~',
];

export interface PowerFixtureMarks {
  readonly generator: number; // generator cell
  readonly cutWire: number; // gen-side wire cell to cut/relay
  readonly door: number; // door cell
  readonly doorId: string; // door entity id
  readonly vent: number; // vent cell (inside the sealed pocket)
}

export interface PowerFixtureStation {
  readonly level: Level;
  readonly doors: Door[];
  readonly mark: PowerFixtureMarks;
}

/** Build the Epic-E power fixture: gen → wire → door → wire → vent. */
export function buildPowerFixture(world: World, config: Config): PowerFixtureStation {
  const level = layTiles(world, config, POWER_FIXTURE_MAP);
  const { doors } = placeDoors(world, level, POWER_FIXTURE_MAP);

  const wire = ensureU8Layer(level, 'wire');
  for (let y = 0; y < POWER_FIXTURE_MAP.length; y++) {
    for (let x = 0; x < level.width; x++) {
      const ch = POWER_FIXTURE_MAP[y]![x]!;
      if (ch === '=' || ch === 'v' || ch === 'G' || DOOR_CHARS.has(ch)) wire[levelCell(level, x, y)] = 1;
    }
  }

  // Depressurize the whole sealed pocket (cols 6–11, the door's far side up to the
  // hull) so the powered vent has somewhere to push pressure into.
  const pressure = ensureFloatLayer(level, 'pressure');
  for (let x = 6; x <= 11; x++) pressure[levelCell(level, x, 2)] = config.atmos.breathThreshold / 2;

  const mark: PowerFixtureMarks = {
    generator: levelCell(level, 2, 2),
    cutWire: levelCell(level, 3, 2),
    door: levelCell(level, 5, 2),
    doorId: doors[0]!.id,
    vent: levelCell(level, 9, 2),
  };
  return { level, doors, mark };
}
