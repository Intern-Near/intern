import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DRAND_CHAIN, DRAND_HOSTS, drandRoundTime, fetchBeacon } from "../src/drand.ts";

const SIG =
  "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39";

describe("drand (01 1.7, item 22)", () => {
  it("quicknet round times: round 1 at genesis, then every 3 seconds", () => {
    assert.equal(drandRoundTime(1), Date.UTC(2023, 7, 23, 15, 9, 27));
    assert.equal(drandRoundTime(1000) - drandRoundTime(1), 999 * 3_000);
  });

  it("takes the beacon from the first relay that has it, and checks its round and form", async () => {
    const asked: string[] = [];
    const fetchFn = (async (url: string) => {
      asked.push(url);
      if (url.startsWith(DRAND_HOSTS[0] ?? "")) return new Response("down", { status: 502 });
      if (url.startsWith(DRAND_HOSTS[1] ?? "")) return Response.json({ round: 999, signature: SIG });
      return Response.json({ round: 1000, signature: SIG });
    }) as typeof fetch;
    assert.equal(await fetchBeacon(1000, fetchFn), SIG);
    assert.equal(asked.length, 3);
    assert.equal(asked[2], `${DRAND_HOSTS[2]}/${DRAND_CHAIN}/public/1000`);
  });

  it("fails with every relay's reason when none has it", async () => {
    const fetchFn = (async () => Response.json({ round: 7, signature: "zz" })) as unknown as typeof fetch;
    await assert.rejects(fetchBeacon(7, fetchFn), /no drand relay gave round 7 .*no 48-byte signature/);
  });
});
