# Implementation plan — handoff to code

Rough, dependency-ordered build plan for The Final Frontier on top of rlkit. The
atmosphere foundation is built and proven; everything below is sequenced so each
epic lands behind a runnable proof. Design source of truth:
[game-design.md](./game-design.md); engine contract: [engine-requirements.md](./engine-requirements.md).

## Done (Epic 0 — atmosphere foundation)

`config.ts` · `content.ts` (flags, tiles, entity doors) · `station.ts` (ASCII
prefab) · `atmos.ts` (conservative-diffusion stepper) · `world.ts` ·
`atmos-proof.ts`. `npm run proof` green (seal / door / breach / determinism),
`npm run typecheck` clean. Proves engine **R1** (flag layer + `registerStepper`)
and **R2** (`setTileEffect`).

## Conventions (a coding agent must hold these)

- **Engine from source.** Import `from '../../rlkit/src/index'` in `server/`
  (node/tsx); the client uses the `rlkit` vite alias. Never edit engine files —
  gaps go to `engine-requirements.md` as a new R-item, not a patch.
- **Config vs logic.** Every number/rate/threshold/glyph/table lives in
  `config.ts` (or a registry). Rules read from it. If you're typing a literal
  number into a rule, it belongs in config.
- **Systems, not one-offs.** Doors, lockers, the generator are all "entity with
  components + an `on:bump`/`useOn` rule." Extract the shared shape; don't
  special-case each.
- **Proof per epic.** Each epic ends with a headless `*-proof.ts` (runnable via
  an `npm run` script) or, for client work, a typecheck + manual checklist. Tests
  record *intended* behavior; a failing proof is a real regression or a changed
  intent, never silenced.
- **Two clocks.** Global rates → world-tick steppers; per-actor rates → per-actor
  status ticks. `ticksPerSecond = 25`; convert seconds via `config.seconds()`.
- **Commits:** no co-author lines.

## Critical path to a playable traitor round

Epic 0 ✅ → **A** breathing → **B** server+client → **C** full station → **D**
doors/access/`useOn` → **F** items/ID → **H** round loop → **I** hidden-info+chat.
E (power) and G (combat) and J (HUD polish) hang off the path and can land in
parallel once their deps exist.

---

## Epic A — Breathing, suffocation, O₂ tanks

Makes a breach a *threat*. Per-actor, on the actor's own clock.

- **Depends on:** 0.
- **Engine:** resources + `changeResource` thresholds; per-actor status ticks
  (statuses module). No new engine.
- **Tasks:**
  - `oxygen` resource + `breathing` system: each actor tick, sample pressure at
    its cell; below `breathThreshold` drain O₂, else regen; O₂ at 0 → HP damage
    `cause:'suffocation'`; HP 0 → `died`.
  - O₂ tank item: while equipped/active, pause the drain for `tankDuration`.
  - `breathing-proof.ts`: actor in a breached room loses O₂ then HP then dies;
    same actor with an active tank survives the same breach.

## Epic B — Authoritative server + thin client

See the station and move in it. Mirror `examples/netcoop`.

- **Depends on:** 0 (A for the O₂ HUD field).
- **Engine:** `createGameServer` (`join`/`enqueue`/`tick`/`viewFor`/`snapshot`),
  `tickRealtimeMulti`, `ServerUpdate.events` (**R4**), `PlayerView<E>` +
  `viewExtra` (**R6**), `canViewerSee` (**R4**).
- **Tasks:**
  - `server/server.ts`: wrap the station world in a `GameServer`; spawn a crew
    actor per `join`; fixed 25/s tick loop; fan `viewFor` to each socket.
  - `server/index.ts`: WS host (PORT/FOG env), message decoder map (start with
    `move`; built to take `useOn` later — **R5** seam).
  - `src/main.ts`: canvas client — connect, render frames, send move intents.
  - **Proof:** two clients connect, move on the station, see each other (shared
    fog); `npm run typecheck`.

## Epic C — Full station map

Grow `station.ts`'s `MAP` to the game-design §3 layout.

- **Depends on:** 0.
- **Engine:** none (content).
- **Tasks:** author the full ASCII (bridge+window+locker, engineering+generator,
  storage, dorms, bar, maintenance loop, arrivals+shuttle); add the `wire` layer
  cells; mark room rects, spawn points, vent cells. Extend the char→tile/entity
  decoder for vents and wire. **Proof:** a `station-proof.ts` asserting the map is
  fully hull-enclosed (no floor touches space except through a window/door) and
  every room is airtight-sealed at spawn.

## Epic D — Doors, access, the `useOn` verb

The permission structure + the tool economy's dispatch.

- **Depends on:** B (intents), C (doors in the map).
- **Engine:** `BumpInteraction`/`on:bump` (**R7**, `BLOCK`); `ActionMap` merge +
  `useOn` handler (**R5**); tags for access.
- **Tasks:**
  - Register a door `on:bump` rule: open if carried-ID access passes AND powered
    AND unbolted; else `BLOCK` + a denied event.
  - `useOn` action variant (discriminated `{kind:'entity'|'cell'}` target) +
    handler registry keyed by (tool tag × target tag/state).
  - ID-card item with access tags; locker entity (access-checked open; pryable).
  - **Proof:** `interaction-proof.ts` — right ID opens, wrong ID blocks, emag
    opens+breaks, crowbar pries an unpowered door.

## Epic E — Power network

- **Depends on:** C (wire layer), D (doors consult power).
- **Engine:** `createNetworkManager` + flag-backed `NetworkDescriptor` (**R3**).
- **Tasks:** generator entity (fuel resource drained by a world-tick stepper;
  on/off); `wire` network index; `powered(cell) = sameNetwork(cell, genCell) &&
  running`; doors/vents/locker read `powered`. **Proof:** cut a wire → downstream
  door unpowered (pry-only) and its vent stops repressurizing; relay cable →
  restored.

## Epic F — Items, inventory, tools, corpses

- **Depends on:** D (`useOn`), A (tanks), E (wire edits for cutters/cable).
- **Engine:** inventory/equipment core; `setTileEffect` (welder/wrench edits).
- **Tasks:** tool items (welder, wrench, crowbar, wirecutters, cable, knife,
  emag, O₂ tank, intel disk); pickup/drop; corpse entity on `died` carrying full
  inventory; loot via `on:bump`/`useOn`. Wire tool behaviors into `useOn`
  dispatch (welder→repair breach, wrench→smash window, cutters→cut wire,
  cable→relay). **Proof:** `tools-proof.ts` — smash window (vents), weld it shut
  (repressurizes), cut+relay a wire (power drops+restores), loot a corpse's ID.

## Epic G — Combat via explicit strikes

- **Depends on:** F (weapons), B.
- **Engine:** combat module (damage/death); `useOn` entity target. `bumpToAttack`
  stays `false`.
- **Tasks:** `useOn(weapon, targetEntity)` → combat damage by `weaponDamage`
  table; death → corpse (Epic F). **Proof:** knife strike kills in N hits, drops a
  lootable corpse; bumping a crewmate never deals damage.

## Epic H — Round loop + traitor + objective

- **Depends on:** B (server), C (spawns), F (disk/ID).
- **Engine:** timeline delayed effects (world clock) for shuttle/round timers;
  `snapshot()` for rejoin.
- **Tasks:** server-side FSM `lobby→setup→shift→departure→reveal`; job assignment
  + secret traitor draw; spawns by job; shuttle airlock lock/unlock on timers;
  win/loss eval (disk-leaves-on-shuttle + per-crew survival); reveal payload.
  **Proof:** `round-proof.ts` drives a scripted round headless: traitor takes the
  disk, boards the shuttle, round ends with the correct outcome.

## Epic I — Hidden info, chat, perception

- **Depends on:** B.
- **Engine:** hidden-fog `viewFor`; `canViewerSee` (**R4**); `core/geometry` for
  hearing distance.
- **Tasks:** per-player hidden-fog frames; local `say` within `hearingRadius`
  (distance, game-side); ghost chat for the dead; private role briefings; denied
  beeps gated by `canViewerSee`. **Proof:** a player only receives chat/entities
  it can hear/see; a ghost sees all.

## Epic J — Client HUD + interaction UX

- **Depends on:** B, A, D.
- **Engine:** `viewExtra` payload (**R6**).
- **Tasks:** O₂ bar, role card, round clock, held item from `extra`; an
  adjacent-target interaction prompt for `useOn`; chat panel. **Proof:**
  typecheck + manual checklist (HUD reflects O₂ drop during a breach; no other
  player's `extra` leaks under hidden fog).

---

## Sequencing notes

- **Parallelizable:** A ∥ B ∥ C (independent). E after C+D. G after F. J trails B.
- **First playtest milestone:** 0+A+B+C+D+F+H+I — a round you can win or lose as
  traitor. E/G/J deepen it.
- **No engine asks expected** for any epic — batch-1 (R1–R7) covers all of this.
  If a gap appears, stop and file an R-item rather than working around it.

## Deferred (post-v0, already scoped out in game-design §10)

Reagents/medical · lighting · body-dragging · radio · construction from raw
materials · multiple antagonists/events · temperature/fire · cross-round
persistence · moving shuttle · channeled (interruptible) actions · active-region
atmos optimization.
