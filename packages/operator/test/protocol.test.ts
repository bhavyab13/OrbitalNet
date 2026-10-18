import { describe, it, expect } from "vitest";
import { sign, verify, canonicalJson, generateKey, signAs, loadKey } from "@orbitalnet/protocol";

describe("protocol signing", () => {
  it("canonical json sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { z: 2, y: [3, { k: 1, a: 2 }] }, u: undefined })).toBe('{"a":{"y":[3,{"a":2,"k":1}],"z":2},"b":1}');
  });
  it("sign/verify roundtrip and tamper detection", () => {
    const k = generateKey("t");
    const s = sign({ hello: "world", n: 1 }, k.private_key!, "t");
    expect(s.kid).toBe("t");
    expect(verify(s, k.public_key)).toBe(true);
    expect(verify({ ...s, n: 2 }, k.public_key)).toBe(false);
    const other = generateKey("o");
    expect(verify(s, other.public_key)).toBe(false);
  });
  it("signAs uses the provisioned world key", () => {
    const wa = signAs("world", { sim_t: 1, issued_at: "x" });
    expect(verify(wa, loadKey("world").public_key)).toBe(true);
  });
});
