// Stellar/Soroban interaction: read XLM balance + vault root, and submit spends.
// A shield needs the depositor's own auth, so the wallet signs and submits it
// directly; transfers/withdrawals go through the relayer.
import {
  Contract, Horizon, TransactionBuilder, Operation, Asset, rpc, BASE_FEE, scValToNative, xdr, nativeToScVal,
} from "@stellar/stellar-sdk";
import { RPC_URL, NETWORK_PASSPHRASE, FRIENDBOT, type Pool } from "./config";
import type { Wallet } from "./wallet";
import { diversifiedKey } from "./wallet";
import { buildTransaction, noteCommitment, noteNullifier, type InNote, type OutNote, type TxProofHex } from "./prover";
import { type Point, randScalar } from "./babyjub";
import type { ExtData } from "./extdata";
import { proofScVal, extScVal } from "./scval";
import { addNote, markSpent, loadNotes, type Note } from "./notes";
import { relayerSubmit, getQuote } from "./relayer";
import { fetchCommitments, spendPaths } from "./tree";

const fromHex = (s: string) => Uint8Array.from((s.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const noteD = (note: Note) => (note.d ? fromHex(note.d) : new Uint8Array(11));
// pk_d of a note we own, from our ivk and the note's diversifier.
const notePkd = (wallet: Wallet, note: Note) => diversifiedKey(wallet.ivk, noteD(note));

/** Wait for final on-chain status before mutating local note state, so a failed
 * tx never marks a note spent or adds a phantom note. */
async function awaitTx(hash: string): Promise<void> {
  // Read status from raw RPC JSON; server.getTransaction decodes the result
  // meta and throws on TransactionMetaV4 in older SDK builds.
  for (let i = 0; i < 40; i++) {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash } }),
    });
    const status = (await res.json())?.result?.status as string | undefined;
    if (status === "SUCCESS") return;
    if (status === "FAILED") throw new Error("transaction failed on-chain");
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("confirmation timeout - note state left unchanged");
}

const server = new rpc.Server(RPC_URL);
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");

export async function xlmBalance(address: string): Promise<string> {
  try {
    const acct = await horizon.loadAccount(address);
    const native = acct.balances.find((b) => b.asset_type === "native");
    return native ? native.balance : "0";
  } catch {
    return "0";
  }
}

export async function fundAccount(address: string): Promise<void> {
  await fetch(`${FRIENDBOT}?addr=${address}`);
}

/** Public balance for the holder: native XLM for the XLM pool, else the classic
 * asset's trustline balance (0 if no trustline). */
export async function poolBalance(address: string, pool: Pool): Promise<string> {
  if (pool.native) return xlmBalance(address);
  try {
    const acct = await horizon.loadAccount(address);
    const line = acct.balances.find(
      (b) => "asset_code" in b && b.asset_code === pool.assetCode && b.asset_issuer === pool.assetIssuer,
    );
    return line ? line.balance : "0";
  } catch {
    return "0";
  }
}

export async function hasTrustline(address: string, pool: Pool): Promise<boolean> {
  if (pool.native) return true;
  try {
    const acct = await horizon.loadAccount(address);
    return acct.balances.some(
      (b) => "asset_code" in b && b.asset_code === pool.assetCode && b.asset_issuer === pool.assetIssuer,
    );
  } catch {
    return false;
  }
}

async function readU256(pool: Pool, name: string, source: string): Promise<bigint> {
  const contract = new Contract(pool.vaultId);
  const acct = await server.getAccount(source);
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call(name))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error("simulate failed");
  return scValToNative(sim.result!.retval as xdr.ScVal) as bigint;
}

export const vaultRoot = (pool: Pool, source: string) => readU256(pool, "current_root", source);

/** True if `root` is in the vault's on-chain history; guards against spending
 * against a tree the wallet reconstructed incompletely. */
async function isKnownRoot(pool: Pool, root: bigint, source: string): Promise<boolean> {
  const contract = new Contract(pool.vaultId);
  const acct = await server.getAccount(source);
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call("is_known_root", nativeToScVal(root, { type: "u256" })))
    .setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) return false;
  return scValToNative(sim.result!.retval as xdr.ScVal) as boolean;
}

function poolAsset(pool: Pool): Asset {
  return pool.native ? Asset.native() : new Asset(pool.assetCode!, pool.assetIssuer!);
}

/** Establish a trustline so the account can hold the pool's classic asset. */
export async function addTrustline(wallet: Wallet, pool: Pool): Promise<string> {
  const acct = await server.getAccount(wallet.address);
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset: poolAsset(pool) }))
    .setTimeout(60).build();
  tx.sign(wallet.stellar);
  const hash = (await server.sendTransaction(tx)).hash;
  await awaitTx(hash);
  return hash;
}

/** Swap `sendXlm` stroops into the pool's asset via path payment strict send.
 * `minOut` guards against slippage. */
export async function swapXlmToAsset(wallet: Wallet, sendXlm: bigint, minOut: bigint, pool: Pool): Promise<string> {
  const toAmt = (s: bigint) => `${s / 10_000_000n}.${(s % 10_000_000n).toString().padStart(7, "0")}`;
  const acct = await server.getAccount(wallet.address);
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.pathPaymentStrictSend({
      sendAsset: Asset.native(), sendAmount: toAmt(sendXlm),
      destination: wallet.address, destAsset: poolAsset(pool), destMin: toAmt(minOut), path: [],
    }))
    .setTimeout(60).build();
  tx.sign(wallet.stellar);
  const hash = (await server.sendTransaction(tx)).hash;
  await awaitTx(hash);
  return hash;
}

// A zero-value input fills an unused circuit slot. The Merkle root check is
// gated off for amount 0, but the nullifier must be unique, so a random blinding
// makes each dummy commitment (hence nullifier) distinct.
function dummyInput(wallet: Wallet): InNote {
  return { amount: 0n, ask: wallet.ask, nsk: wallet.nsk, d: wallet.d, blinding: randScalar(), pathIndices: 0n, pathElements: Array(20).fill(0n) };
}

const selfOut = (wallet: Wallet, amount: bigint, blinding: bigint): OutNote => ({ amount, pkD: wallet.pkD, blinding });

/** Shield `amount` stroops of the pool's asset into a single private note. Both
 * inputs are dummies (amount 0), so no Merkle path or indexer is needed; the
 * deposit output is locked to the depositor's own pk_d. The user signs and
 * submits the transact themselves (deposits cannot be relayed). */
export async function shield(wallet: Wallet, amount: bigint, pool: Pool, artifacts = "/circuits"): Promise<string> {
  const root = await vaultRoot(pool, wallet.address);
  const { encryptNote } = await import("./crypto");

  const inputs: [InNote, InNote] = [dummyInput(wallet), dummyInput(wallet)];
  const outBlind = randScalar();
  const dummyBlind = randScalar();
  const outputs: [OutNote, OutNote] = [selfOut(wallet, amount, outBlind), selfOut(wallet, 0n, dummyBlind)];
  // Both outputs encrypted to our own pk_d (even the zero note) so every tx emits
  // two equal-size blobs: enables seed recovery and hides the output count.
  const ext: ExtData = {
    extAmount: amount, fee: 0n, recipient: wallet.address, relayer: wallet.address,
    encryptedOutput0: await encryptNote(wallet.pkD, wallet.d, amount, outBlind),
    encryptedOutput1: await encryptNote(wallet.pkD, wallet.d, 0n, dummyBlind),
  };

  const { proof } = await buildTransaction(root, inputs, outputs, ext, pool.domain, artifacts);
  const hash = await submit(pool, wallet, proof, ext);
  await awaitTx(hash);
  addNote(pool.id, wallet.address, { amount: amount.toString(), blinding: outBlind.toString(), d: toHex(wallet.d), commitment: proof.commitments[0], leafIndex: -1, spent: false });
  return hash;
}

async function submit(pool: Pool, wallet: Wallet, proof: TxProofHex, e: ExtData): Promise<string> {
  const contract = new Contract(pool.vaultId);
  const acct = await server.getAccount(wallet.address);
  let tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call(
      "transact", proofScVal(proof),
      extScVal({ ext_amount: e.extAmount, fee: 0n, recipient: e.recipient, relayer: e.relayer, encrypted_output0: e.encryptedOutput0, encrypted_output1: e.encryptedOutput1 }),
      nativeToScVal(wallet.address, { type: "address" }),
    ))
    .setTimeout(60).build();
  tx = await server.prepareTransaction(tx);
  tx.sign(wallet.stellar);
  return (await server.sendTransaction(tx)).hash;
}

/** Locate a note's leaf index on-chain by matching its recomputed commitment
 * (from the note's own diversified pk_d). */
async function leafIndexOf(pool: Pool, note: Note, pkD: Point): Promise<number> {
  const c = await noteCommitment(BigInt(note.amount), pkD, BigInt(note.blinding));
  const all = await fetchCommitments(pool);
  const matches = all.filter((x) => x.value === c);
  if (matches.length === 0) throw new Error("note not found on-chain (not yet indexed?)");
  if (matches.length > 1) throw new Error("ambiguous note (duplicate commitment) - cannot safely spend");
  return matches[0].leafIndex;
}

/** Spend 1 or 2 real notes against one shared root; the second slot is a dummy
 * when only one note is spent. The circuit is fixed at two inputs. */
async function spendInputsFor(pool: Pool, wallet: Wallet, notes: Note[]): Promise<{ inputs: [InNote, InNote]; root: bigint }> {
  if (notes.length < 1 || notes.length > 2) throw new Error("a spend takes one or two notes");
  if (notes.length === 2 && notes[0].commitment === notes[1].commitment) throw new Error("cannot spend the same note twice");
  const pkds = await Promise.all(notes.map((n) => notePkd(wallet, n)));
  const idxs = await Promise.all(notes.map((n, i) => leafIndexOf(pool, n, pkds[i])));
  const { root, paths } = await spendPaths(pool, idxs);
  if (!(await isKnownRoot(pool, root, wallet.address))) {
    throw new Error("could not reconstruct the on-chain tree (use an indexer for an older pool)");
  }
  const real: InNote[] = notes.map((n, i) => ({
    amount: BigInt(n.amount), ask: wallet.ask, nsk: wallet.nsk, d: noteD(n), blinding: BigInt(n.blinding),
    pathIndices: paths[i].pathIndices, pathElements: paths[i].pathElements,
  }));
  const inputs: [InNote, InNote] = real.length === 2 ? [real[0], real[1]] : [real[0], dummyInput(wallet)];
  return { inputs, root };
}

const sumNotes = (notes: Note[]) => notes.reduce((s, n) => s + BigInt(n.amount), 0n);

/** Withdraw `amount` to the wallet's public balance; remainder stays as change. */
export async function withdraw(
  wallet: Wallet,
  notes: Note[],
  amount: bigint,
  pool: Pool,
  opts: { relay?: boolean; artifacts?: string } = {},
): Promise<string> {
  // Self-signed withdraw (relay disabled) skips the relayer: no fee, sender pays.
  const selfSign = opts.relay === false;
  const { encryptNote } = await import("./crypto");
  const { inputs, root } = await spendInputsFor(pool, wallet, notes);
  const fee = selfSign ? 0n : await getQuote(pool);
  const change = sumNotes(notes) - amount - fee;
  if (change < 0n) throw new Error("amount + fee exceeds notes");
  const changeBlind = randScalar();
  const dummyBlind = randScalar();
  const outputs: [OutNote, OutNote] = [selfOut(wallet, change, changeBlind), selfOut(wallet, 0n, dummyBlind)];
  const e: ExtData = {
    extAmount: -amount, fee, recipient: wallet.address,
    relayer: selfSign ? wallet.address : pool.relayerAddress,
    encryptedOutput0: await encryptNote(wallet.pkD, wallet.d, change, changeBlind),
    encryptedOutput1: await encryptNote(wallet.pkD, wallet.d, 0n, dummyBlind),
  };
  const { proof } = await buildTransaction(root, inputs, outputs, e, pool.domain, opts.artifacts);
  const hash = selfSign ? await submit(pool, wallet, proof, e) : await relayerSubmit(pool, proof, e);
  await awaitTx(hash);
  for (const n of notes) markSpent(pool.id, wallet.address, n.commitment);
  if (change > 0n) addNote(pool.id, wallet.address, { amount: change.toString(), blinding: changeBlind.toString(), d: toHex(wallet.d), commitment: proof.commitments[0], leafIndex: -1, spent: false });
  return hash;
}

/** Private transfer to self: spend into two new private notes (amount + change),
 * no custody movement. */
export async function transfer(wallet: Wallet, notes: Note[], amount: bigint, pool: Pool): Promise<string> {
  const { encryptNote } = await import("./crypto");
  const { inputs, root } = await spendInputsFor(pool, wallet, notes);
  const fee = await getQuote(pool);
  const change = sumNotes(notes) - amount - fee;
  if (change < 0n) throw new Error("amount + fee exceeds notes");
  const b0 = randScalar();
  const b1 = randScalar();
  const outputs: [OutNote, OutNote] = [selfOut(wallet, amount, b0), selfOut(wallet, change, b1)];
  const e: ExtData = {
    extAmount: 0n, fee, recipient: pool.relayerAddress, relayer: pool.relayerAddress,
    encryptedOutput0: await encryptNote(wallet.pkD, wallet.d, amount, b0),
    encryptedOutput1: await encryptNote(wallet.pkD, wallet.d, change, b1),
  };
  const { proof } = await buildTransaction(root, inputs, outputs, e, pool.domain);
  const hash = await relayerSubmit(pool, proof, e);
  await awaitTx(hash);
  for (const n of notes) markSpent(pool.id, wallet.address, n.commitment);
  addNote(pool.id, wallet.address, { amount: amount.toString(), blinding: b0.toString(), d: toHex(wallet.d), commitment: proof.commitments[0], leafIndex: -1, spent: false });
  if (change > 0n) addNote(pool.id, wallet.address, { amount: change.toString(), blinding: b1.toString(), d: toHex(wallet.d), commitment: proof.commitments[1], leafIndex: -1, spent: false });
  return hash;
}

/** Merge one or two notes into a single note worth their sum minus the fee. No
 * custody movement. The merged note is encrypted to our own viewing key so it
 * survives a local-storage loss (recoverable by scanning). */
export async function consolidate(wallet: Wallet, notes: Note[], pool: Pool): Promise<string> {
  const { encryptNote } = await import("./crypto");
  const { inputs, root } = await spendInputsFor(pool, wallet, notes);
  const fee = await getQuote(pool);
  const merged = sumNotes(notes) - fee;
  if (merged <= 0n) throw new Error("notes too small to cover the fee");
  const b0 = randScalar();
  const dummyBlind = randScalar();
  const outputs: [OutNote, OutNote] = [selfOut(wallet, merged, b0), selfOut(wallet, 0n, dummyBlind)];
  const e: ExtData = {
    extAmount: 0n, fee, recipient: pool.relayerAddress, relayer: pool.relayerAddress,
    encryptedOutput0: await encryptNote(wallet.pkD, wallet.d, merged, b0),
    encryptedOutput1: await encryptNote(wallet.pkD, wallet.d, 0n, dummyBlind),
  };
  const { proof } = await buildTransaction(root, inputs, outputs, e, pool.domain);
  const hash = await relayerSubmit(pool, proof, e);
  await awaitTx(hash);
  for (const n of notes) markSpent(pool.id, wallet.address, n.commitment);
  addNote(pool.id, wallet.address, { amount: merged.toString(), blinding: b0.toString(), d: toHex(wallet.d), commitment: proof.commitments[0], leafIndex: -1, spent: false });
  return hash;
}

/** Private transfer to another user's receiving address. output[0] is locked to
 * the recipient's spend pubkey and encrypted to their viewing key (they discover
 * it by scanning); output[1] is change back to self. No custody movement. */
export async function transferTo(wallet: Wallet, notes: Note[], amount: bigint, recipientAddr: string, pool: Pool): Promise<string> {
  const { parseAddress } = await import("./wallet");
  const { encryptNote } = await import("./crypto");
  const r = await parseAddress(recipientAddr); // { d, pkD }, validated in-subgroup
  const fee = await getQuote(pool);
  const change = sumNotes(notes) - amount - fee;
  if (change < 0n) throw new Error("amount + fee exceeds notes");

  const { inputs, root } = await spendInputsFor(pool, wallet, notes);
  const b0 = randScalar();
  const b1 = randScalar();
  const outputs: [OutNote, OutNote] = [
    { amount, pkD: r.pkD, blinding: b0 }, // locked to the recipient's diversified key
    selfOut(wallet, change, b1),
  ];
  const e: ExtData = {
    extAmount: 0n, fee, recipient: pool.relayerAddress, relayer: pool.relayerAddress, // recipient unused (ext_amount==0); relayer addr avoids leaking the sender
    encryptedOutput0: await encryptNote(r.pkD, r.d, amount, b0), // recipient's note (their diversifier)
    encryptedOutput1: await encryptNote(wallet.pkD, wallet.d, change, b1), // our change (encrypted even if zero)
  };
  const { proof } = await buildTransaction(root, inputs, outputs, e, pool.domain);
  const hash = await relayerSubmit(pool, proof, e);
  await awaitTx(hash);
  for (const n of notes) markSpent(pool.id, wallet.address, n.commitment);
  if (change > 0n) addNote(pool.id, wallet.address, { amount: change.toString(), blinding: b1.toString(), d: toHex(wallet.d), commitment: proof.commitments[1], leafIndex: -1, spent: false });
  return hash;
}

/** Discover incoming notes from a persisted cursor (or from 0 on a full rescan):
 * scan commitments' encrypted_output, decrypt with the viewing key, and add notes
 * locked to this wallet's spend key. Incremental by default; pass { full: true }
 * to re-scan the whole history (e.g. after a local-storage loss). */
export async function scanIncoming(wallet: Wallet, pool: Pool, opts: { full?: boolean } = {}): Promise<number> {
  const { decryptNote } = await import("./crypto");
  const cursorKey = `scanCursor:${pool.id}:${wallet.address}`;
  const since = opts.full ? 0 : Number(localStorage.getItem(cursorKey) ?? "0");
  // A recovered note may already be spent; its on-chain nullifier is the source
  // of truth, so mark spent rather than resurrect it as spendable. Fail closed:
  // if spent status cannot be confirmed, abort rather than persist as unspent
  // (which would inflate the balance and later fail on-chain). The caller retries.
  const isSpent = async (nf: bigint): Promise<boolean> => {
    const res = await fetch(`${pool.indexerUrl}/nullifier/${nf.toString(16).padStart(64, "0")}`);
    if (!res.ok) throw new Error(`indexer /nullifier returned ${res.status} - scan aborted to avoid wrong spent status`);
    return (await res.json()).spent === true;
  };
  // Discovery needs encrypted_output, which only the indexer serves; surface an
  // unreachable indexer as an error rather than silently reporting no notes.
  let rows: { leaf_index: string; commitment: string; encrypted_output: string }[] = [];
  try {
    const res = await fetch(`${pool.indexerUrl}/notes?since=${since}`);
    if (!res.ok) throw new Error(`indexer returned ${res.status}`);
    rows = await res.json();
  } catch (e) {
    throw new Error("indexer unreachable - cannot scan for incoming notes (" + (e as Error).message + ")");
  }

  const existing = new Set(loadNotes(pool.id, wallet.address).map((n) => n.commitment)); // incl. spent, so spent notes are not resurrected
  let added = 0;
  let maxLeaf = since - 1;
  for (const row of rows) {
    const leafIndex = Number(row.leaf_index);
    if (leafIndex > maxLeaf) maxLeaf = leafIndex;
    if (!row.encrypted_output) continue;
    const enc = Uint8Array.from(row.encrypted_output.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    const dec = await decryptNote(wallet.ivk, enc);
    if (!dec || dec.amount === 0n) continue;
    // Confirm the note is locked to us: recompute pk_d for its diversifier and
    // check the commitment matches the on-chain one.
    const pkD = await diversifiedKey(wallet.ivk, dec.d);
    const c = await noteCommitment(dec.amount, pkD, dec.blinding);
    if (c !== BigInt("0x" + row.commitment)) continue;
    if (existing.has(row.commitment)) continue;
    const nf = await noteNullifier(dec.amount, pkD, wallet.nsk, dec.blinding, leafIndex);
    const spent = await isSpent(nf);
    addNote(pool.id, wallet.address, { amount: dec.amount.toString(), blinding: dec.blinding.toString(), d: toHex(dec.d), commitment: row.commitment, leafIndex, spent });
    existing.add(row.commitment);
    if (!spent) added++;
  }
  // Advance the cursor past every leaf seen so the next poll only fetches new
  // outputs. A thrown isSpent aborts above and leaves the cursor, so the scan
  // retries from the same point (fail-closed).
  if (maxLeaf >= since) localStorage.setItem(cursorKey, String(maxLeaf + 1));
  return added;
}
