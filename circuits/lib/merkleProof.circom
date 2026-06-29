pragma circom 2.2.2;
// Binary merkle inclusion proof: recompute the root from a leaf and its sibling path.

include "poseidon2/poseidon2_compress.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/switcher.circom";

template MerkleProof(levels) {
  signal input leaf;
  signal input pathElements[levels];
  signal input pathIndices;
  signal output root;

  // pathIndices packs the per-level left/right selector bits
  component bits = Num2Bits(levels);
  bits.in <== pathIndices;

  component order[levels];
  component hash[levels];
  signal node[levels + 1];
  node[0] <== leaf;

  for (var i = 0; i < levels; i++) {
    // order the current node and its sibling by the selector bit
    order[i] = Switcher();
    order[i].sel <== bits.out[i];
    order[i].L <== node[i];
    order[i].R <== pathElements[i];

    hash[i] = PoseidonCompress();
    hash[i].inputs[0] <== order[i].outL;
    hash[i].inputs[1] <== order[i].outR;
    node[i + 1] <== hash[i].out;
  }

  root <== node[levels];
}
