/**
 * items-proof — carried items in isolation (Epic D items.ts). Run: `npm run proof:items`.
 *
 * interaction-proof exercises items only incidentally (as door keys/tools); this
 * proves items.ts directly:
 *   - spawnItem builds a carried entity whose renderable reads from config
 *     (glyph + fallback color + item layer) — the config-vs-logic pillar
 *   - giveItem / carries: ownership is authoritative (false until given)
 *   - hasAccess reads the carried ID's `access:<area>` tags, and ONLY when carried
 *   - findTool resolves a carried tool by kind (and only when carried)
 *   - consumeChargeEffect spends one charge and refuses when empty
 *
 * Built on the two-room fixture (registers item component schemas). Assertions are
 * plain; the script exits non-zero on first failure.
 */
import { get, type Entity } from '../../rlkit/src/index';
import { buildFixtureWorld } from './world';
import { LEVEL_ID } from './station';
import { spawnCrew } from './content';
import { spawnItem, spawnIdCard, spawnCrowbar, spawnEmag, giveItem, carries, hasAccess, findTool, consumeChargeEffect } from './items';
import { config } from './config';

// --- tiny assert harness ----------------------------------------------------
let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

interface Renderable {
  type: 'renderable';
  glyph: string;
  fg: string;
  layer: number;
  [key: string]: unknown;
}
const renderableOf = (e: Entity) => get<Renderable>(e, 'renderable')!;

/** A fresh fixture world with one crew actor placed in a known cell. */
function scene() {
  const { world } = buildFixtureWorld();
  spawnCrew(world, LEVEL_ID, 0, { id: 'actor' }, config);
  return world;
}

// --- (1) spawnItem renderable reads from config -----------------------------
{
  console.log('(1) spawnItem builds a config-driven renderable');
  const world = scene();
  const id = spawnItem(world, { id: 'plain', name: 'thing', glyph: '?' });
  const r = renderableOf(world.state.entities.get(id)!);
  check('item uses the item render layer', r.layer === config.render.layers.item, `layer=${r.layer}`);
  check('item without fg falls back to config default', r.fg === config.render.items.default.fg, `fg=${r.fg}`);

  const idCard = spawnIdCard(world, 'id1', ['bridge']);
  const rc = renderableOf(world.state.entities.get(idCard)!);
  check('ID card glyph+color come from config', rc.glyph === config.render.items.id.glyph && rc.fg === config.render.items.id.fg);
}

// --- (2) ownership is authoritative -----------------------------------------
{
  console.log('(2) giveItem / carries');
  const world = scene();
  const bar = spawnCrowbar(world, 'bar');
  check('actor does not carry an ungiven item', !carries(world, 'actor', bar));
  giveItem(world, 'actor', bar);
  check('actor carries the item after giveItem', carries(world, 'actor', bar));
}

// --- (3) hasAccess reads carried ID tags ------------------------------------
{
  console.log('(3) hasAccess only counts a CARRIED id with the matching tag');
  const world = scene();
  const id = spawnIdCard(world, 'id-bridge', ['bridge', 'maintenance']);
  check('uncarried ID grants no access', !hasAccess(world, 'actor', 'bridge'));
  giveItem(world, 'actor', id);
  check('carried ID grants its area', hasAccess(world, 'actor', 'bridge'));
  check('carried ID grants a second area', hasAccess(world, 'actor', 'maintenance'));
  check('carried ID denies an ungranted area', !hasAccess(world, 'actor', 'engineering'));
}

// --- (4) findTool resolves a carried tool by kind ---------------------------
{
  console.log('(4) findTool by kind, carried-only');
  const world = scene();
  const bar = spawnCrowbar(world, 'bar');
  check('findTool returns undefined when uncarried', findTool(world, 'actor', 'crowbar') === undefined);
  giveItem(world, 'actor', bar);
  check('findTool finds the carried crowbar', findTool(world, 'actor', 'crowbar') === bar);
  check('findTool returns undefined for an absent kind', findTool(world, 'actor', 'emag') === undefined);
}

// --- (5) consumeChargeEffect spends, then refuses when empty -----------------
{
  console.log('(5) consumeChargeEffect spends a charge and refuses at zero');
  const world = scene();
  const emag = spawnEmag(world, 'emag', 2);
  const effect = consumeChargeEffect(emag);
  const charges = () => get<{ type: 'tool'; charges?: number }>(world.state.entities.get(emag)!, 'tool')!.charges;

  check('effect validates with charges left', effect.validate(world) === true);
  effect.apply(world);
  check('one charge spent', charges() === 1, `charges=${charges()}`);
  effect.apply(world);
  check('drained to zero', charges() === 0, `charges=${charges()}`);
  check('effect refuses when empty', effect.validate(world) === false);
}

console.log(failures === 0 ? '\nALL ITEMS PROOFS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
