import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requestBody } from "./exchange.ts";
import { parsePrices } from "./hyperliquid.ts";
import { FIXTURES_DIR } from "./paths.ts";
import { PINNED_01 } from "./pinned.ts";
import { marketDataMessage } from "./prompt.ts";
import { RANKS } from "./ranks.ts";
import { buildRulebookV12 } from "./rulebook.ts";

/**
 * The fixed question of the seed and temperature research (runner/docs/seed-and-temperature.md): one rulebook and
 * one user message that never change, so that the same case always gives the same request bytes. The rulebook is
 * 01 §6.1's text for rank INTERN on a $1,000 pool, round 42, a fixed nonce. The user message is the market data of
 * a saved Hyperliquid mainnet snapshot (fixtures/hl/info/2026-11-11T153837Z), then the runner's usual instruction.
 */
export const SEED_ROUND = 42;
export const SEED_NONCE = "5eed5eed5eed5eed";
const SNAPSHOT = "hl/info/2026-11-11T153837Z/metaAndAssetCtxs-mainnet.json";
const SNAPSHOT_AT = "2026-11-11T15:38:37.000Z";

export function seedRulebook(): string {
  return buildRulebookV12({
    round_id: SEED_ROUND,
    nonce: SEED_NONCE,
    rank: "INTERN",
    brave_at_open_e6: 1_000_000_000n,
    bets_used: 0,
    at_risk_e6: 0n,
    playbook: null,
  });
}

export function seedUserMessage(): string {
  const rows = parsePrices(readFileSync(join(FIXTURES_DIR, SNAPSHOT), "utf8"), "mainnet").filter((r) =>
    RANKS.INTERN.markets.includes(r.market),
  );
  return `${marketDataMessage(rows, SNAPSHOT_AT, "mainnet")}\nDecide this round's bet.`;
}

/** The cases: extra top-level request fields, written after `stream` (the runner's request has none). */
export const SEED_CASES: Readonly<Record<string, { what: string; extra?: Record<string, unknown> }>> = {
  default: { what: "The runner's request today: no temperature, no seed (the model's defaults)." },
  "t0-seed42": { what: 'Plus "temperature":0,"seed":42.', extra: { temperature: 0, seed: 42 } },
  "t1-seed42": { what: 'Plus "temperature":1,"seed":42.', extra: { temperature: 1, seed: 42 } },
  t0: { what: 'Plus "temperature":0 only.', extra: { temperature: 0 } },
  // Two invalid values: a refusal naming the field shows that some layer reads and checks it; silence would mean
  // the field is ignored or passed on unchecked.
  "bad-temperature": { what: 'Plus "temperature":-1 (invalid).', extra: { temperature: -1 } },
  "bad-seed": { what: 'Plus "seed":"x" (not a number).', extra: { seed: "x" } },
};

/** The exact request bytes of one case: the same bytes every time. */
export function seedRequest(name: string): Buffer {
  const c = SEED_CASES[name];
  if (c === undefined) throw new Error(`unknown case ${name}`);
  return requestBody(PINNED_01.model, seedRulebook(), seedUserMessage(), c.extra ? { extra: c.extra } : {});
}
