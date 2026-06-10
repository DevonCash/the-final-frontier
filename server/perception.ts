/**
 * perception — who receives which event (game-design §6, Epic I).
 *
 * The engine hands the transport EVERY event of a tick (`ServerUpdate.events`),
 * including high-frequency internals (`entity:entered/exited`, `flags:changed`, …)
 * the client never consumes. `perceive` is the per-viewer gate the transport
 * applies before sending. Rules, in order:
 *   - only client-facing types (`CLIENT_EVENTS`) are forwarded AT ALL — this bounds
 *     the wire and keeps a spectating ghost from eating the whole sim event log;
 *   - the DEAD then see/hear everything (ghost chat + spectating);
 *   - `chat:say` is audible within `hearingRadius` (chebyshev distance, NOT sight —
 *     you hear through walls but not across the station);
 *   - any other client-facing event carrying a `cell` is visual: gated by the
 *     viewer's own FOV (`canViewerSee`) — a denied-door beep only reaches a carrier
 *     who can see the door.
 */
import {
  get,
  pointOf,
  type EntityId,
  type GameEvent,
  type GameServer,
  type Position,
} from '../../rlkit/src/index';

/**
 * The event types the client actually consumes — the only ones the transport puts
 * on the wire. A protocol allowlist, not a gameplay tunable: extend it as the HUD
 * grows (Epic J). Everything else (movement/atmos/resource internals) stays server-side.
 */
export const CLIENT_EVENTS: ReadonlySet<string> = new Set(['chat:say', 'access:denied']);

/** Is the viewer dead (off the timeline)? Ghosts perceive everything. */
function isGhost(game: GameServer<unknown>, viewerId: EntityId): boolean {
  return !game.world.state.timeline.actors.some((a) => a.id === viewerId);
}

/** The viewer's grid position + its level width, or undefined if it has no position/level. */
function viewerAt(game: GameServer<unknown>, viewerId: EntityId): { x: number; y: number; width: number } | undefined {
  const e = game.world.state.entities.get(viewerId);
  const pos = e && get<Position>(e, 'position');
  const level = pos && game.world.state.levels.get(pos.levelId);
  if (!pos || !level) return undefined;
  return { x: pos.x, y: pos.y, width: level.width };
}

/** Whether `viewerId` should receive `ev` this tick (see module doc for the rules). */
export function perceive(
  game: GameServer<unknown>,
  viewerId: EntityId,
  ev: GameEvent,
  opts: { hearingRadius: number },
): boolean {
  if (!CLIENT_EVENTS.has(ev.type)) return false; // internals never reach the wire (even for ghosts)
  if (isGhost(game, viewerId)) return true; // ghosts see and hear all

  const cell = (ev as { cell?: unknown }).cell;
  if (typeof cell !== 'number') return false; // a client-facing event must carry a cell to gate

  if (ev.type === 'chat:say') {
    // Audible: chebyshev distance ≤ hearingRadius (through walls, not across the station).
    const here = viewerAt(game, viewerId);
    if (!here) return false;
    const there = pointOf(cell, here.width);
    return Math.max(Math.abs(here.x - there.x), Math.abs(here.y - there.y)) <= opts.hearingRadius;
  }

  // Visual: only if the viewer can actually see the event's cell (own FOV under hidden fog).
  return game.canViewerSee(viewerId, cell);
}
