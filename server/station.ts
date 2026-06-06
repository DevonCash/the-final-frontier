/**
 * station — the hand-authored station prefab: ASCII art → a `Level`.
 *
 * The map is one editable constant. Each char maps to a tile (or a tile + an
 * entity placed on it). v0 proof layout: two sealed rooms joined by an airlock
 * (entity door), roomB's outer hull carries a window to space (the breach test).
 * Grow `MAP` toward the full game-design §3 station without touching the decoder.
 *
 * Legend:
 *   '~' space (void, pressure sink)     '#' hull (airtight wall)
 *   '.' floor (holds air)               '%' window (airtight, smashes to space)
 *   '+' airlock door (floor + door entity)
 */
import {
  createLevel,
  ensureFloatLayer,
  levelCell,
  setTile,
  type World,
  type Level,
} from '../../rlkit/src/index';
import { TILES, placeDoor, type Door } from './content';
import type { Config } from './config';

export const LEVEL_ID = 'station';

// 20×7. Door at (8,3) divides roomA (x2..7) from roomB (x9..17); window at (18,3).
const MAP = [
  '~~~~~~~~~~~~~~~~~~~~',
  '~##################~',
  '~#......#.........#~',
  '~#......+.........%~',
  '~#......#.........#~',
  '~##################~',
  '~~~~~~~~~~~~~~~~~~~~',
];

const CHAR_TILE: Record<string, string> = {
  '~': TILES.space,
  '#': TILES.hull,
  '.': TILES.floor,
  '%': TILES.window,
  '+': TILES.floor, // the door is an entity ON a floor cell
};

/** Named cells for tests / spawns. */
export interface StationMarks {
  readonly roomA: number;
  readonly roomB: number;
  readonly door: number;
  readonly window: number;
  readonly spaceOutsideWindow: number;
}

export interface Station {
  readonly level: Level;
  readonly doors: Door[];
  readonly mark: StationMarks;
}

/** Build the station level into the world: tiles, the pressure layer, door entities. */
export function buildStation(world: World, config: Config): Station {
  const height = MAP.length;
  const width = MAP[0]!.length;
  const floorIdx = world.services.tiles.index(TILES.floor);
  const level = createLevel(LEVEL_ID, width, height, floorIdx);
  world.state.levels.set(LEVEL_ID, level);

  // Lay tiles from the art.
  for (let y = 0; y < height; y++) {
    const row = MAP[y]!;
    for (let x = 0; x < width; x++) {
      const ch = row[x]!;
      const tileId = CHAR_TILE[ch] ?? TILES.floor;
      setTile(level, levelCell(level, x, y), world.services.tiles.index(tileId));
    }
  }

  // Pressure layer: interior floor at nominal, everything else (hull/space/window) 0.
  const pressure = ensureFloatLayer(level, 'pressure');
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = MAP[y]![x]!;
      if (ch === '.' || ch === '+') pressure[levelCell(level, x, y)] = config.atmos.nominalPressure;
    }
  }

  // Place door entities (after tiles + pressure; the flag index captures them on
  // its first build, which the atmos stepper triggers on its first sweep).
  const doors: Door[] = [];
  let doorN = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (MAP[y]![x] === '+') {
        doors.push(placeDoor(world, LEVEL_ID, levelCell(level, x, y), { id: `door-${doorN++}` }));
      }
    }
  }

  const mark = {
    roomA: levelCell(level, 4, 3),
    roomB: levelCell(level, 13, 3),
    door: levelCell(level, 8, 3),
    window: levelCell(level, 18, 3),
    spaceOutsideWindow: levelCell(level, 19, 3),
  };

  return { level, doors, mark };
}
