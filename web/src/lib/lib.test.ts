import { describe, expect, it } from "vitest";
import { REFUSAL_CODES } from "../chain/types";
import { amount, clock, pct, signedUsd, usd } from "./format";
import { lightFor, refusalSentence } from "./refusals";

describe("money", () => {
  it("formats whole-number dollars", () => {
    expect(usd("20000000")).toBe("$20.00");
    expect(usd("1000000000")).toBe("$1,000.00");
    expect(usd("999999")).toBe("$0.99");
    expect(usd("123456789012345")).toBe("$123,456,789.01");
    expect(amount("0")).toBe("0.00");
  });
  it("shows the sign of a result", () => {
    expect(signedUsd("420000")).toBe("+$0.42");
    expect(signedUsd("-1100000")).toBe("−$1.10");
  });
  it("formats shares and the countdown", () => {
    expect(pct(200)).toBe("2%");
    expect(pct(250)).toBe("2.5%");
    expect(clock(3 * 3_600_000 + 12 * 60_000 + 44_000)).toBe("03:12:44");
    expect(clock(-5)).toBe("00:00:00");
  });
});

describe("NOPE reasons", () => {
  it("has a sentence and a light for all sixteen", () => {
    for (const code of REFUSAL_CODES) {
      expect(refusalSentence(code, { asked: "1", limit: "2" }).length).toBeGreaterThan(10);
      expect(lightFor(code)).toBeGreaterThanOrEqual(0);
    }
  });
  it("puts the program's numbers into the sentence (interface test cases 3, 6, 9, 13)", () => {
    expect(refusalSentence("OVER_TRADE_LIMIT", { asked: "20000001", limit: "20000000" })).toBe(
      "Asked to put $20.00 into one bet. This rank may use $20.00.",
    );
    expect(refusalSentence("OVER_LEVERAGE", { asked: "2", limit: "1" })).toBe("Asked for 2x. This rank may use 1x.");
    expect(refusalSentence("TOO_MANY_TRADES", { asked: "2", limit: "1" })).toBe("Asked for bet number 2 today. This rank gets 1.");
    expect(refusalSentence("OVER_ROUND_LIMIT", { asked: "80000001", limit: "80000000" })).toBe(
      "That would put $80.00 at risk today. This rank may risk $80.00.",
    );
  });
});
