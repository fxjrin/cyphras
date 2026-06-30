// Submits shielded spends so the user's wallet never signs on-chain and stays anonymous.
import Fastify from "fastify";
import {
  Contract, Keypair, TransactionBuilder, rpc, BASE_FEE, Networks, nativeToScVal,
} from "@stellar/stellar-sdk";
import { proofScVal, extScVal, ProofHex, ExtHex } from "./scval.js";

const server = new rpc.Server(process.env.RPC_URL!, { allowHttp: true });
const networkPassphrase = process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;
const relayerKp = Keypair.fromSecret(process.env.RELAYER_SECRET!);
const VAULT = process.env.VAULT_CONTRACT_ID!;
const POOL_RELAYER_ADDRESS =
  process.env.POOL_RELAYER_ADDRESS ?? "GASOF6NKJJWYE4AB2SFXK6RD26VBYGWNK2KL7TLZT2S3YRS3NRQWH4UQ";
if (relayerKp.publicKey() !== POOL_RELAYER_ADDRESS) {
  // Vault pays ext.fee to the pool relayerAddress, so the signer must equal it or gas goes unpaid.
  throw new Error(
    `RELAYER_SECRET pubkey ${relayerKp.publicKey()} != pool relayerAddress ${POOL_RELAYER_ADDRESS}; the vault would pay fees to a different account`,
  );
}

// Self-calibrates from the real simulated cost so a relayed spend can never cost the relayer money.
const NET_COST = BigInt(process.env.NET_COST ?? 300_000); // bootstrap seed until the first real tx calibrates
const MARGIN_BPS = BigInt(process.env.MARGIN_BPS ?? 2_000); // target markup baked into the quote
const MIN_MARGIN_BPS = BigInt(process.env.MIN_MARGIN_BPS ?? 500); // floor enforced over the real simulated cost
const QUOTE_BUFFER_BPS = BigInt(process.env.QUOTE_BUFFER_BPS ?? 1_000); // headroom for gas drift between quote and submit
// RATE_PPM is pool asset per 1 XLM (1e6 scale): gas paid in XLM, fee collected in pool asset.
const RATE_PPM = BigInt(process.env.RATE_PPM ?? 1_000_000);
const toAsset = (xlm: bigint) => (xlm * RATE_PPM) / 1_000_000n;

let observedCost = NET_COST; // XLM stroops the relayer actually pays

function quoteFee(): { fee: bigint; basis: bigint; margin: bigint } {
  const basis = toAsset(observedCost + (observedCost * QUOTE_BUFFER_BPS) / 10_000n);
  const margin = (basis * MARGIN_BPS) / 10_000n;
  return { fee: basis + margin, basis, margin };
}

// Jump up at once, decay down slowly, so a cheap outlier cannot drop the quote below real gas.
function learnCost(cost: bigint): void {
  observedCost = cost > observedCost ? cost : observedCost - (observedCost - cost) / 8n;
}

const app = Fastify({ logger: true, bodyLimit: 64 * 1024 });
// Browser wallet runs on a different localhost port.
await app.register((await import("@fastify/cors")).default, { origin: true });
app.get("/health", async () => ({ ok: true, relayer: relayerKp.publicKey() }));
// Wallet quotes the fee to bake into the proof; breakdown lets it show the user where the fee goes.
app.get("/quote", async () => {
  const q = quoteFee();
  return {
    fee: q.fee.toString(),
    netCost: q.basis.toString(), // live cost estimate incl. drift buffer
    margin: q.margin.toString(),
    marginBps: MARGIN_BPS.toString(),
    minMarginBps: MIN_MARGIN_BPS.toString(),
    calibrated: (observedCost !== NET_COST).toString(),
  };
});

function parseBody(raw: unknown): { proof: ProofHex; ext: ExtHex } {
  const b = raw as { proof?: ProofHex; ext?: Record<string, unknown> };
  if (!b?.proof || !b.ext) throw new Error("missing proof or ext");
  const p = b.proof;
  const hexOk = (s: unknown, n: number) => typeof s === "string" && /^[0-9a-f]+$/.test(s) && s.length === n;
  if (!hexOk(p.a, 128) || !hexOk(p.b, 256) || !hexOk(p.c, 128)) throw new Error("bad proof points");
  const ext: ExtHex = {
    ext_amount: BigInt(b.ext.ext_amount as string | number),
    fee: BigInt(b.ext.fee as string | number),
    recipient: String(b.ext.recipient),
    relayer: String(b.ext.relayer),
    encrypted_output0: Buffer.from((b.ext.encrypted_output0 as string) ?? "", "hex"),
    encrypted_output1: Buffer.from((b.ext.encrypted_output1 as string) ?? "", "hex"),
  };
  return { proof: p, ext };
}

app.post("/submit", async (req, reply) => {
  let body: { proof: ProofHex; ext: ExtHex };
  try {
    body = parseBody(req.body);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
  if (body.ext.ext_amount > 0n) {
    // Deposits pull user funds and need the user's own auth; the wallet submits them, not the relayer.
    return reply.code(400).send({ error: "deposits are submitted by the wallet, not the relayer" });
  }
  if (body.ext.relayer !== relayerKp.publicKey()) {
    // ext.relayer is proof-bound and the vault pays the fee to it; any other value fronts gas unpaid.
    return reply.code(400).send({ error: "ext.relayer must equal this relayer address; the fee would be paid elsewhere" });
  }
  // Cheap pre-check rejects stale fees before paying for a simulation; compare in asset units.
  if (body.ext.fee < toAsset(observedCost)) {
    return reply.code(400).send({ error: `fee ${body.ext.fee} below relayer cost estimate ${toAsset(observedCost)}; GET /quote` });
  }
  const contract = new Contract(VAULT);
  const op = contract.call(
    "transact",
    proofScVal(body.proof),
    extScVal(body.ext),
    nativeToScVal(relayerKp.publicKey(), { type: "address" }), // sender = relayer; the proof authorizes the spend
  );
  const source = await server.getAccount(relayerKp.publicKey());
  let tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(op)
    .setTimeout(60)
    .build();
  // prepareTransaction stamps the real network fee; re-check the in-asset fee against it.
  tx = await server.prepareTransaction(tx);
  const cost = BigInt(tx.fee); // XLM gas the relayer pays
  learnCost(cost); // recalibrate from the real network fee
  const costAsset = toAsset(cost); // same cost in the pool asset
  const required = costAsset + (costAsset * MIN_MARGIN_BPS) / 10_000n;
  if (body.ext.fee < required) {
    return reply.code(400).send({
      error: `fee ${body.ext.fee} below required ${required} (asset cost ${costAsset} + ${MIN_MARGIN_BPS}bps min margin); GET /quote and re-prove`,
      cost: costAsset.toString(),
      required: required.toString(),
    });
  }
  tx.sign(relayerKp);
  const res = await server.sendTransaction(tx);
  const profit = body.ext.fee - costAsset; // in asset units
  app.log.info({ hash: res.hash, fee: body.ext.fee.toString(), gasXlm: cost.toString(), costAsset: costAsset.toString(), profit: profit.toString() }, "relayed spend");
  return { hash: res.hash, status: res.status, fee: body.ext.fee.toString(), cost: costAsset.toString(), profit: profit.toString() };
});

const port = Number(process.env.PORT ?? 8081);
app.listen({ port, host: "0.0.0.0" }).then(() => console.log(`relayer on :${port}`));
