/**
 * items — minimal carried items for Epic D: ID cards (access tags) and tools
 * (crowbar, emag). Full inventory/pickup/drop/corpse-loot is Epic F; here an item
 * is an entity with no position held in an actor's `inventory.items`, and the
 * access check reads the carried ID's tags (game-design §7).
 *
 * Access is modeled as engine tags `access:<area>` on the ID card; a tool carries
 * a `tool` component whose `kind` keys the `useOn` dispatch.
 */
import { z } from 'zod';
import {
  createEntity,
  get,
  type World,
  type ReadonlyWorld,
  type EntityId,
  type Effect,
  type Component,
  type ComponentRegistry,
  type ActionHandler,
  type ActionContext,
  type Registry,
} from '../../rlkit/src/index';
import { config } from './config';
import { activateTank } from './breathing';

export const ToolSchema = z.object({
  type: z.literal('tool'),
  kind: z.string(), // 'crowbar' | 'emag' | 'welder' | … (keys useOn / activate dispatch)
  charges: z.number().int().optional(), // emag / cable: limited uses
});
export type Tool = z.infer<typeof ToolSchema> & { [key: string]: unknown };

// The engine's inventory core registers the `pickup`/`drop` handlers and the
// `inventory`/`item` components; we declaration-merge their action shapes (plus the
// game's `activate`) so `perform` calls typecheck across the package boundary (R5).
declare module '../../rlkit/src/core/action' {
  interface ActionMap {
    pickup: { type: 'pickup'; actor: EntityId; item: EntityId };
    drop: { type: 'drop'; actor: EntityId; item: EntityId };
    activate: { type: 'activate'; actor: EntityId; item: EntityId };
  }
}

const TaggedSchema = z.object({ type: z.literal('tags'), tags: z.array(z.string()) });

interface Inventory {
  type: 'inventory';
  items: string[];
  [key: string]: unknown;
}
interface Tagged {
  type: 'tags';
  tags: string[];
  [key: string]: unknown;
}

// --- activate dispatch (self-used items, e.g. the O₂ tank) -------------------
// A tiny sibling to `useOn`: no target, no adjacency — just "use the held item on
// yourself". Keyed by tool kind so it stays a system, not a special-case.
export type ActivateRule = (ctx: ActionContext, args: { itemId: EntityId }) => void;
const ACTIVATE = new WeakMap<World, Map<string, ActivateRule>>();
function activateRulesFor(world: World): Map<string, ActivateRule> {
  let m = ACTIVATE.get(world);
  if (!m) ACTIVATE.set(world, (m = new Map()));
  return m;
}
export function registerActivateRule(world: World, kind: string, rule: ActivateRule): void {
  activateRulesFor(world).set(kind, rule);
}

/** Register the item component schemas, the `activate` handler, and the O₂-tank rule. */
export function registerItems(world: World): void {
  const reg = world.services.registries.components as ComponentRegistry;
  reg.override('tags', { type: 'tags', schema: TaggedSchema });
  reg.override('tool', { type: 'tool', schema: ToolSchema });

  const rules = activateRulesFor(world);
  const handler: ActionHandler = (ctx) => {
    const a = ctx.action as { actor: EntityId; item?: EntityId };
    if (!a.item || !carries(ctx.world, a.actor, a.item)) return void ctx.reject('activate: item not carried');
    const tool = get<Tool>(ctx.world.state.entities.get(a.item)!, 'tool');
    const rule = tool && rules.get(tool.kind);
    if (!rule) return void ctx.reject('activate: nothing to activate');
    rule(ctx, { itemId: a.item });
  };
  (world.services.registries.handlers as Registry<ActionHandler>).register('activate', handler);

  // O₂ tank: activating a carried tank pauses the holder's suffocation for
  // `tankDuration` (the EVA enabler, Epic A's `activateTank`). A free action.
  registerActivateRule(world, 'o2tank', (ctx, { itemId }) => {
    ctx.cost = 0;
    ctx.push(activateTankEffect(ctx.action.actor, itemId));
  });
}

/** An effect that activates an O₂ tank on its holder (pauses the oxygen drain). */
function activateTankEffect(actorId: EntityId, tankId: EntityId): Effect {
  return {
    kind: 'tank:activate',
    validate: (world) => carries(world, actorId, tankId),
    apply: (world) => {
      activateTank(world, actorId, config);
      return [{ type: 'tank:activated', actor: actorId, item: tankId }];
    },
  };
}

interface ItemSpec {
  id: string;
  name: string;
  glyph: string;
  fg?: string;
  tags?: string[];
  tool?: { kind: string; charges?: number };
}

/** Create a carried item entity (no position; lives in an inventory). */
export function spawnItem(world: World, spec: ItemSpec): EntityId {
  const components: Component[] = [
    { type: 'item', name: spec.name, stackable: false, qty: 1 },
    { type: 'renderable', glyph: spec.glyph, fg: spec.fg ?? config.render.items.default.fg, layer: config.render.layers.item },
    { type: 'info', name: spec.name },
  ];
  if (spec.tags) components.push({ type: 'tags', tags: spec.tags });
  if (spec.tool) components.push({ type: 'tool', kind: spec.tool.kind, ...(spec.tool.charges !== undefined ? { charges: spec.tool.charges } : {}) });
  const e = createEntity(spec.id, components);
  world.state.entities.set(spec.id, e);
  world.services.queries.index(e); // indexes tags so byTag works; no `place` (carried)
  return spec.id;
}

// --- convenience factories --------------------------------------------------

export function spawnIdCard(world: World, id: string, access: string[], name = 'ID card'): EntityId {
  const g = config.render.items.id;
  return spawnItem(world, { id, name, glyph: g.glyph, fg: g.fg, tags: access.map((a) => `access:${a}`) });
}
export function spawnCrowbar(world: World, id: string): EntityId {
  const g = config.render.items.crowbar;
  return spawnItem(world, { id, name: 'crowbar', glyph: g.glyph, fg: g.fg, tool: { kind: 'crowbar' } });
}
export function spawnEmag(world: World, id: string, charges: number): EntityId {
  const g = config.render.items.emag;
  return spawnItem(world, { id, name: 'cryptographic sequencer', glyph: g.glyph, fg: g.fg, tool: { kind: 'emag', charges } });
}
export function spawnWelder(world: World, id: string): EntityId {
  const g = config.render.items.welder;
  return spawnItem(world, { id, name: 'welding tool', glyph: g.glyph, fg: g.fg, tool: { kind: 'welder' } });
}
export function spawnWrench(world: World, id: string): EntityId {
  const g = config.render.items.wrench;
  return spawnItem(world, { id, name: 'wrench', glyph: g.glyph, fg: g.fg, tool: { kind: 'wrench' } });
}
export function spawnWirecutters(world: World, id: string): EntityId {
  const g = config.render.items.wirecutters;
  return spawnItem(world, { id, name: 'wirecutters', glyph: g.glyph, fg: g.fg, tool: { kind: 'wirecutters' } });
}
export function spawnCable(world: World, id: string, charges = config.cableLength): EntityId {
  const g = config.render.items.cable;
  return spawnItem(world, { id, name: 'cable coil', glyph: g.glyph, fg: g.fg, tool: { kind: 'cable', charges } });
}
export function spawnKnife(world: World, id: string): EntityId {
  const g = config.render.items.knife;
  return spawnItem(world, { id, name: 'combat knife', glyph: g.glyph, fg: g.fg, tool: { kind: 'knife' } });
}
export function spawnO2Tank(world: World, id: string): EntityId {
  const g = config.render.items.o2tank;
  return spawnItem(world, { id, name: 'O₂ tank', glyph: g.glyph, fg: g.fg, tool: { kind: 'o2tank' } });
}
export function spawnIntelDisk(world: World, id: string): EntityId {
  const g = config.render.items.disk;
  return spawnItem(world, { id, name: 'intel disk', glyph: g.glyph, fg: g.fg, tags: ['objective:disk'] });
}

// --- inventory / access reads (hand-rolled; full inventory is Epic F) --------

function inventoryOf(world: ReadonlyWorld, actorId: EntityId): string[] {
  const e = world.state.entities.get(actorId);
  return (e && get<Inventory>(e, 'inventory')?.items) ?? [];
}

/** Put an item into an actor's inventory (creates the component if absent). */
export function giveItem(world: World, actorId: EntityId, itemId: EntityId): void {
  const e = world.state.entities.get(actorId);
  if (!e) return;
  const inv = get<Inventory>(e, 'inventory');
  if (inv) inv.items.push(itemId);
  else e.components.set('inventory', { type: 'inventory', items: [itemId] });
}

/** True if the actor is currently carrying `itemId` (authoritative ownership check). */
export function carries(world: ReadonlyWorld, actorId: EntityId, itemId: EntityId): boolean {
  return inventoryOf(world, actorId).includes(itemId);
}

/** True if the actor carries an ID granting `access` (tag `access:<access>`). */
export function hasAccess(world: ReadonlyWorld, actorId: EntityId, access: string): boolean {
  const want = `access:${access}`;
  for (const itemId of inventoryOf(world, actorId)) {
    const item = world.state.entities.get(itemId);
    if (item && get<Tagged>(item, 'tags')?.tags.includes(want)) return true;
  }
  return false;
}

/** The carried tool of a given kind, if any (for resolving a `useOn` item). */
export function findTool(world: ReadonlyWorld, actorId: EntityId, kind: string): EntityId | undefined {
  for (const itemId of inventoryOf(world, actorId)) {
    const item = world.state.entities.get(itemId);
    if (item && get<Tool>(item, 'tool')?.kind === kind) return itemId;
  }
  return undefined;
}

/** Read a tool component off an entity id, if present. */
function toolOf(world: ReadonlyWorld, toolId: EntityId): Tool | undefined {
  const e = world.state.entities.get(toolId);
  return e && get<Tool>(e, 'tool');
}

/** An effect that spends one charge of a tool (e.g. the emag), rejecting if empty. */
export function consumeChargeEffect(toolId: EntityId): Effect {
  return {
    kind: 'tool:charge',
    validate: (world) => (toolOf(world, toolId)?.charges ?? 0) > 0,
    apply: (world) => {
      const tool = toolOf(world, toolId);
      if (tool && tool.charges !== undefined) tool.charges -= 1;
      return [{ type: 'tool:used', tool: toolId, kind: tool?.kind, charges: tool?.charges }];
    },
  };
}
