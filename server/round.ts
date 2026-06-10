/**
 * round — the server-side round loop, ABOVE the rlkit world (game-design §2).
 *
 * A small FSM `lobby → setup → shift → departure → reveal` that owns the world's
 * lifecycle: the world exists only during shift/departure. `createRound` is
 * transport-agnostic and headless-drivable (see `round-proof.ts`) — the WS host
 * would drive `tick`/`viewFor` per loop; the live lobby UX (ready-up, reveal
 * screen, rejoin) is Epic I/J and consumes the data this controller already exposes.
 *
 * Setup builds the world via the existing `createStationServer` (injecting a
 * job-aware spawner), draws jobs + one secret traitor from a FORKED rng stream (so
 * the draw never perturbs atmos/combat sequences), kits each crew member, seeds the
 * intel disk into the bridge locker, and bolts the shuttle airlock. Two one-shot
 * world-clock timers (`round:departure` at `shuttleAt`, `round:reveal` at
 * `roundLength`) drive the phase transitions; the controller observes their events
 * on `ServerUpdate.events` (exactly how `power.ts`'s burn timer fires).
 */
import {
  get,
  cellOf,
  type World,
  type EntityId,
  type Cell,
  type Viewport,
  type GameServer,
  type ServerUpdate,
  type PlayerView,
  type Position,
  type TimerEffect,
  type Registry,
} from '../../rlkit/src/index';
import { createStationServer, type CrewExtra } from './server';
import { LEVEL_ID, type Station, type StationMarks } from './station';
import { spawnCrew } from './content';
import { setRole, roleOf, type Job } from './role';
import { setOpen, setBolted, placeLocker } from './openable';
import {
  giveItem,
  carries,
  spawnIdCard,
  spawnIntelDisk,
  spawnWelder,
  spawnWrench,
  spawnCrowbar,
  spawnWirecutters,
  spawnCable,
  spawnO2Tank,
  spawnKnife,
  spawnEmag,
} from './items';
import { config, seconds } from './config';

export type Phase = 'lobby' | 'setup' | 'shift' | 'departure' | 'reveal';

const DEPARTURE_TIMER = 'round:departure';
const REVEAL_TIMER = 'round:reveal';
const LOCKER_ID = 'bridge-locker';
const DISK_ID = 'intel-disk';

/** Where the disk ended up when the round closed (for the win check). */
export type DiskLocation = 'on-station' | 'aboard-with-traitor' | 'aboard-with-crew' | 'aboard-loose';

export interface PlayerOutcome {
  readonly seat: string;
  readonly entityId: EntityId;
  readonly name: string;
  readonly job: Job;
  readonly traitor: boolean;
  readonly alive: boolean; // still on the timeline (not a corpse)
  readonly aboard: boolean; // alive AND standing in the shuttle zone at reveal
  readonly survived: boolean; // crew goal: alive and aboard
}

export interface RoundOutcome {
  readonly players: PlayerOutcome[];
  readonly disk: { location: DiskLocation; holder?: EntityId };
  readonly traitorWin: boolean; // traitor escaped alive WITH the disk
  readonly crewWin: boolean; // the disk did not leave (on-station or held by a crew member aboard)
}

/** A per-seat private role briefing (consumed by the client at setup; Epic I/J). */
export interface Briefing {
  readonly job: Job;
  readonly traitor: boolean;
  readonly objective: string;
}

export interface Round {
  phase(): Phase;
  addPlayer(seat: string, name?: string): void;
  removePlayer(seat: string): void;
  ready(seat: string): void;
  game(): GameServer<CrewExtra> | null;
  world(): World | null;
  tick(ticks: number): ServerUpdate | null;
  viewFor(seat: string, vp: Viewport): PlayerView<CrewExtra> | { lobby: true; phase: Phase };
  briefingFor(seat: string): Briefing | null;
  outcome(): RoundOutcome | null;
  // --- headless test/setup hooks (the proof's seam) ---
  forceSetup(opts?: { traitor?: string; seed?: number }): void;
  forceTraitor(seat: string): void;
  advanceTo(phase: 'departure' | 'reveal'): void;
  seatToEntity(seat: string): EntityId | undefined;
  lockerId(): string;
  marks(): StationMarks | null;
}

interface RoundOpts {
  seed?: number;
  fog?: 'shared' | 'hidden';
}

/** Item `kind` → factory. Keeps kit assembly a table, not a per-item branch. */
const TOOL_FACTORIES: Record<string, (w: World, id: string) => EntityId> = {
  welder: spawnWelder,
  wrench: spawnWrench,
  crowbar: spawnCrowbar,
  wirecutters: spawnWirecutters,
  cable: spawnCable,
  o2tank: spawnO2Tank,
  knife: spawnKnife,
  emag: (w, id) => spawnEmag(w, id, config.emagCharges),
};

export function createRound(opts: RoundOpts = {}): Round {
  let phase: Phase = 'lobby';
  let seed = opts.seed ?? 12345;
  const fog = opts.fog ?? 'shared';

  const roster = new Map<string, { name: string }>(); // insertion-ordered seats
  const ready = new Set<string>();

  let game: GameServer<CrewExtra> | null = null;
  let world: World | null = null;
  let station: Station | null = null;

  // Setup-time plan (filled in `assign`, consumed by the join spawner).
  let orderedSeats: string[] = [];
  let jobOf = new Map<string, Job>();
  let traitorSeat: string | undefined;
  let forcedTraitor: string | undefined;
  let joinCursor = 0;
  let crewSpawnIdx = 0;
  const seatEntity = new Map<string, EntityId>();
  let outcomeData: RoundOutcome | null = null;

  const nameOf = (seat: string): string => roster.get(seat)?.name ?? seat;

  // --- setup helpers --------------------------------------------------------

  function assign(): void {
    const seats = [...roster.keys()].filter((s) => ready.has(s));
    const rng = world!.services.rng.fork(); // isolated stream → never perturbs sim RNG
    const shuffled = rng.shuffle(seats);
    jobOf = new Map();
    shuffled.forEach((seat, i) => {
      jobOf.set(seat, i === 0 ? 'captain' : i <= config.round.engineerCount ? 'engineer' : 'crew');
    });
    traitorSeat = forcedTraitor && seats.includes(forcedTraitor) ? forcedTraitor : rng.pick(seats);
    orderedSeats = seats; // join in stable insertion order
    joinCursor = 0;
    crewSpawnIdx = 0;
  }

  function spawnCellFor(job: Job): Cell {
    const m = station!.mark;
    if (job === 'captain' && m.captainSpawn !== undefined) return m.captainSpawn;
    const slots = m.spawns;
    return slots[crewSpawnIdx++ % slots.length]!;
  }

  function giveKit(w: World, actorId: EntityId, seat: string, job: Job, traitor: boolean): void {
    giveItem(w, actorId, spawnIdCard(w, `id-${seat}`, [...config.access.ids[job]]));
    const tools = [...(job === 'engineer' ? config.kits.engineer : []), ...(traitor ? config.kits.traitor : [])];
    for (const kind of tools) {
      const make = TOOL_FACTORIES[kind];
      if (make) giveItem(w, actorId, make(w, `${kind}-${seat}`));
    }
  }

  /** The GameServer join spawner (injected into createStationServer). */
  function spawnNextSeat(w: World): EntityId {
    const seat = orderedSeats[joinCursor++]!;
    const job = jobOf.get(seat)!;
    const traitor = seat === traitorSeat;
    const id = spawnCrew(w, LEVEL_ID, spawnCellFor(job), { id: `crew-${seat}`, name: nameOf(seat) }, config);
    setRole(w.state.entities.get(id)!, job, traitor);
    giveKit(w, id, seat, job, traitor);
    seatEntity.set(seat, id);
    return id;
  }

  function shuttleDoorId(): string | undefined {
    const cell = station!.mark.shuttleDoor;
    return cell === undefined ? undefined : station!.doors.find((d) => d.cell === cell)?.id;
  }

  function setupFixtures(): void {
    const w = world!;
    const m = station!.mark;
    // The intel disk lives in the bridge locker (access-gated). Place the locker
    // entity (the map only marks its cell) and seed its inventory with the disk.
    if (m.locker !== undefined) {
      placeLocker(w, LEVEL_ID, m.locker, { id: LOCKER_ID, access: config.access.doors.bridge });
      const disk = spawnIntelDisk(w, DISK_ID);
      w.state.entities.get(LOCKER_ID)!.components.set('inventory', { type: 'inventory', items: [disk] });
    }
    // Lock the shuttle airlock until departure (bolt denies the bump).
    const sd = shuttleDoorId();
    if (sd) setBolted(w, sd, true);

    // Round timers on the world clock: departure unlocks the shuttle, reveal ends
    // the round. The effects emit the signal; the controller owns the phase entry.
    const reg = w.services.registries.timerEffects as Registry<TimerEffect>;
    reg.override(DEPARTURE_TIMER, () => [{ type: DEPARTURE_TIMER }]);
    reg.override(REVEAL_TIMER, () => [{ type: REVEAL_TIMER }]);
    w.services.timeline.schedule(seconds(config.round.shuttleAt), DEPARTURE_TIMER);
    w.services.timeline.schedule(seconds(config.round.roundLength), REVEAL_TIMER);
  }

  function enterSetup(): void {
    if (phase !== 'lobby') return;
    phase = 'setup';
    const ss = createStationServer({ seed, fog, spawnPlayer: spawnNextSeat });
    game = ss.game;
    world = ss.world;
    station = ss.station;
    assign();
    setupFixtures();
    for (let i = 0; i < orderedSeats.length; i++) game.join(); // each join → spawnNextSeat
    phase = 'shift';
  }

  function enterDeparture(): void {
    if (phase !== 'shift') return;
    const sd = shuttleDoorId();
    if (sd && world) setBolted(world, sd, false); // unlock the shuttle airlock
    phase = 'departure';
  }

  function enterReveal(): void {
    if (phase !== 'shift' && phase !== 'departure') return;
    outcomeData = computeOutcome();
    phase = 'reveal';
  }

  // --- outcome --------------------------------------------------------------

  function aliveAboard(id: EntityId): { alive: boolean; aboard: boolean } {
    const w = world!;
    const e = w.state.entities.get(id);
    const alive = w.state.timeline.actors.some((a) => a.id === id);
    if (!e || !alive) return { alive, aboard: false };
    const pos = get<Position>(e, 'position');
    const width = w.state.levels.get(LEVEL_ID)!.width;
    const zone = new Set(station!.mark.shuttleZone);
    const aboard = !!pos && zone.has(cellOf({ x: pos.x, y: pos.y }, width));
    return { alive, aboard };
  }

  function diskHolder(diskId: EntityId): EntityId | undefined {
    for (const e of world!.state.entities.values()) {
      const inv = e.components.get('inventory') as { items: string[] } | undefined;
      if (inv?.items.includes(diskId)) return e.id;
    }
    return undefined;
  }

  function computeOutcome(): RoundOutcome {
    const w = world!;
    const players: PlayerOutcome[] = [];
    for (const [seat, id] of seatEntity) {
      const e = w.state.entities.get(id);
      const role = e && roleOf(e);
      const { alive, aboard } = aliveAboard(id);
      players.push({
        seat,
        entityId: id,
        name: nameOf(seat),
        job: role?.job ?? 'crew',
        traitor: role?.traitor ?? false,
        alive,
        aboard,
        survived: alive && aboard,
      });
    }

    // Locate the disk and classify where it ended up.
    const diskId = [...w.services.queries.byTag('objective:disk')][0];
    let location: DiskLocation = 'on-station';
    let holder: EntityId | undefined;
    if (diskId) {
      const inHolder = diskHolder(diskId);
      const holderRole = inHolder ? roleOf(w.state.entities.get(inHolder)!) : undefined;
      if (inHolder && holderRole) {
        // A PLAYER carries it (a container like the locker has no role → on-station).
        holder = inHolder;
        const { aboard } = aliveAboard(inHolder);
        if (!aboard) location = 'on-station'; // carried, but never reached the shuttle (or holder dead)
        else location = holderRole.traitor ? 'aboard-with-traitor' : 'aboard-with-crew';
      } else {
        // Not held by a player → in the locker (no position) or loose on the floor.
        const de = w.state.entities.get(diskId);
        const pos = de && get<Position>(de, 'position');
        const width = w.state.levels.get(LEVEL_ID)!.width;
        const inZone = !!pos && new Set(station!.mark.shuttleZone).has(cellOf({ x: pos.x, y: pos.y }, width));
        location = inZone ? 'aboard-loose' : 'on-station';
      }
    }

    const traitorWin = location === 'aboard-with-traitor';
    const crewWin = location === 'on-station' || location === 'aboard-with-crew';
    return { players, disk: { location, ...(holder ? { holder } : {}) }, traitorWin, crewWin };
  }

  // --- public surface -------------------------------------------------------

  return {
    phase: () => phase,
    addPlayer(seat, name) {
      if (!roster.has(seat)) roster.set(seat, { name: name ?? seat });
    },
    removePlayer(seat) {
      roster.delete(seat);
      ready.delete(seat);
    },
    ready(seat) {
      if (!roster.has(seat)) return;
      ready.add(seat);
      if (phase === 'lobby' && ready.size >= config.round.minPlayers) enterSetup();
    },
    game: () => game,
    world: () => world,
    tick(ticks) {
      if (!game) return null;
      const update = game.tick(ticks);
      for (const ev of update.events) {
        if (ev.type === DEPARTURE_TIMER) enterDeparture();
        else if (ev.type === REVEAL_TIMER) enterReveal();
      }
      return update;
    },
    viewFor(seat, vp) {
      const id = seatEntity.get(seat);
      if (game && id) return game.viewFor(id, vp);
      return { lobby: true, phase };
    },
    briefingFor(seat) {
      const role = jobOf.get(seat);
      if (!role) return null;
      const traitor = seat === traitorSeat;
      return {
        job: role,
        traitor,
        objective: traitor ? 'Steal the intel disk and escape on the shuttle.' : 'Survive the shift and reach the shuttle.',
      };
    },
    outcome: () => outcomeData,
    forceSetup(o = {}) {
      if (o.seed !== undefined) seed = o.seed;
      if (o.traitor) forcedTraitor = o.traitor;
      for (const s of roster.keys()) ready.add(s); // force everyone ready
      enterSetup();
    },
    forceTraitor(seat) {
      forcedTraitor = seat;
    },
    advanceTo(target) {
      if (target === 'departure') enterDeparture();
      else if (target === 'reveal') enterReveal();
    },
    seatToEntity: (seat) => seatEntity.get(seat),
    lockerId: () => LOCKER_ID,
    marks: () => station?.mark ?? null,
  };
}
