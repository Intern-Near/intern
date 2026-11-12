import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { format, inspect } from "node:util";
import { readSecret, Secret } from "../src/secret.ts";

const VALUE = "sk-test-0123456789";

describe("Secret", () => {
  it("never prints its value", () => {
    const s = new Secret(VALUE);
    for (const printed of [
      String(s),
      `${s}`,
      JSON.stringify({ key: s }),
      inspect(s),
      inspect({ nested: { s } }),
      format("%s %o %j", s, s, s),
    ]) {
      assert.ok(!printed.includes(VALUE), `leaked in: ${printed}`);
      assert.ok(printed.includes("[redacted]"));
    }
  });

  it("gives the value only when asked", () => {
    assert.equal(new Secret(VALUE).reveal(), VALUE);
  });

  it("reads missing or empty variables as null", () => {
    assert.equal(readSecret("X", {}), null);
    assert.equal(readSecret("X", { X: "" }), null);
    assert.equal(readSecret("X", { X: VALUE })?.reveal(), VALUE);
  });
});
