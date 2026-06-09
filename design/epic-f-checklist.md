# Epic F — Items, inventory, tools, corpses (done)

Source of truth: `design/implementation-plan.md` (Epic F), `design/game-design.md` §5–7.
Rebased onto `main` after Epic E (power) landed.

## What shipped
- `config.ts`: `render.items` extended (welder/wrench/wirecutters/cable/knife/o2tank/disk)
  + `render.corpse` + `render.layers.corpse`; `cableLength`.
- `items.ts`: tool factories for the above (main's `glyph/fg` style); an `activate`
  verb for self-used items (O₂ tank arms the suffocation pause); pickup/drop/activate
  ActionMap decls (engine handlers reused).
- `useon.ts`: cell-target rules alongside Epic-D entity rules — welder reseals a
  breach, wrench smashes a window, wirecutters/cable drive Epic E's `setWire`.
- `breach.ts`: window-smash + breach-repair as pipeline effects over `setTileEffect`.
- `corpse.ts`: `died` reactor → lootable corpse in place (keeps inventory + position);
  loot via the bump channel (R7).
- `tools-proof.ts` (+ `proof:tools`, appended to the `test` chain).

## Epic E integration (was a minimal seam pre-merge)
The standalone `server/power.ts` I wrote pre-merge was dropped. The wire tools now
drive Epic E's real network via `setWire` (generator/fuel/running gate included), and
the proof's wire scenario runs on Epic E's `buildPowerFixtureWorld`
(gen → wire → door → wire → vent): snip the gen-side wire → the downstream door reads
unpowered while the generator still runs; re-lay it → repowered.

## Gotcha recorded
Effect `validate` receives a frozen `{state, services}` view (a fresh object each
resolve), so a per-world `WeakMap<World>` MISSES in `validate` (hits in `apply`). Key
such side tables by `world.state` (shared into the view). Bit `breach.ts`.

## Out of scope / follow-ups
- `proof:net` (Epic B) is flaky under real-socket timing — pre-existing, unrelated to F.
- Wirecutters dropping a physical cable item on cut (design §6) — deferred.
- knife `useOn`→person combat is Epic G; the intel disk win-condition is Epic H.
