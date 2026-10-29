import { describe, expect, it } from "bun:test";
import { CanonicalJsonService } from "../../src/application/services/canonical-json.service";

describe("CanonicalJsonService", () => {
  it("should generate identical hash regardless of key order", () => {
    const payload1 = {
      b: 2,
      a: 1,
      nested: { z: "foo", y: "bar" },
    };

    const payload2 = {
      nested: { y: "bar", z: "foo" },
      a: 1,
      b: 2,
    };

    const hash1 = CanonicalJsonService.hash(payload1);
    const hash2 = CanonicalJsonService.hash(payload2);

    expect(hash1).toBe(hash2);
  });

  it("should generate different hash for different values", () => {
    const payload1 = { a: "10.00", b: "BRL" };
    const payload2 = { a: "10.01", b: "BRL" };

    const hash1 = CanonicalJsonService.hash(payload1);
    const hash2 = CanonicalJsonService.hash(payload2);

    expect(hash1).not.toBe(hash2);
  });
});
