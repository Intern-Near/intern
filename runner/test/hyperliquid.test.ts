import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkMarkets } from "../src/check.ts";
import { type HlAsset, parseMeta } from "../src/hyperliquid.ts";
import type { Network } from "../src/markets.ts";

// Real responses of POST /info {"type":"meta"}, saved by `npm run check -- --save`.
const SNAPSHOT = new URL("../../fixtures/hl/info/2026-11-11T1451Z/", import.meta.url);
const real = (network: Network): HlAsset[] =>
  parseMeta(readFileSync(new URL(`meta-${network}.json`, SNAPSHOT), "utf8"));

function at<T>(list: readonly T[], i: number): T {
  const v = list[i];
  if (v === undefined) throw new Error(`no item at ${i}`);
  return v;
}

function row(network: Network, assets: readonly HlAsset[], market: string) {
  const r = checkMarkets(network, assets).find((c) => c.market === market);
  if (!r) throw new Error(`no row for ${market}`);
  return r;
}

describe("Hyperliquid market list against 01 §4", () => {
  it("parses the real snapshots from 2026-11-11", () => {
    assert.equal(real("testnet").length, 213);
    assert.equal(real("mainnet").length, 235);
  });

  it("finds all six markets where 01 §4 says, on both networks", () => {
    for (const network of ["testnet", "mainnet"] as const) {
      const rows = checkMarkets(network, real(network));
      assert.equal(rows.length, 6);
      assert.deepEqual(
        rows.filter((r) => r.problems.length > 0),
        [],
      );
    }
    assert.equal(row("testnet", real("testnet"), "DOGE").found_index, 173);
    assert.equal(row("mainnet", real("mainnet"), "DOGE").found_index, 12);
  });

  it("reports a market whose index moved", () => {
    const assets = [...real("testnet")];
    [assets[172], assets[173]] = [at(assets, 173), at(assets, 172)];
    const doge = row("testnet", assets, "DOGE");
    assert.equal(doge.found_index, 172);
    assert.deepEqual(doge.problems, ["index is 172, 01 §4 says 173"]);
  });

  it("reports changed size decimals, delisting and a max leverage below 2", () => {
    const assets = real("mainnet").map((a) =>
      a.name === "TRUMP" ? { ...a, szDecimals: 2, isDelisted: true, maxLeverage: 1 } : a,
    );
    assert.deepEqual(row("mainnet", assets, "TRUMP").problems, [
      "size decimals are 2, 01 §4 says 1",
      "delisted",
      "max leverage 1 is below 2, the TRADER rank's limit",
    ]);
  });

  it("reports a market that is not listed", () => {
    const assets = real("testnet").map((a) => (a.name === "kSHIB" ? { ...a, name: "kSHIB-gone" } : a));
    const shib = row("testnet", assets, "SHIB");
    assert.equal(shib.found_index, null);
    assert.deepEqual(shib.problems, ['"kSHIB" is not listed on testnet']);
  });

  it("reports a market listed twice, and keeps the expected index when it is one of them", () => {
    const assets = real("testnet");
    const twice = [...assets, at(assets, 150)];
    const trump = row("testnet", twice, "TRUMP");
    assert.equal(trump.found_index, 150);
    assert.deepEqual(trump.problems, ["listed 2 times, at indexes 150, 213"]);
  });

  it("rejects bodies of the wrong shape", () => {
    assert.throws(() => parseMeta("not json"));
    assert.throws(() => parseMeta("{}"), /no `universe` array/);
    assert.throws(() => parseMeta('{"universe":[{"name":"X"}]}'), /asset 0 has an unexpected shape/);
    assert.throws(
      () => parseMeta('{"universe":[{"name":"X","szDecimals":0.5,"maxLeverage":3}]}'),
      /unexpected shape/,
    );
  });
});
