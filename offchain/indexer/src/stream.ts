// One LISTEN connection fans ingest NOTIFY out to SSE clients; a missed wake recovers via catch-up.
import { EventEmitter } from "node:events";
import pg from "pg";

export const commitmentBus = new EventEmitter();
commitmentBus.setMaxListeners(0); // one listener per connected SSE client

const RECONNECT_MS = 2_000;

export function startCommitmentListener(): void {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  let reconnecting = false;
  const reconnect = (why: string): void => {
    if (reconnecting) return;
    reconnecting = true;
    console.error(`listen connection lost (${why}); reconnecting in ${RECONNECT_MS}ms`);
    client.end().catch(() => {});
    setTimeout(startCommitmentListener, RECONNECT_MS);
  };
  client.on("notification", (msg) => commitmentBus.emit("commitment", msg.payload ?? ""));
  client.on("error", (err) => reconnect(err.message));
  client
    .connect()
    .then(() => client.query("LISTEN new_commitment"))
    .then(() => console.log("listening for new_commitment NOTIFY"))
    .catch((err) => reconnect((err as Error).message));
}
