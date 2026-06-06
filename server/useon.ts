/**
 * useon — the one context-sensitive interaction verb (game-design §7, R5): use the
 * held tool on an adjacent target. A game-registered `useOn` action + a per-world
 * dispatch registry keyed by tool kind keep the tool economy open: Epic D wires
 * crowbar (pry an unpowered door / locker) and emag (break any openable); Epic F
 * adds welder / wrench / wirecutters / cable / knife with `registerUseOnRule`.
 *
 * The action is declaration-merged into rlkit's `ActionMap` (R5) so it typechecks
 * across the package boundary with no engine patch. Targets are a discriminated
 * `{kind:'entity'|'cell'}` (both ids and cells are numbers, so they're tagged).
 *
 * AUTHORITATIVE: the handler trusts nothing from the client — it verifies the actor
 * actually CARRIES the named tool and the target is ADJACENT before dispatching.
 */
import {
  get,
  type World,
  type EntityId,
  type Cell,
  type Position,
  type ActionHandler,
  type ActionContext,
  type Registry,
} from '../../rlkit/src/index';
import { openableEffect, breakOpenEffect, type Openable } from './openable';
import { consumeChargeEffect, carries, type Tool } from './items';

export type UseOnTarget = { kind: 'entity'; id: EntityId } | { kind: 'cell'; cell: Cell };

declare module '../../rlkit/src/core/action' {
  interface ActionMap {
    useOn: { type: 'useOn'; actor: EntityId; item?: EntityId; target: UseOnTarget };
  }
}

/** A tool's behavior on a resolved target. Push effects, or reject with a reason. */
export type UseOnRule = (ctx: ActionContext, args: { toolId: EntityId; targetId: EntityId }) => void;

// Per-world dispatch tables — no cross-world shared state (proofs build many worlds).
const RULES = new WeakMap<World, Map<string, UseOnRule>>();
function rulesFor(world: World): Map<string, UseOnRule> {
  let m = RULES.get(world);
  if (!m) RULES.set(world, (m = new Map()));
  return m;
}

/** Register a tool's `useOn` behavior on a world (keyed by the tool's `kind`). */
export function registerUseOnRule(world: World, kind: string, rule: UseOnRule): void {
  rulesFor(world).set(kind, rule);
}

/** Resolve the entity a target points at (an explicit entity, or one at a cell). */
function targetEntity(world: World, actorId: EntityId, target: UseOnTarget): EntityId | undefined {
  if (target.kind === 'entity') return target.id;
  const actor = world.state.entities.get(actorId);
  const pos = actor && get<Position>(actor, 'position');
  if (!pos) return undefined;
  for (const id of world.services.queries.at(target.cell, pos.levelId)) {
    if (world.state.entities.get(id)?.components.has('openable')) return id;
  }
  return undefined;
}

/** Two cells are adjacent (8-neighbour) and distinct. */
function adjacent(a: Position, b: Position): boolean {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return a.levelId === b.levelId && dx <= 1 && dy <= 1 && dx + dy > 0;
}

/** Register the `useOn` handler + the Epic-D tool rules (crowbar, emag). */
export function registerUseOn(world: World): void {
  const rules = rulesFor(world);

  const handler: ActionHandler = (ctx) => {
    const a = ctx.action as { actor: EntityId; item?: EntityId; target: UseOnTarget };
    const actor = ctx.world.state.entities.get(a.actor);
    const apos = actor && get<Position>(actor, 'position');
    if (!apos) return void ctx.reject('useOn: no actor');

    // Ownership: the actor must actually carry the named tool (anti-cheat).
    const toolId = a.item;
    if (!toolId || !carries(ctx.world, a.actor, toolId)) return void ctx.reject('useOn: tool not carried');
    const tool = get<Tool>(ctx.world.state.entities.get(toolId)!, 'tool');
    if (!tool) return void ctx.reject('useOn: not a tool');
    const rule = rules.get(tool.kind);
    if (!rule) return void ctx.reject(`useOn: tool '${tool.kind}' does nothing here`);

    // Adjacency: the target must be a real entity next to the actor (anti-cheat).
    const targetId = targetEntity(ctx.world as World, a.actor, a.target);
    const tpos = targetId && get<Position>(ctx.world.state.entities.get(targetId)!, 'position');
    if (!targetId || !tpos) return void ctx.reject('useOn: no target');
    if (!adjacent(apos, tpos)) return void ctx.reject('useOn: target not adjacent');

    rule(ctx, { toolId, targetId });
  };
  (world.services.registries.handlers as Registry<ActionHandler>).register('useOn', handler);

  // crowbar: pry an unpowered door or any locker (no access check — power loss
  // degrades access, which is the point). A powered door resists the bar.
  registerUseOnRule(world, 'crowbar', (ctx, { targetId }) => {
    const o = get<Openable>(ctx.world.state.entities.get(targetId)!, 'openable');
    if (!o || o.open) return void ctx.reject('crowbar: nothing to pry');
    if (o.kind === 'door' && o.powered) return void ctx.reject('crowbar: door is powered — cut the wire first');
    ctx.cost = ctx.world.services.config.baseActionCost;
    ctx.push(openableEffect(targetId, true));
  });

  // emag: force ANY openable — breaks it permanently open. Consumes a charge.
  registerUseOnRule(world, 'emag', (ctx, { toolId, targetId }) => {
    const tool = get<Tool>(ctx.world.state.entities.get(toolId)!, 'tool');
    if (!tool || (tool.charges ?? 0) <= 0) return void ctx.reject('emag: out of charges');
    ctx.cost = ctx.world.services.config.baseActionCost;
    ctx.push(consumeChargeEffect(toolId));
    ctx.push(breakOpenEffect(targetId));
  });
}
