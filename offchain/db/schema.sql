-- Off-chain mirror of chain events; everything here is reconstructable from chain history.

-- Last ledger fully processed, so restarts resume cleanly.
CREATE TABLE IF NOT EXISTS cursor (
  id            INT PRIMARY KEY DEFAULT 1,
  last_ledger   BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 1)
);

-- Vault's first-event ledger, discovered once; resume derives from tree state.
ALTER TABLE cursor ADD COLUMN IF NOT EXISTS deploy_ledger BIGINT;
ALTER TABLE cursor ADD COLUMN IF NOT EXISTS gap_detected BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cursor ADD COLUMN IF NOT EXISTS last_error TEXT;
-- True liveness signal: advances only with last_ledger, unlike updated_at which moves on errors.
ALTER TABLE cursor ADD COLUMN IF NOT EXISTS cursor_advanced_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Seed after additive columns exist so fresh init and running DB converge on one row.
INSERT INTO cursor (id) VALUES (1) ON CONFLICT DO NOTHING;

-- One row per leaf in insertion order; encrypted_output is the recipient note ciphertext.
CREATE TABLE IF NOT EXISTS commitments (
  leaf_index        BIGINT PRIMARY KEY,
  commitment        BYTEA NOT NULL UNIQUE,
  encrypted_output  BYTEA NOT NULL,
  ledger            BIGINT NOT NULL,
  tx_hash           TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commitments_ledger_idx ON commitments (ledger);

-- Spent nullifiers for double-spend detection and wallet note-status checks.
CREATE TABLE IF NOT EXISTS nullifiers (
  nullifier   BYTEA PRIMARY KEY,
  ledger      BIGINT NOT NULL,
  tx_hash     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
