// Network-wide constants shared by every pool.
export const RPC_URL = "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
export const FRIENDBOT = "https://friendbot.stellar.org";
export const FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
// Offline fallback; wallet fetches live GET /quote per pool.
export const FEE = 360000n;

// One vault bound to one Stellar asset. Wallet can hold several pools; the
// private receiving address is the same across pools (it is the account keys),
// notes are tracked per pool.
export interface Pool {
  id: string; // note-storage + UI key
  label: string;
  vaultId: string; // Soroban vault contract
  domain: bigint; // proof domain separation, distinct per pool
  indexerUrl: string;
  relayerUrl: string;
  relayerAddress: string; // tx source for relayed spends
  native: boolean; // true = native XLM, false = classic asset (needs trustline)
  assetCode?: string;
  assetIssuer?: string;
  decimals: number; // Stellar assets use 7
  maxDeposit: bigint; // vault max_deposit cap
  swapMinRatePpm?: bigint; // slippage floor (asset per XLM, x1e6)
}

// Offchain host for the per-pool indexer and relayer endpoints.
const BASE = "https://private.cyphras.com";

export const POOLS: Pool[] = [
  {
    id: "xlm",
    label: "XLM",
    vaultId: "CDPUJYCTPGPEGS6MBXYLEWTYSGCPVKUHCURLF2ORT3RAVL5TF5JKIAI5",
    domain: 67890n,
    indexerUrl: `${BASE}/indexer`,
    relayerUrl: `${BASE}/relayer`,
    relayerAddress: "GDEPXRVATYLS6BO7IP4FCENJKGTMZ72FIZJKPEHLXW4PMHWHMBIL24QY",
    native: true,
    decimals: 7,
    maxDeposit: 1_000_000_000n,
  },
];

export const poolById = (id: string): Pool => POOLS.find((p) => p.id === id) ?? POOLS[0];
