pragma circom 2.2.2;

// 2-in/2-out shielded JoinSplit; on-chain verifier untouched (only the VK changes).
// Domain tags: 01 commit, 02 nullifier, 05 pk_d, 06 nk, 07 ak, 10 ivk, 11 r_d.

include "poseidon2/poseidon2_hash.circom";
include "merkleProof.circom";
include "keypair.circom";                          // DerivePoint, AssertLtL, ReduceModL
include "circomlib/circuits/babyjub.circom";       // BabyCheck
include "circomlib/circuits/escalarmulany.circom"; // EscalarMulAny (variable base)
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

template Transaction(levels, nIns, nOuts) {
  signal input root;
  signal input publicAmount;
  signal input extDataHash;
  signal input domain;

  signal input inputNullifier[nIns];
  signal input inAmount[nIns];
  signal input inAsk[nIns];        // spend scalar, canonical in [0,L)
  signal input inNsk[nIns];        // nullifier scalar, canonical in [0,L)
  signal input inD[nIns];          // diversifier
  signal input inBlinding[nIns];
  signal input inPathIndices[nIns];
  signal input inPathElements[nIns][levels];
  signal input outputCommitment[nOuts];
  signal input outAmount[nOuts];
  signal input outPubkeyAx[nOuts]; // recipient pk_d.x
  signal input outPubkeyAy[nOuts]; // recipient pk_d.y
  signal input outBlinding[nOuts];

  component inAskChk[nIns];
  component inNskChk[nIns];
  component inAk[nIns];
  component inNk[nIns];
  component inAkFold[nIns];
  component inNkFold[nIns];
  component inIvkHash[nIns];
  component inIvkRed[nIns];
  component inRdHash[nIns];
  component inRdRed[nIns];
  component inGd[nIns];
  component inIvkBits[nIns];
  component inPkd[nIns];
  component inPkdFold[nIns];
  component inCommitmentHasher[nIns];
  component inNullifierHasher[nIns];
  component inTree[nIns];
  component inCheckRoot[nIns];
  component inAmountCheck[nIns];
  var sumIns = 0;

  for (var tx = 0; tx < nIns; tx++) {
    inAskChk[tx] = AssertLtL();
    inAskChk[tx].s <== inAsk[tx];
    inNskChk[tx] = AssertLtL();
    inNskChk[tx].s <== inNsk[tx];

    inAk[tx] = DerivePoint();
    inAk[tx].s <== inAsk[tx];
    inNk[tx] = DerivePoint();
    inNk[tx].s <== inNsk[tx];

    // fold each point to one field (no t=5 Poseidon2)
    inAkFold[tx] = Poseidon2(2);
    inAkFold[tx].inputs[0] <== inAk[tx].Px;
    inAkFold[tx].inputs[1] <== inAk[tx].Py;
    inAkFold[tx].domainSeparation <== 0x07;

    inNkFold[tx] = Poseidon2(2);
    inNkFold[tx].inputs[0] <== inNk[tx].Px;
    inNkFold[tx].inputs[1] <== inNk[tx].Py;
    inNkFold[tx].domainSeparation <== 0x06;

    inIvkHash[tx] = Poseidon2(2);
    inIvkHash[tx].inputs[0] <== inAkFold[tx].out;
    inIvkHash[tx].inputs[1] <== inNkFold[tx].out;
    inIvkHash[tx].domainSeparation <== 0x10;
    inIvkRed[tx] = ReduceModL();
    inIvkRed[tx].in <== inIvkHash[tx].out;

    // g_d = r_d.Base8, r_d from the diversifier
    inRdHash[tx] = Poseidon2(1);
    inRdHash[tx].inputs[0] <== inD[tx];
    inRdHash[tx].domainSeparation <== 0x11;
    inRdRed[tx] = ReduceModL();
    inRdRed[tx].in <== inRdHash[tx].out;
    inGd[tx] = DerivePoint();
    inGd[tx].s <== inRdRed[tx].out;

    // pk_d = ivk . g_d (off-chain: (ivk*r_d).Base8, same point)
    inIvkBits[tx] = Num2Bits(253);
    inIvkBits[tx].in <== inIvkRed[tx].out;
    inPkd[tx] = EscalarMulAny(253);
    for (var i = 0; i < 253; i++) { inPkd[tx].e[i] <== inIvkBits[tx].out[i]; }
    inPkd[tx].p[0] <== inGd[tx].Px;
    inPkd[tx].p[1] <== inGd[tx].Py;

    inPkdFold[tx] = Poseidon2(2);
    inPkdFold[tx].inputs[0] <== inPkd[tx].out[0];
    inPkdFold[tx].inputs[1] <== inPkd[tx].out[1];
    inPkdFold[tx].domainSeparation <== 0x05;

    inCommitmentHasher[tx] = Poseidon2(3);
    inCommitmentHasher[tx].inputs[0] <== inAmount[tx];
    inCommitmentHasher[tx].inputs[1] <== inPkdFold[tx].out;
    inCommitmentHasher[tx].inputs[2] <== inBlinding[tx];
    inCommitmentHasher[tx].domainSeparation <== 0x01;

    // nullifier binds nk + leaf position
    inNullifierHasher[tx] = Poseidon2(3);
    inNullifierHasher[tx].inputs[0] <== inCommitmentHasher[tx].out;
    inNullifierHasher[tx].inputs[1] <== inPathIndices[tx];
    inNullifierHasher[tx].inputs[2] <== inNkFold[tx].out;
    inNullifierHasher[tx].domainSeparation <== 0x02;
    inNullifierHasher[tx].out === inputNullifier[tx];

    inTree[tx] = MerkleProof(levels);
    inTree[tx].leaf <== inCommitmentHasher[tx].out;
    inTree[tx].pathIndices <== inPathIndices[tx];
    for (var i = 0; i < levels; i++) {
      inTree[tx].pathElements[i] <== inPathElements[tx][i];
    }

    // dummy inputs (amount 0) skip the root check
    inCheckRoot[tx] = ForceEqualIfEnabled();
    inCheckRoot[tx].in[0] <== root;
    inCheckRoot[tx].in[1] <== inTree[tx].root;
    inCheckRoot[tx].enabled <== inAmount[tx];

    inAmountCheck[tx] = Num2Bits(248);
    inAmountCheck[tx].in <== inAmount[tx];

    sumIns += inAmount[tx];
  }

  component outBabyCheck[nOuts];
  component outPkdFold[nOuts];
  component outCommitmentHasher[nOuts];
  component outAmountCheck[nOuts];
  var sumOuts = 0;

  for (var tx = 0; tx < nOuts; tx++) {
    // untrusted sender point; off-curve only makes the note unspendable
    outBabyCheck[tx] = BabyCheck();
    outBabyCheck[tx].x <== outPubkeyAx[tx];
    outBabyCheck[tx].y <== outPubkeyAy[tx];

    outPkdFold[tx] = Poseidon2(2);
    outPkdFold[tx].inputs[0] <== outPubkeyAx[tx];
    outPkdFold[tx].inputs[1] <== outPubkeyAy[tx];
    outPkdFold[tx].domainSeparation <== 0x05;

    outCommitmentHasher[tx] = Poseidon2(3);
    outCommitmentHasher[tx].inputs[0] <== outAmount[tx];
    outCommitmentHasher[tx].inputs[1] <== outPkdFold[tx].out;
    outCommitmentHasher[tx].inputs[2] <== outBlinding[tx];
    outCommitmentHasher[tx].domainSeparation <== 0x01;
    outCommitmentHasher[tx].out === outputCommitment[tx];

    outAmountCheck[tx] = Num2Bits(248);
    outAmountCheck[tx].in <== outAmount[tx];

    sumOuts += outAmount[tx];
  }

  // nullifiers must differ
  component sameNullifiers[nIns * (nIns - 1) / 2];
  var index = 0;
  for (var i = 0; i < nIns - 1; i++) {
    for (var j = i + 1; j < nIns; j++) {
      sameNullifiers[index] = IsEqual();
      sameNullifiers[index].in[0] <== inputNullifier[i];
      sameNullifiers[index].in[1] <== inputNullifier[j];
      sameNullifiers[index].out === 0;
      index++;
    }
  }

  sumIns + publicAmount === sumOuts;

  // bind extDataHash + domain into the witness (anti-malleability)
  signal extDataSquare <== extDataHash * extDataHash;
  signal domainSquare <== domain * domain;
}

component main {public [root, publicAmount, extDataHash, domain, inputNullifier, outputCommitment]} = Transaction(20, 2, 2);
