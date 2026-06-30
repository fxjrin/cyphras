import pg from "pg";

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function getCursor(): Promise<number> {
  const r = await pool.query("SELECT last_ledger FROM cursor WHERE id=1");
  return Number(r.rows[0]?.last_ledger ?? 0);
}

export async function nextLeafIndex(): Promise<bigint> {
  const r = await pool.query("SELECT COALESCE(MAX(leaf_index)+1, 0) AS n FROM commitments");
  return BigInt(r.rows[0].n);
}

export async function getDeployLedger(): Promise<number | null> {
  const r = await pool.query("SELECT deploy_ledger FROM cursor WHERE id=1");
  const v = r.rows[0]?.deploy_ledger;
  return v == null ? null : Number(v);
}

export async function setDeployLedger(n: number): Promise<void> {
  await pool.query("UPDATE cursor SET deploy_ledger=$1, updated_at=now() WHERE id=1", [n]);
}

export async function getCursorState(): Promise<{
  last_ledger: number;
  deploy_ledger: number | null;
  gap_detected: boolean;
  last_error: string | null;
  cursor_advanced_at: string;
}> {
  const r = await pool.query(
    "SELECT last_ledger, deploy_ledger, gap_detected, last_error, cursor_advanced_at FROM cursor WHERE id=1",
  );
  const row = r.rows[0];
  return {
    last_ledger: Number(row.last_ledger),
    deploy_ledger: row.deploy_ledger == null ? null : Number(row.deploy_ledger),
    gap_detected: row.gap_detected,
    last_error: row.last_error,
    cursor_advanced_at: row.cursor_advanced_at.toISOString(),
  };
}

// Advances the cursor inside the apply txn, so a crash leaves it behind the tree, never ahead.
export async function setCursorTx(client: pg.PoolClient, ledger: number): Promise<void> {
  await client.query(
    "UPDATE cursor SET last_ledger=$1, updated_at=now(), cursor_advanced_at=now() WHERE id=1",
    [ledger],
  );
}

export async function setGapState(gap: boolean, lastError: string | null): Promise<void> {
  await pool.query("UPDATE cursor SET gap_detected=$1, last_error=$2, updated_at=now() WHERE id=1", [
    gap,
    lastError,
  ]);
}

export async function ledgerOfLeaf(index: bigint): Promise<number | null> {
  const r = await pool.query("SELECT ledger FROM commitments WHERE leaf_index=$1", [index.toString()]);
  const v = r.rows[0]?.ledger;
  return v == null ? null : Number(v);
}
