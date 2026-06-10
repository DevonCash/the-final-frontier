/**
 * openable — doors and lockers as one system: an `openable` entity + an `on:bump`
 * rule (game-design §7, R7). Bumping a closed openable tries to open it: allowed
 * iff access passes AND it's powered AND unbolted (and not a locker-only check);
 * otherwise the bump is free and emits `access:denied`. Tools (crowbar, emag) take
 * the other routes through `useOn` (see `useon.ts`).
 *
 * Doors additionally gate airflow + sight: a CLOSED door contributes the `airtight`
 * flag and blocks movement; an OPEN door drops both (a `walkover` marker makes the
 * cell passable, and the flag clears) — toggled via `tileFlags`/`walkover` +
 * `invalidateCell`, so the atmos stepper and the mover both see it next step.
 *
 * `placeDoor` keeps a tiny closure API (`open`/`close`/`isOpen`) the atmos/breathing
 * fixture proofs drive directly; the bump/useOn paths go through `openableEffect`.
 */
import { z } from 'zod';
import {
  createEntity,
  get,
  set,
  remove,
  pointOf,
  cellOf,
  neighbors4,
  BLOCK,
  type World,
  type EntityId,
  type Entity,
  type Effect,
  type GameEvent,
  type Action,
  type ActionHandler,
  type ActionContext,
  type BumpInteraction,
  type Component,
  type ComponentRegistry,
  type Registry,
} from '../../rlkit/src/index';
import { FLAGS, TILES } from './content';
import { hasAccess } from './items';
import { config } from './config';

export const OpenableSchema = z.object({
  type: z.literal('openable'),
  kind: z.enum(['door', 'locker']),
  open: z.boolean(),
  access: z.string().nullable(), // required access tag suffix, e.g. 'bridge'; null = unlocked
  powered: z.boolean(),
  bolted: z.boolean(),
  broken: z.boolean(), // emag'd: forced open, access system destroyed
});
export type Openable = z.infer<typeof OpenableSchema> & { [key: string]: unknown };

/** Open/closed glyph pair per openable kind (config-vs-logic pillar). */
const glyphFor = (kind: 'door' | 'locker', open: boolean): string =>
  config.render.openable[kind][open ? 'open' : 'closed'];

function setGlyph(e: Entity, glyph: string): void {
  const r = e.components.get('renderable') as { type: 'renderable'; glyph: string } | undefined;
  if (r) r.glyph = glyph;
}

/**
 * Low-level open/close mutation shared by the closure API and `openableEffect`:
 * flips `open`, and for a door toggles the airtight flag + the `walkover` passable
 * marker and invalidates the cell. Returns the events; mutates in place.
 */
export function setOpen(world: World, id: EntityId, open: boolean): GameEvent[] {
  const e = world.state.entities.get(id);
  const o = e && get<Openable>(e, 'openable');
  if (!e || !o || o.open === open) return [];
  o.open = open;
  const pos = e.components.get('position') as { x: number; y: number; levelId: string } | undefined;
  setGlyph(e, glyphFor(o.kind, open));
  const events: GameEvent[] = [{ type: open ? 'openable:opened' : 'openable:closed', entity: id, kind: o.kind }];

  if (o.kind === 'door' && pos) {
    const tf = e.components.get('tileFlags') as { type: 'tileFlags'; flags: string[] } | undefined;
    if (tf) tf.flags = open ? [] : [FLAGS.airtight];
    // Toggle the `walkover` passable marker around a reindex so the component
    // index (not just the live `has` read in the mover) stays correct.
    world.services.queries.unindex(e);
    if (open) set(e, { type: 'walkover' }); // open door: passable cell
    else remove(e, 'walkover');
    world.services.queries.index(e);
    const level = world.state.levels.get(pos.levelId);
    if (level) world.services.flagIndex.forLevel(pos.levelId).invalidateCell(cellOf({ x: pos.x, y: pos.y }, level.width));
  }

  // A locker that opens dumps its contents onto the floor (a container, not a
  // bespoke "give to opener" rule): the disk becomes a floor item the opener picks
  // up with the Epic-F `pickup`. The closed locker blocks its own cell, so spill
  // to a free neighbour. Doors never carry an inventory, so they skip this.
  if (o.kind === 'locker' && open && pos) events.push(...spillInventory(world, e, pos.levelId));

  return events;
}

/** Move every item out of a container entity onto free floor cells near it. */
function spillInventory(world: World, container: Entity, levelId: string): GameEvent[] {
  const inv = container.components.get('inventory') as { type: 'inventory'; items: string[] } | undefined;
  if (!inv || inv.items.length === 0) return [];
  const level = world.state.levels.get(levelId);
  const cpos = container.components.get('position') as { x: number; y: number } | undefined;
  if (!level || !cpos) return [];
  const origin = cellOf({ x: cpos.x, y: cpos.y }, level.width);

  const events: GameEvent[] = [];
  const spilled = inv.items.splice(0); // empty the container
  for (const itemId of spilled) {
    const item = world.state.entities.get(itemId);
    if (!item) continue;
    const dest = freeFloorNear(world, levelId, origin);
    const { x, y } = pointOf(dest, level.width);
    set(item, { type: 'position', x, y, levelId });
    world.services.queries.onComponentAdded(item, 'position');
    world.services.queries.place(itemId, levelId, dest);
    events.push({ type: 'container:spilled', container: container.id, item: itemId, cell: dest });
  }
  return events;
}

/** A floor cell near `origin` with no blocking occupant; falls back to a row scan. */
function freeFloorNear(world: World, levelId: string, origin: number): number {
  const level = world.state.levels.get(levelId)!;
  const floorIdx = world.services.tiles.index(TILES.floor);
  const tiles = level.layers.get('tiles') as Uint16Array;
  const free = (c: number): boolean => {
    if (tiles[c] !== floorIdx) return false;
    for (const occ of world.services.queries.at(c, levelId)) {
      const oe = world.state.entities.get(occ);
      if (oe?.components.has('openable') || oe?.components.has('resources')) return false; // door/locker/actor
    }
    return true;
  };
  for (const nb of neighbors4(origin, level.width, level.height)) if (free(nb)) return nb;
  for (let c = 0; c < tiles.length; c++) if (free(c)) return c; // fallback: never lose the disk
  return origin; // pathological: pile on the container's own cell
}

/** An effect that opens/closes an openable through the action pipeline. */
export function openableEffect(id: string, open: boolean): Effect {
  return {
    kind: `openable:${open ? 'open' : 'close'}`,
    validate: (world) => !!world.state.entities.get(id)?.components.has('openable'),
    apply: (world) => setOpen(world, id, open),
  };
}

/** Force an emag'd openable: broken (access destroyed) and forced open. */
export function breakOpen(world: World, id: EntityId): GameEvent[] {
  const e = world.state.entities.get(id);
  const o = e && get<Openable>(e, 'openable');
  if (!e || !o) return [];
  o.broken = true;
  return [{ type: 'openable:broken', entity: id }, ...setOpen(world, id, true)];
}

/** Bolt/unbolt an openable (the shuttle-airlock lock; bolted denies the bump). */
export function setBolted(world: World, id: EntityId, bolted: boolean): GameEvent[] {
  const e = world.state.entities.get(id);
  const o = e && get<Openable>(e, 'openable');
  if (!e || !o || o.bolted === bolted) return [];
  o.bolted = bolted;
  return [{ type: bolted ? 'openable:bolted' : 'openable:unbolted', entity: id }];
}

/** An effect that emags an openable through the action pipeline. */
export function breakOpenEffect(id: string): Effect {
  return {
    kind: 'openable:break',
    validate: (world) => !!world.state.entities.get(id)?.components.has('openable'),
    apply: (world) => breakOpen(world, id),
  };
}

// --- entities ---------------------------------------------------------------

export interface Door {
  readonly id: EntityId;
  readonly cell: number;
  readonly access: string | null;
  open(world: World): void;
  close(world: World): void;
  isOpen(): boolean;
}

interface PlaceOpts {
  id: string;
  access?: string;
  powered?: boolean;
  bolted?: boolean;
}

function placeOpenable(world: World, levelId: string, cell: number, kind: 'door' | 'locker', opts: PlaceOpts): Entity {
  const level = world.state.levels.get(levelId)!;
  const { x, y } = pointOf(cell, level.width);
  const components: Component[] = [
    { type: 'position', x, y, levelId },
    { type: 'renderable', glyph: glyphFor(kind, false), fg: config.render.openable[kind].fg, layer: config.render.layers.openable },
    { type: 'info', name: kind === 'door' ? 'airlock' : 'locker' },
    {
      type: 'openable',
      kind,
      open: false,
      access: opts.access ?? null,
      powered: opts.powered ?? true,
      bolted: opts.bolted ?? false,
      broken: false,
    },
  ];
  if (kind === 'door') components.push({ type: 'tileFlags', flags: [FLAGS.airtight] }); // closed door seals
  const e = createEntity(opts.id, components);
  world.state.entities.set(opts.id, e);
  world.services.queries.index(e);
  world.services.queries.place(opts.id, levelId, cell);
  return e;
}

/** Place a door entity (airtight + sight-blocking when closed). */
export function placeDoor(world: World, levelId: string, cell: number, opts: PlaceOpts): Door {
  placeOpenable(world, levelId, cell, 'door', opts);
  return {
    id: opts.id,
    cell,
    access: opts.access ?? null,
    isOpen: () => !!get<Openable>(world.state.entities.get(opts.id)!, 'openable')?.open,
    open: (w) => void setOpen(w, opts.id, true),
    close: (w) => void setOpen(w, opts.id, false),
  };
}

/** Place a locker entity (access-checked open; pryable/emag'able). */
export function placeLocker(world: World, levelId: string, cell: number, opts: PlaceOpts): EntityId {
  placeOpenable(world, levelId, cell, 'locker', opts);
  return opts.id;
}

// --- the on:bump rule -------------------------------------------------------

const BUMP_ACTION = 'openable:bump';

/** Register the openable component schema, the bump rule, and its action handler. */
export function registerOpenable(world: World): void {
  (world.services.registries.components as ComponentRegistry).override('openable', {
    type: 'openable',
    schema: OpenableSchema,
  });
  // `walkover` is a marker (open doors are passable); declare it for save validation.
  (world.services.registries.components as ComponentRegistry).override('walkover', {
    type: 'walkover',
    schema: z.object({ type: z.literal('walkover') }),
  });

  // Bump into an openable → try to open it (priority above the absent attack rule).
  const rule: BumpInteraction = {
    priority: config.openableBumpPriority,
    claim(ctx) {
      const target = ctx.world.state.entities.get(ctx.target);
      if (!target?.components.has('openable')) return undefined;
      return { type: BUMP_ACTION, actor: ctx.actor, target: ctx.target } as Action;
    },
  };
  world.services.bumpInteractions.register(rule);

  const handler: ActionHandler = (ctx) => openOnBump(ctx);
  (world.services.registries.handlers as Registry<ActionHandler>).register(BUMP_ACTION, handler);
  void BLOCK; // (claim never returns BLOCK; a person-bump simply finds no rule → blocked)
}

/** Resolve a bump into an openable: open if access+power+unbolted, else free deny. */
function openOnBump(ctx: ActionContext): void {
  const action = ctx.action as unknown as { target: EntityId };
  const e = ctx.world.state.entities.get(action.target);
  const o = e && get<Openable>(e, 'openable');
  const pos = e && (e.components.get('position') as { x: number; y: number; levelId: string } | undefined);
  if (!o || !pos) return void ctx.reject('bump: not openable');

  const level = ctx.world.state.levels.get(pos.levelId);
  const cell = level ? cellOf({ x: pos.x, y: pos.y }, level.width) : 0;
  const deny = (reason: string) => {
    ctx.cost = 0; // a denied bump costs nothing
    ctx.push(announce({ type: 'access:denied', actor: ctx.action.actor, target: action.target, cell, reason }));
  };

  if (o.open) {
    ctx.cost = 0; // bumping an already-open openable is a free no-op (doors are passable anyway)
    return;
  }
  if (o.broken) {
    ctx.push(openableEffect(action.target, true));
    return;
  }
  if (o.bolted) return deny('bolted');
  if (!o.powered) return deny('unpowered'); // pry it open with a crowbar instead
  if (o.access !== null && !hasAccess(ctx.world, ctx.action.actor, o.access)) return deny('access');

  ctx.push(openableEffect(action.target, true));
}

/** A trivial effect that only emits an event (the denied beep, perception in Epic I). */
function announce(event: GameEvent): Effect {
  return { kind: 'announce', validate: () => true, apply: () => [event] };
}
