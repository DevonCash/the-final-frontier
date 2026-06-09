/**
 * corpse — death leaves a lootable body (game-design §4.3, §7).
 *
 * Death (any cause) fires the engine's core `died`, whose default reactor drops the
 * actor from the timeline but leaves the entity in place (engine bookkeeping; loot
 * is content). This module adds the content: a global `died` reactor converts the
 * body into a `corpse` in place — same entity, so it KEEPS its full inventory and
 * position — and re-skins it. Looting reuses the bump channel (R7), exactly like a
 * door or locker: bumping a corpse transfers its items to the bumper. This is how
 * IDs and the intel disk change hands violently (design §1, §4.3).
 */
import { z } from 'zod';
import {
  get,
  type World,
  type EntityId,
  type Effect,
  type GameEvent,
  type Action,
  type ActionHandler,
  type ActionContext,
  type BumpInteraction,
  type Reactor,
  type EventReactionCtx,
  type Component,
  type ComponentRegistry,
  type Registry,
} from '../../rlkit/src/index';
import { config } from './config';

export const CorpseSchema = z.object({ type: z.literal('corpse'), looted: z.boolean() });

interface Inventory {
  type: 'inventory';
  items: string[];
  [key: string]: unknown;
}
interface Renderable {
  type: 'renderable';
  glyph: string;
  fg: string;
  layer: number;
  [key: string]: unknown;
}
interface Info {
  type: 'info';
  name: string;
  [key: string]: unknown;
}

const LOOT_ACTION = 'corpse:loot';

/** Turn a just-died entity into a lootable corpse in place (keeps inventory + position). */
function makeCorpse(world: World, id: EntityId): void {
  const e = world.state.entities.get(id);
  if (!e || e.components.has('corpse')) return; // idempotent: don't re-corpse
  if (!e.components.has('position')) return; // unplaced/carried entities don't leave a body
  e.components.set('corpse', { type: 'corpse', looted: false } as Component);

  const sprite = config.render.corpse;
  const r = get<Renderable>(e, 'renderable');
  if (r) {
    r.glyph = sprite.glyph;
    r.fg = sprite.fg;
    r.layer = config.render.layers.corpse; // below the living and floor items
  }
  const info = get<Info>(e, 'info');
  if (info) info.name = `corpse of ${info.name}`;
}

/** An effect that transfers all of a corpse's items into the looter's inventory. */
function lootEffect(actorId: EntityId, corpseId: EntityId): Effect {
  return {
    kind: 'corpse:loot',
    validate(world) {
      const actor = world.state.entities.get(actorId);
      const corpse = world.state.entities.get(corpseId);
      if (!actor || !corpse || !corpse.components.has('corpse')) return false;
      return !!get<Inventory>(actor, 'inventory') && !!get<Inventory>(corpse, 'inventory');
    },
    apply(world) {
      const actorInv = get<Inventory>(world.state.entities.get(actorId)!, 'inventory')!;
      const corpse = world.state.entities.get(corpseId)!;
      const corpseInv = get<Inventory>(corpse, 'inventory')!;
      const taken = corpseInv.items.splice(0); // empty the body
      actorInv.items.push(...taken);
      const c = get<{ type: 'corpse'; looted: boolean }>(corpse, 'corpse');
      if (c) c.looted = true;
      return [{ type: 'corpse:looted', actor: actorId, corpse: corpseId, items: taken }];
    },
  };
}

/** Register the corpse component, the death→corpse reactor, and the loot bump rule. */
export function registerCorpses(world: World): void {
  (world.services.registries.components as ComponentRegistry).override('corpse', {
    type: 'corpse',
    schema: CorpseSchema,
  });

  // Death → corpse. Global post reactor (mirrors the engine's `diedReactor`): it
  // mutates the entity directly, sharing the reaction pass's context.
  const onDied: Reactor = {
    on: 'died',
    scope: 'global',
    phase: 'post',
    react(ctx) {
      const { event, world } = ctx as EventReactionCtx;
      const entity = (event as { entity?: string }).entity;
      if (typeof entity === 'string') makeCorpse(world, entity);
    },
  };
  world.services.reactors.register(onDied);

  // Bump a corpse → loot it (same channel as doors/lockers). Priority matches the
  // openable rule; a corpse is never also an openable, so they don't contend.
  const rule: BumpInteraction = {
    priority: 5,
    claim(ctx) {
      const target = ctx.world.state.entities.get(ctx.target);
      if (!target?.components.has('corpse')) return undefined;
      return { type: LOOT_ACTION, actor: ctx.actor, target: ctx.target } as Action;
    },
  };
  world.services.bumpInteractions.register(rule);

  const handler: ActionHandler = (ctx: ActionContext) => {
    const a = ctx.action as unknown as { actor: EntityId; target: EntityId };
    const corpse = ctx.world.state.entities.get(a.target);
    if (!corpse?.components.has('corpse')) return void ctx.reject('loot: not a corpse');
    ctx.cost = ctx.world.services.config.baseActionCost;
    ctx.push(lootEffect(a.actor, a.target));
  };
  (world.services.registries.handlers as Registry<ActionHandler>).register(LOOT_ACTION, handler);
}
