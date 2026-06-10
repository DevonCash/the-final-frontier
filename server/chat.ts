/**
 * chat — local `say` as an authoritative action (game-design §6, Epic I).
 *
 * Speaking is an action on the same pipeline as `move`/`useOn`: the transport
 * decodes a sanitized `{type:'say', actor, text}` and `enqueue`s it; the handler
 * resolves the speaker's cell and emits a `chat:say` event via an `announce`-style
 * effect (mirrors `openable.ts`'s denied beep). It resolves like any turn (default
 * cost), so a 25/s tick of talking briefly occupies the speaker. The event lands in
 * `ServerUpdate.events`, where the transport fans it out per viewer — filtered by
 * earshot/sight in `perception.ts`. The game never broadcasts raw chat; range is
 * applied at fan-out, so the wire only carries what a listener could actually hear.
 */
import {
  get,
  cellOf,
  type World,
  type EntityId,
  type Cell,
  type Effect,
  type GameEvent,
  type Action,
  type ActionHandler,
  type ActionContext,
  type Registry,
  type Position,
} from '../../rlkit/src/index';

const SAY_ACTION = 'say';

// The `say` action (R5 seam) and the `chat:say` event it emits — declaration-merged
// into rlkit so both typecheck without touching the engine.
declare module '../../rlkit/src/core/action' {
  interface ActionMap {
    say: { type: 'say'; actor: EntityId; text: string };
  }
}
declare module '../../rlkit/src/core/events' {
  interface EventMap {
    'chat:say': { type: 'chat:say'; speaker: EntityId; cell: Cell; text: string };
  }
}

/** A trivial effect that only emits an event (mirrors `openable.ts`'s `announce`). */
function announce(event: GameEvent): Effect {
  return { kind: 'announce', validate: () => true, apply: () => [event] };
}

/** Register the `say` handler: speaker at its cell → a `chat:say` event, for free. */
export function registerSay(world: World): void {
  const handler: ActionHandler = (ctx: ActionContext) => {
    const a = ctx.action as Action & { actor: EntityId; text: string };
    const speaker = ctx.world.state.entities.get(a.actor);
    const pos = speaker && get<Position>(speaker, 'position');
    if (!pos) return void ctx.reject('say: no speaker');
    const level = ctx.world.state.levels.get(pos.levelId);
    if (!level) return void ctx.reject('say: speaker off-level');
    const cell = cellOf({ x: pos.x, y: pos.y }, level.width);
    ctx.push(announce({ type: 'chat:say', speaker: a.actor, cell, text: a.text }));
  };
  (world.services.registries.handlers as Registry<ActionHandler>).register(SAY_ACTION, handler);
}
