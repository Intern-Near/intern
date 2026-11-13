import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import type { Snapshot } from "./chain-snapshot.ts";
import { readConstants } from "./contract.ts";
import { usd } from "./explain.ts";
import { analyze, gather, MAX_ROUNDS } from "./fills-check.ts";
import { renderText } from "./fills-text.ts";
import { isRecord } from "./json.ts";
import { MARKETS, type Market } from "./markets.ts";
import {
  clock,
  QuoteError,
  quoteFromViews,
  quoteLines,
  readBet,
  readQuoteViews,
  type View,
} from "./quote.ts";
import { dollarLimit } from "./ranks.ts";
import { longShotOf } from "./rulebook.ts";
import { limitBase } from "./rules.ts";
import { verifyRound } from "./verify-round.ts";

/**
 * A read-only MCP server for the Intern, so other AI agents can look at it (the Agent Economy track). Six tools,
 * each only reading: the coin contract's views (01 §8) at the latest final block, Hyperliquid testnet's public
 * /info for fills-check, and public transactions for verify-round. No tool signs, sends or spends anything, and none
 * reads a key or .env: this module has no key to read and is given none (src/cli/mcp.ts starts it over stdio).
 */

export interface InternSources {
  /** The coin contract. */
  coin: string;
  /** NEAR RPC, for the answers' text (the first URL the snapshot reads from). */
  rpc: string;
  /** A fresh read-only snapshot: the latest final block and the coin's views at it. One per tool call. */
  snapshot(): Promise<Snapshot>;
  /** For Hyperliquid testnet's /info (fills-check) and NEAR RPC (verify-round). */
  fetchFn: typeof fetch;
  /** NEAR RPC URLs for verify-round: the regular node first, then archival nodes. */
  verifyRpcs: readonly string[];
  now(): number;
}

const READ_ONLY =
  "Read-only: it signs nothing, sends no transaction and spends nothing, and it reads no key and no .env.";
const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const INSTRUCTIONS =
  "$INTERN on NEAR testnet: an AI (the Intern) proposes Hyperliquid perp bets; a NEAR contract checks each one " +
  "against the Intern's rank (YES, or NOPE with one of 16 codes) and signs the orders itself. These tools only " +
  "read: the contract's views over NEAR RPC, Hyperliquid testnet's public /info and public transactions. Nothing " +
  "here signs, sends or spends anything. Start with intern_status; intern_quote shows the verdict a bet would get " +
  "from checks 6 to 12 right now, and why. Amounts ending in _e6 are US dollars times 1,000,000.";

/** A tool's answer: plain words first, then the same data as JSON (and as structuredContent). */
function answer(text: string, data: Record<string, unknown>): CallToolResult {
  return {
    content: [
      { type: "text", text },
      { type: "text", text: JSON.stringify(data) },
    ],
    structuredContent: data,
  };
}

function refusal(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Views of one snapshot, each read once (the block is fixed, so a second read would give the same answer). */
function once(view: View): View {
  const seen = new Map<string, Promise<unknown>>();
  return (method, args) => {
    const key = `${method} ${JSON.stringify(args)}`;
    let hit = seen.get(key);
    if (hit === undefined) {
      hit = view(method, args);
      seen.set(key, hit);
    }
    return hit;
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();
const blockOf = (s: Snapshot) => ({ height: s.block.height, hash: s.block.hash, time: iso(s.block.time_ms) });

/** The parts of get_pot that status shows (01 §8.1 `Pot`): dollars with 6 decimals as decimal strings. */
interface PotForStatus {
  brave_total_e6: string;
  brave_idle_e6: string;
  brave_lent_e6: string;
  brave_in_play_e6: string;
  brave_pending_e6: string;
  safe_total_e6: string;
  coin_supply_e6: string;
  coin_price_e6: string;
  bosses: number;
}

/** Reads those parts strictly: a missing field, or a number where a decimal string belongs, throws. */
function readPotForStatus(v: unknown): PotForStatus {
  const digits = (o: unknown, k: string, path: string): string => {
    const x = isRecord(o) ? o[k] : undefined;
    if (typeof x !== "string" || !/^(0|[1-9][0-9]*)$/.test(x))
      throw new Error(`${path}.${k}: expected a decimal string`);
    return x;
  };
  if (!isRecord(v) || !isRecord(v.brave) || !isRecord(v.safe))
    throw new Error("get_pot: expected brave and safe");
  if (typeof v.bosses !== "number") throw new Error("get_pot.bosses: expected a number");
  return {
    brave_total_e6: digits(v.brave, "total", "get_pot.brave"),
    brave_idle_e6: digits(v.brave, "idle", "get_pot.brave"),
    brave_lent_e6: digits(v.brave, "lent", "get_pot.brave"),
    brave_in_play_e6: digits(v.brave, "in_play", "get_pot.brave"),
    brave_pending_e6: digits(v.brave, "pending", "get_pot.brave"),
    safe_total_e6: digits(v.safe, "total", "get_pot.safe"),
    coin_supply_e6: digits(v, "coin_supply", "get_pot"),
    coin_price_e6: digits(v, "coin_price_e6", "get_pot"),
    bosses: v.bosses,
  };
}

/** 01 §8.1 `FeedItem`. */
function readFeed(v: unknown): { seq: number; at: number; event: string; data: Record<string, unknown> }[] {
  if (!Array.isArray(v)) throw new Error("get_feed: expected a list");
  return v.map((x: unknown, i: number) => {
    if (
      !isRecord(x) ||
      typeof x.seq !== "number" ||
      typeof x.at !== "number" ||
      typeof x.event !== "string" ||
      !isRecord(x.data)
    )
      throw new Error(`get_feed[${i}]: expected {seq, at, event, data}`);
    return { seq: x.seq, at: x.at, event: x.event, data: x.data };
  });
}

// ---------------------------------------------------------------- the tools

async function status(src: InternSources): Promise<CallToolResult> {
  const snap = await src.snapshot();
  const view = once(snap.view);
  const views = await readQuoteViews(view);
  const { constants: c, round, rank, rulebook } = views;
  const pot = readPotForStatus(await view("get_pot", {}));
  // The limits in force now, from the contract's own table (get_constants().ranks) and the limit base of 01 §3.
  const limits = c.ranks.find((r) => r.rank === rank.rank);
  if (!limits) throw new Error(`get_constants has no limits for rank ${rank.rank}`);
  const base = limitBase({
    brave_at_open_e6: BigInt(round.brave_at_open),
    brave_now_e6: BigInt(views.pot.brave_total),
  });
  const perBet = dollarLimit(base, limits.per_bet_bps);
  const perRound = dollarLimit(base, limits.per_round_bps);
  const roundLeft = perRound > BigInt(round.at_risk) ? perRound - BigInt(round.at_risk) : 0n;
  const ticket = longShotOf(rulebook.text); // 01 1.5: only a ticket round's rulebook has the line
  const msIn = snap.block.time_ms - round.started_at;
  const data = {
    coin: src.coin,
    block: blockOf(snap),
    interface_version: c.interface_version,
    network: c.network,
    rank: await view("get_rank", {}),
    round: {
      id: round.id,
      phase: round.phase,
      ms_into_round: msIn,
      started_at: iso(round.started_at),
      propose_from: iso(round.propose_from),
      propose_until: iso(round.propose_until),
      close_from: iso(round.close_from),
      ends_at: iso(round.ends_at),
      settled: round.settled,
      stuck: round.stuck,
      rank_at_open: round.rank,
      brave_at_open_e6: round.brave_at_open,
      bets_used: round.bets_used,
      at_risk_e6: round.at_risk,
      skipped: round.skipped,
      refused: round.refused,
      result_e6: round.result,
    },
    pool: pot,
    limits_now: {
      rank: rank.rank,
      status: rank.status,
      limit_base_e6: base.toString(),
      per_bet_e6: perBet.toString(),
      per_round_e6: perRound.toString(),
      round_left_e6: roundLeft.toString(),
      bets_left: Math.max(0, limits.max_bets - round.bets_used),
      max_bets: limits.max_bets,
      max_leverage: limits.max_leverage,
      markets: limits.markets,
      sides: limits.sides,
      min_notional_e6: c.min_notional,
      long_shot: ticket
        ? { margin_e6: ticket.margin_e6.toString(), max_leverage: ticket.max_leverage }
        : null,
    },
    bets_this_round: views.positions,
  };
  const pending =
    isRecord(data.rank) && isRecord(data.rank.pending)
      ? ` (waiting: ${JSON.stringify(data.rank.pending)})`
      : "";
  const text = [
    `$INTERN, ${src.coin} on ${c.network}, block ${snap.block.height} (${iso(snap.block.time_ms)}). ${READ_ONLY}`,
    `rank ${rank.rank}, ${rank.status} since round ${rank.since_round}${pending}`,
    `round ${round.id}: phase ${round.phase}, ${clock(msIn)} in; proposals ${clock(c.round.propose_from_ms)} to ` +
      `${clock(c.round.propose_until_ms)}, closing from ${clock(c.round.close_from_ms)}; ends ${iso(round.ends_at)}` +
      `${round.settled ? "; settled" : ""}${round.stuck ? "; STUCK" : ""}; skipped ${round.skipped}, refused ${round.refused}`,
    `pool: BRAVE ${usd(BigInt(views.pot.brave_total))} (at round open ${usd(BigInt(round.brave_at_open))}; idle ` +
      `${usd(BigInt(pot.brave_idle_e6))}, lent ${usd(BigInt(pot.brave_lent_e6))}, in play ` +
      `${usd(BigInt(pot.brave_in_play_e6))}, pending ${usd(BigInt(pot.brave_pending_e6))}); SAFE ` +
      `${usd(BigInt(pot.safe_total_e6))}; coin price ${usd(BigInt(pot.coin_price_e6))}; ${pot.bosses} boss(es)`,
    `limits now (${rank.rank}, from get_constants): per bet ${usd(perBet)}, per round ${usd(perRound)} ` +
      `(${usd(roundLeft)} left), bets ${round.bets_used} of ${limits.max_bets}, leverage up to ${limits.max_leverage}x, ` +
      `${limits.markets.join(", ")}, ${limits.sides.map((x) => x.toLowerCase()).join(" and ")}; min notional ` +
      `${usd(BigInt(c.min_notional))}; limit base ${usd(base)}` +
      (ticket
        ? `; this round has a long-shot ticket: margin exactly ${usd(ticket.margin_e6)}, up to ${ticket.max_leverage}x`
        : ""),
    views.positions.length === 0
      ? "bets this round: none"
      : `bets this round: ${views.positions
          .map(
            (p) =>
              `#${p.id} ${p.market} ${p.side.toLowerCase()} ${usd(BigInt(p.margin))} ×${p.leverage} ${p.status}`,
          )
          .join("; ")}`,
  ].join("\n");
  return answer(text, data);
}

async function rulebookTool(src: InternSources): Promise<CallToolResult> {
  const snap = await src.snapshot();
  const views = await readQuoteViews(once(snap.view));
  const r = views.rulebook;
  const data = { coin: src.coin, block: blockOf(snap), round_id: r.round_id, nonce: r.nonce, text: r.text };
  const head =
    `The rulebook get_rulebook serves now (round ${r.round_id}, nonce ${r.nonce}, block ${snap.block.height}). The ` +
    "program writes it from its own state; the runner sends it to the AI unchanged as the system message (01 §6.1). " +
    `The nonce changes after every ruling. ${READ_ONLY}`;
  return answer(`${head}\n\n${r.text}`, data);
}

async function quoteTool(
  src: InternSources,
  args: { market: Market; side: "long" | "short"; margin_usd: string | number; leverage: number },
): Promise<CallToolResult> {
  const bet = readBet({
    market: args.market,
    side: args.side,
    margin_usd: String(args.margin_usd),
    leverage: args.leverage,
  });
  if (!bet.ok) return refusal(`This bet cannot be quoted: ${bet.reason}.`);
  const snap = await src.snapshot();
  const views = await readQuoteViews(once(snap.view));
  try {
    const q = quoteFromViews(views, bet.decision, {
      coin: src.coin,
      now_ms: snap.block.time_ms,
      block: snap.block,
    });
    return answer(quoteLines(q).join("\n"), { ...q });
  } catch (e) {
    if (e instanceof QuoteError) return refusal(`No quote: ${e.message}.`);
    throw e;
  }
}

async function feedTool(
  src: InternSources,
  args: { after_seq?: number | undefined; limit: number },
): Promise<CallToolResult> {
  const snap = await src.snapshot();
  const viewArgs: Record<string, unknown> = { limit: args.limit };
  if (args.after_seq !== undefined) viewArgs.after_seq = args.after_seq;
  const items = readFeed(await snap.view("get_feed", viewArgs)).map((i) => ({ ...i, time: iso(i.at) }));
  const last = items.at(-1)?.seq ?? null;
  const data = { coin: src.coin, block: blockOf(snap), items, last_seq: last };
  const lines = items.map((i) => `#${i.seq} ${i.time} ${i.event} ${JSON.stringify(i.data)}`);
  const text = [
    `The coin's feed (get_feed, oldest first; the program keeps the latest 1,000 events, 01 §10), block ` +
      `${snap.block.height}. ${READ_ONLY}`,
    ...(lines.length > 0 ? lines : ["(no events)"]),
    ...(last === null ? [] : [`For newer events, call again with after_seq ${last}.`]),
  ].join("\n");
  return answer(text, data);
}

async function verifyTool(
  src: InternSources,
  args: { tx_hash: string; sender?: string | undefined },
): Promise<CallToolResult> {
  // The account that may propose is the contract's runner (01 §9.3); without a sender, that is the one asked.
  let sender = args.sender;
  if (sender === undefined) {
    const snap = await src.snapshot();
    sender = readConstants(await snap.view("get_constants", {})).runner;
  }
  const r = await verifyRound({ txHash: args.tx_hash, sender, rpcs: src.verifyRpcs, fetchFn: src.fetchFn });
  const ok = r.fatal === null && r.failures === 0 && r.unverified === 0;
  const data = {
    tx_hash: args.tx_hash,
    sender,
    rpcs: src.verifyRpcs,
    verified: ok,
    failures: r.failures,
    unverified: r.unverified,
    fatal: r.fatal,
    lines: r.lines,
  };
  const head = `verify-round for ${args.tx_hash} (sender ${sender}), from public data only. ${READ_ONLY}`;
  return answer([head, ...r.lines].join("\n"), data);
}

async function fillsTool(src: InternSources, args: { rounds: number }): Promise<CallToolResult> {
  const snap = await src.snapshot();
  const g = await gather(
    { contract: src.coin, view: snap.view, fetchFn: src.fetchFn, now: src.now },
    args.rounds,
  );
  const report = analyze(g, src.rpc);
  const data = {
    coin: src.coin,
    block: blockOf(snap),
    checked_at: report.checked_at,
    rounds: report.rounds,
    hl: report.hl,
    matching: report.matching,
    rule: report.rule,
    summary: report.summary,
    bets: report.bets.map((b) => ({
      round_id: b.round_id,
      position_id: b.position_id,
      market: b.market,
      side: b.side,
      leverage: b.leverage,
      position_status: b.position_status,
      orders_signed: b.orders_signed,
      fills_matched: b.fills_matched,
      reported_result_e6: b.reported?.result_e6 ?? null,
      recomputed_result_e6: b.recomputed?.result_e6 ?? null,
      status: b.status,
      reason: b.reason,
    })),
    unmatched_fills: report.unmatched_fills.length,
  };
  return answer(
    [`fills-check at block ${snap.block.height}. ${READ_ONLY}`, ...renderText(report)].join("\n"),
    data,
  );
}

// ---------------------------------------------------------------- the server

const MARKET_NAMES = MARKETS.map((m) => m.market) as [Market, ...Market[]];

export function internMcpServer(src: InternSources): McpServer {
  const server = new McpServer({ name: "intern-testnet", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "intern_status",
    {
      title: "The Intern now",
      description:
        "The Intern's rank and status, the current round (id, phase, times, counters), the pool (BRAVE and SAFE), " +
        `the limits in force now and this round's bets, from the coin contract's views at the latest final block. ${READ_ONLY}`,
      annotations: ANNOTATIONS,
    },
    () => status(src),
  );

  server.registerTool(
    "intern_rulebook",
    {
      title: "The rulebook now",
      description:
        "The exact rulebook text the contract serves now (get_rulebook): the system message the AI gets, with the " +
        `round, the nonce, the rank's markets, sides and limits. ${READ_ONLY}`,
      annotations: ANNOTATIONS,
    },
    () => rulebookTool(src),
  );

  server.registerTool(
    "intern_quote",
    {
      title: "Why NOPE? A free dry run of a bet",
      description:
        "The verdict a hypothetical bet would get right now from the contract's rank checks 6 to 12 (YES, or NOPE " +
        "with its code), with the rule in plain words, its section of the shared interface (01) and the numbers it " +
        "hit (asked against limit, and where the limit comes from). Checks 1 to 5 (the proposal window, the firing, " +
        "the AI's signature, the request, the decision line) are not part of a dry run. Nothing is proposed. " +
        READ_ONLY,
      inputSchema: {
        market: z.enum(MARKET_NAMES).describe("One of the six markets (01 §4)."),
        side: z
          .enum(["long", "short"])
          .describe("long or short, lower case as in the decision line (01 §6.2)."),
        margin_usd: z
          .union([z.string(), z.number()])
          .describe('The margin in US dollars, up to 6 decimals, e.g. "20" or 12.5.'),
        leverage: z.number().int().min(1).default(1).describe("A whole number, 1 or more (default 1)."),
      },
      annotations: ANNOTATIONS,
    },
    (args) => quoteTool(src, args),
  );

  server.registerTool(
    "intern_feed",
    {
      title: "Recent events",
      description:
        "Recent events from the coin contract's feed (get_feed, oldest first): rounds opening and settling, bets " +
        "approved, refusals with their codes, orders signed, results, votes, tips. Without after_seq, the latest " +
        `ones. ${READ_ONLY}`,
      inputSchema: {
        after_seq: z.number().int().min(0).optional().describe("Only events after this seq."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("How many events, 1 to 100 (default 20)."),
      },
      annotations: ANNOTATIONS,
    },
    (args) => feedTool(src, args),
  );

  server.registerTool(
    "intern_verify_round",
    {
      title: "Re-check a proposal from public data",
      description:
        "Re-checks one propose transaction from public NEAR data alone: the AI's signature against the pinned " +
        "model and signer, the request against the rulebook of that moment, the decision line, and whether the " +
        `contract's verdict fits (the runner's verify-round). ${READ_ONLY}`,
      inputSchema: {
        tx_hash: z
          .string()
          .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
          .describe("The propose transaction's hash (base58)."),
        sender: z
          .string()
          .min(2)
          .max(64)
          .optional()
          .describe("The account that sent it. Default: the contract's runner, get_constants().runner."),
      },
      annotations: ANNOTATIONS,
    },
    (args) => verifyTool(src, args),
  );

  server.registerTool(
    "intern_fills_check",
    {
      title: "Reported results against Hyperliquid's fills",
      description:
        "For the last N rounds: each bet's reported result against Hyperliquid testnet's own fills for the " +
        "contract's address, worked out again with the runner's rule, with a status per bet and a summary (the " +
        `runner's fills-check). ${READ_ONLY}`,
      inputSchema: {
        rounds: z
          .number()
          .int()
          .min(1)
          .max(MAX_ROUNDS)
          .default(10)
          .describe(`How many rounds back, the current one included: 1 to ${MAX_ROUNDS} (default 10).`),
      },
      annotations: ANNOTATIONS,
    },
    (args) => fillsTool(src, args),
  );

  return server;
}

/** The tool names, in the order they are registered. */
export const TOOL_NAMES = [
  "intern_status",
  "intern_rulebook",
  "intern_quote",
  "intern_feed",
  "intern_verify_round",
  "intern_fills_check",
] as const;
