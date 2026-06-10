/**
 * perception-proof — hidden info, chat, and perception, proven headless (Epic I, §6).
 * Run: `npm run proof:perception`.
 *
 *   (1) say is heard within earshot — a `chat:say` reaches the speaker and a
 *       listener within `hearingRadius`, but NOT one beyond it (distance, not sight).
 *   (2) the denied beep is gated by sight — an `access:denied` reaches a player who
 *       can see its cell, but not one whose hidden FOV excludes it.
 *   (3) a ghost sees and hears all — a dead viewer perceives both an out-of-earshot
 *       `chat:say` and an unseen `access:denied`.
 *   (4) role briefings are private — the traitor's briefing carries the steal
 *       objective; a crew briefing does not leak the traitor flag.
 *
 * Drives a real hidden-fog `GameServer` (say rides the action pipeline; FOV is the
 * engine's own per-viewer layer) plus the `Round` controller for briefings. Plain
 * asserts; exits non-zero on first failure.
 */
import {
  changeResource,
  runReactions,
  computeVisibilityFor,
  get,
  pointOf,
  type World,
  type EntityId,
  type GameEvent,
  type Position,
} from '../../rlkit/src/index';
import { createStationServer } from './server';
import { createRound } from './round';
import { perceive } from './perception';
import { LEVEL_ID } from './station';
import { TILES } from './content';
import { config } from './config';

// --- tiny assert harness ----------------------------------------------------
let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const HEAR = config.hearingRadius;

// --- (1)-(3): live hidden-fog server -----------------------------------------
{
  const ss = createStationServer({ fog: 'hidden', seed: 1 });
  const { game, world } = ss;
  const a = game.join();
  const b = game.join();

  const level = world.state.levels.get(LEVEL_ID)!;
  const width = level.width;
  const tiles = level.layers.get('tiles') as Uint16Array;
  const floorIdx = world.services.tiles.index(TILES.floor);
  const cheb = (c1: number, c2: number): number => {
    const p = pointOf(c1, width);
    const q = pointOf(c2, width);
    return Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y));
  };
  const findFloor = (pred: (c: number) => boolean): number => {
    for (let c = 0; c < tiles.length; c++) if (tiles[c] === floorIdx && pred(c)) return c;
    throw new Error('perception-proof: no floor cell matched');
  };

  /** Move an actor to a cell and refresh its hidden FOV (the engine seeds FOV on move). */
  const place = (id: EntityId, cell: number): void => {
    const pos = get<Position>(world.state.entities.get(id)!, 'position')!;
    const { x, y } = pointOf(cell, width);
    pos.x = x;
    pos.y = y;
    world.services.queries.place(id, LEVEL_ID, cell);
    computeVisibilityFor(world, id);
  };

  /** Enqueue a `say` and tick until its `chat:say` event surfaces (the full pipeline). */
  const say = (actor: EntityId, text: string): GameEvent => {
    game.enqueue(actor, { type: 'say', actor, text });
    for (let i = 0; i < 20; i++) {
      const ev = game.tick(1).events.find((e) => e.type === 'chat:say' && (e as { speaker?: string }).speaker === actor);
      if (ev) return ev;
    }
    throw new Error('perception-proof: say produced no chat:say event');
  };

  const aCell = findFloor((c) => !occupied(world, c, a, b));
  const nearCell = findFloor((c) => c !== aCell && cheb(c, aCell) >= 1 && cheb(c, aCell) <= HEAR);
  const farCell = findFloor((c) => cheb(c, aCell) > HEAR + 2);

  // (1) say heard within earshot, not beyond.
  console.log('(1) local say is heard within hearingRadius, not beyond');
  place(a, aCell);
  place(b, nearCell);
  const near = say(a, 'hello');
  check('speaker hears itself', perceive(game, a, near, { hearingRadius: HEAR }));
  check('listener within radius hears it', perceive(game, b, near, { hearingRadius: HEAR }), `dist ${cheb(nearCell, aCell)} ≤ ${HEAR}`);
  place(b, farCell);
  const far = say(a, 'too far');
  check('listener beyond radius does NOT hear it', !perceive(game, b, far, { hearingRadius: HEAR }), `dist ${cheb(farCell, aCell)} > ${HEAR}`);

  // (2) denied beep gated by sight. The event is what `openable.ts` emits; perceive
  // filters it by the viewer's own hidden FOV.
  console.log('(2) the denied beep reaches only players who can see its cell');
  const denied: GameEvent = { type: 'access:denied', actor: a, target: 'door', cell: aCell, reason: 'bolted' };
  check('speaker can see its own cell', game.canViewerSee(a, aCell));
  check('a viewer who can see the cell perceives the beep', perceive(game, a, denied, { hearingRadius: HEAR }));
  check('a far viewer cannot see the cell', !game.canViewerSee(b, aCell));
  check('a viewer who cannot see the cell does NOT perceive the beep', !perceive(game, b, denied, { hearingRadius: HEAR }));

  // (3) ghost omniscience: kill B → off the timeline → perceives everything.
  console.log('(3) a ghost sees and hears all');
  runReactions(world, changeResource(world, b, 'hp', -999, 'test')); // hp→0 → died → corpse
  check('B is now a ghost (off the timeline)', !world.state.timeline.actors.some((x) => x.id === b));
  check('ghost hears the out-of-earshot say', perceive(game, b, far, { hearingRadius: HEAR }));
  check('ghost perceives the unseen denied beep', perceive(game, b, denied, { hearingRadius: HEAR }));
}

// --- (4): private role briefings (via the round controller) ------------------
{
  console.log('(4) role briefings are private and role-correct');
  const r = createRound({ seed: 1 });
  for (const s of ['p1', 'p2', 'p3', 'p4']) r.addPlayer(s, s.toUpperCase());
  r.forceSetup({ traitor: 'p1' });

  const tb = r.briefingFor('p1')!;
  check('traitor briefing flags the traitor', tb.traitor === true);
  check('traitor objective is to steal the disk', /steal/i.test(tb.objective));

  const cb = r.briefingFor('p2')!;
  check('crew briefing does NOT flag the traitor', cb.traitor === false);
  check('crew objective is to survive', /survive/i.test(cb.objective));
}

/** Whether a cell is occupied by either named player (so we spawn A on a free one). */
function occupied(world: World, cell: number, ...ids: EntityId[]): boolean {
  for (const id of world.services.queries.at(cell, LEVEL_ID)) if (ids.includes(id)) return true;
  return false;
}

console.log(failures === 0 ? '\nALL PERCEPTION PROOFS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
