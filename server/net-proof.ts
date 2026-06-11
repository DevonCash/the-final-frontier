/**
 * net-proof — the server/client slice, proven headless. Run: `npm run proof:net`.
 *
 * Stands up a real WS host on a throwaway port and drives two node clients through
 * it (mirrors netcoop's roundtrip):
 *   - two clients connect and each gets a DISTINCT crew id + its own frame
 *   - under shared fog, each client's frame shows BOTH crew (they see each other)
 *   - a movement intent advances the world and the mover's frame updates
 *   - malformed/unknown input is sanitized server-side and never crashes the host
 *
 * Assertions are plain; the script exits non-zero on first failure.
 */
import { WebSocket } from 'ws';
import type { RenderFrame } from '../../rlkit/src/index';
import { startStationServer } from './server';

const PORT = 8799;

// --- tiny assert harness ----------------------------------------------------
let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const countGlyph = (f: RenderFrame | undefined, g: string) =>
  f ? f.cells.reduce((n, c) => n + (c.glyph === g ? 1 : 0), 0) : 0;

interface GameEventMsg {
  type: string;
  [key: string]: unknown;
}

interface Client {
  ws: WebSocket;
  playerId?: string;
  lastFrame?: RenderFrame;
  events: GameEventMsg[]; // `{type:'event'}` payloads the server fanned out to this client
}

function connect(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const client: Client = { ws, events: [] };
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as { type: string; playerId?: string; frame?: RenderFrame; event?: GameEventMsg };
      if (m.type === 'welcome') client.playerId = m.playerId;
      if (m.type === 'view') client.lastFrame = m.frame;
      if (m.type === 'event' && m.event) client.events.push(m.event);
    });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}

/** Poll `pred` until true or timeout (returns whether it became true). */
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(20);
  }
  return pred();
}

async function main(): Promise<void> {
  const server = startStationServer({ port: PORT, fog: 'shared' });

  console.log('two crew connect to one authoritative station');
  const a = await connect(PORT);
  await waitFor(() => a.playerId !== undefined);
  const b = await connect(PORT);
  await waitFor(() => b.playerId !== undefined);

  check('distinct crew ids', !!a.playerId && a.playerId !== b.playerId, `${a.playerId} vs ${b.playerId}`);

  await waitFor(() => countGlyph(a.lastFrame, '@') >= 2);
  check('A sees both crew (shared fog)', countGlyph(a.lastFrame, '@') >= 2, `@ count=${countGlyph(a.lastFrame, '@')}`);
  // A's 2-crew frame and B's first frame ride independent sockets, so B's may
  // still be in flight when A's arrives — await it rather than assume ordering.
  await waitFor(() => b.lastFrame !== undefined);
  check('B receives its own frame', b.lastFrame !== undefined);

  console.log('a movement intent advances the world');
  const before = JSON.stringify(a.lastFrame);
  a.ws.send(JSON.stringify({ type: 'move', dir: { x: 0, y: 1 } })); // down into open floor
  const moved = await waitFor(() => JSON.stringify(a.lastFrame) !== before);
  check("A's frame updates after moving", moved);

  console.log('malformed input is sanitized, not fatal');
  a.ws.send(JSON.stringify({ type: 'move', dir: { x: '9', y: null } })); // non-integer dir
  a.ws.send(JSON.stringify({ type: 'bogus' })); // unknown action
  a.ws.send('not json at all');
  await sleep(200);
  check('host still serving after bad input', a.ws.readyState === WebSocket.OPEN);

  console.log('chat rides the wire; internal events do not (Epic I fan-out)');
  // B speaks: it always hears itself (distance 0), so a `chat:say` event must come
  // back to B. A's earlier moves emitted entity:entered/exited internally — those
  // must NOT reach any client (the perception allowlist drops non-client events).
  b.ws.send(JSON.stringify({ type: 'say', text: 'ping' }));
  const heard = await waitFor(() => b.events.some((e) => e.type === 'chat:say' && e.text === 'ping'));
  check('speaker receives its own chat:say over the wire', heard);
  const leaked = [...a.events, ...b.events].filter((e) => e.type !== 'chat:say' && e.type !== 'access:denied');
  check('no internal events leak to clients', leaked.length === 0, leaked.map((e) => e.type).join(',') || 'none');

  a.ws.close();
  b.ws.close();
  server.close();

  // The hidden-fog transport path (FOG=hidden) is otherwise untested. Full
  // FOV-occlusion behavior is Epic I (perception) and needs controlled movement;
  // here we just prove the hidden path stands up end-to-end and delivers per-player
  // frames in which each crew sees itself — i.e. `fog:'hidden'` doesn't break the wire.
  console.log('the hidden-fog server delivers per-player frames (smoke)');
  const hidden = startStationServer({ port: PORT + 1, fog: 'hidden' });
  const ha = await connect(PORT + 1);
  await waitFor(() => ha.playerId !== undefined);
  const hb = await connect(PORT + 1);
  await waitFor(() => hb.playerId !== undefined);
  await waitFor(() => countGlyph(ha.lastFrame, '@') >= 1 && countGlyph(hb.lastFrame, '@') >= 1);
  check('hidden: A receives a frame and sees a crew', countGlyph(ha.lastFrame, '@') >= 1, `@=${countGlyph(ha.lastFrame, '@')}`);
  check('hidden: B receives its own frame', hb.lastFrame !== undefined);
  ha.ws.close();
  hb.ws.close();
  hidden.close();

  console.log(failures === 0 ? '\nALL NET PROOFS PASS' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
