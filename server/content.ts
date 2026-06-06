/**
 * content — registers the station's tile flags, tile types, and entity factories.
 *
 * Flags are registered BEFORE tiles, because the tile palette resolves a tile's
 * `flags: [...]` names into bits at register time and throws on an unknown name
 * (fail-loud). `airtight` blocks airflow; `wire` marks the power network's member
 * cells (R3, used later). `walkable`/`transparent` are core flags (bits 0,1).
 *
 * Doors are ENTITIES, not tiles — v0 doors carry access/power/bolt state a tile
 * can't hold — so a closed door contributes the `airtight` flag via a `tileFlags`
 * component, toggled by mutate-then-`invalidateCell` (game-design §7, R1/R7).
 */
import { createEntity, pointOf, type World, type EntityId, type Entity } from '../../rlkit/src/index';
import type { Config } from './config';

/** Mutate an entity's renderable glyph in place (door open/closed visuals). */
function setGlyph(e: Entity, glyph: string): void {
  const r = e.components.get('renderable') as { type: 'renderable'; glyph: string } | undefined;
  if (r) r.glyph = glyph;
}

/** Game-registered tile flags (on top of core walkable/transparent). */
export const FLAGS = { airtight: 'airtight', wire: 'wire' } as const;

/** Tile ids. `floor` is the engine's core tile (reused); the rest are ours. */
export const TILES = {
  floor: 'floor', // engine core tile — non-airtight, the air lives here
  hull: 'hull', // station wall — airtight, opaque
  space: 'space', // the void — non-airtight SINK, pinned to 0 pressure
  window: 'window', // airtight but transparent; smashes into `space`
} as const;

/**
 * Register flags + the station's tiles into a fresh world. Call once, before
 * building levels. Flags go first (the palette resolves a tile's flag names to
 * bits at register time). `floor`/`wall` are core tiles already registered by the
 * engine, so we only add the station-specific ones.
 */
export function registerContent(world: World): void {
  const flags = world.services.flags;
  flags.register(FLAGS.airtight);
  flags.register(FLAGS.wire);

  const t = world.services.tiles;
  t.register({ id: TILES.hull, walkable: false, transparent: false, glyph: '#', fg: '#8af', flags: [FLAGS.airtight] });
  t.register({ id: TILES.space, walkable: true, transparent: true, glyph: ' ', fg: '#000' });
  t.register({ id: TILES.window, walkable: false, transparent: true, glyph: '%', fg: '#9cf', flags: [FLAGS.airtight] });
}

/**
 * Place a door entity at a cell: an airtight, sight-blocking obstacle when
 * closed. `open`/`close` flip the `airtight` contribution in place and invalidate
 * the one cell so the atmos stepper sees the change on its next sweep.
 */
export interface Door {
  readonly id: EntityId;
  readonly cell: number;
  readonly access?: string;
  open(world: World): void;
  close(world: World): void;
  isOpen(): boolean;
}

export function placeDoor(world: World, levelId: string, cell: number, opts: { id: string; access?: string } ): Door {
  const level = world.state.levels.get(levelId)!;
  const { x, y } = pointOf(cell, level.width);
  const e = createEntity(
    opts.id,
    [
      { type: 'position', x, y, levelId },
      { type: 'renderable', glyph: '+', fg: '#b85', layer: 4 },
      { type: 'info', name: 'airlock' },
      // Closed door seals: contributes airtight at its cell.
      { type: 'tileFlags', flags: [FLAGS.airtight] },
    ],
  );
  world.state.entities.set(opts.id, e);
  world.services.queries.index(e);
  world.services.queries.place(opts.id, levelId, cell);

  let open = false;
  const setFlags = (names: string[]) => {
    const tf = e.components.get('tileFlags') as { type: 'tileFlags'; flags: string[] } | undefined;
    if (tf) tf.flags = names;
    world.services.flagIndex.forLevel(levelId).invalidateCell(cell);
  };
  return {
    id: opts.id,
    cell,
    ...(opts.access !== undefined ? { access: opts.access } : {}),
    isOpen: () => open,
    open(w) {
      if (open) return;
      open = true;
      // Open door: stops sealing (airflow + sight pass). Render as an open airlock.
      setGlyph(e, "'");
      void w;
      setFlags([]);
    },
    close(w) {
      if (!open) return;
      open = false;
      setGlyph(e, '+');
      void w;
      setFlags([FLAGS.airtight]);
    },
  };
}

/**
 * Spawn a crew actor at a cell: a breathing, oxygen-bearing entity that paces the
 * timeline and suffocates in vacuum (the `breather` mixin, registered separately
 * by `registerBreathing`). `max-hp` is authored content; `max-oxygen` reads from
 * config. The `breathing` state component seeds `last` to the current world clock
 * so the mixin's first dt is small. Mirrors `placeDoor`'s index/place pattern plus
 * `addActor`, matching the netcoop monster spawn.
 */
export function spawnCrew(
  world: World,
  levelId: string,
  cell: number,
  opts: { id: string; name?: string },
  config: Config,
): EntityId {
  const level = world.state.levels.get(levelId)!;
  const { x, y } = pointOf(cell, level.width);
  const now = world.services.timeline.worldClock;
  const e = createEntity(
    opts.id,
    [
      { type: 'position', x, y, levelId },
      { type: 'renderable', glyph: '@', fg: '#fff', layer: 5 },
      { type: 'info', name: opts.name ?? 'crew' },
      { type: 'allegiance', faction: 'crew' },
      { type: 'stats', base: { 'max-hp': 100, 'max-oxygen': config.oxygen.max } },
      { type: 'resources', pools: { hp: { current: 100 }, oxygen: { current: config.oxygen.max } } },
      { type: 'breathing', last: now, tankUntil: 0 },
    ],
    ['breather'],
  );
  world.state.entities.set(opts.id, e);
  world.services.queries.index(e);
  world.services.queries.place(opts.id, levelId, cell);
  world.services.timeline.addActor(opts.id, world.services.config.defaultSpeed);
  return opts.id;
}
