/**
 * tools-proof — items, tools, the tile/wire economy, and corpse loot (Epic F, §5–7).
 * Run: `npm run proof:tools`.
 *
 *   (1) wrench smashes a window over `windowHits` blows → the room vents to vacuum
 *   (2) welder reseals the breach over `repairUses` passes → the hull holds and,
 *       reconnected to a pressurized neighbour, the room repressurizes
 *   (3) wirecutters cut a wire → a downstream door drops power; cable re-lays it → restored
 *   (4) death leaves a corpse carrying full inventory; an adjacent looter bumps it
 *       and takes the ID (access changes hands)
 *   (5) inventory core: pickup/drop round-trips a floor item
 *   (6) O₂ tank: activating a carried tank pauses suffocation (the EVA enabler)
 *
 * Headless. A non-breathing "hand" actor performs tool actions (it never ticks, so
 * it can stand in vacuum); a bystander paces the atmos driver. Assertions are plain;
 * exit non-zero on first failure.
 */
import {
  perform,
  tickRealtime,
  changeResource,
  runReactions,
  createEntity,
  pointOf,
  levelCell,
  ensureFloatLayer,
  ensureU8Layer,
  get,
  type World,
  type EntityId,
} from '../../rlkit/src/index';
import { buildFixtureWorld, buildPowerFixtureWorld } from './world';
import { LEVEL_ID } from './station';
import { spawnCrew } from './content';
import { config } from './config';
import {
  spawnWrench,
  spawnWelder,
  spawnWirecutters,
  spawnCable,
  spawnO2Tank,
  spawnCrowbar,
  spawnIdCard,
  giveItem,
  carries,
  hasAccess,
} from './items';
import { isPowered, generatorRunning } from './power';

// --- tiny assert harness ----------------------------------------------------
let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const OBS = 'obs';
const pressureLayer = (w: World) => ensureFloatLayer(w.state.levels.get(LEVEL_ID)!, 'pressure');
const cellAt = (w: World, x: number, y: number) => levelCell(w.state.levels.get(LEVEL_ID)!, x, y);
const tileId = (w: World, cell: number) =>
  w.services.tiles.byIndex((w.state.levels.get(LEVEL_ID)!.layers.get('tiles') as Uint16Array)[cell]!).id;

/** A bare, non-breathing actor that can carry tools and `perform` — never ticks. */
function spawnHand(w: World, cell: number, id: EntityId): EntityId {
  const level = w.state.levels.get(LEVEL_ID)!;
  const { x, y } = pointOf(cell, level.width);
  const e = createEntity(id, [
    { type: 'position', x, y, levelId: LEVEL_ID },
    { type: 'renderable', glyph: '@', fg: '#fff', layer: 5 },
    { type: 'info', name: 'hand' },
    { type: 'inventory', items: [] },
  ]);
  w.state.entities.set(id, e);
  w.services.queries.index(e);
  w.services.queries.place(id, LEVEL_ID, cell);
  return id;
}

const useOnCell = (w: World, actor: EntityId, item: EntityId, cell: number) =>
  perform(w, { type: 'useOn', actor, item, target: { kind: 'cell', cell } });

// --- (1)+(2) wrench smashes a window; welder reseals + repressurizes ----------
{
  console.log('(1)/(2) wrench smashes the bridge window (vents); welder reseals (repressurizes)');
  const { world, station } = buildFixtureWorld();
  world.services.timeline.addActor(OBS, 100); // paces the atmos driver
  const p = pressureLayer(world);
  const roomB = station.mark.roomB;
  const windowCell = station.mark.window; // (18,3)
  const handCell = cellAt(world, 17, 3); // floor in roomB, adjacent to the window

  const hand = spawnHand(world, handCell, 'hand');
  const wrench = spawnWrench(world, 'wrench');
  const welder = spawnWelder(world, 'welder');
  giveItem(world, hand, wrench);
  giveItem(world, hand, welder);

  // Smash: `windowHits` blows. The first hits are progress; the last opens the breach.
  let smashed = false;
  for (let i = 0; i < config.windowHits; i++) {
    const out = useOnCell(world, hand, wrench, windowCell);
    smashed = out.status === 'done' && out.events.some((e) => e.type === 'window:smashed');
  }
  check('window smashes after windowHits blows', smashed && tileId(world, windowCell) === 'space',
    `tile=${tileId(world, windowCell)}`);

  // The breach vents roomB through the pinhole — below the breath threshold (a
  // real threat) but not all the way to hard vacuum, so the neighbour can refill it.
  tickRealtime(world, { player: OBS, ticks: 1500 });
  const vented = p[roomB]!;
  check('breach vents the room below the breath threshold', vented < config.atmos.breathThreshold,
    `roomB=${vented.toFixed(1)} kPa`);

  // Weld: `repairUses` passes restore the original window tile (reseals the hull).
  let repaired = false;
  for (let i = 0; i < config.repairUses; i++) {
    const out = useOnCell(world, hand, welder, windowCell);
    repaired = out.status === 'done' && out.events.some((e) => e.type === 'breach:repaired');
  }
  check('welder reseals the window after repairUses passes', repaired && tileId(world, windowCell) === 'window',
    `tile=${tileId(world, windowCell)}`);

  // Sealed: with the door still closed, the room holds its air — it only settles
  // internally, it does NOT keep bleeding toward vacuum (an open breach would).
  tickRealtime(world, { player: OBS, ticks: 4000 });
  const held = p[roomB]!;
  check('resealed room holds its air (no longer venting)', held > vented * 0.85,
    `${vented.toFixed(1)} → ${held.toFixed(1)} kPa (retained ${((held / vented) * 100).toFixed(0)}%)`);

  // Repressurize: open the airlock to the full neighbour; air flows back in.
  station.doors[0]!.open(world);
  tickRealtime(world, { player: OBS, ticks: 4000 });
  const repress = p[roomB]!;
  check('reconnected room repressurizes above the breath threshold', repress > config.atmos.breathThreshold,
    `roomB=${repress.toFixed(1)} kPa`);
}

// --- (3) wirecutters cut a wire (power drops); cable re-lays it (restores) -----
// Drives the Epic-F tools through Epic E's REAL power network: the power fixture is
// gen → wire → door → wire → vent; snipping the gen-side wire disconnects the door.
{
  console.log('(3) wirecutters cut a wire → door unpowered; cable relays → repowered');
  const { world, station } = buildPowerFixtureWorld();
  const door = station.mark.doorId;
  const wire = ensureU8Layer(world.state.levels.get(LEVEL_ID)!, 'wire');
  const o = () => get<{ type: 'openable'; powered: boolean }>(world.state.entities.get(door)!, 'openable')!;

  check('generator running; door starts powered', generatorRunning(world) && o().powered && isPowered(world, station.mark.door));

  // The cut wire is at (3,2); stand the engineer on the wire run at (4,2), adjacent.
  const hand = spawnHand(world, cellAt(world, 4, 2), 'engineer');
  giveItem(world, hand, spawnWirecutters(world, 'cutters'));
  giveItem(world, hand, spawnCable(world, 'cable'));

  const cut = useOnCell(world, hand, 'cutters', station.mark.cutWire);
  check('wirecutters cut the wire', cut.status === 'done' && wire[station.mark.cutWire] === 0);
  check('downstream door loses power (generator still runs)',
    !o().powered && !isPowered(world, station.mark.door) && generatorRunning(world));

  const relay = useOnCell(world, hand, 'cable', station.mark.cutWire);
  check('cable re-lays the wire (spends a length)', relay.status === 'done' && wire[station.mark.cutWire] === 1);
  check('downstream door is repowered', o().powered && isPowered(world, station.mark.door));
}

// --- (4) corpse carries inventory; bump loots the ID --------------------------
{
  console.log('(4) death drops a lootable corpse; an adjacent looter bumps it and takes the ID');
  const { world } = buildFixtureWorld();
  const victimCell = cellAt(world, 13, 3);
  const looterCell = cellAt(world, 12, 3);

  const victim = spawnCrew(world, LEVEL_ID, victimCell, { id: 'victim' }, config);
  giveItem(world, victim, spawnIdCard(world, 'capt-id', ['bridge']));
  const looter = spawnHand(world, looterCell, 'looter');

  // Kill the victim: hp→0 emits the core `died`; reactors convert it to a corpse.
  runReactions(world, changeResource(world, victim, 'hp', -999, 'test'));
  const isCorpse = !!world.state.entities.get(victim)?.components.has('corpse');
  check('died → entity becomes a corpse (keeps its inventory)', isCorpse && carries(world, victim, 'capt-id'));
  check('dead actor is off the timeline', !world.state.timeline.actors.some((a) => a.id === victim));

  // Looter bumps east into the corpse → loots it.
  const bump = perform(world, { type: 'move', actor: looter, dir: { x: 1, y: 0 } });
  check('bumping the corpse loots it', bump.status === 'done' && bump.events.some((e) => e.type === 'corpse:looted'));
  check('looter now holds the captain ID (access changed hands)', hasAccess(world, looter, 'bridge'));
  check('corpse is emptied', !carries(world, victim, 'capt-id'));
}

// --- (5) inventory core: pickup / drop round-trip -----------------------------
{
  console.log('(5) inventory core: drop a tool to the floor, pick it back up');
  const { world } = buildFixtureWorld();
  const cell = cellAt(world, 5, 3);
  const hand = spawnHand(world, cell, 'hand');
  const bar = spawnCrowbar(world, 'bar');
  giveItem(world, hand, bar);

  const dropped = perform(world, { type: 'drop', actor: hand, item: bar });
  const onFloor = !!world.state.entities.get(bar)?.components.has('position');
  check('drop puts the item on the floor', dropped.status === 'done' && onFloor && !carries(world, hand, bar));

  const picked = perform(world, { type: 'pickup', actor: hand, item: bar });
  check('pickup returns it to the inventory', picked.status === 'done' && carries(world, hand, bar));
}

// --- (6) O₂ tank activation pauses suffocation --------------------------------
{
  console.log('(6) O₂ tank: activating a carried tank pauses the oxygen drain');
  const { world } = buildFixtureWorld();
  const crew = spawnCrew(world, LEVEL_ID, cellAt(world, 13, 3), { id: 'spacer' }, config);
  giveItem(world, crew, spawnO2Tank(world, 'tank'));

  const before = get<{ type: 'breathing'; tankUntil: number }>(world.state.entities.get(crew)!, 'breathing')!.tankUntil;
  const out = perform(world, { type: 'activate', actor: crew, item: 'tank' });
  const after = get<{ type: 'breathing'; tankUntil: number }>(world.state.entities.get(crew)!, 'breathing')!.tankUntil;
  check('activating the tank arms the suffocation pause', out.status === 'done' && after > before,
    `tankUntil ${before} → ${after}`);
}

console.log(failures === 0 ? '\nALL TOOLS PROOFS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
