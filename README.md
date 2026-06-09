# The Final Frontier

A bare-bones Space Station 13 built on [rlkit](../rlkit) — the smallest game that proves the baseline capabilities of the genre: continuously simulated atmosphere and power, a mutable hull, ID-gated access, one hidden traitor, and a lobby→shift→shuttle→reveal round loop. 4–6 players, server-authoritative over WebSocket.

## Status

**In development.** Epics 0, A, B, C, D are done (atmosphere, breathing/O₂, authoritative server + thin client, full station map, doors/access/`useOn`). Next on the critical path is Epic F (items/inventory/tools/corpses); Epic E (power) lands alongside. See [design/implementation-plan.md](./design/implementation-plan.md) for the epic sequence and per-epic proofs.

- [design/game-design.md](./design/game-design.md) — the game: round loop, station, jobs, atmos, power, traitor, config values.
- [design/engine-requirements.md](./design/engine-requirements.md) — R1–R8: what the game needs from rlkit, with acceptance sketches. The engine side designs and implements these; the game consumes them.

## Layout

```
design/        game design + engine requirements (source of truth)
src/           Vite canvas client (thin: render frames, send intents, chat)
server/        Node WS server: GameServer + round state machine + content + *-proof.ts
```

Engine is consumed from a sibling `../rlkit` checkout via tsconfig/vite alias (see `vite.config.ts`) — no publish step while both evolve.

## Running it

Requires a sibling `../rlkit` checkout (the path the tsconfig/vite alias resolves). From the repo root:

```
npm install
npm run server       # authoritative WS host (env: PORT=8787, FOG=shared|hidden)
npm run dev          # Vite client on http://localhost:5180 — connects to the server
npm test             # typecheck + every headless *-proof.ts (run before committing)
```

Individual proofs: `npm run proof` (atmos), `proof:breathing`, `proof:net`, `proof:station`, `proof:interaction`, `proof:items`.

## Workflow

Two threads, one contract: the **game designer** (this repo) specs mechanics and files capability requirements; the **engine** (rlkit) designs and implements them. Gaps are negotiated in `design/engine-requirements.md`, never patched around inside engine files.
