/**
 * useon — the one context-sensitive interaction verb (game-design §7, R5): use the
 * held tool on an adjacent target. A game-registered `useOn` action + per-world
 * dispatch registries keep the tool economy open:
 *
 *   - ENTITY-target tools key off the target entity (crowbar pries a door/locker,
 *     emag breaks any openable) — Epic D.
 *   - CELL-target tools key off a tile/cell (wrench smashes a window, welder
 *     reseals a breach, wirecutters cut a wire, cable re-lays it) — Epic F.
 *
 * The action is declaration-merged into rlkit's `ActionMap` (R5) so it typechecks
 * across the package boundary with no engine patch. Targets are a discriminated
 * `{kind:'entity'|'cell'}`; the handler routes to the matching rule.
 *
 * AUTHORITATIVE: the handler trusts nothing from the client — it verifies the actor
 * actually CARRIES the named tool and the target is ADJACENT before dispatching.
 */
import {
  get,
  pointOf,
  ensureU8Layer,
  type World,
  type EntityId,
  type Cell,
  type Position,
  type Effect,
  type ActionHandler,
  type ActionContext,
  type Registry,
} from '../../rlkit/src/index';
import { openableEffect, breakOpenEffect, type Openable } from './openable';
import { consumeChargeEffect, carries, type Tool } from './items';
import { smashWindowEffect, repairBreachEffect } from './breach';
import { setWire } from './power';
import { LEVEL_ID } from './station';

export type UseOnTarget = { kind: 'entity'; id: EntityId } | { kind: 'cell'; cell: Cell };

declare module '../../rlkit/src/core/action' {
  interface ActionMap {
    useOn: { type: 'useOn'; actor: EntityId; item?: EntityId; target: UseOnTarget };
  }
}

/** An entity-target tool's behavior on a resolved target entity. */
export type UseOnRule = (ctx: ActionContext, args: { toolId: EntityId; targetId: EntityId }) => void;
/** A cell-target tool's behavior on a resolved cell. */
export type UseOnCellRule = (ctx: ActionContext, args: { toolId: EntityId; levelId: string; cell: Cell }) => void;

// Per-world dispatch tables — no cross-world shared state (proofs build many worlds).
const ENTITY_RULES = new WeakMap<World, Map<string, UseOnRule>>();
const CELL_RULES = new WeakMap<World, Map<string, UseOnCellRule>>();
function entityRulesFor(world: World): Map<string, UseOnRule> {
  let m = ENTITY_RULES.get(world);
  if (!m) ENTITY_RULES.set(world, (m = new Map()));
  return m;
}
function cellRulesFor(world: World): Map<string, UseOnCellRule> {
  let m = CELL_RULES.get(world);
  if (!m) CELL_RULES.set(world, (m = new Map()));
  return m;
}

/** Register an entity-target tool behavior on a world (keyed by the tool's `kind`). */
export function registerUseOnRule(world: World, kind: string, rule: UseOnRule): void {
  entityRulesFor(world).set(kind, rule);
}
/** Register a cell-target tool behavior on a world (keyed by the tool's `kind`). */
export function registerUseOnCellRule(world: World, kind: string, rule: UseOnCellRule): void {
  cellRulesFor(world).set(kind, rule);
}

/** Resolve the entity a target points at (an explicit entity, or an openable at a cell). */
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

/** Register the `useOn` handler + every tool rule (Epic D entity tools, Epic F cell tools). */
export function registerUseOn(world: World): void {
  const entityRules = entityRulesFor(world);
  const cellRules = cellRulesFor(world);

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

    const entityRule = entityRules.get(tool.kind);
    const cellRule = cellRules.get(tool.kind);
    if (!entityRule && !cellRule) return void ctx.reject(`useOn: tool '${tool.kind}' does nothing here`);

    // CELL-target tool on a cell: adjacency is to the cell itself.
    if (a.target.kind === 'cell' && cellRule) {
      const cell = a.target.cell;
      const level = ctx.world.state.levels.get(apos.levelId);
      if (!level || cell < 0 || cell >= level.width * level.height) return void ctx.reject('useOn: bad cell');
      const cpos: Position = { type: 'position', ...pointOf(cell, level.width), levelId: apos.levelId };
      if (!adjacent(apos, cpos)) return void ctx.reject('useOn: target not adjacent');
      return cellRule(ctx, { toolId, levelId: apos.levelId, cell });
    }

    // ENTITY-target tool (or an entity resolved at a bumped cell): adjacency to its position.
    if (!entityRule) return void ctx.reject(`useOn: tool '${tool.kind}' needs a cell target`);
    const targetId = targetEntity(ctx.world as World, a.actor, a.target);
    const tpos = targetId && get<Position>(ctx.world.state.entities.get(targetId)!, 'position');
    if (!targetId || !tpos) return void ctx.reject('useOn: no target');
    if (!adjacent(apos, tpos)) return void ctx.reject('useOn: target not adjacent');
    entityRule(ctx, { toolId, targetId });
  };
  (world.services.registries.handlers as Registry<ActionHandler>).register('useOn', handler);

  // --- Epic D entity tools --------------------------------------------------

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

  // --- Epic F cell tools ----------------------------------------------------

  // wrench: smash a window over `windowHits` blows (the breach). Rejects on a
  // non-window cell via the effect's validate.
  registerUseOnCellRule(world, 'wrench', (ctx, { levelId, cell }) => {
    ctx.cost = ctx.world.services.config.baseActionCost;
    ctx.push(smashWindowEffect(levelId, cell));
  });

  // welder: reseal a tracked breach over `repairUses` passes (restores the tile).
  registerUseOnCellRule(world, 'welder', (ctx, { levelId, cell }) => {
    ctx.cost = ctx.world.services.config.baseActionCost;
    ctx.push(repairBreachEffect(levelId, cell));
  });

  // wirecutters: cut the wire at a cell — downstream consumers lose power (Epic E).
  registerUseOnCellRule(world, 'wirecutters', (ctx, { cell }) => {
    ctx.cost = ctx.world.services.config.baseActionCost;
    ctx.push(setWireEffect(cell, false));
  });

  // cable: re-lay wire at a cut cell — downstream restored. Spends one length.
  registerUseOnCellRule(world, 'cable', (ctx, { toolId, cell }) => {
    const tool = get<Tool>(ctx.world.state.entities.get(toolId)!, 'tool');
    if (!tool || (tool.charges ?? 0) <= 0) return void ctx.reject('cable: spent');
    ctx.cost = ctx.world.services.config.baseActionCost;
    ctx.push(consumeChargeEffect(toolId));
    ctx.push(setWireEffect(cell, true));
  });
}

/**
 * An effect that cuts (`on=false`) or re-lays (`on=true`) the power wire at a cell,
 * driving Epic E's `setWire` (which marks the network dirty + re-syncs consumers).
 * Rejects a no-op (cutting an empty cell / relaying a live one) via `validate`.
 */
function setWireEffect(cell: Cell, on: boolean): Effect {
  return {
    kind: on ? 'wire:relay' : 'wire:cut',
    validate: (world) => {
      const level = world.state.levels.get(LEVEL_ID);
      if (!level) return false;
      const live = ensureU8Layer(level, 'wire')[cell] !== 0;
      return on ? !live : live;
    },
    apply: (world) => {
      setWire(world, cell, on);
      return [{ type: on ? 'wire:relayed' : 'wire:cut', levelId: LEVEL_ID, cell }];
    },
  };
}
