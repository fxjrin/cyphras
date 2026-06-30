pragma circom 2.2.2;
include "../lib/poseidon2/poseidon2_hash.circom";
template P2_2() {
    signal input inputs[2];
    signal input dom;
    signal output out;
    component h = Poseidon2(2);
    for (var i = 0; i < 2; i++) { h.inputs[i] <== inputs[i]; }
    h.domainSeparation <== dom;
    out <== h.out;
}
component main = P2_2();
