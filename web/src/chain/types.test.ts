import { describe, expect, it } from "vitest";
import { REFUSAL_CODES, SCENES } from "./types";

describe("shared interface copy", () => {
  it("has the sixteen NOPE reasons, with no repeats", () => {
    expect(REFUSAL_CODES).toHaveLength(16);
    expect(new Set(REFUSAL_CODES).size).toBe(16);
  });

  it("keeps the program's check order", () => {
    expect(REFUSAL_CODES[0]).toBe("OUTSIDE_WINDOW");
    expect(REFUSAL_CODES[1]).toBe("FIRED");
    expect(REFUSAL_CODES[10]).toBe("OVER_TRADE_LIMIT");
    expect(REFUSAL_CODES[15]).toBe("TOO_EXPENSIVE");
  });

  it("has the ten scenes", () => {
    expect(SCENES).toHaveLength(10);
  });
});
