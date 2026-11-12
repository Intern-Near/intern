import { describe, expect, it } from "vitest";
import codes from "../../../interface/refusal-codes.json";
import ranks from "../../../interface/ranks.json";
import vectors from "../../../interface/vectors/checks.json";
import { lightFor, refusalSentence } from "../lib/refusals";
import { sampleChain } from "./sample";
import { INTERFACE_VERSION, REFUSAL_CODES, type RefusalCode } from "./types";

/** The site must name the same rules as the program. These read the files the program is built from. */
describe("the shared interface files", () => {
  it("agree with the site on the interface version", () => {
    expect(codes.interface_version).toBe(INTERFACE_VERSION);
    expect(vectors.interface_version).toBe(INTERFACE_VERSION);
  });

  it("list the same sixteen codes in the same order", () => {
    expect(codes.codes.map((c) => c.code)).toEqual([...REFUSAL_CODES]);
  });

  it("put every code under the same light as the site does", () => {
    for (const c of codes.codes) expect(lightFor(c.code as RefusalCode) + 1).toBe(c.light);
  });

  it("give the same rank limits as the site's sample data", async () => {
    const constants = await sampleChain("QUIET").getConstants();
    const fromFile = (ranks as { ranks?: unknown[] }).ranks ?? ranks;
    expect(constants.ranks).toEqual(fromFile);
  });

  it("every refusing test case turns into a sentence with no missing number", () => {
    const refusing = vectors.rule_cases.filter((c) => c.expected.verdict === "NOPE");
    expect(refusing.length).toBeGreaterThan(10);
    for (const c of refusing) {
      const e = c.expected as { code: RefusalCode; asked?: string | null; limit?: string | null };
      const text = refusalSentence(e.code, { asked: e.asked ?? null, limit: e.limit ?? null });
      expect(text, `case ${c.id}`).not.toContain("?");
      expect(text.length).toBeGreaterThan(10);
    }
  });
});
