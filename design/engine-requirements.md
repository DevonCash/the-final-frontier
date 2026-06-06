# Engine requirements — batch 1

From the game designer to the engine. Each entry states the **gameplay goal**, the **capability contract** the game needs, **what exists today** (with file refs from a survey of rlkit @ rev 10), and an **acceptance sketch**. How to design/implement each is the engine side's call — these are requirements, not designs. Mechanics in [game-design.md](./game-design.md) reference these as R1–R6.

Blocking order: **R1, R2** block atmosphere (the slice's heart) · **R3** blocks power · **R4** blocks chat/briefings (game can prototype around it ugly, not ship without it) · **R5** blocks all tool interactions · **R6** is needed by the first playable client.

---

## R1 — Airtightness + a conservative bulk-simulation step (atmos)

**Goal:** rooms hold pressure; a breach vents connected rooms to space; closed doors hold air; re-pressurization spreads from a vent (game-design §5).

**Need:**
1. **An `airtight` query per cell** — composed from tile properties *and* occupying entities (a closed door is airtight, the same door open is not; an intact window is airtight but not walkable). This is a third channel alongside `walkable`/`transparent`; it must be cheap enough to call per-cell-pair inside a full-grid step, and it must reflect entity state changes (door opened) by the next atmos step.
2. **A sanctioned per-world-tick bulk step over a named Float32 layer** — game registers a stepper (id, layer name, cadence in world ticks) whose update runs as a *single coarse effect* (one `apply` may rewrite the whole layer), inside the normal effect→event pipeline, deterministically ordered against other steppers and actor turns. The game supplies the math (conservative diffusion is game logic); the engine supplies the slot, the cadence, the ordering, and the layer lifecycle (created with the level, serialized — the devalue codec already carries typed arrays).
3. The stepper must be able to **emit events** from its apply (e.g. a cell crossing a pressure threshold) so reactors/UI can hear it without scanning the layer.

**Today:** `FieldStore` steppers exist but only for AI field kinds (goal/scent/influence — `src/core/fields.ts`, `src/sim/ai/field.ts`); scent diffusion is non-conserving by design. Custom effects *can* write any layer (`src/core/level.ts` — `layers: Map<string, Layer>`), but nothing owns registration, cadence, ordering, or the airtight channel. Passability queries (`FieldCtx.passable`) are tile-based.

**Acceptance sketch:** headless world, two rooms joined by a door, vacuum outside. (a) Sealed: total pressure constant across 1000 steps (conservation). (b) Open the door between rooms: pressures equalize, total still constant. (c) Breach one wall tile: connected rooms decay toward 0; the room behind a *closed* door doesn't. (d) Save/load mid-vent: identical continuation. (e) Determinism: same seed+actions ⇒ identical layer bytes.

## R2 — Tile mutation as a first-class effect (breach & repair)

**Goal:** smashing a window or cutting a wall changes the world for *every* system at once — sight lines, pathing, AI fields, and R1's airflow (game-design §5, §7).

**Need:** a core `setTile`-effect that (1) validates+applies through the pipeline like any mutation, (2) emits a `tile:changed { levelId, cell, from, to }` event, and (3) that event is honored by the standard invalidation consumers: fields' `invalidateOn`, FOV/visibility recompute, and R1's airtight view. The game keeps "what stood here originally" itself (level metadata) — restoration is game logic.

**Today:** `setTile(level, cell, idx)` is a bare synchronous function (`src/core/tiles.ts`); it emits nothing and nothing invalidates. Fields would notice lazily at next recompute; FOV would not.

**Acceptance sketch:** actor adjacent to a wall with a goal field and FOV computed; apply the effect swapping wall→floor: event observed, field re-routes through the opening on its next read, FOV sees through it same turn, R1 step treats the cell as non-airtight on its next cadence.

## R3 — Cell-network connectivity (power; pipes later)

**Goal:** "is this door's cell wire-connected to a running generator?" — cut a wire anywhere on the path and downstream consumers lose power; re-lay it and they're back (game-design §6).

**Need:** a generic **network index over a marked cell layer**: given a layer marking member cells (wire = nonzero), maintain connected components (4-neighbor) and answer `networkOf(cell)` / `sameNetwork(a, b)` cheaply. Components recompute (or incrementally repair) when membership changes — driven by events (R2's `tile:changed`, or a `layer:changed` equivalent for wire add/cut). Multiple independent indexes must coexist (wires now, pipes later — please build the reusable primitive, not a power-specific one). Determinism and serialization: component ids must be stable under save/load or derived purely from state.

**Today:** nothing — no connectivity primitive exists. The game *could* hand-roll a flood fill over a layer, but a second game system (pipes) and the engine's own future users would each re-roll it; this is squarely "extract the reusable component."

**Acceptance sketch:** layer with two disjoint wire blobs → two networks; mark one bridging cell → one network; unmark it → two again, and a consumer that was powered via the bridge reads unpowered on the next query. Save/load preserves answers.

## R4 — Tick events out, per-player delivery in (chat, briefings, sounds)

**Goal:** local chat within `hearingRadius`, private traitor briefing, a "door denied" beep only the people who can see/hear it get, announcements to all, ghosts seeing everything (game-design §4.2–4.3). Today the app layer can't even *see* what happened in a tick.

**Need:**
1. **`tick()` returns (or streams) the `GameEvent`s emitted during that tick**, in order, so the transport can fan them out. Without this the game would have to monkey-patch the event bus.
2. **A per-viewer filter the app can use:** expose the per-player visibility predicate that `viewFor`'s hidden-fog mode already uses internally (`canSee(viewerId, cell)`-shaped), so the game can decide "does player P perceive event E" itself. Chat itself stays app-layer (it's WS protocol, not sim) — but it needs the same predicate for hearing checks, so it must be queryable, not buried in the frame builder.

**Today:** `ServerUpdate` is `{ worldClock, acted, idle }` — no events (`src/multiplayer/server.ts`). Hidden-fog visibility lives in private `visibleLayerFor` closures inside `createGameServer`. `src/sim/visibility.ts` exists — possibly just needs a public, per-player-keyed surface.

**Acceptance sketch:** two players in separate sealed rooms, fog hidden; one bumps a locked door: the events for the tick are available to the transport; the visibility predicate says player A perceives the bump and player B doesn't; a dead player (off-timeline) can still be evaluated as an all-seeing viewer (or the predicate composes with a game-side ghost override).

## R5 — Entity-targeted interaction action (tool on target)

**Goal:** the whole tool economy — welder on breach, wirecutters on wire cell, crowbar on unpowered door, emag on locker, hand on corpse (game-design §7).

**Need:** confirmation (or extension) that a **game package** can register: a new `Action` variant shaped like `{ type: 'useOn', actor, item?, target: EntityId | Cell }`, its handler, and its client command mapping — across the package boundary, with the documented `ActionMap`/`EventMap` declaration-merging working from an external consumer of `rlkit`'s public types. Dispatch-by-tool-and-target-tags is game logic; the engine just has to make the extension seam real (and reachable through the netcoop-style server's input path, which currently sanitizes only `move`).

**Today:** core `useItem` targets `Cell` only; declaration merging is specced (docs §7.2) but unverified from outside the workspace. The netcoop server hardcodes the move-only protocol — fine, that's example code, but the input sanitization pattern needs to be reusable for game-defined actions.

**Acceptance sketch:** this repo declares `useOn`, registers a handler, sends it client→server→`enqueue`→resolution, typechecks against published types with no `any` and no patching of engine files.

## R6 — Game-defined per-player view payload (HUD)

**Goal:** the client HUD needs O₂ bar, role card, round clock, held-item — per player, beyond hp (game-design §11).

**Need:** `viewFor`/`PlayerView` accepts a game-supplied extension — e.g. the server factory takes a `viewExtra(world, playerId) => T` and `PlayerView` carries it generically — instead of the engine hardcoding which resources are HUD-worthy.

**Today:** `PlayerView` is `{ frame, hp?, alive }` with `hp` special-cased in `createGameServer.viewFor` (`src/multiplayer/server.ts:129-141`). The pattern is right; it just needs to be open.

**Acceptance sketch:** game supplies `viewExtra` returning `{ oxygen, role, clock }`; a hidden-fog client receives it for itself and never receives another player's extras.

---

## R7 — In-pipeline `on:bump` channel (surfaced during R1–R6 review; engine-accepted)

**Goal:** bumping a door opens it (access/power/bolt-gated), bumping a locker/corpse interacts — and bumping a person does *not* auto-attack. This genre's combat is intent-based; a strike must be an explicit `useOn` (game-design §7).

**Why it's a requirement, not game code:** the core move handler redirects a bump into a non-passable occupant straight to `attack` (when combat is present), and that redirect runs *before* pre-reactors — so the game cannot intercept it, and a post-`bumped` reactor can't carry the turn cost.

**Resolution (engine-accepted):** bump-into-occupant consults registered `on:bump` handlers `(ctx, actor, target) => Action | undefined`; redirects to the first claim, inheriting its cost; no claim → `blocked` (free bump). Attack moves out of core movement into the **combat module** as *its* `on:bump` rule — so a game that doesn't register combat's rule has no bump-attack. The game registers door/locker/corpse `on:bump` handlers returning its `useOn` interaction (R5).

**Open question for the engine:** when a cell has multiple `on:bump` claimants, what orders "first claim" — registration order or a priority field? Doesn't bite v0 (interactables don't stack), but needs to be deterministic and declared before they can.

**Acceptance sketch:** entity-door with an `on:bump` handler opens on bump when access+power pass, blocks (free) otherwise; with combat's rule unregistered, bumping a person never deals damage; the door handler's returned action carries its own cost.

---

## Resolution status

| Req | State | Notes |
|---|---|---|
| R1 | accepted | flag registry + `flags` layer + `registerStepper`; `pressure` persists, `flags`/`visible`/`field:*` transient. Airtight-via-entity path: mutate `tileFlags` **then** `invalidateCell`. |
| R2 | accepted | `setTileEffect` → `tile:changed`; fields/FOV/airtight honor it. Windows-as-tiles ride this. |
| R3 | accepted | flag-backed network index, `networkOf`/`sameNetwork`, lazy relabel, min-cell id. |
| R4 | accepted | `ServerUpdate.events` + `canViewerSee` (LoS, hidden-fog only). Hearing is game-side (distance over `core/geometry`; optional muffling via `airtight`). |
| R5 | accepted | `ActionMap`/`EventMap` merge; discriminated `{kind:'entity'\|'cell'}` target. |
| R6 | accepted | `PlayerView<E>` + `viewExtra`, viewer-only contract. |
| R7 | accepted | `on:bump` channel; attack → combat module rule. |

**Calibration handshake (resolved):** `ticksPerSecond` is a game constant (no engine const), set to **25**, coupled to the action economy (`moveCost ÷ speed` ticks/action). Global env rates → world-tick steppers; per-actor rates → per-actor status ticks; see game-design §9.

## Noted, not asked (v0 works around these)

- **Channeled actions** (3-second weld, interruptible): v0 fakes it as N discrete uses per repair. A real primitive is a likely batch-2 ask.
- **Active-region atmos optimization:** at 64×48 a full sweep each cadence is fine. Revisit if maps grow.
- **Lighting layer:** cut from v0 scope entirely.
