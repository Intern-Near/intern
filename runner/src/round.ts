import { existsSync, readFileSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Chain } from "./chain.ts";
import type { ChainVerdict, Constants, Position, RankState, Round, SignedAction } from "./contract.ts";
import { requestBody, runExchange, writeNew } from "./exchange.ts";
import {
  cannotDeliver,
  type ExchangeReply,
  exchangeBody,
  fetchFills,
  fetchFunding,
  fetchMids,
  fetchOpenPositions,
  type InfoRecord,
  missingAccount,
  parseExchangeReply,
  postExchange,
} from "./hl-exchange.ts";
import { fetchPrices } from "./hyperliquid.ts";
import { answerText, judge } from "./judge.ts";
import type { Log } from "./log.ts";
import { MARKETS, type MarketRow } from "./markets.ts";
import { limitPxE8, parseScaled } from "./pricing.ts";
import { marketDataMessage } from "./prompt.ts";
import { MIN_NOTIONAL_E6, RANKS } from "./ranks.ts";
import { type BetOnExchange, CLOCK_SLACK_MS, type Outcome, workOutReturned } from "./result.ts";
import { askGlm, copycat, type Rival, type Verdict3 } from "./rivals.ts";
import { longShotOf } from "./rulebook.ts";
import type { Secret } from "./secret.ts";
import { hexToBytes, parseSignatureReply } from "./signature.ts";
import { TRICK_LIMITS, type TrickDesk } from "./trick-desk.ts";

/**
 * The runner's pass through a round (03 brief, step 5), driven by what the chain says each time: it reads the
 * round, the rank, the round's positions and the outbox, does the next thing that is due, and reads again. So it
 * can be stopped and started at any moment. The only things it keeps are logs: `runner.jsonl`, the AI exchanges,
 * and `deliveries.jsonl` (which signed actions it sent to Hyperliquid, and the replies).
 */

export interface Settings {
  /** Most exchanges with the model in one round, counting every verdict (YES, SKIP, NOPE). 1 by default. */
  maxAsks: number;
  /** How far through the market an immediate order's limit price is set, in basis points. */
  slippageBps: number;
  /** The last line of the user message, after the market data. */
  instruction: string;
}

export const DEFAULT_SETTINGS: Settings = {
  maxAsks: 1,
  slippageBps: 100,
  instruction: "Decide this round's bet.",
};

export interface Deps {
  chain: Chain;
  /** NEAR AI key. */
  apiKey: Secret;
  /** Used for NEAR AI and Hyperliquid. */
  fetchFn: typeof fetch;
  log: Log;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Where the runner's logs and AI exchanges go (`runner/logs/`). */
  dataDir: string;
  /** Where every Hyperliquid order request and reply is saved (`fixtures/hl/exchange/`). */
  hlSaveDir: string;
  /** The trick page's queue: asked in the proposal window after the Intern's own decision (`loop` only). */
  tricks?: TrickDesk;
  /** 01 1.7: labelled rival players who guess once a round while guessing is open (`src/rivals.ts`). */
  rivals?: Rival[];
}

/** A user-written message for the challenge page, put in the user message instead of the instruction. */
export const TRICK_MAX_BYTES = 2_000;

/** No new exchange is started with less than this left in the proposal window (thinking can take a minute). */
export const MIN_WINDOW_LEFT_MS = 90_000;
/** Failed exchanges with NEAR AI in one round before the runner stops asking (each is logged with its reason). */
const MAX_ASK_FAILURES = 3;
/** Consecutive failed passes (chain or network errors) before `runRound` gives up. */
const MAX_PASS_ERRORS = 20;
/** Closing orders signed for one bet before the runner stops and asks for a person (01 §9.3 step 4 sets no limit). */
export const MAX_CLOSE_SIGNS = 6;
/** The widest price margin a closing order is given, in basis points: each new close doubles it, up to this. */
export const MAX_CLOSE_SLIPPAGE_BPS = 1_000;

/** JSON with bigints written as decimal strings. */
const toJson = (v: unknown): string =>
  `${JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2)}\n`;

const stamp = (ms: number): string =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

/** The version of 01-SHARED-INTERFACE.md this runner follows. */
export const INTERFACE_VERSION = "1.7";
/**
 * Versions of 01 this runner works with: 1.4 and 1.5 added the reward ladder, 1.6 leagues, the weekly review and
 * order tags (none of which the runner has to do anything for), so a 1.3 contract still works.
 */
export const ACCEPTED_VERSIONS: readonly string[] = ["1.3", "1.4", "1.5", "1.6", "1.7"];
/** Versions with `rewards_tick`. */
const REWARD_VERSIONS: readonly string[] = ["1.4", "1.5", "1.6", "1.7"];

/**
 * A NEAR account id (NEAR's account-id rules: 2 to 64 characters, lower-case letters and digits in parts joined by
 * `-` or `_`, parts separated by `.`). For `credited_to`, which the program stores as given and cannot check.
 */
export function isAccountId(s: string): boolean {
  return s.length >= 2 && s.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);
}

/** Startup checks: the runner only works on testnet and on 01 version 1.3, with 01's market table. */
export function checkConstants(c: Constants): string[] {
  const problems: string[] = [];
  if (!ACCEPTED_VERSIONS.includes(c.interface_version))
    problems.push(
      `interface_version is ${c.interface_version}; this runner follows ${ACCEPTED_VERSIONS.join(" or ")}`,
    );
  if (c.network !== "testnet") problems.push(`network is ${c.network}; the runner is for testnet only`);
  if (!c.hl.testnet)
    problems.push("hl.testnet is false; the runner sends orders to Hyperliquid testnet only");
  if (!/^0x[0-9a-fA-F]{40}$/.test(c.hl.address))
    problems.push(`hl.address ${c.hl.address} is not an address`);
  for (const row of MARKETS) {
    const m = c.markets.find((x) => x.market === row.market);
    if (!m) problems.push(`market ${row.market} is missing from get_constants`);
    else if (
      m.hl_name !== row.hl_name ||
      m.hl_asset !== row.hl_asset.testnet ||
      m.sz_decimals !== row.sz_decimals
    ) {
      problems.push(`market ${row.market} differs from 01 §4: ${JSON.stringify(m)}`);
    }
  }
  for (const r of c.ranks) {
    const mine = RANKS[r.rank];
    const same =
      r.per_bet_bps === mine.per_bet_bps &&
      r.max_bets === mine.max_bets &&
      r.per_round_bps === mine.per_round_bps &&
      r.max_leverage === mine.max_leverage &&
      r.sides.join() === mine.sides.join() &&
      r.markets.join() === mine.markets.join();
    // Not fatal: the contract's numbers win. Only the runner's own forecast of the verdict uses its copy.
    if (!same)
      problems.push(`warning: rank ${r.rank} differs from 01 §3, so the runner's forecast may differ`);
  }
  if (BigInt(c.min_notional) !== MIN_NOTIONAL_E6)
    problems.push(`warning: min_notional is ${c.min_notional}, not 01 1.2's ${MIN_NOTIONAL_E6}`);
  return problems;
}

interface Delivery {
  contract: string;
  action_id: number;
  position_id: number;
  kind: SignedAction["kind"];
  sent: boolean;
  ok: boolean;
  detail: string;
}

export class Runner {
  readonly #d: Deps;
  readonly #s: Settings;
  readonly #c: Constants;
  readonly #deliveries = new Map<number, Delivery>();
  readonly #rivalsDone = new Set<number>();
  #lastRound: { id: number; bets_used: number; refused: number } | null = null;
  readonly #noted = new Set<string>();
  /** Rounds this process has called `rebalance` for (01 1.3 §9.6: once each round, before proposing). */
  readonly #rebalanced = new Set<number>();
  /** Rounds this process has settled: the chain's view can lag a few seconds behind the settle transaction. */
  readonly #settled = new Set<number>();
  /** The program's interface version, read again each round: the contract can be upgraded under a running runner. */
  #version: string;
  #askFailures = new Map<number, number>();

  constructor(deps: Deps, settings: Settings, constants: Constants) {
    this.#d = deps;
    this.#s = settings;
    this.#c = constants;
    this.#version = constants.interface_version;
    const file = this.#deliveriesFile;
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        const d = JSON.parse(line) as Delivery;
        if (d.contract === deps.chain.contractId) this.#deliveries.set(d.action_id, d);
      }
    }
  }

  get #deliveriesFile(): string {
    return join(this.#d.dataDir, "deliveries.jsonl");
  }

  #log(step: string, roundId: number | undefined, fields: Record<string, unknown> = {}): void {
    this.#d.log(roundId === undefined ? { step, ...fields } : { step, round_id: roundId, ...fields });
  }

  /** Logs a condition once per process, so a waiting loop does not repeat it every pass. */
  #once(key: string, step: string, roundId: number, fields: Record<string, unknown>): void {
    if (this.#noted.has(key)) return;
    this.#noted.add(key);
    this.#log(step, roundId, fields);
  }

  /** Waits until `ms`, and at least `minMs` (so a loop never spins when the chain lags behind the clock). */
  async #sleepUntil(ms: number, roundId: number, why: string, minMs = 5_000): Promise<void> {
    const wait = Math.max(ms - this.#d.now(), minMs);
    this.#log("wait", roundId, { until: new Date(this.#d.now() + wait).toISOString(), why });
    await this.#d.sleep(wait);
  }

  #market(name: string): MarketRow {
    const row = MARKETS.find((m) => m.market === name);
    if (!row) throw new Error(`unknown market ${name}`);
    return row;
  }

  // ------------------------------------------------------------ steps 3 to 8: ask the model, propose

  /**
   * One exchange with the pinned model and one proposal. `last` is the last line of the user message: the
   * instruction, or a visitor's message in the trick entry point. `creditedTo` is that visitor's account, sent as
   * `credited_to` (01 1.3 §9.5), or null. Returns the verdict, or null if nothing was proposed (the reason is logged).
   */
  async askAndPropose(
    round: Round,
    rank: RankState,
    last: string,
    creditedTo: string | null = null,
  ): Promise<ChainVerdict | null> {
    return (await this.askAndProposeDetailed(round, rank, last, creditedTo))?.verdict ?? null;
  }

  /** `askAndPropose`, also returning the `propose` transaction and the model's answer text (the trick page shows both). */
  async askAndProposeDetailed(
    round: Round,
    rank: RankState,
    last: string,
    creditedTo: string | null = null,
    attempt = 1,
  ): Promise<{ verdict: ChainVerdict; tx: string; answer: string | null } | null> {
    const { chain, fetchFn, apiKey } = this.#d;
    const c = this.#c;
    const rulebook = await chain.rulebook();
    if (rulebook.round_id !== round.id) {
      this.#log("ask skipped", round.id, { reason: `the rulebook is for round ${rulebook.round_id}` });
      return null;
    }
    const limits = c.ranks.find((r) => r.rank === round.rank);
    if (!limits) throw new Error(`get_constants has no limits for rank ${round.rank}`);

    // Step 4: market data for the user message: the rank's markets, Hyperliquid testnet, where the orders go.
    const prices = await fetchPrices("testnet", fetchFn);
    const at = new Date(this.#d.now()).toISOString();
    const rows = prices.rows.filter((r) => limits.markets.includes(r.market));
    const user = `${marketDataMessage(rows, at, "testnet")}\n${last}`;

    // Steps 5 and 6: the exchange, saved as it happens, and the pinned scheme's signature.
    const algo = c.model.signing_algo;
    const requestBytes = requestBody(c.model.id, rulebook.text, user);
    // One folder per exchange, named to the second; a second exchange in the same second gets a suffix.
    const base = join(this.#d.dataDir, "rounds", String(round.id), `ask-${stamp(this.#d.now())}`);
    let dir = base;
    for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`;
    const ex = await runExchange({
      dir,
      requestBytes,
      apiKey,
      fetchFn,
      algos: [algo],
      log: (detail) => this.#log("ai", round.id, { detail }),
    });
    await writeNew(
      join(dir, "meta.json"),
      `${JSON.stringify({ round_id: round.id, nonce: rulebook.nonce, model: c.model.id, algo, exchange: ex }, null, 2)}\n`,
    );
    if (ex.error !== undefined || ex.signatures[algo]?.status !== 200) {
      this.#log("ask failed", round.id, {
        reason: ex.error ?? `signature HTTP ${ex.signatures[algo]?.status}`,
        dir,
      });
      return null;
    }
    const response = await readFile(join(dir, "response.bin"));
    const reply = parseSignatureReply(await readFile(join(dir, `signature-${algo}.json`), "utf8"));
    const signature = hexToBytes(reply.signature, algo === "ecdsa" ? 65 : 64);
    if (signature === null) {
      this.#log("ask failed", round.id, { reason: "the signature is not hex of the right length", dir });
      return null;
    }

    // 01 1.7 (Engine 2's fix "e2"): the rulebook states the limit on the pool now, so it can change while the model
    // answers (a cash-out). An answer to an old text is refused WRONG_RULEBOOK: read it again, and ask once more.
    const again = await chain.rulebook();
    if (again.text !== rulebook.text) {
      this.#log("rulebook changed while asking", round.id, { attempt, dir });
      if (attempt >= 2) return null;
      return this.askAndProposeDetailed(await chain.round(), rank, last, creditedTo, attempt + 1);
    }

    // The runner's own forecast with its TypeScript copy of the checks (01 §7, version 1.2: nothing may stand before
    // or after the decision line), to compare with the contract's verdict.
    const proposal = { request: requestBytes, response, signature };
    const ticket = longShotOf(rulebook.text); // 01 1.5: only a ticket round has one
    const pot = await chain.pot();
    // 01 1.7: under the drawdown brake the program halves the limit base; the forecast does the same.
    const halve = /^brake: /m.test(rulebook.text) ? 2n : 1n;
    const state = {
      phase: round.phase,
      status: rank.status,
      rank: round.rank,
      brave_at_open_e6: BigInt(round.brave_at_open) / halve,
      brave_now_e6: BigInt(pot.brave_total) / halve,
      bets_used: round.bets_used,
      at_risk_e6: BigInt(round.at_risk),
      ms_into_round: this.#d.now() - round.started_at,
      propose_from_ms: c.round.propose_from_ms,
      propose_until_ms: c.round.propose_until_ms,
      min_notional_e6: BigInt(c.min_notional),
      ...(ticket ? { ticket } : {}),
    };
    const pinned = { model: c.model.id, algo, signer: c.model.signer };
    const expected = { rulebook: rulebook.text, round_id: round.id, nonce: rulebook.nonce };
    const forecast = judge(state, pinned, expected, proposal, { answerRule: "strict" });
    if (forecast.verdict === "NOPE" && forecast.code === "BAD_MODEL_SIGNATURE") {
      this.#log("SIGNER CHANGED?", round.id, {
        detail: `the answer's signature does not match the pinned signer ${c.model.signer}; the contract will refuse it`,
        signing_address: reply.signing_address,
      });
    }

    // Step 7: the proposal, with the exact bytes (and the visitor to credit, if any). Step 8: the verdict.
    this.#log("propose", round.id, {
      nonce: rulebook.nonce,
      dir,
      forecast: forecast.verdict === "NOPE" ? forecast.code : forecast.verdict,
      ...(creditedTo === null ? {} : { credited_to: creditedTo }),
    });
    const sent = await chain.propose(
      creditedTo === null ? proposal : { ...proposal, credited_to: creditedTo },
    );
    const v = sent.value;
    const said = v.verdict === "NOPE" ? v.code : v.verdict;
    const ours = forecast.verdict === "NOPE" ? forecast.code : forecast.verdict;
    this.#log("verdict", round.id, {
      tx: sent.txHash,
      tgas: sent.tgas,
      verdict: v,
      forecast: ours,
      agrees: said === ours,
    });
    if (said !== ours) {
      this.#log("CONTRACT AND RUNNER DISAGREE", round.id, { contract: said, runner_copy: ours, dir });
    }
    await writeFile(
      join(dir, "verdict.json"),
      `${JSON.stringify({ tx: sent.txHash, tgas: sent.tgas, verdict: v, forecast: ours, credited_to: creditedTo }, null, 2)}\n`,
      { flag: "wx" },
    );
    return { verdict: v, tx: sent.txHash, answer: answerText(response) };
  }

  /**
   * 01 1.3 §9.6, once each round before proposing: `rebalance` keeps the Intern's slice idle and lends the rest to the
   * lender (a STAND-IN on testnet), or brings money back. A failure is logged and the round goes on: the program
   * decides what may be bet, as always.
   */
  async #rebalance(roundId: number): Promise<void> {
    if (this.#rebalanced.has(roundId)) return;
    this.#rebalanced.add(roundId);
    // 01 1.4: the reward ladder's jackpots and draws, once a round (a 1.3 contract has no rewards_tick). The version is
    // read again here, once a round, because the contract may have been upgraded since the runner started.
    try {
      this.#version = (await this.#d.chain.constants()).interface_version;
    } catch {
      // keep the last version read; the round goes on
    }
    if (REWARD_VERSIONS.includes(this.#version)) await this.#rewardsTick(roundId);
    // 01 1.7: ask first (a free view) and skip a call that would fail with "nothing to move" (Engine 2's finding:
    // the relayer paid for one every round). An older contract has no such view: then call as before.
    if (this.#d.chain.rebalanceDue) {
      try {
        const due = await this.#d.chain.rebalanceDue();
        if (due === false) {
          this.#log("rebalance: nothing to move", roundId, { checked: "get_rebalance" });
          return;
        }
      } catch {
        // the view is missing or failed: fall back to calling rebalance
      }
    }
    try {
      const sent = await this.#d.chain.rebalance();
      const pot = await this.#d.chain.pot();
      this.#log("rebalanced", roundId, {
        tx: sent.txHash,
        tgas: sent.tgas,
        moved: sent.value,
        brave_total: pot.brave_total,
        brave_idle: pot.brave_idle,
        brave_lent: pot.brave_lent,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // The program refuses a rebalance with nothing to move (the slice is idle, the rest under $10): not a failure.
      if (/nothing to move/.test(reason)) this.#log("rebalance: nothing to move", roundId, {});
      else
        this.#log("rebalance failed", roundId, {
          reason,
          note: "the round goes on; the program decides what may be bet",
        });
    }
  }

  async #rewardsTick(roundId: number): Promise<void> {
    try {
      const sent = await this.#d.chain.rewardsTick();
      this.#log("rewards tick", roundId, { tx: sent.txHash, tgas: sent.tgas });
    } catch (e) {
      this.#log("rewards tick failed", roundId, {
        reason: e instanceof Error ? e.message : String(e),
        note: "the round goes on; anyone may call rewards_tick",
      });
    }
  }

  // ------------------------------------------------------------ steps 9 and 10: sign and deliver

  async #limitPx(market: string, isBuy: boolean, slippageBps = this.#s.slippageBps): Promise<bigint> {
    const row = this.#market(market);
    const mids = await fetchMids(this.#d.fetchFn);
    const mid = mids[row.hl_name];
    if (mid === undefined) throw new Error(`Hyperliquid testnet has no mid price for ${row.hl_name}`);
    const [whole = "0", frac = ""] = mid.split(".");
    const midE8 = BigInt(whole) * 100_000_000n + BigInt(frac.slice(0, 8).padEnd(8, "0"));
    return limitPxE8(midE8, isBuy, slippageBps, row.sz_decimals);
  }

  #delivered(a: SignedAction): Delivery | undefined {
    return this.#deliveries.get(a.id);
  }

  async #record(d: Delivery): Promise<void> {
    this.#deliveries.set(d.action_id, d);
    await appendFile(this.#deliveriesFile, `${JSON.stringify(d)}\n`);
  }

  /** Step 10: sends one signed action to Hyperliquid testnet, once, and saves the request and the reply. */
  async deliver(roundId: number, a: SignedAction): Promise<Delivery> {
    const done = this.#delivered(a);
    if (done) return done;
    const base = {
      contract: this.#d.chain.contractId,
      action_id: a.id,
      position_id: a.position_id,
      kind: a.kind,
    };
    const why = cannotDeliver(a, this.#d.now());
    if (why !== null) {
      const d: Delivery = { ...base, sent: false, ok: false, detail: why };
      this.#log("not delivered", roundId, {
        action_id: a.id,
        kind: a.kind,
        position_id: a.position_id,
        reason: why,
      });
      await this.#record(d);
      return d;
    }
    const body = exchangeBody(a);
    const dir = join(
      this.#d.hlSaveDir,
      `${stamp(this.#d.now())}-round${roundId}-position${a.position_id}-${a.kind.toLowerCase()}-action${a.id}`,
    );
    await writeNew(join(dir, "request.json"), body);
    const t0 = this.#d.now();
    let status: number;
    let text: string;
    try {
      ({ status, body: text } = await postExchange(body, this.#d.fetchFn));
    } catch (e) {
      // The request may or may not have arrived. It is not sent again: Hyperliquid refuses a nonce used before.
      const d: Delivery = {
        ...base,
        sent: true,
        ok: false,
        detail: `no reply: ${e instanceof Error ? e.message : String(e)}`,
      };
      this.#log("delivery failed", roundId, { action_id: a.id, kind: a.kind, reason: d.detail, dir });
      await this.#record(d);
      return d;
    }
    await writeNew(join(dir, "reply.json"), text);
    await writeNew(
      join(dir, "meta.json"),
      `${JSON.stringify({ url: "https://api.hyperliquid-testnet.xyz/exchange", http_status: status, ms: this.#d.now() - t0, action: a }, null, 2)}\n`,
    );
    let reply: ExchangeReply | null = null;
    try {
      reply = parseExchangeReply(text);
    } catch {
      // kept as it is on disk; reported below
    }
    const ok =
      status === 200 && reply !== null && reply.kind === "ok" && reply.statuses.every((s) => !("error" in s));
    const d: Delivery = { ...base, sent: true, ok, detail: text.slice(0, 300) };
    // Hyperliquid recovers the signer before it looks for the account, so this refusal names who signed.
    const signer = missingAccount(text);
    this.#log(ok ? "delivered" : "delivery refused", roundId, {
      action_id: a.id,
      kind: a.kind,
      position_id: a.position_id,
      http_status: status,
      reply: reply ?? text.slice(0, 300),
      ...(signer === null
        ? {}
        : {
            signer_recovered_by_hyperliquid: signer,
            signer_is_the_contract: signer === this.#c.hl.address.toLowerCase(),
          }),
      dir,
    });
    await this.#record(d);
    return d;
  }

  /**
   * Steps 9 and 10 for one approved bet: `sign_next` for the leverage, deliver it; then `sign_next` for the
   * opening order, deliver it. Each signed action is delivered at once, within its 120 seconds.
   */
  async #open(roundId: number, p: Position, actions: SignedAction[]): Promise<void> {
    const mine = actions.filter((a) => a.position_id === p.id);
    let lev = mine.filter((a) => a.kind === "LEVERAGE").at(-1);
    let open = mine.filter((a) => a.kind === "OPEN").at(-1);
    const isBuy = p.side === "LONG";

    if (p.status === "APPROVED") {
      if (!lev && !open) {
        const signed = await this.#signNext(roundId, p, isBuy);
        if (signed === null) return; // the signing network failed; the next pass calls sign_next again
        if (signed.kind === "LEVERAGE") lev = signed;
        else open = signed;
      }
      if (lev) {
        const d = await this.deliver(roundId, lev);
        if (!d.ok) {
          const why = d.sent ? `Hyperliquid refused it: ${d.detail}` : d.detail;
          const signer = d.sent ? missingAccount(d.detail) : null;
          if (signer !== null && signer === this.#c.hl.address.toLowerCase()) {
            // No account at the contract's address yet (never funded): no order can be placed or filled there, so
            // the opening order is signed and sent all the same, and Hyperliquid checks that signature too.
            this.#once(`no-account-${p.id}`, "Hyperliquid account not funded", roundId, {
              position_id: p.id,
              reason: `${why}. Hyperliquid recovered the contract's own address from the signature, so the leverage action is signed right; the address holds no test dollars (step 6). The opening order is still signed and sent: it cannot fill on an account that does not exist.`,
            });
          } else {
            this.#once(`no-open-${p.id}`, "not opening", roundId, {
              position_id: p.id,
              reason: `the leverage setting was not accepted (${why}); 01 gives no way to sign it again, so the opening order is not signed. The margin is reported back in full at close.`,
            });
            return;
          }
        }
      }
      if (!open) {
        const signed = await this.#signNext(roundId, p, isBuy);
        if (signed === null) return;
        open = signed;
      }
    }
    if (open) {
      const d = await this.deliver(roundId, open);
      if (!d.ok) {
        this.#once(`open-failed-${p.id}`, "opening order not placed", roundId, {
          position_id: p.id,
          reason: d.detail,
          note: "nothing is opened; at close the fills decide what is reported",
        });
      }
    }
  }

  /** Step 9: one `sign_next` call (the runner's key, no deposit). Null when the signing network failed this time. */
  async #signNext(roundId: number, p: Position, isBuy: boolean): Promise<SignedAction | null> {
    const px = await this.#limitPx(p.market, isBuy);
    const sent = await this.#d.chain.signNext(p.id, px);
    if (sent.value === null) {
      this.#log("not signed", roundId, {
        position_id: p.id,
        px_e8: px,
        tx: sent.txHash,
        tgas: sent.tgas,
        reason: "sign_next returned null: NEAR's signing network did not sign this time; it is called again",
      });
      return null;
    }
    this.#log("signed", roundId, {
      position_id: p.id,
      kind: sent.value.kind,
      px_e8: px,
      tx: sent.txHash,
      tgas: sent.tgas,
      action_id: sent.value.id,
    });
    return sent.value;
  }

  // ------------------------------------------------------------ steps 12 to 14: close, report, settle

  /**
   * Step 12 for one bet: sign the closing order and deliver it. 01 §9.3 step 4: while the bet has no result the close
   * may be signed again with a new price. An immediate-or-cancel order fills at once or never, so once every closing
   * order so far has been sent (or expired unsent) and Hyperliquid's fills still show the bet open, the close is
   * signed again at the price of that moment, with twice the price margin of the last one (up to
   * `MAX_CLOSE_SLIPPAGE_BPS`), at most `MAX_CLOSE_SIGNS` times.
   */
  async #close(roundId: number, p: Position, all: Position[], actions: SignedAction[]): Promise<void> {
    if (p.result !== null) return;
    if (p.status === "OPEN_SIGNED") {
      await this.#signClose(roundId, p, 0);
      return;
    }
    if (p.status !== "CLOSE_SIGNED") return;
    const closes = actions.filter((x) => x.position_id === p.id && x.kind === "CLOSE");
    let sentNow = false;
    for (const a of closes) {
      if (!this.#delivered(a)) {
        await this.deliver(roundId, a);
        sentNow = true;
      }
    }
    // Something was just sent: the next pass reads the fills, after Hyperliquid has had time to record them.
    if (sentNow) return;
    if (!actions.some((a) => a.position_id === p.id && a.kind === "OPEN")) return;
    const { outcome } = await this.#readBack(p, all, actions);
    if (outcome.kind !== "waiting") return;
    if (closes.length >= MAX_CLOSE_SIGNS) {
      this.#once(`stuck-close-${p.id}`, "STUCK", roundId, {
        position_id: p.id,
        reason: outcome.reason,
        note: `${closes.length} closing orders signed and the bet is still open on Hyperliquid; a person has to look`,
      });
      return;
    }
    this.#log("closing again", roundId, {
      position_id: p.id,
      reason: outcome.reason,
      closing_orders_before: closes.length,
    });
    await this.#signClose(roundId, p, closes.length);
  }

  /** One `close` call (the relayer, 1 yocto) at the price of this moment, then delivery. */
  async #signClose(roundId: number, p: Position, earlier: number): Promise<void> {
    const slippageBps = Math.min(this.#s.slippageBps * 2 ** earlier, MAX_CLOSE_SLIPPAGE_BPS);
    const px = await this.#limitPx(p.market, p.side !== "LONG", slippageBps);
    const sent = await this.#d.chain.close(p.id, px);
    if (sent.value === null) {
      this.#log("not signed", roundId, {
        position_id: p.id,
        kind: "CLOSE",
        px_e8: px,
        slippage_bps: slippageBps,
        tx: sent.txHash,
        tgas: sent.tgas,
        reason: "close returned null: NEAR's signing network did not sign this time; it is called again",
      });
      return;
    }
    this.#log("signed", roundId, {
      position_id: p.id,
      kind: sent.value.kind,
      px_e8: px,
      slippage_bps: slippageBps,
      tx: sent.txHash,
      tgas: sent.tgas,
      action_id: sent.value.id,
    });
    await this.deliver(roundId, sent.value);
  }

  /**
   * Reads what Hyperliquid recorded for the contract's account since the bet was approved (fills, funding, the open
   * positions) and works out what the bet returned. `keep` receives every reply as it came. As a cross-check, a bet
   * whose fills say it is closed must not still show as a position on Hyperliquid.
   */
  async #readBack(
    p: Position,
    all: Position[],
    actions: SignedAction[],
    keep?: (r: InfoRecord) => void,
  ): Promise<{ outcome: Outcome; bet: BetOnExchange }> {
    const user = this.#c.hl.address.toLowerCase();
    const from = p.approved_at - CLOCK_SLACK_MS;
    const to = this.#d.now();
    const { fetchFn } = this.#d;
    const fills = await fetchFills(user, from, to, fetchFn, keep);
    const funding = await fetchFunding(user, from, to, fetchFn, keep);
    const open = await fetchOpenPositions(user, fetchFn, keep);
    const others = all.filter((o) => o.id !== p.id && o.result === null).map((o) => this.#bet(o, actions));
    const bet = this.#bet(p, actions);
    const outcome = workOutReturned(bet, fills, funding, others);
    const szi = open[bet.coin];
    if (outcome.kind === "returned" && szi !== undefined && parseScaled(szi, 8) !== 0n) {
      return {
        outcome: {
          kind: "waiting",
          reason: `the fills say ${bet.coin} is closed, but Hyperliquid still shows a position of ${szi}`,
          detail: outcome.detail,
        },
        bet,
      };
    }
    return { outcome, bet };
  }

  #bet(p: Position, actions: SignedAction[]): BetOnExchange {
    const mine = actions.filter((a) => a.position_id === p.id);
    const win = (a: SignedAction) => ({ from: a.nonce, to: a.expires_after });
    const open = mine.filter((a) => a.kind === "OPEN").at(-1);
    return {
      position_id: p.id,
      coin: this.#market(p.market).hl_name,
      side: p.side,
      margin_e6: BigInt(p.margin),
      ordered_sz_e8: p.sz_e8 === null ? null : BigInt(p.sz_e8),
      open: open ? win(open) : null,
      close: mine.filter((a) => a.kind === "CLOSE").map(win),
    };
  }

  /** Step 13 for one bet. Returns true once its result is reported (or was already). */
  async #report(roundId: number, p: Position, all: Position[], actions: SignedAction[]): Promise<boolean> {
    if (p.result !== null || p.status === "SETTLED") return true;
    const chain = this.#d.chain;
    const opened = actions.some((a) => a.position_id === p.id && a.kind === "OPEN");
    if (!opened) {
      // No opening order was ever signed: nothing can be on the exchange.
      const sent = await chain.reportResult(p.id, BigInt(p.margin));
      this.#log("reported", roundId, {
        position_id: p.id,
        returned: p.margin,
        tx: sent.txHash,
        tgas: sent.tgas,
        note: "no opening order was signed: the margin is reported back in full",
      });
      return true;
    }
    if (p.status !== "CLOSE_SIGNED") return false;
    const raw: InfoRecord[] = [];
    const { outcome, bet } = await this.#readBack(p, all, actions, (r) => raw.push(r));
    if (outcome.kind === "returned") {
      // The evidence first: Hyperliquid's replies the amount comes from, next to the orders' own folders.
      const dir = join(this.#d.hlSaveDir, `${stamp(this.#d.now())}-round${roundId}-position${p.id}-result`);
      await writeNew(join(dir, "info.json"), toJson(raw));
      await writeNew(
        join(dir, "result.json"),
        toJson({
          contract: this.#d.chain.contractId,
          round_id: roundId,
          position_id: p.id,
          hl_address: this.#c.hl.address,
          bet,
          returned_e6: outcome.returned_e6,
          note: outcome.note,
          detail: outcome.detail,
          formula: "returned = margin + trading result - fees + funding (src/result.ts)",
        }),
      );
      const sent = await chain.reportResult(p.id, outcome.returned_e6);
      this.#log("reported", roundId, {
        position_id: p.id,
        returned: outcome.returned_e6,
        tx: sent.txHash,
        tgas: sent.tgas,
        note: outcome.note,
        detail: outcome.detail,
        dir,
      });
      return true;
    }
    if (outcome.kind === "needs-person") {
      this.#once(`person-${p.id}`, "NEEDS A PERSON", roundId, { position_id: p.id, reason: outcome.reason });
      return false;
    }
    const closes = actions.filter((a) => a.position_id === p.id && a.kind === "CLOSE");
    const allExpired = closes.every((a) => a.expires_after < this.#d.now());
    this.#once(`waiting-${p.id}-${outcome.reason}`, "waiting for the close", roundId, {
      position_id: p.id,
      reason: outcome.reason,
      note: allExpired
        ? "the bet is still open on Hyperliquid; the close is signed again with a new price (01 §9.3 step 4)"
        : "the closing order may still fill",
    });
    return false;
  }

  // ------------------------------------------------------------ one round

  /** Runs one step for one bet; a failure is logged (once per distinct reason) and does not stop the others. */
  async #each(roundId: number, p: Position, what: string, step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.#once(`${what}-${p.id}-${reason}`, `${what} failed`, roundId, {
        position_id: p.id,
        reason,
        retry: "next pass",
      });
    }
  }

  /**
   * One round, from wherever it is. "dry" stops after the verdicts (steps 1 to 8) and asks `maxAsks` times in this
   * process; "full" goes on to sign, deliver, close, report and settle, counting the verdicts the chain already
   * has. A round that was already settled when this starts is skipped: the next one is run.
   */
  async runRound(mode: "dry" | "full"): Promise<"dry-done" | "settled" | "gave-up"> {
    const { chain } = this.#d;
    let roundId: number | null = null;
    let errors = 0;
    let dryAsks = 0;
    for (;;) {
      try {
        const round = await chain.round();
        if (round.settled) {
          if (roundId === round.id) {
            this.#log("settled", round.id, { result: round.result });
            return "settled";
          }
          this.#once(`already-settled-${round.id}`, "round already settled", round.id, {
            note: "waiting for the next round",
          });
          await this.#sleepUntil(round.ends_at + 1_000, round.id, "the next round", 15_000);
          continue;
        }
        if (roundId === null) {
          roundId = round.id;
          this.#log("round", round.id, {
            phase: round.phase,
            rank: round.rank,
            status: round.status,
            brave_at_open: round.brave_at_open,
            mode,
          });
        } else if (round.id !== roundId) {
          this.#log("round over", roundId, { now_round: round.id });
          return "settled";
        }
        const outcome =
          mode === "dry" ? await this.#dryPass(round, () => dryAsks++, dryAsks) : await this.#fullPass(round);
        errors = 0;
        if (outcome !== null) return outcome;
      } catch (e) {
        errors++;
        this.#log("error", roundId ?? undefined, {
          reason: e instanceof Error ? e.message : String(e),
          retry_in_s: 15,
          consecutive: errors,
        });
        if (errors >= MAX_PASS_ERRORS) {
          this.#log("giving up", roundId ?? undefined, { reason: `${errors} failed passes in a row` });
          return "gave-up";
        }
        await this.#d.sleep(15_000);
      }
    }
  }

  /** May a new exchange start now? Logs why not, once. */
  #mayAsk(round: Round): boolean {
    const left = round.propose_until - this.#d.now();
    if (left >= MIN_WINDOW_LEFT_MS) return true;
    this.#once(`late-${round.id}`, "not asking", round.id, {
      reason: `only ${Math.max(0, Math.round(left / 1000))} s left in the proposal window`,
    });
    return false;
  }

  async #dryPass(round: Round, countAsk: () => void, asked: number): Promise<"dry-done" | null> {
    const { chain } = this.#d;
    if (round.phase === "OPEN") {
      await this.#sleepUntil(round.propose_from + 1_000, round.id, "proposals open");
      return null;
    }
    if (round.phase !== "PROPOSE") {
      this.#log("dry run done", round.id, {
        asked,
        note: `the proposal window is over (phase ${round.phase}); dry mode does not sign, close or settle`,
      });
      return "dry-done";
    }
    const failures = this.#askFailures.get(round.id) ?? 0;
    if (asked < this.#s.maxAsks && failures < MAX_ASK_FAILURES && this.#mayAsk(round)) {
      const rank = await chain.rank();
      const v = await this.askAndPropose(round, rank, this.#s.instruction);
      if (v === null) {
        this.#askFailures.set(round.id, failures + 1);
        this.#log("will ask again", round.id, {
          reason: "the last exchange failed",
          attempt: failures + 2,
          of: MAX_ASK_FAILURES,
          in_s: 30,
        });
        await this.#d.sleep(30_000);
      } else {
        countAsk();
      }
      return null;
    }
    this.#log("dry run done", round.id, { asked });
    return "dry-done";
  }

  /** 01 1.7: each rival guesses once a round, while guessing is open. A failure is logged; the round goes on. */
  async #rivalsGuess(round: Round): Promise<void> {
    const rivals = this.#d.rivals ?? [];
    if (rivals.length === 0 || this.#rivalsDone.has(round.id)) return;
    this.#rivalsDone.add(round.id);
    const closeMs = this.#c.round.guess_close_ms ?? this.#c.round.propose_from_ms - 60_000;
    if (this.#d.now() > round.started_at + closeMs - 10_000) return;
    const prev = this.#lastRound?.id === round.id - 1 ? this.#lastRound : null;
    for (const r of rivals) {
      try {
        const verdict: Verdict3 =
          r.strategy === "contrarian"
            ? "NOPE"
            : r.strategy === "copycat"
              ? copycat(prev)
              : await askGlm(
                  this.#c.model.id,
                  (await this.#d.chain.rulebook()).text,
                  this.#d.apiKey,
                  this.#d.fetchFn,
                );
        const tx = await r.guess(verdict);
        this.#log("rival guessed", round.id, { account: r.account, strategy: r.strategy, verdict, tx });
      } catch (e) {
        this.#log("rival guess failed", round.id, {
          account: r.account,
          reason: (e instanceof Error ? e.message : String(e)).slice(0, 200),
        });
      }
    }
  }

  async #fullPass(round: Round): Promise<null> {
    const { chain } = this.#d;
    // 01 1.7: the copycat rival repeats the last round's outcome; remember it as the rounds go by.
    if (this.#lastRound === null || this.#lastRound.id <= round.id)
      this.#lastRound = { id: round.id, bets_used: round.bets_used, refused: round.refused };
    const rank = await chain.rank();
    const fired = rank.status === "FIRED";
    const positions = await chain.positions(round.id);
    const actions = positions.length > 0 ? await chain.outbox() : [];

    // FIRED: no new bets; open bets may be closed at any time (01 §3, §9.3).
    if (fired) {
      this.#once(`fired-${round.id}`, "fired", round.id, { note: "no new bets; closing what is open" });
      const open = positions.filter((x) => x.status === "OPEN_SIGNED");
      for (const p of open)
        await this.#each(round.id, p, "close", () => this.#close(round.id, p, positions, actions));
      if (open.length > 0) return null; // read the chain again
    }

    switch (round.phase) {
      case "OPEN":
        await this.#rivalsGuess(round); // 01 1.7: once a round, before guessing closes
        await this.#sleepUntil(round.propose_from + 1_000, round.id, "proposals open");
        return null;

      case "PROPOSE":
      case "HOLD": {
        if (round.phase === "PROPOSE") await this.#rebalance(round.id);
        if (!fired) {
          for (const p of positions.filter((x) => x.status === "APPROVED" || x.status === "OPEN_SIGNED")) {
            await this.#each(round.id, p, "open", () => this.#open(round.id, p, actions));
          }
        }
        if (round.phase === "PROPOSE") {
          const limits = this.#c.ranks.find((r) => r.rank === round.rank);
          const rulings = round.bets_used + round.skipped + round.refused;
          const failures = this.#askFailures.get(round.id) ?? 0;
          const betsLeft = (limits?.max_bets ?? 0) - round.bets_used;
          if (
            !fired &&
            rulings < this.#s.maxAsks &&
            betsLeft > 0 &&
            failures < MAX_ASK_FAILURES &&
            this.#mayAsk(round)
          ) {
            const v = await this.askAndPropose(round, rank, this.#s.instruction);
            if (v === null) {
              this.#askFailures.set(round.id, failures + 1);
              this.#log("will ask again", round.id, {
                reason: "the last exchange failed",
                attempt: failures + 2,
                of: MAX_ASK_FAILURES,
                in_s: 30,
              });
              await this.#d.sleep(30_000);
            }
            return null;
          }
          // The trick page: visitors' messages, after the Intern's own decision, a few per window (spec 24.G).
          if (await this.#askTrick(round, rank)) return null;
        }
        // Nothing more to ask. Look again every minute (a bet approved late still needs signing) until closing opens.
        const until = round.phase === "PROPOSE" ? round.propose_until : round.close_from;
        await this.#sleepUntil(
          Math.min(until + 1_000, this.#d.now() + 60_000),
          round.id,
          round.phase === "PROPOSE" ? "proposal window" : "closing opens",
        );
        return null;
      }

      case "CLOSE": {
        for (const p of positions)
          await this.#each(round.id, p, "close", () => this.#close(round.id, p, positions, actions));
        const fresh = await chain.positions(round.id);
        const freshActions = fresh.length > 0 ? await chain.outbox() : [];
        let done = true;
        for (const p of fresh) {
          let reported = false;
          await this.#each(round.id, p, "report", async () => {
            reported = await this.#report(round.id, p, fresh, freshActions);
          });
          done = done && reported;
        }
        if (done) {
          if (this.#settled.has(round.id)) {
            // Settled by this process a moment ago; the view has not caught up yet.
            await this.#d.sleep(5_000);
            return null;
          }
          const sent = await chain.settle(round.id);
          this.#settled.add(round.id);
          this.#log("settle", round.id, { tx: sent.txHash, tgas: sent.tgas, value: sent.value });
          return null; // the next pass sees `settled`
        }
        if (round.stuck)
          this.#once(`stuck-${round.id}`, "round stuck", round.id, {
            note: "the contract marks this round stuck",
          });
        await this.#d.sleep(30_000);
        return null;
      }
    }
  }

  /**
   * One queued trick, if one is waiting and this window has room: the visitor's message goes after the market data,
   * the model answers, and the answer is proposed as it is, credited to the visitor when they proved their account.
   * Returns true if it asked (the caller reads the chain again).
   */
  async #askTrick(round: Round, rank: RankState): Promise<boolean> {
    const desk = this.#d.tricks;
    if (!desk) return false;
    if (desk.askedIn(round.id) >= TRICK_LIMITS.perWindow) return false;
    const t = desk.next();
    if (!t || !this.#mayAsk(round)) return false;
    desk.asking(t.id, round.id);
    this.#log("trick", round.id, { trick: t.id, credited_to: t.account_id });
    try {
      const r = await this.askAndProposeDetailed(round, rank, t.message, t.account_id);
      if (r === null) desk.notProposed(t.id, "the exchange with the model failed");
      else desk.done(t.id, r.verdict, r.tx, r.answer);
    } catch (e) {
      desk.notProposed(t.id, e instanceof Error ? e.message : String(e));
      throw e;
    }
    return true;
  }

  /**
   * The trick entry point (steps 3 to 8 with a visitor's message). Waits for the proposal window if needed.
   * `creditedTo` is the visitor's NEAR account, sent as `credited_to` (01 1.3 §9.5), or null.
   */
  async trick(message: string, creditedTo: string | null = null): Promise<ChainVerdict | null> {
    if (Buffer.byteLength(message, "utf8") > TRICK_MAX_BYTES)
      throw new Error(`the message is longer than ${TRICK_MAX_BYTES} bytes`);
    if (creditedTo !== null && !isAccountId(creditedTo))
      throw new Error(`credited_to ${JSON.stringify(creditedTo)} is not a NEAR account id`);
    for (;;) {
      const round = await this.#d.chain.round();
      if (round.phase === "PROPOSE" && round.propose_until - this.#d.now() >= MIN_WINDOW_LEFT_MS) {
        const rank = await this.#d.chain.rank();
        return this.askAndPropose(round, rank, message, creditedTo);
      }
      if (round.phase === "PROPOSE") {
        await this.#sleepUntil(
          round.ends_at + 1_000,
          round.id,
          "trick: too little time left; waiting for the next round",
          15_000,
        );
        continue;
      }
      const next = round.phase === "OPEN" ? round.propose_from : round.ends_at;
      await this.#sleepUntil(next + 1_000, round.id, "trick: waiting for the proposal window", 15_000);
    }
  }
}
