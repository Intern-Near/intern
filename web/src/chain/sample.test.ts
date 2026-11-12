import { describe, expect, it } from "vitest";
import { sampleChain } from "./sample";
import { SCENES } from "./types";

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);

describe("sample data", () => {
  it("answers every scene with a round, a pot and a feed whose seq only goes up", async () => {
    for (const scene of SCENES) {
      const c = sampleChain(scene, () => T0);
      const [round, pot, feed] = await Promise.all([c.getRound(), c.getPot(), c.getFeed()]);
      expect(round.id).toBe(42);
      expect(BigInt(pot.brave.lent) + BigInt(pot.brave.in_play) + BigInt(pot.brave.idle)).toBe(BigInt(pot.brave.total));
      for (let i = 1; i < feed.length; i++) expect(feed[i]!.seq).toBeGreaterThan(feed[i - 1]!.seq);
    }
  });

  it("puts each scene in the right phase", async () => {
    const phase = async (s: (typeof SCENES)[number]) => (await sampleChain(s, () => T0).getRound()).phase;
    expect(await phase("QUIET")).toBe("OPEN");
    expect(await phase("REFUSED")).toBe("PROPOSE");
    expect(await phase("HOLDING")).toBe("HOLD");
    expect(await phase("SETTLED_WIN")).toBe("CLOSE");
    const stuck = await sampleChain("STUCK", () => T0).getRound();
    expect(stuck.stuck).toBe(true);
    expect(stuck.settled).toBe(false);
  });

  it("REFUSED: the refusal arrives a few seconds later, and the views follow", async () => {
    let now = T0;
    const c = sampleChain("REFUSED", () => now);
    const before = await c.getFeed();
    const last = before[before.length - 1]!.seq;
    expect(await c.getFeed(last)).toEqual([]);
    expect((await c.getRound()).refused).toBe(0);

    now += 5_000;
    const fresh = await c.getFeed(last);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.event).toBe("refused");
    expect(fresh[0]!.seq).toBe(last + 1);
    expect((await c.getRound()).refused).toBe(1);
    expect((await c.getRefusals())[0]!.code).toBe("OVER_TRADE_LIMIT");
  });

  it("APPROVED: a bet appears, then its order is signed", async () => {
    let now = T0;
    const c = sampleChain("APPROVED", () => now);
    expect(await c.getPositions()).toEqual([]);
    now += 5_000;
    expect((await c.getPositions())[0]!.status).toBe("APPROVED");
    expect((await c.getRound()).at_risk).toBe("20000000");
    now += 20_000;
    expect((await c.getPositions())[0]!.status).toBe("OPEN_SIGNED");
    const pot = await c.getPot();
    expect(pot.brave.in_play).toBe("20000000");
  });

  it("FIRED and PROMOTED set the rank state", async () => {
    expect((await sampleChain("FIRED", () => T0).getRank()).status).toBe("FIRED");
    expect((await sampleChain("PROMOTED", () => T0).getRank()).rank).toBe("ANALYST");
  });
});

describe("sample history", () => {
  it("finds one refusal by its number, and says nothing for a number that does not exist", async () => {
    const c = sampleChain("QUIET", () => T0);
    const [r] = await c.getRefusals(28, 1);
    expect(r!.id).toBe(28);
    expect(r!.code).toBe("OVER_LEVERAGE");
    const [none] = await c.getRefusals(27, 1);
    expect(none!.id).not.toBe(27);
  });

  it("has earlier shifts for the record", async () => {
    const c = sampleChain("QUIET", () => T0);
    const r41 = await c.getRoundById(41);
    expect(r41!.result).toBe("3100000");
    expect((await c.getPositions(41))[0]!.market).toBe("PENGU");
    expect((await c.getRoundById(40))!.skipped).toBe(1);
    expect(await c.getRoundById(3)).toBeNull();
  });
});
