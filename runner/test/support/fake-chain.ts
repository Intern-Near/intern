import type { Chain, ProposalArgs, Sent } from "../../src/chain.ts";
import type {
  ChainVerdict,
  Constants,
  Position,
  Pot,
  RankState,
  Round,
  Rulebook,
  SignedAction,
} from "../../src/contract.ts";
import { judge } from "../../src/judge.ts";
import { MARKETS } from "../../src/markets.ts";
import { formatScaled } from "../../src/pricing.ts";
import { MIN_NOTIONAL_E6, RANKS, type RankName } from "../../src/ranks.ts";
import { buildRulebookV12 } from "../../src/rulebook.ts";

/**
 * TEST DOUBLE, NOT THE PROGRAM. An in-memory stand-in for the contract, used only by the runner's own tests to drive
 * the round loop through every phase without NEAR. It follows 01 version 1.2 §5, §6.1, §7, §8 and §9.3 as the
 * runner reads them and judges proposals with the runner's own TypeScript copy of the checks (strict answer rule).
 * Its signatures are dummy bytes. No command of the runner can select it.
 */

export const T0 = Date.parse("2026-11-12T12:00:00Z");
export const DEMO_ROUND = {
  genesis_ms: T0,
  round_ms: 1_800_000,
  propose_from_ms: 900_000,
  propose_until_ms: 1_200_000,
  close_from_ms: 1_500_000,
};
export const HL_ADDRESS = "0x283779ffb96dc9ac3a03333e39b18ed0a793e040";
const DUMMY_SIG = { r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, v: 27 };

export function fakeConstants(model: Constants["model"]): Constants {
  return {
    interface_version: "1.3",
    network: "testnet",
    ranks: (["INTERN", "ANALYST", "TRADER"] as const).map((r) => ({
      ...RANKS[r],
      sides: [...RANKS[r].sides],
      markets: [...RANKS[r].markets],
    })),
    model,
    markets: MARKETS.map((m) => ({
      market: m.market,
      hl_name: m.hl_name,
      hl_asset: m.hl_asset.testnet,
      sz_decimals: m.sz_decimals,
    })),
    round: DEMO_ROUND,
    hl: {
      testnet: true,
      address: HL_ADDRESS,
      signer_contract: "v1.signer-prod.testnet",
      path: "hl-1",
      order_expiry_ms: 120_000,
    },
    runner: "runner.test",
    result_source: "REPORTED",
    min_notional: MIN_NOTIONAL_E6.toString(),
  };
}

interface RoundData {
  id: number;
  started_at: number;
  bets_used: number;
  at_risk: bigint;
  skipped: number;
  refused: number;
  settled: boolean;
  result: bigint | null;
}

export class FakeChain implements Chain {
  readonly contractId = "fake-contract.test";
  readonly calls: string[] = [];
  readonly positions_: Position[] = [];
  readonly outbox_: SignedAction[] = [];
  readonly refusals: ChainVerdict[] = [];
  rankState: RankState = { rank: "INTERN", status: "EMPLOYED", since_round: 1 };
  brave = 1_000_000_000n;
  /** The BRAVE pool now; null means the same as at the round's start. */
  braveNow: bigint | null = null;
  /** Time a call to NEAR's signing network takes (01 §9.3: 6 to 10 seconds). */
  signMs = 8_000;
  /** How many of the next `sign_next` calls return null, as when the signing network fails (Engine 1's note). */
  signFailures = 0;
  /** How many `get_round` reads after a settle still show the round unsettled, as when the view lags the chain. */
  settleLag = 0;
  #lagLeft = 0;
  #round: RoundData;
  #nonceCounter = 0;
  #nonce: string;
  #txCounter = 0;
  readonly #constants: Constants;
  readonly #clock: { now: number };

  constructor(constants: Constants, clock: { now: number }, roundId = 7) {
    this.#constants = constants;
    this.#clock = clock;
    this.#round = this.#fresh(roundId, T0);
    this.#nonce = this.#nextNonce();
  }

  #fresh(id: number, startedAt: number): RoundData {
    return {
      id,
      started_at: startedAt,
      bets_used: 0,
      at_risk: 0n,
      skipped: 0,
      refused: 0,
      settled: false,
      result: null,
    };
  }
  #nextNonce(): string {
    this.#nonceCounter++;
    return this.#nonceCounter.toString(16).padStart(16, "0");
  }
  #tx(): string {
    this.#txCounter++;
    return `faketx${this.#txCounter}`;
  }
  #phase(r: RoundData): Round["phase"] {
    const into = this.#clock.now - r.started_at;
    const c = this.#constants.round;
    if (into < c.propose_from_ms) return "OPEN";
    if (into < c.propose_until_ms) return "PROPOSE";
    if (into < c.close_from_ms) return "HOLD";
    return "CLOSE";
  }
  /** 01 §5: the next round starts once this one is settled, on the grid. */
  #roll(): void {
    const c = this.#constants.round;
    const r = this.#round;
    if (r.settled && this.#clock.now >= r.started_at + c.round_ms) {
      const slots = Math.floor((this.#clock.now - c.genesis_ms) / c.round_ms);
      this.#round = this.#fresh(r.id + 1, c.genesis_ms + slots * c.round_ms);
      this.#nonce = this.#nextNonce();
    }
  }
  #rulebookText(): string {
    const r = this.#round;
    return buildRulebookV12(
      {
        round_id: r.id,
        nonce: this.#nonce,
        rank: this.rankState.rank as RankName,
        brave_at_open_e6: this.brave,
        bets_used: r.bets_used,
        at_risk_e6: r.at_risk,
        playbook: null,
      },
      BigInt(this.#constants.min_notional),
    );
  }
  #position(id: number): Position {
    const p = this.positions_.find((x) => x.id === id);
    if (!p) throw new Error(`no position ${id}`);
    return p;
  }

  async constants(): Promise<Constants> {
    this.calls.push("get_constants");
    return this.#constants;
  }
  async rank(): Promise<RankState> {
    this.calls.push("get_rank");
    return { ...this.rankState };
  }
  async round(): Promise<Round> {
    this.calls.push("get_round");
    this.#roll();
    const r = this.#round;
    const c = this.#constants.round;
    const lagging = r.settled && this.#lagLeft > 0;
    if (lagging) this.#lagLeft--;
    return {
      id: r.id,
      phase: this.#phase(r),
      settled: r.settled && !lagging,
      stuck: false,
      started_at: r.started_at,
      propose_from: r.started_at + c.propose_from_ms,
      propose_until: r.started_at + c.propose_until_ms,
      close_from: r.started_at + c.close_from_ms,
      ends_at: r.started_at + c.round_ms,
      rank: this.rankState.rank,
      status: this.rankState.status,
      brave_at_open: this.brave.toString(),
      bets_used: r.bets_used,
      at_risk: r.at_risk.toString(),
      skipped: r.skipped,
      refused: r.refused,
      result: r.result === null ? null : r.result.toString(),
    };
  }
  async rulebook(): Promise<Rulebook> {
    this.calls.push("get_rulebook");
    return { round_id: this.#round.id, nonce: this.#nonce, text: this.#rulebookText() };
  }
  async pot(): Promise<Pot> {
    this.calls.push("get_pot");
    const total = this.braveNow ?? this.brave;
    return { brave_total: total.toString(), brave_idle: total.toString(), brave_lent: "0" };
  }
  async positions(roundId: number): Promise<Position[]> {
    this.calls.push(`get_positions ${roundId}`);
    return this.positions_.filter((p) => p.round_id === roundId).map((p) => ({ ...p }));
  }
  async outbox(): Promise<SignedAction[]> {
    this.calls.push("get_outbox");
    return this.outbox_.map((a) => ({ ...a }));
  }

  /** What `rebalance` returns next; set to an Error to make it fail. */
  rebalanceReply: string | Error = "0";
  /** The `credited_to` of each proposal, in order (null when none was sent). */
  readonly credited: (string | null)[] = [];

  async rebalance(): Promise<Sent<string>> {
    this.calls.push("rebalance");
    if (this.rebalanceReply instanceof Error) throw this.rebalanceReply;
    return { txHash: this.#tx(), value: this.rebalanceReply, tgas: null };
  }

  async propose(p: ProposalArgs): Promise<Sent<ChainVerdict>> {
    this.calls.push("propose");
    this.credited.push(p.credited_to ?? null);
    const r = this.#round;
    const c = this.#constants;
    const v = judge(
      {
        phase: this.#phase(r),
        status: this.rankState.status,
        rank: this.rankState.rank,
        brave_at_open_e6: this.brave,
        brave_now_e6: this.braveNow ?? this.brave,
        bets_used: r.bets_used,
        at_risk_e6: r.at_risk,
        ms_into_round: this.#clock.now - r.started_at,
        propose_from_ms: c.round.propose_from_ms,
        propose_until_ms: c.round.propose_until_ms,
        min_notional_e6: BigInt(c.min_notional),
      },
      { model: c.model.id, algo: c.model.signing_algo, signer: c.model.signer },
      { rulebook: this.#rulebookText(), round_id: r.id, nonce: this.#nonce },
      p,
      { answerRule: "strict" },
    );
    let out: ChainVerdict;
    if (v.verdict === "SKIP") {
      r.skipped++;
      out = { verdict: "SKIP" };
    } else if (v.verdict === "NOPE") {
      r.refused++;
      out = {
        verdict: "NOPE",
        refusal_id: this.refusals.length + 1,
        code: v.code,
        asked: v.asked,
        limit: v.limit,
      };
      this.refusals.push(out);
    } else {
      // Read the bet back out of the answer (the runner's own decision reader did this inside judge).
      const answer = JSON.parse(Buffer.from(p.response).toString("utf8")).choices[0].message.content;
      const d = JSON.parse(answer);
      const id = this.positions_.length + 1;
      const margin = BigInt(d.margin_e6);
      r.bets_used++;
      r.at_risk += margin;
      this.positions_.push({
        id,
        round_id: r.id,
        market: d.market,
        side: d.side === "long" ? "LONG" : "SHORT",
        margin: margin.toString(),
        leverage: d.leverage,
        notional: (margin * BigInt(d.leverage)).toString(),
        status: "APPROVED",
        approved_at: this.#clock.now,
        open_signed_at: null,
        close_signed_at: null,
        settled_at: null,
        sz_e8: null,
        returned: null,
        result: null,
      });
      out = { verdict: "YES", position_id: id };
    }
    this.#nonce = this.#nextNonce(); // 01 §6.1: the nonce changes after every ruling
    return { txHash: this.#tx(), value: out, tgas: null };
  }

  #signed(p: Position, kind: SignedAction["kind"], action: Record<string, unknown>): SignedAction {
    this.#clock.now += this.signMs;
    const a: SignedAction = {
      id: this.outbox_.length + 1,
      position_id: p.id,
      kind,
      action,
      nonce: this.#clock.now,
      expires_after: this.#clock.now + this.#constants.hl.order_expiry_ms,
      signature: { ...DUMMY_SIG },
      created_at: this.#clock.now,
    };
    this.outbox_.push(a);
    return a;
  }

  async signNext(positionId: number, pxE8: bigint): Promise<Sent<SignedAction | null>> {
    this.calls.push(`sign_next ${positionId}`);
    if (this.signFailures > 0) {
      this.signFailures--;
      this.#clock.now += this.signMs;
      return { txHash: this.#tx(), value: null, tgas: null };
    }
    const p = this.#position(positionId);
    const m = this.#constants.markets.find((x) => x.market === p.market);
    if (!m) throw new Error("no market");
    const mine = this.outbox_.filter((a) => a.position_id === p.id);
    if (p.status !== "APPROVED") throw new Error("sign_next: the position is not APPROVED");
    if (!mine.some((a) => a.kind === "LEVERAGE")) {
      const a = this.#signed(p, "LEVERAGE", {
        type: "updateLeverage",
        asset: m.hl_asset,
        isCross: false,
        leverage: p.leverage,
      });
      return { txHash: this.#tx(), value: a, tgas: null };
    }
    // size = floor(notional / px), cut to the market's size decimals (01 §9.3, hl-order's size_for).
    const step = 10n ** BigInt(8 - m.sz_decimals);
    const sz = ((BigInt(p.notional) * 10n ** 10n) / pxE8 / step) * step;
    const a = this.#signed(p, "OPEN", {
      type: "order",
      orders: [
        {
          a: m.hl_asset,
          b: p.side === "LONG",
          p: formatScaled(pxE8, 8),
          s: formatScaled(sz, 8),
          r: false,
          t: { limit: { tif: "Ioc" } },
        },
      ],
      grouping: "na",
    });
    p.status = "OPEN_SIGNED";
    p.open_signed_at = this.#clock.now;
    p.sz_e8 = sz.toString();
    return { txHash: this.#tx(), value: a, tgas: null };
  }

  async close(positionId: number, pxE8: bigint): Promise<Sent<SignedAction | null>> {
    this.calls.push(`close ${positionId}`);
    const p = this.#position(positionId);
    // 01 §9.3 step 4: signed again with a new price for as long as the position has no result.
    if ((p.status !== "OPEN_SIGNED" && p.status !== "CLOSE_SIGNED") || p.result !== null || p.sz_e8 === null)
      throw new Error("close: the position is not OPEN_SIGNED or CLOSE_SIGNED without a result");
    if (this.#phase(this.#round) !== "CLOSE" && this.rankState.status !== "FIRED")
      throw new Error("close: not in CLOSE");
    const m = this.#constants.markets.find((x) => x.market === p.market);
    if (!m) throw new Error("no market");
    const a = this.#signed(p, "CLOSE", {
      type: "order",
      orders: [
        {
          a: m.hl_asset,
          b: p.side !== "LONG",
          p: formatScaled(pxE8, 8),
          s: formatScaled(BigInt(p.sz_e8), 8),
          r: true,
          t: { limit: { tif: "Ioc" } },
        },
      ],
      grouping: "na",
    });
    p.status = "CLOSE_SIGNED";
    p.close_signed_at = this.#clock.now;
    return { txHash: this.#tx(), value: a, tgas: null };
  }

  async reportResult(positionId: number, returnedE6: bigint): Promise<Sent<null>> {
    this.calls.push(`report_result ${positionId} ${returnedE6}`);
    const p = this.#position(positionId);
    if (p.result !== null) throw new Error("report_result: already reported");
    p.returned = returnedE6.toString();
    p.result = (returnedE6 - BigInt(p.margin)).toString();
    p.status = "SETTLED";
    p.settled_at = this.#clock.now;
    return { txHash: this.#tx(), value: null, tgas: null };
  }

  async settle(roundId: number): Promise<Sent<unknown>> {
    this.calls.push(`settle ${roundId}`);
    const r = this.#round;
    if (r.id !== roundId || this.#phase(r) !== "CLOSE") throw new Error("settle: not now");
    if (r.settled) throw new Error("Smart contract panicked: the round is already settled");
    const mine = this.positions_.filter((p) => p.round_id === roundId);
    if (mine.some((p) => p.result === null)) throw new Error("settle: a bet has no result");
    r.settled = true;
    this.#lagLeft = this.settleLag;
    r.result = mine.reduce((sum, p) => sum + BigInt(p.result ?? "0"), 0n);
    return { txHash: this.#tx(), value: r.result.toString(), tgas: null };
  }
}
