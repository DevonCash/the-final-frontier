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
  type GameServer,
  type EntityId,
  type World,
  type Action,
  type Viewport,
} from '../../rlkit/src/index';
import { buildGameWorld } from './world';
import { spawnCrew, TILES } from './content';
import { config } from './config';

/** Per-player HUD extension carried on `PlayerView.extra` (R6). O₂ now; role/clock land in Epic H/J. */
export interface CrewExtra {
  oxygen?: { current: number; max: number };
}

interface ResourcesComponent {
  type: 'resources';
  pools: Record<string, { current: number }>;
  [key: string]: unknown;
}

export interface StationServer {
  game: GameServer<CrewExtra>;
  viewport: Viewport;
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

/** Wrap the station world in a GameServer: crew-per-join, O₂ HUD extra, fog mode. */
export function createStationServer(opts: { seed?: number; fog?: 'shared' | 'hidden' } = {}): StationServer {
  const { world, station } = buildGameWorld(opts.seed ?? 12345);
  const level = station.level;
  const floorIdx = world.services.tiles.index(TILES.floor);
  const tiles = level.layers.get('tiles') as Uint16Array;

  let joined = 0;
  const spawnPlayer = (w: World): EntityId => {
    const n = joined++;
    // Prefer the first FREE designated crew spawn (dorms) so reconnects reuse
    // vacated slots; fall back to any free floor cell only when all are taken.
    const free = station.mark.spawns.find((s) => !isOccupied(w, level.id, s));
    const cell = free ?? nextFreeFloor(w, level.id, tiles, floorIdx);
    return spawnCrew(w, level.id, cell, { id: `crew-${n + 1}`, name: `Crew ${n + 1}` }, config);
  };

  const viewExtra = (w: World, id: EntityId): CrewExtra => {
    const e = w.state.entities.get(id);
    const pools = e && get<ResourcesComponent>(e, 'resources')?.pools;
    if (!pools?.oxygen) return {};
    return { oxygen: { current: Math.round(pools.oxygen.current), max: config.oxygen.max } };
  };

  const game = createGameServer<CrewExtra>({
    world,
    spawnPlayer,
    fog: opts.fog ?? 'shared',
    viewExtra,
  });
  return { game, viewport: { width: level.width, height: level.height } };
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
  const lastSent = new Map<WebSocket, string>();
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
    ws.send(JSON.stringify({ type: 'welcome', playerId: id, viewport }));

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
      needsFrame.delete(ws);
      game.leave(id);
    });
  });

  // Fixed logical timestep: 25 ticks/s (config.ticksPerSecond). Catch up at most
  // config.server.maxTickCatchup ticks per loop so a stalled tab can't make the sim sprint.
  const MS_PER_TICK = 1000 / config.ticksPerSecond;
  let last = Date.now();
  let acc = 0;
  const loop = setInterval(() => {
    const now = Date.now();
    acc += now - last;
    last = now;
    const ticks = Math.min(config.server.maxTickCatchup, Math.floor(acc / MS_PER_TICK));
    if (ticks > 0) {
      acc -= ticks * MS_PER_TICK;
      game.tick(ticks);
    }
    // Frames can only differ if the world advanced (ticks>0) — including passive
    // changes like O₂ drain that don't go through an action — or if a freshly
    // joined socket still owes its first frame. A loop fire with no elapsed ticks
    // can't change any existing frame, so skip the build+diff entirely.
    if (ticks === 0 && needsFrame.size === 0) return;
    for (const [ws, id] of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ticks === 0 && !needsFrame.has(ws)) continue;
      needsFrame.delete(ws);
      const payload = JSON.stringify({ type: 'view', ...game.viewFor(id, viewport) });
      if (payload === lastSent.get(ws)) continue; // skip an unchanged frame
      lastSent.set(ws, payload);
      ws.send(payload);
    }
  }, MS_PER_TICK);

  const close = (): void => {
    clearInterval(loop);
    for (const ws of sockets.keys()) ws.close();
    wss.close();
  };
  return { game, port: opts.port, close };
}
