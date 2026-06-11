/**
 * main — the thin canvas client. Connects to the authoritative station server over
 * WebSocket, renders each per-player frame the server sends, and forwards intents.
 * All rules live server-side; this is render + input only. The HUD (Epic J) is painted
 * entirely from the viewer's own `PlayerView.extra` (R6) — O₂ bar, role card, round
 * clock, held item, and an adjacent-target `useOn` prompt — plus a local chat panel fed
 * by `{type:'event'}` (Epic I). The HUD's labels/colors/thresholds arrive once in the
 * `welcome` payload so config.ts stays the single source of truth.
 */
import { CanvasRenderer, type RenderFrame } from 'rlkit';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const TILE = 16;
const renderer = new CanvasRenderer(ctx, { tileSize: TILE, font: `${TILE}px monospace` });
const statusEl = document.getElementById('status')!;

// HUD elements (Epic J).
const hudEl = document.getElementById('hud')!;
const o2Fill = document.getElementById('o2-fill') as HTMLElement;
const o2Text = document.getElementById('o2-text')!;
const roleCard = document.getElementById('role-card') as HTMLElement;
const clockRow = document.getElementById('clock-row')!;
const clockEl = document.getElementById('clock')!;
const heldEl = document.getElementById('held')!;
const promptEl = document.getElementById('prompt')!;
const chatEl = document.getElementById('chat')!;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;

// Server WS port — must match the server's PORT env (default 8787). Override for a
// non-default server with ?port=NNNN on the page URL.
const SERVER_PORT = Number(new URLSearchParams(location.search).get('port')) || 8787;
const WS_URL = `ws://${location.hostname}:${SERVER_PORT}`;
let socket: WebSocket | undefined;
let playerId: string | undefined;

// --- perf instrumentation (dormant unless ?perf=1) --------------------------
// Attributes the per-frame budget across the wire (view msgs/s, KB/s), parse,
// canvas draw, and HUD paint, plus real on-screen fps via rAF. Logs a rolling
// per-second summary to the console. Zero cost when the flag is off.
const PERF = new URLSearchParams(location.search).get('perf') === '1';
const perf = { frames: 0, draws: 0, extras: 0, bytes: 0, parse: 0, draw: 0, hud: 0, raf: 0 };
if (PERF) {
  const rafTick = (): void => {
    perf.raf++;
    requestAnimationFrame(rafTick);
  };
  requestAnimationFrame(rafTick);
  setInterval(() => {
    const d = perf.draws || 1;
    const f = perf.frames || 1;
    console.log(
      `[perf] view ${perf.frames}/s  draws ${perf.draws}/s  extra ${perf.extras}/s  ${(perf.bytes / 1024).toFixed(1)}KB/s  ` +
        `rAF ${perf.raf}fps  parse ${(perf.parse / f).toFixed(2)}ms  draw ${(perf.draw / d).toFixed(2)}ms  ` +
        `hud ${(perf.hud / f).toFixed(2)}ms`,
    );
    perf.frames = perf.draws = perf.bytes = perf.parse = perf.draw = perf.hud = perf.raf = 0;
  }, 1000);
}

// The HUD presentation config shipped in `welcome` (mirrors config.ts `HudConfig`).
interface HudConfig {
  oxygen: { fill: string; low: string; lowFraction: number };
  roles: Record<string, { label: string; color: string }>;
  targets: { door: string; locker: string; key: string };
  clock: Record<string, string>;
}
let hud: HudConfig | undefined;

// Cap the chat panel's DOM nodes so a long session can't grow it unboundedly.
const MAX_CHAT_LINES = 100;

interface CrewExtra {
  oxygen?: { current: number; max: number };
  role?: { job: string; traitor: boolean };
  held?: { name: string; kind?: string };
  targets?: Array<{ id: string; cell: number; label: string }>;
  clock?: { phase: string; secondsRemaining?: number };
}
interface ViewMsg {
  type: string;
  viewport?: { width: number; height: number };
  hud?: HudConfig;
  playerId?: string;
  frame?: RenderFrame;
  alive?: boolean;
  extra?: CrewExtra;
  event?: { type: string; speaker?: string; text?: string; cell?: number };
}

// The viewer's current adjacent target (if any) — what the interact key acts on.
let target: { id: string; cell: number; label: string } | undefined;
let held: CrewExtra['held'];
// Latest HUD state, applied whenever a `view` or `extra` message lands.
let alive = false;
let lastExtra: CrewExtra | undefined;

// paintHud write-guards: only touch the DOM when a field actually changed, so the
// throttled per-tick HUD updates don't thrash layout for unchanged role/held/prompt.
const painted: Record<string, string> = {};
function set(el: HTMLElement, key: string, prop: 'textContent' | 'width' | 'background' | 'color', val: string): void {
  if (painted[key] === val) return;
  painted[key] = val;
  if (prop === 'textContent') el.textContent = val;
  else (el.style as unknown as Record<string, string>)[prop] = val;
}

function paintHud(extra: CrewExtra | undefined, isAlive: boolean): void {
  if (hudEl.hidden) hudEl.hidden = false;

  // O₂ bar: fill width by fraction, switching to the low color below the threshold.
  const o2 = extra?.oxygen;
  if (o2 && hud) {
    const frac = Math.max(0, Math.min(1, o2.current / o2.max));
    set(o2Fill, 'o2w', 'width', `${frac * 100}%`);
    set(o2Fill, 'o2bg', 'background', frac <= hud.oxygen.lowFraction ? hud.oxygen.low : hud.oxygen.fill);
    set(o2Text, 'o2t', 'textContent', `${o2.current}/${o2.max}`);
  } else {
    set(o2Fill, 'o2w', 'width', '0');
    set(o2Text, 'o2t', 'textContent', '');
  }

  // Role card: the job's label/color, with the traitor accent when the viewer is one.
  const role = extra?.role;
  if (role && hud) {
    const job = hud.roles[role.job]?.label ?? role.job;
    set(roleCard, 'roleT', 'textContent', role.traitor ? `${job} · ${hud.roles.traitor?.label ?? 'Traitor'}` : job);
    set(roleCard, 'roleC', 'color', (role.traitor ? hud.roles.traitor : hud.roles[role.job])?.color ?? '#9cf');
  } else {
    set(roleCard, 'roleT', 'textContent', '—');
  }

  // Round clock: only when the host actually provides one (the simple host does not).
  if (extra?.clock && hud) {
    if (clockRow.hidden) clockRow.hidden = false;
    const label = hud.clock[extra.clock.phase] ?? extra.clock.phase;
    const secs = extra.clock.secondsRemaining;
    set(clockEl, 'clk', 'textContent', secs === undefined ? label : `${label} · ${Math.ceil(secs)}s`);
  } else if (!clockRow.hidden) {
    clockRow.hidden = true;
  }

  held = extra?.held;
  set(heldEl, 'held', 'textContent', held ? held.name : '—');

  // Interaction prompt: the first adjacent usable target, but only when the held item
  // is actually a tool — `useOn` needs a tool kind, so an ID card can't act on a door.
  target = extra?.targets?.[0];
  set(
    promptEl,
    'prompt',
    'textContent',
    isAlive && target && hud && held?.kind ? `[${hud.targets.key}] use ${held.name} on ${target.label}` : '',
  );
}

/** Append a chat line. `text` is verbatim from another player — `textContent` only (no XSS). */
function appendChat(speaker: string | undefined, text: string | undefined): void {
  if (!text) return;
  const line = document.createElement('div');
  line.className = speaker === playerId ? 'chat-line chat-self' : 'chat-line';
  const who = document.createElement('span');
  who.className = 'chat-speaker';
  who.textContent = `${speaker === playerId ? 'you' : (speaker ?? '???')}: `;
  line.append(who, document.createTextNode(text));
  chatEl.append(line);
  while (chatEl.childElementCount > MAX_CHAT_LINES) chatEl.firstElementChild!.remove();
  chatEl.scrollTop = chatEl.scrollHeight;
}

let denyTimer: ReturnType<typeof setTimeout> | undefined;
/** Flash the prompt red briefly when a useOn was denied (Epic I `access:denied`). */
function flashDenied(): void {
  const prev = promptEl.textContent ?? '';
  promptEl.classList.add('denied');
  promptEl.textContent = 'access denied';
  painted.prompt = 'access denied'; // keep the write-guard cache in sync (see `set`)
  clearTimeout(denyTimer);
  denyTimer = setTimeout(() => {
    promptEl.classList.remove('denied');
    // Restore the prompt if a fresh frame hasn't already repainted it (static world).
    if (promptEl.textContent === 'access denied') {
      promptEl.textContent = prev;
      painted.prompt = prev;
    }
  }, 600);
}

function connect(): void {
  const ws = new WebSocket(WS_URL);
  socket = ws;
  ws.onopen = () => (statusEl.textContent = 'connected — you are a crew member');
  ws.onclose = () => {
    statusEl.textContent = 'disconnected — retrying…';
    setTimeout(connect, 1000);
  };
  ws.onmessage = (ev) => {
    const data = ev.data as string;
    const t0 = PERF ? performance.now() : 0;
    let msg: ViewMsg;
    try {
      msg = JSON.parse(data) as ViewMsg;
    } catch {
      return; // ignore a malformed frame rather than throwing in the handler
    }
    if (PERF) {
      perf.parse += performance.now() - t0;
      perf.bytes += data.length;
    }
    if (msg.type === 'welcome' && msg.viewport) {
      canvas.width = msg.viewport.width * TILE;
      canvas.height = msg.viewport.height * TILE;
      hud = msg.hud;
      playerId = msg.playerId;
    } else if (msg.type === 'view' && msg.frame) {
      // Render frame (cells only). The server now dedups frames, so every `view` that
      // arrives is a real visual change — draw it. The HUD rides separate `extra` msgs.
      if (PERF) perf.frames++;
      const t1 = PERF ? performance.now() : 0;
      renderer.draw(msg.frame);
      const t2 = PERF ? performance.now() : 0;
      alive = msg.alive ?? alive;
      statusEl.textContent = alive ? 'you' : 'YOU DIED';
      paintHud(lastExtra, alive); // alive may have flipped; targets/o2 come from lastExtra
      if (PERF) {
        perf.draws++;
        perf.draw += t2 - t1;
        perf.hud += performance.now() - t2;
      }
    } else if (msg.type === 'extra') {
      // Throttled HUD update — no canvas redraw, just guarded DOM writes.
      const t = PERF ? performance.now() : 0;
      lastExtra = msg.extra;
      alive = msg.alive ?? alive;
      paintHud(lastExtra, alive);
      if (PERF) {
        perf.extras++;
        perf.hud += performance.now() - t;
      }
    } else if (msg.type === 'event' && msg.event) {
      if (msg.event.type === 'chat:say') appendChat(msg.event.speaker, msg.event.text);
      else if (msg.event.type === 'access:denied') flashDenied();
    }
  };
}
connect();

const KEYS: Record<string, { x: number; y: number }> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  w: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  a: { x: -1, y: 0 },
  d: { x: 1, y: 0 },
};
window.addEventListener('keydown', (ev) => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  if (ev.target === chatInput) return; // typing in chat — don't move or interact
  const dir = KEYS[ev.key];
  if (dir) {
    socket.send(JSON.stringify({ type: 'move', dir }));
    ev.preventDefault();
    return;
  }
  // Interact (Epic J): use the held tool on the adjacent target. Gated on a tool kind
  // (matches the prompt). The server validates tool/adjacency and beeps `access:denied`
  // if it can't — the client doesn't judge.
  if ((ev.key === 'e' || ev.key === 'E') && target && held?.kind) {
    socket.send(JSON.stringify({ type: 'useOn', target: { kind: 'entity', id: target.id }, item: held.kind }));
    ev.preventDefault();
  }
});

// Local chat (Epic I `say`): send on Enter. The server fans the `chat:say` event out
// by earshot; the speaker hears itself, so it echoes back into the panel above.
chatInput.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const text = chatInput.value.trim();
  if (text && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'say', text }));
  chatInput.value = '';
});
