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
  type ComponentRegistry,
} from '../../rlkit/src/index';

export const ToolSchema = z.object({
  type: z.literal('tool'),
  kind: z.string(), // 'crowbar' | 'emag' | … (keys useOn dispatch)
  charges: z.number().int().optional(), // emag: limited uses
});
export type Tool = z.infer<typeof ToolSchema> & { [key: string]: unknown };

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

/** Register the item-related component schemas (tags + tool) for save validation. */
export function registerItems(world: World): void {
  const reg = world.services.registries.components as ComponentRegistry;
  reg.override('tags', { type: 'tags', schema: TaggedSchema });
  reg.override('tool', { type: 'tool', schema: ToolSchema });
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
  const components: Array<Record<string, unknown>> = [
    { type: 'item', name: spec.name, stackable: false, qty: 1 },
    { type: 'renderable', glyph: spec.glyph, fg: spec.fg ?? '#ddd', layer: 3 },
    { type: 'info', name: spec.name },
  ];
  if (spec.tags) components.push({ type: 'tags', tags: spec.tags });
  if (spec.tool) components.push({ type: 'tool', kind: spec.tool.kind, ...(spec.tool.charges !== undefined ? { charges: spec.tool.charges } : {}) });
  const e = createEntity(spec.id, components as never);
  world.state.entities.set(spec.id, e);
  world.services.queries.index(e); // indexes tags so byTag works; no `place` (carried)
  return spec.id;
}

// --- convenience factories --------------------------------------------------

export function spawnIdCard(world: World, id: string, access: string[], name = 'ID card'): EntityId {
  return spawnItem(world, { id, name, glyph: 'i', fg: '#fc6', tags: access.map((a) => `access:${a}`) });
}
export function spawnCrowbar(world: World, id: string): EntityId {
  return spawnItem(world, { id, name: 'crowbar', glyph: '/', fg: '#c44', tool: { kind: 'crowbar' } });
}
export function spawnEmag(world: World, id: string, charges: number): EntityId {
  return spawnItem(world, { id, name: 'cryptographic sequencer', glyph: '!', fg: '#f4f', tool: { kind: 'emag', charges } });
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

/** An effect that spends one charge of a tool (e.g. the emag), rejecting if empty. */
export function consumeChargeEffect(toolId: EntityId): Effect {
  return {
    kind: 'tool:charge',
    validate: (world) => ((get<Tool>(world.state.entities.get(toolId) ?? ({} as never), 'tool')?.charges ?? 0) > 0),
    apply: (world) => {
      const tool = get<Tool>(world.state.entities.get(toolId)!, 'tool');
      if (tool && tool.charges !== undefined) tool.charges -= 1;
      return [{ type: 'tool:used', tool: toolId, kind: tool?.kind, charges: tool?.charges }];
    },
  };
}
