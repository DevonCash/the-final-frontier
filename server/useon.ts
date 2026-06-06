/**
 * useon — the one context-sensitive interaction verb (game-design §7, R5): use the
 * held tool on an adjacent target. A game-registered `useOn` action + a dispatch
 * registry keyed by tool kind keep the tool economy open: Epic D wires crowbar
 * (pry an unpowered door / locker) and emag (break any openable); Epic F adds
 * welder / wrench / wirecutters / cable / knife by registering more rules.
 *
 * The action is declaration-merged into rlkit's `ActionMap` (R5) so it typechecks
 * across the package boundary with no engine patch. Targets are a discriminated
 * `{kind:'entity'|'cell'}` (both ids and cells are numbers, so they're tagged).
 */
import {
  get,
  cellOf,
  type World,
  type EntityId,
  type Cell,
  type ActionHandler,
  type ActionContext,
  type Registry,
} from '../../rlkit/src/index';
import { openableEffect, breakOpenEffect, type Openable } from './openable';
import { consumeChargeEffect, type Tool } from './items';

export type UseOnTarget = { kind: 'entity'; id: EntityId } | { kind: 'cell'; cell: Cell };

declare module '../../rlkit/src/core/action' {
  interface ActionMap {
    useOn: { type: 'useOn'; actor: EntityId; item?: EntityId; target: UseOnTarget };
  }
}

/** A tool's behavior on a resolved target. Push effects, or reject with a reason. */
export type UseOnRule = (ctx: ActionContext, args: { toolId: EntityId; targetId: EntityId }) => void;

const RULES = new Map<string, UseOnRule>();

/** Register a tool's `useOn` behavior (keyed by the tool's `kind`). */
export function registerUseOnRule(kind: string, rule: UseOnRule): void {
  RULES.set(kind, rule);
}

/** Resolve the entity a target points at (an explicit entity, or one at a cell). */
function targetEntity(world: World, actorId: EntityId, target: UseOnTarget): EntityId | undefined {
  if (target.kind === 'entity') return target.id;
  const actor = world.state.entities.get(actorId);
  const pos = actor && (actor.components.get('position') as { levelId: string } | undefined);
  if (!pos) return undefined;
  for (const id of world.services.queries.at(target.cell, pos.levelId)) {
    if (world.state.entities.get(id)?.components.has('openable')) return id;
  }
  return undefined;
}

/** Register the `useOn` handler + the Epic-D tool rules (crowbar, emag). */
export function registerUseOn(world: World): void {
  const handler: ActionHandler = (ctx) => {
    const a = ctx.action as { actor: EntityId; item?: EntityId; target: UseOnTarget };
    const toolId = a.item;
    const tool = toolId && get<Tool>(ctx.world.state.entities.get(toolId) ?? ({} as never), 'tool');
    if (!toolId || !tool) return void ctx.reject('useOn: no tool');
    const rule = RULES.get(tool.kind);
    if (!rule) return void ctx.reject(`useOn: tool '${tool.kind}' does nothing here`);
    const targetId = targetEntity(ctx.world as World, a.actor, a.target);
    if (!targetId) return void ctx.reject('useOn: no target');
    rule(ctx, { toolId, targetId });
  };
  (world.services.registries.handlers as Registry<ActionHandler>).register('useOn', handler);

  // crowbar: pry an unpowered door or any locker (no access check — power loss
  // degrades access, which is the point). A powered door resists the bar.
  registerUseOnRule('crowbar', (ctx, { targetId }) => {
    const o = get<Openable>(ctx.world.state.entities.get(targetId)!, 'openable');
    if (!o || o.open) return void ctx.reject('crowbar: nothing to pry');
    if (o.kind === 'door' && o.powered) return void ctx.reject('crowbar: door is powered — cut the wire first');
    ctx.cost = ctx.world.services.config.baseActionCost;
    ctx.push(openableEffect(targetId, true));
  });

  // emag: force ANY openable — breaks it permanently open. Consumes a charge.
  registerUseOnRule('emag', (ctx, { toolId, targetId }) => {
    const tool = get<Tool>(ctx.world.state.entities.get(toolId)!, 'tool');
    if (!tool || (tool.charges ?? 0) <= 0) return void ctx.reject('emag: out of charges');
    ctx.cost = ctx.world.services.config.baseActionCost;
    ctx.push(consumeChargeEffect(toolId));
    ctx.push(breakOpenEffect(targetId));
  });

  void world;
}
