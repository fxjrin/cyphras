// Ingests vault events into Postgres in strict gapless leaf order; self-healing on gaps and restarts.
import { Contract, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  pool,
  getCursor,
  nextLeafIndex,
  getDeployLedger,
  setDeployLedger,
  setCursorTx,
  setGapState,
  ledgerOfLeaf,
} from "./db.js";

const server = new rpc.Server(process.env.RPC_URL!, { allowHttp: true });
const VAULT = process.env.VAULT_CONTRACT_ID!;

// Absorbs the race where RPC reports a latest ledger before its events are queryable; never 0.
const CONFIRMATIONS = Math.min(2, Math.max(1, Number(process.env.CONFIRMATIONS ?? 1)));

// Walk-back depth, kept just under the RPC's ~7-day event retention window.
const RETENTION_LEDGERS = 110_000;

// getEvents caps a page at 10000; pull near the cap to cut round-trips.
const PAGE_LIMIT = 10_000;

// Window size so a deep backfill never buffers the whole span or commits it in one txn.
const SCAN_WINDOW = 10_000;

// Cap on non-progressing rescans before routing to backoff instead of hot-spinning at RPC rate.
const MAX_RESCAN_ATTEMPTS = 5;

const POLL_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

const buf = (x: bigint) => Buffer.from(x.toString(16).padStart(64, "0"), "hex");

interface Decoded {
  id: string;
  kind: "commitment" | "nullifier";
  index?: bigint;
  value: bigint;
  enc?: Buffer;
  ledger: number;
  txHash: string;
}

interface FetchResult {
  events: Decoded[];
  // RPC's oldest retained ledger, so the loop can detect when resume fell out of retention.
  oldest: number;
}

// Resume point fell out of RPC retention; transient failures never produce this.
class RetentionError extends Error {}

// Deploy ledger is after leaf 0's ledger; loop re-discovers via the index==0 walk-back.
class DeployTooLateError extends Error {}

function decode(e: rpc.Api.EventResponse): Decoded | null {
  const name = scValToNative(e.topic[0] as xdr.ScVal) as string;
  const data = scValToNative(e.value as xdr.ScVal) as Record<string, unknown>;
  if (name === "new_commitment") {
    return {
      id: e.id,
      kind: "commitment",
      index: BigInt(data.index as number),
      value: BigInt(data.commitment as bigint),
      enc: Buffer.from((data.encrypted_output as Uint8Array) ?? []),
      ledger: e.ledger,
      txHash: e.txHash,
    };
  }
  if (name === "new_nullifier") {
    return { id: e.id, kind: "nullifier", value: BigInt(data.nullifier as bigint), ledger: e.ledger, txHash: e.txHash };
  }
  return null;
}

// Best-effort string match; the loop also guards retention numerically via from < oldestLedger.
function isRetentionError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    (msg.includes("startledger") || msg.includes("start ledger")) &&
    (msg.includes("oldest") || msg.includes("older") || msg.includes("retention") || msg.includes("out of range"))
  );
}

// Pages getEvents over [from, to] by cursor, deduping by id; a short page ends the window.
async function fetchRange(from: number, to: number): Promise<FetchResult> {
  const filters = [{ type: "contract" as const, contractIds: [VAULT] }];
  const seen = new Set<string>();
  const out: Decoded[] = [];
  let cursor: string | undefined;
  let oldest = 0;
  for (;;) {
    let res: rpc.Api.GetEventsResponse;
    try {
      res = await server.getEvents(
        cursor
          ? { filters, limit: PAGE_LIMIT, cursor }
          : { filters, limit: PAGE_LIMIT, startLedger: from, endLedger: to + 1 },
      );
    } catch (err) {
      if (isRetentionError(err)) throw new RetentionError((err as Error).message);
      throw err;
    }
    oldest = res.oldestLedger;
    for (const e of res.events) {
      if (e.ledger > to) return { events: out, oldest };
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const d = decode(e);
      if (d) out.push(d);
    }
    if (res.events.length < PAGE_LIMIT) break;
    cursor = res.cursor;
  }
  return { events: out, oldest };
}

type ApplyResult = { status: "ok" } | { status: "gap"; expected: bigint };

// Applies a batch and advances the cursor in one txn; a gap rolls back and reports expected index.
async function apply(batch: Decoded[], safe: number): Promise<ApplyResult> {
  const commits = batch.filter((d) => d.kind === "commitment").sort((a, b) => Number(a.index! - b.index!));
  const nulls = batch.filter((d) => d.kind === "nullifier");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let expected = await nextLeafIndex();
    let inserted = false;
    for (const c of commits) {
      if (c.index! < expected) continue; // already applied; rescan overlap is safe
      if (c.index! !== expected) {
        await client.query("ROLLBACK");
        return { status: "gap", expected };
      }
      await client.query(
        "INSERT INTO commitments(leaf_index,commitment,encrypted_output,ledger,tx_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(leaf_index) DO NOTHING",
        [c.index!.toString(), buf(c.value), c.enc, c.ledger, c.txHash],
      );
      expected = c.index! + 1n;
      inserted = true;
    }
    for (const n of nulls) {
      await client.query(
        "INSERT INTO nullifiers(nullifier,ledger,tx_hash) VALUES($1,$2,$3) ON CONFLICT(nullifier) DO NOTHING",
        [buf(n.value), n.ledger, n.txHash],
      );
    }
    await setCursorTx(client, safe);
    // NOTIFY fires on COMMIT, so a rolled-back batch wakes nobody; payload is a wake signal only.
    if (inserted) {
      await client.query("SELECT pg_notify('new_commitment', $1)", [expected.toString()]);
    }
    await client.query("COMMIT");
    return { status: "ok" };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Code entry's lastModifiedLedgerSeq, a cheap upper bound on deploy ledger; null if unavailable.
async function deployLedgerFromCodeEntry(): Promise<number | null> {
  const instanceKey = new Contract(VAULT).getFootprint();
  const instanceRes = await server.getLedgerEntries(instanceKey);
  const instanceEntry = instanceRes.entries[0];
  if (!instanceEntry) return null;
  const instanceVal = instanceEntry.val.contractData().val();
  if (instanceVal.switch().name !== "scvContractInstance") return null;
  const executable = instanceVal.instance().executable();
  if (executable.switch().name !== "contractExecutableWasm") return null;
  const wasmHash = executable.wasmHash();
  const codeKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
  const codeRes = await server.getLedgerEntries(codeKey);
  const codeEntry = codeRes.entries[0];
  if (codeEntry?.lastModifiedLedgerSeq == null) return null;
  return codeEntry.lastModifiedLedgerSeq;
}

// Anchors on leaf 0 directly via walk-back; authoritative when the code-entry bound overshoots.
async function deployLedgerFromWalkBack(latest: number): Promise<number | null> {
  const from = Math.max(1, latest - RETENTION_LEDGERS);
  const { events } = await fetchRange(from, latest);
  for (const d of events) {
    if (d.kind === "commitment" && d.index === 0n) return d.ledger;
  }
  return null;
}

// Discovers and persists the deploy ledger; forceWalkBack skips code entry once proven too late.
async function discoverDeployLedger(latest: number, forceWalkBack = false): Promise<number> {
  if (!forceWalkBack) {
    const fromCode = await deployLedgerFromCodeEntry();
    if (fromCode != null) {
      await setDeployLedger(fromCode);
      return fromCode;
    }
  }
  const fromWalk = await deployLedgerFromWalkBack(latest);
  if (fromWalk != null) {
    await setDeployLedger(fromWalk);
    return fromWalk;
  }
  throw new Error("could not discover deploy ledger from code entry or event walk-back");
}

// Fetches and applies [from, safe] in SCAN_WINDOW windows; a gap aborts and returns expected index.
async function ingestRange(from: number, safe: number): Promise<ApplyResult> {
  let windowFrom = from;
  while (windowFrom <= safe) {
    const windowTo = Math.min(windowFrom + SCAN_WINDOW - 1, safe);
    const { events, oldest } = await fetchRange(windowFrom, windowTo);
    // Numeric retention guard: some providers clamp instead of erroring, silently skipping leaves.
    if (oldest > 0 && windowFrom < oldest) {
      throw new RetentionError(`resume ledger ${windowFrom} older than RPC oldestLedger ${oldest}`);
    }
    const result = await apply(events, windowTo);
    if (result.status === "gap") return result;
    windowFrom = windowTo + 1;
  }
  return { status: "ok" };
}

export async function ingestLoop(): Promise<void> {
  let backoff = POLL_MS;
  for (;;) {
    try {
      // Discover and persist the deploy ledger once.
      let deploy = await getDeployLedger();
      if (deploy == null) {
        const latest = (await server.getLatestLedger()).sequence;
        deploy = await discoverDeployLedger(latest);
      }

      const latest = (await server.getLatestLedger()).sequence;
      const safe = latest - CONFIRMATIONS;

      // Empty tree rescans from deploy and never trusts a stale cursor; else resume past last applied.
      const expected = await nextLeafIndex();
      let from = expected === 0n ? deploy : (await getCursor()) + 1;

      // Caught up to the safe tip; nothing to do this tick.
      if (from > safe) {
        backoff = POLL_MS;
        await sleep(POLL_MS);
        continue;
      }

      // Bounded rescan on gaps: rewind to the last known-good leaf and re-fetch; overlap is idempotent.
      let attempts = 0;
      for (;;) {
        const result = await ingestRange(from, safe);
        if (result.status === "ok") break;

        // First commitment is not leaf 0; re-anchor via walk-back, not a rewind to a too-late deploy.
        if (result.expected === 0n) {
          throw new DeployTooLateError(`first commitment after deploy ledger ${deploy} is not leaf 0`);
        }

        if (++attempts > MAX_RESCAN_ATTEMPTS) {
          throw new Error(`leaf gap unresolved after ${MAX_RESCAN_ATTEMPTS} rescans: expected ${result.expected}`);
        }
        await setGapState(true, `leaf gap: expected ${result.expected}`);
        const rewind = (await ledgerOfLeaf(result.expected - 1n)) ?? deploy;
        from = rewind < deploy ? deploy : rewind;
      }

      await setGapState(false, null);
      backoff = POLL_MS;
    } catch (err) {
      if (err instanceof DeployTooLateError) {
        // Re-discover the deploy ledger anchored on leaf 0; next tick resumes corrected, no cursor advance.
        await setGapState(true, err.message).catch(() => {});
        console.error("deploy ledger overshot leaf 0; re-discovering via walk-back:", err.message);
        try {
          const latest = (await server.getLatestLedger()).sequence;
          await discoverDeployLedger(latest, true);
        } catch (rediscoverErr) {
          console.error("walk-back re-discovery failed:", (rediscoverErr as Error).message);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          await sleep(backoff);
        }
        continue;
      }
      if (err instanceof RetentionError) {
        // Resume ledger fell out of RPC retention; halt visibly, never advance past missing leaves.
        await setGapState(
          true,
          "resume ledger older than RPC oldestLedger; cannot backfill via getEvents",
        ).catch(() => {});
        console.error("retention gap: resume ledger older than RPC oldestLedger; halting ingest until backfilled");
        await sleep(MAX_BACKOFF_MS);
        continue;
      }
      // Transient RPC/DB failure: record, back off, never advance the cursor.
      const message = (err as Error).message;
      await setGapState(true, message).catch(() => {});
      console.error("ingest error:", message);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      await sleep(backoff);
      continue;
    }
    await sleep(POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
