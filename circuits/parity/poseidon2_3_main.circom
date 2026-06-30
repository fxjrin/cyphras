pragma circom 2.2.2;
include "../lib/poseidon2/poseidon2_hash.circom";
template P2_3() {
    signal input inputs[3];
    signal input dom;
    signal output out;
    component h = Poseidon2(3);
    for (var i = 0; i < 3; i++) { h.inputs[i] <== inputs[i]; }
    h.domainSeparation <== dom;
    out <== h.out;
}
component main = P2_3();
