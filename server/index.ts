/**
 * index — server entry. Reads PORT/FOG from the environment and starts the WS host.
 * Default fog is `shared` (Epic B: crew see each other on one station); Epic I
 * switches the default to hidden per-player fog.
 */
import { startStationServer } from './server';

const port = Number(process.env.PORT) || 8787;
const fog = (process.env.FOG as 'shared' | 'hidden') || 'shared';

startStationServer({ port, fog });
console.log(`the-final-frontier server listening on ws://localhost:${port} (fog: ${fog})`);
