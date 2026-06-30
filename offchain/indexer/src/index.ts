// Indexer entrypoint: serves the wallet API and runs the ingest loop.
import Fastify from "fastify";
import { rpc } from "@stellar/stellar-sdk";
import { pool, getCursorState, nextLeafIndex } from "./db.js";
import { ingestLoop } from "./ingest.js";
import { commitmentBus, startCommitmentListener } from "./stream.js";

const app = Fastify({ logger: true });
// Allow the browser wallet (a different origin) to read the API.
await app.register((await import("@fastify/cors")).default, { origin: true });

const server = new rpc.Server(process.env.RPC_URL!, { allowHttp: true });
// Beyond this lag the served leaf set is too stale to trust; flip not-ready.
const SYNC_LAG_THRESHOLD = Number(process.env.SYNC_LAG_THRESHOLD ?? 100);

// latest drives sync lag, oldest the retention floor; both null on RPC failure to keep health true.
async function readLedgerBounds(): Promise<{ latest: number | null; oldest: number | null; error: string | null }> {
  try {
    const latest = (await server.getLatestLedger()).sequence;
    const txs = await server.getTransactions({ startLedger: Math.max(1, latest), pagination: { limit: 1 } });
    return { latest, oldest: txs.oldestLedger, error: null };
  } catch (err) {
    return { latest: null, oldest: null, error: (err as Error).message };
  }
}

// Readiness gates on gap or lag only; a bounds-probe failure is reported but does not gate.
async function readiness() {
  const state = await getCursorState();
  const bounds = await readLedgerBounds();
  const sync_lag_ledgers = bounds.latest == null ? null : bounds.latest - state.last_ledger;
  const lagExceeded = sync_lag_ledgers != null && sync_lag_ledgers > SYNC_LAG_THRESHOLD;
  const ready = !state.gap_detected && !lagExceeded;
  return { state, bounds, sync_lag_ledgers, lagExceeded, ready };
}

// Returns non-200 when the leaf set is untrustworthy so the wallet falls back to a direct RPC scan.
app.get("/health", async (_req, reply) => {
  const { state, bounds, sync_lag_ledgers, ready } = await readiness();
  const leaf_count = Number(await nextLeafIndex());

  // From cursor_advanced_at so a stalled-but-erroring loop still shows growing lag.
  const sync_lag_seconds = Math.floor((Date.now() - new Date(state.cursor_advanced_at).getTime()) / 1000);
  const retention_risk = bounds.oldest == null ? null : state.last_ledger - bounds.oldest;

  if (!ready) reply.code(503);

  return {
    ok: ready,
    leaf_count,
    last_ledger: state.last_ledger,
    latest_ledger: bounds.latest,
    sync_lag_ledgers,
    sync_lag_seconds,
    gap_detected: state.gap_detected,
    last_error: state.last_error ?? bounds.error,
    retention_risk,
  };
});

// Commitments the wallet reads to rebuild the tree and trial-decrypt notes with its viewing key.
app.get("/notes", async (req) => {
  const since = Number((req.query as { since?: string }).since ?? 0);
  const r = await pool.query(
    "SELECT leaf_index, encode(commitment,'hex') AS commitment, encode(encrypted_output,'hex') AS encrypted_output, ledger FROM commitments WHERE leaf_index >= $1 ORDER BY leaf_index",
    [since],
  );
  return r.rows;
});

// Whether a nullifier is already spent.
app.get("/nullifier/:hex", async (req) => {
  const { hex } = req.params as { hex: string };
  const r = await pool.query("SELECT 1 FROM nullifiers WHERE nullifier = decode($1,'hex')", [hex]);
  return { spent: (r.rowCount ?? 0) > 0 };
});

// SSE wake signal on each new leaf; clients re-scan /notes locally, so the stream leaks nothing.
app.get("/stream", (req, reply) => {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write("retry: 5000\n\n");
  const onCommitment = (payload: string) => res.write(`event: new_commitment\ndata: ${payload}\n\n`);
  commitmentBus.on("commitment", onCommitment);
  // Keep proxies and load balancers from closing an idle connection.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.raw.on("close", () => {
    clearInterval(heartbeat);
    commitmentBus.off("commitment", onCommitment);
  });
});

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: "0.0.0.0" }).then(() => {
  console.log(`indexer api on :${port}`);
  startCommitmentListener();
  ingestLoop().catch((e) => console.error("ingest loop crashed:", e));
});
