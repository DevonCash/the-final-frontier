/**
 * role — a crew member's job and secret traitor flag (Epic H, game-design §2, §4).
 *
 * Role is a SEPARATE axis from `allegiance`: a traitor is still `faction:'crew'`
 * (that's the whole point of hidden treachery — they look like crew). The round
 * controller (`round.ts`) attaches a `role` after spawn, draws the traitor from a
 * forked RNG stream, and reads it back at reveal for the outcome + briefings. A
 * component (not transient state) so a rejoined save (snapshot) validates it.
 */
import { z } from 'zod';
import { get, type World, type Entity, type ComponentRegistry } from '../../rlkit/src/index';

export type Job = 'captain' | 'engineer' | 'crew';

export const RoleSchema = z.object({
  type: z.literal('role'),
  job: z.enum(['captain', 'engineer', 'crew']),
  traitor: z.boolean(),
});
export type Role = z.infer<typeof RoleSchema> & { [key: string]: unknown };

/** Register the `role` component schema (save validation), mirroring registerItems. */
export function registerRoles(world: World): void {
  (world.services.registries.components as ComponentRegistry).override('role', {
    type: 'role',
    schema: RoleSchema,
  });
}

/** Attach (or overwrite) a crew member's role. */
export function setRole(entity: Entity, job: Job, traitor: boolean): void {
  entity.components.set('role', { type: 'role', job, traitor });
}

/** Read a crew member's role, if assigned. */
export function roleOf(entity: Entity): Role | undefined {
  return get<Role>(entity, 'role');
}
