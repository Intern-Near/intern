import { describe, expect, it } from "vitest";
import { toE6 } from "./session";
import { SAMPLE_ACCOUNT, sampleChain } from "./sample";

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const start = (scene: "QUIET" | "HOLDING" = "QUIET") => {
  const chain = sampleChain(scene, () => T0);
  return { chain, act: chain.act(SAMPLE_ACCOUNT), me: () => chain.getAccount(SAMPLE_ACCOUNT) };
};

describe("amounts typed by a person", () => {
  it("turns dollars into whole numbers, and refuses anything odd", () => {
    expect(toE6("12.5")).toBe("12500000");
    expect(toE6("1,000")).toBe("1000000000");
    expect(toE6("0.000001")).toBe("1");
    expect(toE6("0")).toBeNull();
    expect(toE6("-5")).toBeNull();
    expect(toE6("1.2345678")).toBeNull();
    expect(toE6("ten")).toBeNull();
  });
});

describe("the pretend account's money", () => {
  it("SAFE is credited at once; BRAVE waits and can be taken back", async () => {
    const { chain, act, me } = start();
    await act.payIn("SAFE", "40000000");
    expect((await me()).safe).toBe("90000000");
    await act.payIn("BRAVE", "30000000");
    expect((await me()).pending_brave).toBe("30000000");
    expect((await me()).coin).toBe("100000000");
    expect(await act.getDollars()).toBe("180000000");
    await act.cashOut("BRAVE", "30000000", true);
    expect((await me()).pending_brave).toBe("0");
    expect(await act.getDollars()).toBe("210000000");
    const feed = await chain.getFeed();
    expect(feed.slice(-3).map((f) => f.event)).toEqual(["paid_in", "paid_in", "cashed_out"]);
  });

  it("refuses more than you have, and locked coins", async () => {
    const { act } = start();
    await expect(act.payIn("SAFE", "999000000")).rejects.toThrow(/only have/);
    await expect(act.cashOut("BRAVE", "50000000")).rejects.toThrow(/Locked coins/);
    await act.cashOut("BRAVE", "40000000");
    expect(Number(await act.getDollars())).toBeGreaterThan(289_000_000);
  });

  it("the pot's books still add up after moving money both ways", async () => {
    const { chain, act } = start("HOLDING");
    await act.turnDial("SAFE", "20000000");
    await act.turnDial("BRAVE", "10000000");
    const pot = await chain.getPot();
    expect(BigInt(pot.brave.lent) + BigInt(pot.brave.in_play) + BigInt(pot.brave.idle)).toBe(BigInt(pot.brave.total));
    expect(BigInt(pot.safe.lent) + BigInt(pot.safe.idle)).toBe(BigInt(pot.safe.total));
  });
});

describe("the pretend account's vote", () => {
  it("a fire vote without 34% of all locked coins fails at its deadline, however few voted no (interface 1.2)", async () => {
    let now = T0;
    const chain = sampleChain("QUIET", () => now);
    const act = chain.act(SAMPLE_ACCOUNT);
    await act.unlock("20000000"); // 40 locked of 150: under 34%
    await act.openVote("FIRE");
    const [v] = await chain.getVotes();
    await act.cast(v!.id, true);
    await expect(act.finishVote(v!.id)).rejects.toThrow(/still open/);
    now += 25 * 3_600_000;
    await act.finishVote(v!.id);
    expect((await chain.getVotes())[0]!.state).toBe("FAILED");
    expect((await chain.getRank()).status).toBe("EMPLOYED");
  });

  it("a fire vote with enough yes can be finished early, and takes effect at once", async () => {
    const { chain, act } = start();
    await act.openVote("FIRE");
    const [v] = await chain.getVotes();
    await expect(act.finishVote(v!.id)).rejects.toThrow(/still open/);
    await act.cast(v!.id, true);
    await expect(act.cast(v!.id, true)).rejects.toThrow(/already voted/);
    await act.finishVote(v!.id);
    expect((await chain.getRank()).status).toBe("FIRED");
    expect((await chain.getFeed()).slice(-2).map((f) => f.event)).toEqual(["vote_finished", "fired"]);
    await expect(act.openVote("PROMOTE")).rejects.toThrow(/rehire/);
  });

  it("a promotion cannot be finished before its deadline, and coins stay locked while it is open", async () => {
    const { chain, act } = start();
    await act.openVote("PROMOTE");
    const [v] = await chain.getVotes();
    await act.cast(v!.id, true);
    await expect(act.finishVote(v!.id)).rejects.toThrow(/still open/);
    await expect(act.unlock("10000000")).rejects.toThrow(/still open/);
    expect((await chain.getRank()).rank).toBe("INTERN");
  });
});
