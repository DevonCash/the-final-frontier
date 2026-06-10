/**
 * perception — who receives which event (game-design §6, Epic I).
 *
 * The engine hands the transport every event of a tick (`ServerUpdate.events`);
 * `perceive` is the per-viewer gate the transport applies before sending. Three
 * rules, in order:
 *   - the DEAD see/hear everything (ghost chat + spectating);
 *   - `chat:say` is audible within `hearingRadius` (chebyshev distance, NOT sight —
 *     you hear through walls but not across the station);
 *   - any other event carrying a `cell` is visual: gated by the viewer's own FOV
 *     (`canViewerSee`, populated under hidden fog) — e.g. a denied-door beep only
 *     reaches a carrier who can see the door.
 * Events with no cell are withheld from the living (no leaks) — ghosts already passed.
 */
import {
  get,
  pointOf,
  type EntityId,
  type GameEvent,
  type GameServer,
  type Position,
} from '../../rlkit/src/index';

/** Is the viewer dead (off the timeline)? Ghosts perceive everything. */
function isGhost(game: GameServer<unknown>, viewerId: EntityId): boolean {
  return !game.world.state.timeline.actors.some((a) => a.id === viewerId);
}

/** The viewer's cell + its level width, or undefined if it has no position/level. */
function viewerAt(game: GameServer<unknown>, viewerId: EntityId): { cell: number; width: number } | undefined {
  const e = game.world.state.entities.get(viewerId);
  const pos = e && get<Position>(e, 'position');
  const level = pos && game.world.state.levels.get(pos.levelId);
  if (!pos || !level) return undefined;
  return { cell: pos.y * level.width + pos.x, width: level.width };
}

/** Whether `viewerId` should receive `ev` this tick (see module doc for the rules). */
export function perceive(
  game: GameServer<unknown>,
  viewerId: EntityId,
  ev: GameEvent,
  opts: { hearingRadius: number },
): boolean {
  if (isGhost(game, viewerId)) return true; // ghosts see and hear all

  const cell = (ev as { cell?: unknown }).cell;
  if (typeof cell !== 'number') return false; // cell-less events: no leaks to the living

  if (ev.type === 'chat:say') {
    // Audible: chebyshev distance ≤ hearingRadius (through walls, not across the station).
    const here = viewerAt(game, viewerId);
    if (!here) return false;
    const a = pointOf(here.cell, here.width);
    const b = pointOf(cell, here.width);
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= opts.hearingRadius;
  }

  // Visual: only if the viewer can actually see the event's cell (own FOV under hidden fog).
  return game.canViewerSee(viewerId, cell);
}
