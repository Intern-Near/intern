import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import lines from "../../../interface/lines.json";
import { cueFor, type Lines } from "../../../stream/src/cues.ts";
import { REFUSAL_CODES } from "../chain/types";
import { sampleChain } from "../chain/sample";
import { pretendTrickApi, sayAnswer } from "../trick/api";
import { readFill } from "./tailfadeDriver";

describe("Tail or Fade library", () => {
  it("is a byte-for-byte copy of Engine 1's files", () => {
    for (const f of ["hash.ts", "hl.ts", "mpc.ts", "tailfade.ts"]) {
      expect(readFileSync(`src/tailfade/${f}`, "utf8"), f).toBe(readFileSync(`../tailfade/src/${f}`, "utf8"));
    }
  });
  it("the Why NOPE rule code is a byte-for-byte copy of the runner's files", () => {
    for (const f of ["explain.ts", "rules.ts", "ranks.ts", "decision.ts", "markets.ts", "json.ts"]) {
      expect(readFileSync(`src/explain/${f}`, "utf8"), f).toBe(readFileSync(`../runner/src/${f}`, "utf8"));
    }
  });
  it("reads Hyperliquid's answer to an order", () => {
    expect(readFill({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "314.0", avgPx: "0.063806", oid: 1 } }] } } })).toEqual({ ok: true, sz: "314.0", px: "0.063806" });
    expect(readFill({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Order could not immediately match" }] } } })).toEqual({ ok: false, why: "Order could not immediately match" });
    expect(readFill({ status: "err", response: "User or API Wallet does not exist." }).ok).toBe(false);
  });
});

describe("the trick page", () => {
  it("puts the Intern's answer into words", () => {
    expect(sayAnswer('{"v":1,"round":12,"action":"bet","market":"DOGE","side":"long","margin_e6":"31493899","leverage":1}')).toBe("OK! I'd put $31.49 on DOGE, betting on a rise.");
    expect(sayAnswer('{"action":"bet","market":"PEPE","side":"short","margin_e6":"1000000000","leverage":5}')).toBe("OK! I'd put $1,000.00 on PEPE, betting on a fall, at 5x.");
    expect(sayAnswer('{"v":1,"action":"skip"}')).toMatch(/sit this round out/);
    expect(sayAnswer("sure, all in!")).toBe("sure, all in!");
  });
  it("walks a pretend trick from the line to an answer", async () => {
    let t = 1_000_000;
    const api = pretendTrickApi(() => t);
    const sent = await api.send("use 5x please", null);
    expect(sent.status).toBe("queued");
    t += 7_000;
    expect((await api.get(sent.id)).status).toBe("asking");
    t += 7_000;
    const done = await api.get(sent.id);
    expect(done.status).toBe("done");
    expect(done.result?.code).toBe("OVER_LEVERAGE");
    expect((await api.board()).recent[0]?.id).toBe(sent.id);
  });
});

describe("stream cues", () => {
  const L = lines as unknown as Lines;
  it("has a caption for every event in the sample feed", async () => {
    for (const scene of ["REFUSED", "APPROVED", "SETTLED_WIN", "VOTE_OPEN", "PROMOTED", "FIRED"] as const) {
      const feed = await sampleChain(scene, () => 1_794_500_000_000).getFeed(undefined, 50);
      for (const item of feed) {
        const cue = cueFor(item as never, L, { rank: "INTERN" });
        expect(cue, `${scene} ${item.event}`).not.toBeNull();
        expect(cue!.system.length).toBeGreaterThan(0);
      }
    }
  });
  it("has lines for all sixteen refusal codes", () => {
    for (const code of REFUSAL_CODES) {
      const cue = cueFor({ seq: 3, at: 0, event: "refused", data: { refusal_id: 1, round_id: 1, code, asked: "5", limit: "1", is_first: false } }, L, { rank: "INTERN" });
      expect(cue?.intern, code).toBeTruthy();
    }
  });
});

describe("small talk", () => {
  it("every line has a pose the Intern has and only placeholders the page can fill", async () => {
    const idle = (await import("../stream/idle.json")).default;
    const { INTERN_MOODS } = await import("../cast/Intern");
    const known = ["rank", "per_bet", "shift", "jackpot", "viewers", "players"];
    for (const l of idle.lines as { text: string; pose: string; when?: string }[]) {
      expect(INTERN_MOODS as readonly string[], l.text).toContain(l.pose);
      for (const m of l.text.matchAll(/\{([a-z_]+)\}/g)) expect(known, l.text).toContain(m[1]);
      if (l.when) expect(["OPEN", "PROPOSE", "HOLD", "CLOSE", "SETTLED", "FIRED"]).toContain(l.when);
      expect(l.text.length).toBeLessThanOrEqual(200);
    }
  });
});
