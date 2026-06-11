/**
 * server — the authoritative station server: a GameServer wrapper + WS host.
 *
 * Mirrors `rlkit/examples/netcoop`. `createStationServer` wraps the station world
 * (Epic 0/A: atmosphere + breathing) in the engine's `createGameServer`: each
 * `join` spawns a crew actor, `viewFor` renders a per-player frame, and `viewExtra`
 * (R6) carries the O₂ HUD field. `startStationServer` is the WebSocket transport —
 * it maps sockets→players, decodes/sanitizes input into engine `Action`s, runs a
 * fixed 25/s tick loop, and fans each player's frame out (skipping unchanged ones).
 *
 * Split out from the entry (`index.ts`) so the headless `net-proof` can stand up a
 * real server on a throwaway port and tear it down.
 */
import { WebSocketServer, WebSocket } from 'ws';
import {
  createGameServer,
  get,
  cellOf,
  neighbors4,
  type GameServer,
  type EntityId,
  type World,
  type Action,
  type Viewport,
  type GameEvent,
  type Position,
} from '../../rlkit/src/index';
import { buildGameWorld } from './world';
import { spawnCrew, TILES } from './content';
import type { Station } from './station';
import { config } from './config';
import { perceive } from './perception';
import { roleOf, setRole, type Job } from './role';
import { giveItem, spawnIdCard } from './items';

/**
 * Per-player HUD extension carried on `PlayerView.extra` (R6), read per-viewer from
 * the viewer's OWN entity only — the hidden-fog contract (never read another
 * player's components, or role/held would leak under fog). O₂ (Epic A), role/held/
 * targets (Epic J); `clock` is present only when a round-aware host provides it.
 */
export interface CrewExtra {
  oxygen?: { current: number; max: number };
  /** The viewer's own job + secret traitor flag (its role briefing). */
  role?: { job: Job; traitor: boolean };
  /** The viewer's first carried item (name + tool kind, for the held-item slot + useOn). */
  held?: { name: string; kind?: string };
  /** Adjacent usable entities (doors/lockers) — the useOn interaction prompt's targets. */
  targets?: Array<{ id: string; cell: number; label: string }>;
  /** Round phase + seconds left; absent unless the host runs the round FSM (round.ts). */
  clock?: { phase: 'lobby' | 'setup' | 'shift' | 'departure' | 'reveal'; secondsRemaining?: number };
}

interface InfoComponent {
  type: 'info';
  name: string;
  [key: string]: unknown;
}
interface InventoryComponent {
  type: 'inventory';
  items: string[];
  [key: string]: unknown;
}
interface ToolComponent {
  type: 'tool';
  kind: string;
  [key: string]: unknown;
}
interface OpenableComponent {
  type: 'openable';
  kind: 'door' | 'locker';
  [key: string]: unknown;
}

interface ResourcesComponent {
  type: 'resources';
  pools: Record<string, { current: number }>;
  [key: string]: unknown;
}

export interface StationServer {
  game: GameServer<CrewExtra>;
  viewport: Viewport;
  world: World;
  station: Station;
}

/** Whether any entity occupies a cell. */
function isOccupied(world: World, levelId: string, cell: number): boolean {
  for (const _ of world.services.queries.at(cell, levelId)) return true;
  return false;
}

/** The next unoccupied floor cell on the level (row-major) — a deterministic spawn slot. */
function nextFreeFloor(world: World, levelId: string, tiles: Uint16Array, floorIdx: number): number {
  for (let c = 0; c < tiles.length; c++) {
    if (tiles[c] === floorIdx && !isOccupied(world, levelId, c)) return c;
  }
  throw new Error('nextFreeFloor: no unoccupied floor cell left to spawn a crew member');
}

/**
 * Wrap the station world in a GameServer: O₂ HUD extra + fog mode. By default each
 * `join` spawns a plain crew member at a free dorm slot (the dev/`net-proof` path).
 * The round controller (`round.ts`) injects a job-aware `spawnPlayer` instead — the
 * seam that lets one builder serve both the simple host and round play.
 */
export function createStationServer(opts: {
  seed?: number;
  fog?: 'shared' | 'hidden';
  spawnPlayer?: (world: World, station: Station) => EntityId;
} = {}): StationServer {
  const { world, station } = buildGameWorld(opts.seed ?? 12345);
  const level = station.level;
  const floorIdx = world.services.tiles.index(TILES.floor);
  const tiles = level.layers.get('tiles') as Uint16Array;

  let joined = 0;
  const defaultSpawn = (w: World): EntityId => {
    const n = joined++;
    // Prefer the first FREE designated crew spawn (dorms) so reconnects reuse
    // vacated slots; fall back to any free floor cell only when all are taken.
    const free = station.mark.spawns.find((s) => !isOccupied(w, level.id, s));
    const cell = free ?? nextFreeFloor(w, level.id, tiles, floorIdx);
    const id = spawnCrew(w, level.id, cell, { id: `crew-${n + 1}`, name: `Crew ${n + 1}` }, config);
    // Starter loadout so the HUD shows real role/held data on the simple host (Epic J):
    // a plain crew briefing + a basic ID. The round controller assigns jobs/traitor and
    // full kits instead when it drives spawns.
    setRole(w.state.entities.get(id)!, 'crew', false);
    giveItem(w, id, spawnIdCard(w, `id-${n + 1}`, [...config.access.ids.crew]));
    return id;
  };
  const spawnPlayer = opts.spawnPlayer ? (w: World) => opts.spawnPlayer!(w, station) : defaultSpawn;

  const viewExtra = (w: World, id: EntityId): CrewExtra => {
    const e = w.state.entities.get(id);
    if (!e) return {};
    const extra: CrewExtra = {};

    const pools = get<ResourcesComponent>(e, 'resources')?.pools;
    if (pools?.oxygen) extra.oxygen = { current: Math.round(pools.oxygen.current), max: config.oxygen.max };

    // Role card: the viewer's own briefing (job + secret traitor flag).
    const role = roleOf(e);
    if (role) extra.role = { job: role.job, traitor: role.traitor };

    // Held item: the first carried item — its display name + tool kind (for useOn).
    const held = get<InventoryComponent>(e, 'inventory')?.items[0];
    const heldEntity = held ? w.state.entities.get(held) : undefined;
    if (heldEntity) {
      const name = get<InfoComponent>(heldEntity, 'info')?.name ?? held!;
      const kind = get<ToolComponent>(heldEntity, 'tool')?.kind;
      extra.held = kind ? { name, kind } : { name };
    }

    // Interaction prompt: usable entities in the viewer's four adjacent cells (within
    // its own FOV, so no fog leak). Doors/lockers are the useOn targets.
    const pos = get<Position>(e, 'position');
    const level = pos && w.state.levels.get(pos.levelId);
    if (pos && level) {
      const origin = cellOf({ x: pos.x, y: pos.y }, level.width);
      const targets: NonNullable<CrewExtra['targets']> = [];
      for (const nb of neighbors4(origin, level.width, level.height)) {
        for (const occId of w.services.queries.at(nb, pos.levelId)) {
          const occ = w.state.entities.get(occId);
          const open = occ && get<OpenableComponent>(occ, 'openable');
          if (open) targets.push({ id: occId, cell: nb, label: config.hud.targets[open.kind] });
        }
      }
      if (targets.length) extra.targets = targets;
    }
    return extra;
  };

  const game = createGameServer<CrewExtra>({
    world,
    spawnPlayer,
    fog: opts.fog ?? 'shared',
    viewExtra,
  });
  return { game, viewport: { width: level.width, height: level.height }, world, station };
}

// --- WebSocket transport ----------------------------------------------------

/** Clamp an untrusted `dir` to a single step in [-1,1]² (no speed-hack / NaN). */
function unitDir(d: unknown): { x: number; y: number } | null {
  if (!d || typeof d !== 'object') return null;
  const { x, y } = d as { x?: unknown; y?: unknown };
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  const cx = Math.sign(x as number);
  const cy = Math.sign(y as number);
  return cx === 0 && cy === 0 ? null : { x: cx, y: cy };
}

type Decoder = (msg: Record<string, unknown>, actor: EntityId) => Action | null;

/**
 * Client message → sanitized engine Action. The seam for the tool economy: Epic D
 * adds a `useOn` decoder here (R5), validating `{ kind:'entity'|'cell', … }`.
 */
const DECODERS: Record<string, Decoder> = {
  move: (msg, actor) => {
    const dir = unitDir(msg.dir);
    return dir ? { type: 'move', actor, dir } : null;
  },
  // Tool-on-target (R5): a sanitized discriminated target + optional held item.
  // The game registers the `useOn` handler + tool rules; this only validates input.
  useOn: (msg, actor) => {
    const t = msg.target as { kind?: unknown; id?: unknown; cell?: unknown } | undefined;
    if (!t || typeof t !== 'object') return null;
    const item = typeof msg.item === 'string' ? { item: msg.item } : {};
    if (t.kind === 'entity' && typeof t.id === 'string') return { type: 'useOn', actor, ...item, target: { kind: 'entity', id: t.id } };
    if (t.kind === 'cell' && Number.isInteger(t.cell)) return { type: 'useOn', actor, ...item, target: { kind: 'cell', cell: t.cell as number } };
    return null;
  },
  // Local chat (Epic I): trim + length-cap the text; the handler emits a `chat:say`
  // event that the transport fans out by earshot. Empty/over-long/non-string → drop.
  say: (msg, actor) => {
    if (typeof msg.text !== 'string') return null;
    const text = msg.text.trim().slice(0, config.chat.maxLength);
    return text ? { type: 'say', actor, text } : null;
  },
};

/** Only accept browser clients from localhost; node clients (tests) send no Origin. */
function localhostOnly(origin: string | undefined): boolean {
  if (!origin) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export interface RunningServer {
  game: GameServer<CrewExtra>;
  port: number;
  close: () => void;
}

/** Stand up the WS host on `port`. Returns a handle whose `close()` stops everything. */
export function startStationServer(opts: {
  port: number;
  fog?: 'shared' | 'hidden';
  seed?: number;
  allowedOrigin?: (origin: string | undefined) => boolean;
}): RunningServer {
  const { game, viewport } = createStationServer({ seed: opts.seed, fog: opts.fog });
  const sockets = new Map<WebSocket, EntityId>();
  const lastSent = new Map<WebSocket, string>(); // last render-frame payload (dedup)
  const lastExtra = new Map<WebSocket, string>(); // last HUD-extra payload (dedup)
  const needsFrame = new Set<WebSocket>(); // fresh sockets still owed their first frame
  const originOk = opts.allowedOrigin ?? localhostOnly;

  const wss = new WebSocketServer({
    port: opts.port,
    verifyClient: (info: { origin?: string }) => originOk(info.origin),
  });

  wss.on('connection', (ws) => {
    const id = game.join();
    sockets.set(ws, id);
    needsFrame.add(ws);
    // `hud` ships the HUD presentation config once so the client paints `extra`
    // without duplicating any labels/colors/thresholds (config.ts stays canonical).
    ws.send(JSON.stringify({ type: 'welcome', playerId: id, viewport, hud: config.hud }));

    ws.on('message', (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const decode = typeof msg.type === 'string' ? DECODERS[msg.type] : undefined;
      const action = decode?.(msg, id);
      if (action) game.enqueue(id, action);
    });

    ws.on('close', () => {
      sockets.delete(ws);
      lastSent.delete(ws);
      lastExtra.delete(ws);
      needsFrame.delete(ws);
      game.leave(id);
    });
  });

  // Fixed logical timestep: 25 ticks/s (config.ticksPerSecond). Catch up at most
  // config.server.maxTickCatchup ticks per loop so a stalled tab can't make the sim sprint.
  const MS_PER_TICK = 1000 / config.ticksPerSecond;
  let last = Date.now();
  let acc = 0;
  let extraAcc = 0; // sim-ticks since the last HUD-extra window (throttle)
  const loop = setInterval(() => {
    const now = Date.now();
    acc += now - last;
    last = now;
    const ticks = Math.min(config.server.maxTickCatchup, Math.floor(acc / MS_PER_TICK));
    const events: GameEvent[] = [];
    if (ticks > 0) {
      acc -= ticks * MS_PER_TICK;
      events.push(...game.tick(ticks).events); // events only exist when the world advanced
    }
    // HUD `extra` rides a throttled cadence (a few Hz) so it doesn't re-send a full
    // render frame every tick just because O₂ ticked down — the bug that defeated the
    // frame dedup and flooded the client. Gated globally by sim time; deduped per socket.
    extraAcc += ticks;
    const extraDue = extraAcc >= config.server.extraEveryTicks;
    if (extraDue) extraAcc = 0;
    // Frames can only differ if the world advanced (ticks>0) — including passive
    // changes like O₂ drain that don't go through an action — or if a freshly
    // joined socket still owes its first frame. A loop fire with no elapsed ticks
    // can't change any existing frame (and emits no events), so skip entirely.
    if (ticks === 0 && needsFrame.size === 0) return;
    // Pre-serialize each event once (the payload is socket-independent; only the
    // per-viewer `perceive` decision differs).
    const wire = events.map((event) => ({ event, json: JSON.stringify({ type: 'event', event }) }));
    for (const [ws, id] of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      // Fan out this tick's events, filtered to what this player can hear/see (Epic I).
      for (const { event, json } of wire) {
        if (perceive(game, id, event, { hearingRadius: config.hearingRadius })) ws.send(json);
      }
      const fresh = needsFrame.has(ws);
      if (ticks === 0 && !fresh) continue;
      needsFrame.delete(ws);
      const view = game.viewFor(id, viewport);
      // Render frame (cells only): dedup is now effective — a static map sends nothing,
      // because the fast-changing HUD `extra` no longer rides this payload.
      const framePayload = JSON.stringify({ type: 'view', frame: view.frame, alive: view.alive });
      if (framePayload !== lastSent.get(ws)) {
        lastSent.set(ws, framePayload);
        ws.send(framePayload);
      }
      // HUD extra (O₂/role/held/targets): throttled + deduped, so the cheap HUD update
      // never forces an expensive canvas redraw on the client.
      if (view.extra !== undefined && (fresh || extraDue)) {
        const extraPayload = JSON.stringify({ type: 'extra', extra: view.extra, alive: view.alive });
        if (extraPayload !== lastExtra.get(ws)) {
          lastExtra.set(ws, extraPayload);
          ws.send(extraPayload);
        }
      }
    }
  }, MS_PER_TICK);

  const close = (): void => {
    clearInterval(loop);
    for (const ws of sockets.keys()) ws.close();
    wss.close();
  };
  return { game, port: opts.port, close };
}
