// Timer bumps vault TTL within the ~29-day window; uses its own KEEPER_SECRET, not the relayer key.
import { Contract, Keypair, TransactionBuilder, rpc, BASE_FEE, Networks } from "@stellar/stellar-sdk";

const server = new rpc.Server(process.env.RPC_URL!, { allowHttp: true });
const networkPassphrase = process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;
const kp = Keypair.fromSecret(process.env.KEEPER_SECRET!);
const VAULT = process.env.VAULT_CONTRACT_ID!;
const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS ?? 7 * 24 * 3600 * 1000);

async function bump() {
  const op = new Contract(VAULT).call("bump_ttl");
  const src = await server.getAccount(kp.publicKey());
  let tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase })
    .addOperation(op).setTimeout(60).build();
  tx = await server.prepareTransaction(tx);
  tx.sign(kp);
  const res = await server.sendTransaction(tx);
  console.log("bump_ttl submitted:", res.hash, res.status);
}

(async function loop() {
  for (;;) {
    try { await bump(); } catch (e) { console.error("keeper error:", (e as Error).message); }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
})();
