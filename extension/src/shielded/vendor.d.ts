// Minimal ambient types for the untyped proving libraries. Only the surface this module uses.

declare module "snarkjs" {
  export const groth16: {
    fullProve(input: unknown, wasmPath: string, zkeyPath: string): Promise<{ proof: unknown; publicSignals: string[] }>;
    verify(vk: unknown, pub: string[], proof: unknown): Promise<boolean>;
  };
  export const wtns: {
    calculate(input: unknown, wasmPath: string, wtns: { type: string }): Promise<void>;
    exportJson(wtns: { type: string }): Promise<bigint[]>;
  };
}

declare module "circomlibjs" {
  export function buildBabyjub(): Promise<{
    F: { e(x: unknown): unknown; toObject(x: unknown): bigint };
    Base8: [unknown, unknown];
    mulPointEscalar(p: [unknown, unknown], s: bigint): [unknown, unknown];
    packPoint(p: [unknown, unknown]): Uint8Array;
    unpackPoint(buf: Uint8Array): [unknown, unknown] | null;
    inCurve(p: [unknown, unknown]): boolean;
  }>;
}
