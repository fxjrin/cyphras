pragma circom 2.2.2;
// Baby Jubjub key gadgets. Spend authority is algebraic: pubkey = s . Base8.

include "circomlib/circuits/babyjub.circom";      // BabyPbk
include "circomlib/circuits/comparators.circom";  // LessThan, IsEqual
include "circomlib/circuits/bitify.circom";       // Num2Bits

// Baby Jubjub prime-order subgroup order L, distinct from the BN254 field p.
function SUBGROUP_ORDER() {
  return 2736030358979909402780800718157159386076813972158567259200215660948447373041;
}

// P = s . Base8; s must already be canonical in [0, L).
template DerivePoint() {
  signal input s;
  signal output Px;
  signal output Py;
  component pk = BabyPbk();
  pk.in <== s;
  Px <== pk.Ax;
  Py <== pk.Ay;
}

// Assert a witness scalar is canonical in [0, L).
template AssertLtL() {
  signal input s;
  // bound s first so LessThan cannot wrap mod p (L < 2^251)
  component sBits = Num2Bits(251);
  sBits.in <== s;
  component lt = LessThan(251);
  lt.in[0] <== s;
  lt.in[1] <== SUBGROUP_ORDER();
  lt.out === 1;
}

// Reduce a field element in [0, p) to a canonical [0, L); p < 8L so k is in [0, 8).
// Non-canonical scalars would alias the same point and break nullifier determinism.
template ReduceModL() {
  signal input in;
  signal output out;
  signal k;
  var L = SUBGROUP_ORDER();
  // p - 7L: the only wrap is at k=7, where out must stay below this to keep out + 7L < p
  var RHO = 2736030358979909402780800718157159386010666595306063529296694559936676884330;
  out <-- in % L;
  k <-- in \ L;
  in === out + k * L;
  // bound out first, then out < L
  component outBits = Num2Bits(251);
  outBits.in <== out;
  component ltL = LessThan(251);
  ltL.in[0] <== out;
  ltL.in[1] <== L;
  ltL.out === 1;
  // k in [0, 8)
  component kBits = Num2Bits(3);
  kBits.in <== k;
  // wrap is only reachable at k=7; require out < p-7L so the reduction is unique
  component isK7 = IsEqual();
  isK7.in[0] <== k;
  isK7.in[1] <== 7;
  component ltRho = LessThan(252);
  ltRho.in[0] <== out;
  ltRho.in[1] <== RHO;
  signal k7bad <== isK7.out * (1 - ltRho.out);
  k7bad === 0;
}
