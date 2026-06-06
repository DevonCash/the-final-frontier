# The Final Frontier — Game Design (v0)

A bare-bones Space Station 13. Not a clone — the smallest game that **proves every baseline capability the genre requires**: a continuously simulated station (air, power), a mutable hull, access-gated space, hidden-role social play, and a round structure, all real-time multiplayer.

- **Players:** 4–6 humans, one secret traitor. Server-authoritative over WebSocket (rlkit `GameServer`), thin canvas clients.
- **Round length:** ~10 minutes lobby-to-reveal.
- **Design stance:** every number in this doc is a *configurable value* (see §9), not a rule. Rules are the systems in §4–8.

## 1. The proof

v0 succeeds when one playtest round can contain this story, with no step faked:

> The engineer notices the bar is cold — someone cut a wire in maintenance. While she's re-laying cable, the traitor emags into the bridge, takes the intel disk from the locker, and smashes the bridge window to leave through space (he stole an O₂ tank earlier). The bridge vents; the captain, caught inside, suffocates against a door that has no power. The engineer repairs the breach and re-pressurizes, too late. The shuttle docks; the traitor boards among the survivors; the round ends and the reveal names him.

Every sentence above exercises a different baseline system. That's the genre test.

## 2. Round loop

A server-side state machine **above** the rlkit world (the world exists only during `shift`/`departure`).

| State | Entry | Exit | What happens |
|---|---|---|---|
| `lobby` | server start / round end | ≥ `minPlayers` ready | OOC chat, ready-up |
| `setup` | lobby exit | instantaneous | build world, assign jobs, secretly pick 1 traitor, spawn, private role briefings |
| `shift` | setup done | clock hits `shuttleAt` | the game |
| `departure` | shuttle docks (announcement) | clock hits `roundLength` | shuttle airlock unlocks; everyone scrambles |
| `reveal` | departure end | players ready again | who escaped, who died, traitor identity, objective outcome → back to `lobby` |

**Outcomes.** Each crew member individually *survives* if alive aboard the shuttle at departure. The **traitor wins** if he escapes alive carrying the intel disk. The **crew wins** if the disk doesn't leave (still on station, or held by a crew member aboard). Both can partially win (traitor escapes without disk = survived, failed).

## 3. The station

One level, ~64×48, hand-authored prefab (rlkit vault stamping), surrounded by space tiles. No second deck in v0.

```
            ┌─────────────┐
   space    │   BRIDGE    │◄─ windows (breakable, face space)
            │ capt+locker │
┌───────────┴──┬───┬──────┴───────────┐
│ ENGINEERING  │ C │   DORMS          │
│ generator    │ O │   crew spawn     │
│ fuel, tools  │ R │                  ├────────┐
├──────────────┤ R ├──────────────────┤ARRIVALS│⇐ shuttle berth
│ STORAGE      │ I │   BAR            │ dock   │   (locked until
│ O2 tanks,    │ D │   (social space) │        │    departure)
│ cable, spare │ O │                  ├────────┘
└──────────────┴─R─┴──────────────────┘
      └── maintenance loop (engineer access) wraps the perimeter ──┘
```

Room roles: **Bridge** (captain spawn; wall locker holding the *intel disk*; the only bridge-access door; external windows). **Engineering** (generator, fuel canisters ×2, tool rack: welder/wrench/crowbar/wirecutters/cable). **Storage** (O₂ tanks ×3, spare welder, spare cable). **Dorms** (crew spawn). **Bar** (nothing — social gravity). **Maintenance loop** (engineer access; wires run here; dark corners for crime). **Arrivals** (shuttle airlock, locked until departure). One **external airlock** off maintenance (EVA route).

The wire layer runs generator → every door, vent, and the bridge locker, mostly through maintenance (sabotage has a *place*).

## 4. People

### 4.1 Jobs

| Job | Count | Access | Loadout |
|---|---|---|---|
| Captain | 1 | all | intel disk *(in bridge locker, not on person)*, ID |
| Engineer | 1–2 | basic, engineering, maintenance | toolbelt (welder, wrench, crowbar, wirecutters, cable ×10), O₂ tank, ID |
| Crew | rest | basic | ID |

The **traitor** is any one of them — job assignment and traitor selection are independent draws. Traitor briefing (private): objective + an **emag** (3 charges; forces any door/locker open, permanently breaking it open) and a **knife** (best melee in game) already in his pocket.

### 4.2 Bodies, death, ghosts

Death (any cause) drops the actor from the timeline; the **corpse persists as an entity** carrying full inventory. Anyone adjacent can loot it (this is how IDs and the disk change hands violently). The dead player becomes a **ghost**: full-map view, sees all chat, sends only ghost-chat (visible to ghosts alone). No respawn in v0.

### 4.3 Chat

- **Local say:** delivered to players whose actor is within `hearingRadius` of the speaker. Positional speech is the traitor's cover and the crew's forensics — this is a hidden-information channel, not chrome.
- **Ghost chat / lobby OOC:** unrestricted, out-of-world.
- No radio in v0 (the station is small enough to walk).

Server announcements (shuttle call, round end) broadcast to all.

## 5. Atmosphere

The signature system. One **pressure layer** (Float32, kPa) over the station level; space cells pinned to 0, station sealed at `nominalPressure`.

- **Flow:** every `atmosCadence` world ticks, a conservative diffusion step moves pressure between **airflow-connected** neighbors. Mass is conserved except space cells, which are an infinite sink. Airflow-blocking: walls, intact windows, *closed* doors. Open any path to space and the connected rooms drain.
- **Breathing:** each actor, on its own clock: pressure at feet < `breathThreshold` → drain `oxygen` resource; at 0, hp damage (`cause: 'suffocation'`). Above threshold, `oxygen` regenerates. An active **O₂ tank** (finite, `tankDuration`) pauses the drain — the EVA enabler.
- **Repressurize:** each room has a **vent** entity that adds `ventRate` pressure per second at its cell *while powered* — diffusion spreads it. Vents are the atmos→power coupling.
- **Cause & repair:** windows smash (`windowHits` melee hits) and walls cut open (welder, `wallCutUses` uses) into breaches. Welder on a breach restores the original tile (each use adds `1/repairUses` progress — no channeled-action machinery needed in v0).

## 6. Power

One network, deliberately fragile.

- **Generator** (engineering): on/off switch, `fuel` resource draining per second while on; refuel from canisters. Starts with ~`initialFuelMinutes` of fuel — *less than a full round*, so someone must tend it (forced movement around the map, alibi texture).
- **Wires:** a per-cell wire layer. A cell is **powered** iff wire-connected to a running generator. **Wirecutters** on a wired cell cut it (drops a cable item); **cable** re-lays it. Wires under floors are visible only on engineering-ish inspection — v0: visible to everyone standing on them (keep it simple).
- **Consumers:** *doors* — unpowered doors don't open on bump; a **crowbar pries** them (anyone, no access check: power loss degrades the access system, which is the point). *Vents* — stop repressurizing. *Bridge locker* — unpowered locker can be pried too.
- Lighting/darkness: **cut from v0** (see §10).

## 7. Doors, access, things

- **Airlocks** are door entities (own components, *not* the tile-swap doors module — v0 doors carry access/power/bolt/emag state a tile can't hold): closed/open, auto-close after `doorAutoClose`, airflow-blocking when closed (contributes the `airtight` flag while closed; toggled via `tileFlags` + `invalidateCell`), each tagged with a required access (or none).
- **Bump = interact, never attack (R7).** Walking into a door fires the door's `on:bump` handler: open if the bumper's carried ID passes access *and* the door is powered and unbolted; otherwise blocked (free bump) with a denied beep. Same channel for lockers (open, access-checked) and corpses (loot). Walking into a person blocks or swaps — there is no bump-to-attack (this genre's combat is intent-based, so I don't register combat's `on:bump` rule).
- **ID cards** are items carrying access tags; the access check reads the *carried* ID. IDs loot from corpses. Stealing the captain's ID is a legitimate traitor route to the disk (the locker checks `bridge` access).
- **Interactions** are tool-on-target via one `useOn` verb (R5): welder→breach/wall, wrench→window (smash), wirecutters→wire, cable→cut wire, crowbar→unpowered door/locker, emag→any door/locker, knife/wrench/fist→person (an *explicit* harm strike, never a bump). One context-sensitive "use held item on adjacent target"; no menus.
- **Combat:** rlkit combat module for damage/death resolution, but invoked through explicit `useOn` strikes — never bump. Fists weak, wrench/crowbar medium, knife strong. Murder should be *possible and risky*, not the main loop.

## 8. The shuttle

Pre-built room behind a locked airlock at arrivals. At `shuttleAt`: announcement + airlock unlocks (basic access). At `roundLength`: round ends; everyone standing in the shuttle zone and alive has escaped. The shuttle never moves — arrival and departure are announcements and a lock state. (Cheap now; replaceable by a real docking sequence later without touching round logic.)

## 9. Configurable values (initial)

All gameplay numbers live in one `config.ts`; nothing below is hardcoded in a rule.

| Key | v0 value | Key | v0 value |
|---|---|---|---|
| `minPlayers` | 4 | `nominalPressure` | 101 kPa |
| `roundLength` | 600 s | `breathThreshold` | 50 kPa |
| `shuttleAt` | 480 s | `oxygenMax` / drain / regen | 100 / 5/s / 10/s |
| `tickRate` | 25/s | `suffocationDps` | 5 hp/s |
| `atmosCadence` | 5 ticks | `tankDuration` | 120 s |
| `hearingRadius` | 7 | `ventRate` | 8 kPa/s |
| `doorAutoClose` | 4 s | `diffusionRate` | 0.2 |
| `emagCharges` | 3 | `initialFuelMinutes` | 7 |
| `windowHits` | 3 | `wallCutUses` / `repairUses` | 5 / 3 |
| access table (§4.1) | — | weapon damage table | fists 5, tool 12, knife 25 |
| `ticksPerSecond` | 25 | `moveCost ÷ speed` | ≈ 5 ticks/step (~5 cells/s) |

**Calibration (locked with the engine).** `ticksPerSecond = 25` is the server's fixed logical timestep — there is no engine constant; my loop defines it by what I pass to `tickRealtimeMulti({ ticks })`. All durations above are wall-clock; each converts to engine units against this rate, and each rate is assigned to one of two tick surfaces:

- **World-tick steppers** (global, cadence in world-ticks): pressure equalize, vent flow, generator fuel drain. `atmosCadence = 5` ticks ⇒ atmos steps 5×/s; a per-second rate `r` becomes `r × (atmosCadence ÷ ticksPerSecond)` per step (e.g. `ventRate` 8 kPa/s ⇒ 1.6 kPa/step).
- **Per-actor status ticks** (on the actor's own clock): O₂ drain, suffocation, per-breather tank consumption — so a hasted actor doesn't desync from world seconds.
- **One-shot world-clock timers:** door auto-close, shuttle announcements, round end.

Because `ticksPerSecond` also fixes the action economy (`moveCost ÷ speed` world-ticks per action), movement speed is a first-class knob: at 25/s, ~5 ticks/step gives a ~5-cell/s walk.

## 10. Explicitly out of scope (v0)

Reagents/chemistry and medical (a `bandage` item heals a flat amount; that's it) · lighting and darkness · dragging bodies/objects · radio channels · construction from raw materials (repair restores only what stood there) · multiple antagonist types or random events · AI crew · temperature, fire, multi-gas · persistence across rounds · moving shuttle.

Each of these is a *deepening* of a system v0 already proves, not a new baseline capability.

## 11. Engine dependency map

What each mechanic stands on, and where the engine has a gap (→ [engine-requirements.md](./engine-requirements.md)).

| Mechanic | rlkit today | Gap |
|---|---|---|
| Real-time 4–6 player rounds, hidden-info frames, rejoin | `GameServer`, `tickRealtimeMulti`, `viewFor`, `snapshot()` | — |
| Movement, melee, items, corpse loot | core + combat module + inventory | — |
| **Bump → interact (door/locker/corpse), no bump-attack** | core forces bump→attack, uninterceptable | **R7** (in-pipeline `on:bump` channel; attack → combat rule) |
| Doors + access | entity-doors + tags + `airtight` flag | extend in game code (R1/R7) |
| Map prefab | vault stamping generator | — |
| Shuttle/round timers | timeline delayed effects (world clock) | — |
| Save of pressure/wire layers | devalue codec handles typed-array layers | — |
| **Atmos step** | no conservative producer; no airtightness channel | **R1** |
| **Breach/repair** | `setTile` exists, emits nothing, invalidates nothing | **R2** |
| **Power network** | no connectivity-over-layer primitive | **R3** |
| **Chat, role briefing, denied-beeps** | `tick()` doesn't expose events; no per-player event filter | **R4** |
| **Tool-on-target verb** | `useItem` targets a cell; cross-package action extension unverified | **R5** |
| **HUD (O₂ bar, role, round clock)** | `PlayerView` hardcodes `hp` only | **R6** |
