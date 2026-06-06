# The Final Frontier

A bare-bones Space Station 13 built on [rlkit](../rlkit) — the smallest game that proves the baseline capabilities of the genre: continuously simulated atmosphere and power, a mutable hull, ID-gated access, one hidden traitor, and a lobby→shift→shuttle→reveal round loop. 4–6 players, server-authoritative over WebSocket.

## Status

**Design phase.** No game code yet — implementation starts once the batch-1 engine requirements are settled.

- [design/game-design.md](./design/game-design.md) — the game: round loop, station, jobs, atmos, power, traitor, config values.
- [design/engine-requirements.md](./design/engine-requirements.md) — R1–R6: what the game needs from rlkit, with acceptance sketches. The engine side designs and implements these; the game consumes them.

## Layout (planned)

```
design/        game design + engine requirements (source of truth)
src/           Vite canvas client (thin: render frames, send intents, chat)
server/        Node WS server: GameServer + round state machine + content
```

Engine is consumed from a sibling `../rlkit` checkout via tsconfig/vite alias (see `vite.config.ts`) — no publish step while both evolve.

## Workflow

Two threads, one contract: the **game designer** (this repo) specs mechanics and files capability requirements; the **engine** (rlkit) designs and implements them. Gaps are negotiated in `design/engine-requirements.md`, never patched around inside engine files.
