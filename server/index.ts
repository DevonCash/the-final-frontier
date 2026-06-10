/**
 * index — server entry. Reads PORT/FOG from the environment and starts the WS host.
 * Default fog is `hidden` (Epic I: each player sees only its own FOV); the Epic B
 * shared-vision dev path stays reachable with `FOG=shared`.
 */
import { startStationServer } from './server';

const port = Number(process.env.PORT) || 8787;
const fog = (process.env.FOG as 'shared' | 'hidden') || 'hidden';

startStationServer({ port, fog });
console.log(`the-final-frontier server listening on ws://localhost:${port} (fog: ${fog})`);
