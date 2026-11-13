import type { Snapshot } from "../../src/chain-snapshot.ts";
import { buildRulebookV12, type LongShot } from "../../src/rulebook.ts";
import { fakeConstants } from "./fake-chain.ts";

/**
 * TEST DOUBLE, NOT THE PROGRAM. The coin contract's read-only views (01 §8) answered from memory in the shapes of
 * 01 §8.1, for the MCP server's tests. It answers views only: any other method name throws, and every call is
 * recorded, so a test can show that a tool asked for nothing but views. No command can select it.
 */

/** The 01 §8 views this double answers (all of them are read-only by 01's definition). */
export const VIEWS = [
  "get_constants",
  "get_rank",
  "get_round",
  "get_pot",
  "get_rulebook",
  "get_positions",
  "get_feed",
] as const;

export const T0 = Date.parse("2026-11-13T15:00:00Z");

export class FakeCoinViews {
  readonly calls: { method: string; args: Record<string, unknown> }[] = [];
  constants: Record<string, unknown> = {
    ...fakeConstants({
      id: "z-ai/glm-5.3-flash",
      signing_algo: "ed25519",
      signer: "5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff",
    }),
    runner: "intern-runner-ed25519.testnet",
  };
  rank: Record<string, unknown> = { rank: "INTERN", status: "EMPLOYED", since_round: 1, pending: null };
  round = {
    id: 54,
    phase: "PROPOSE",
    settled: false,
    stuck: false,
    started_at: T0,
    guess_closes_at: T0 + 840_000,
    propose_from: T0 + 900_000,
    propose_until: T0 + 1_200_000,
    close_from: T0 + 1_500_000,
    ends_at: T0 + 1_800_000,
    rank: "INTERN",
    status: "EMPLOYED",
    brave_at_open: "1000000000",
    bets_used: 0,
    at_risk: "0",
    skipped: 0,
    refused: 1,
    result: null as string | null,
  };
  braveNow = "1000000000";
  positions: Record<string, unknown>[] = [];
  feed: { seq: number; at: number; event: string; data: Record<string, unknown> }[] = [
    {
      seq: 1,
      at: T0,
      event: "round_opened",
      data: { round_id: 54, rank: "INTERN", status: "EMPLOYED", brave_at_open: "1000000000" },
    },
    {
      seq: 2,
      at: T0 + 905_000,
      event: "refused",
      data: {
        refusal_id: 9,
        round_id: 54,
        code: "OVER_TRADE_LIMIT",
        asked: "25000000",
        limit: "20000000",
        is_first: false,
      },
    },
  ];
  nonce = "0123456789abcdef";
  longShot: LongShot | undefined = undefined;
  /** The block every snapshot of this double reports. */
  block = {
    height: 277_000_000,
    hash: "FakeBlockHash1111111111111111111111111111111",
    time_ms: T0 + 1_000_000,
  };

  readonly view = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
    this.calls.push({ method, args });
    switch (method) {
      case "get_constants":
        return structuredClone(this.constants);
      case "get_rank":
        return structuredClone(this.rank);
      case "get_round":
        return structuredClone(this.round);
      case "get_pot":
        return {
          brave: {
            total: this.braveNow,
            lent: "900000000",
            in_play: this.round.at_risk,
            idle: (BigInt(this.braveNow) - 900_000_000n - BigInt(this.round.at_risk)).toString(),
            pending: "5000000",
            interest: "0",
            income_waiting: "0",
          },
          safe: { total: "250000000", lent: "0", idle: "250000000" },
          coin_supply: "900000000",
          coin_price_e6: "1111111",
          bosses: 3,
          outside_income_total: "0",
        };
      case "get_rulebook":
        return {
          round_id: this.round.id,
          nonce: this.nonce,
          text: buildRulebookV12({
            round_id: this.round.id,
            nonce: this.nonce,
            rank: this.rank.rank as "INTERN",
            brave_at_open_e6: BigInt(this.round.brave_at_open),
            bets_used: this.round.bets_used,
            at_risk_e6: BigInt(this.round.at_risk),
            playbook: null,
            ...(this.longShot ? { long_shot: this.longShot } : {}),
          }),
        };
      case "get_positions":
        return args.round_id === this.round.id ? structuredClone(this.positions) : [];
      case "get_feed": {
        const limit = typeof args.limit === "number" ? args.limit : 50;
        const after = typeof args.after_seq === "number" ? args.after_seq : undefined;
        const items =
          after === undefined
            ? this.feed.slice(-limit)
            : this.feed.filter((i) => i.seq > after).slice(0, limit);
        return structuredClone(items);
      }
      default:
        throw new Error(`the fake coin answers views only, not ${method}`);
    }
  };

  readonly snapshot = async (): Promise<Snapshot> => ({ block: this.block, view: this.view });
}
