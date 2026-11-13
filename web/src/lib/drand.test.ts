import { describe, expect, it } from "vitest";
import { drandUrl, replayDraw } from "./drand";

const SEED = "af2bdbe1aa9b6ec1e2ade1d694f41fc71a831d0268e9891562113d8a62add1bf";

describe("replaying a payday draw (interface 1.7, section 9.18)", () => {
  it("gives a lone entrant the single pick", () => {
    expect(replayDraw(SEED, [["alice.testnet", "500"]])).toEqual(["alice.testnet"]);
  });

  it("is deterministic and makes eleven picks", () => {
    const tickets: [string, string][] = [["carol.testnet", "7000"], ["you.testnet", "2100"]];
    const a = replayDraw(SEED, tickets);
    expect(a).toHaveLength(11);
    expect(replayDraw(SEED, tickets)).toEqual(a);
    for (const pick of a) expect(["carol.testnet", "you.testnet"]).toContain(pick);
  });

  it("matches the sample vector: the first 16 bytes, little-endian, modulo 9100 is 3315, inside carol's 7000", () => {
    expect(replayDraw(SEED, [["carol.testnet", "7000"], ["you.testnet", "2100"]])[0]).toBe("carol.testnet");
    // The same number falls in the second account when the order is turned round
    expect(replayDraw(SEED, [["you.testnet", "2100"], ["carol.testnet", "7000"]])[0]).toBe("carol.testnet");
    expect(replayDraw(SEED, [["you.testnet", "3400"], ["carol.testnet", "5700"]])[0]).toBe("you.testnet");
  });

  it("returns nothing for no tickets or a bad random number", () => {
    expect(replayDraw(SEED, [])).toEqual([]);
    expect(replayDraw("xyz", [["a.testnet", "1"]])).toEqual([]);
  });

  it("links to the quicknet chain", () => {
    expect(drandUrl(33930398)).toBe("https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/33930398");
  });
});
