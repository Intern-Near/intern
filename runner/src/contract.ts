import { isRecord } from "./json.ts";
import type { Market } from "./markets.ts";
import type { Limits, RankName, Side } from "./ranks.ts";
import { REFUSAL_CODES, type RefusalCode } from "./rules.ts";

/**
 * The program's answers, as 01-SHARED-INTERFACE.md section 8.1 defines them, read strictly: every field the runner
 * uses must be there with the right type, or reading throws, so a surprise from the contract stops the runner with
 * a clear message instead of a wrong action. Fields the runner does not use are not checked (additions to 01 are
 * allowed without a version bump of the runner).
 */

export type Phase = "OPEN" | "PROPOSE" | "HOLD" | "CLOSE";
export type PositionStatus = "APPROVED" | "OPEN_SIGNED" | "CLOSE_SIGNED" | "SETTLED";

export interface Constants {
  interface_version: string;
  network: "testnet" | "mainnet";
  ranks: Limits[];
  model: { id: string; signing_algo: "ecdsa" | "ed25519"; signer: string };
  markets: { market: Market; hl_name: string; hl_asset: number; sz_decimals: number }[];
  round: {
    genesis_ms: number;
    round_ms: number;
    propose_from_ms: number;
    propose_until_ms: number;
    close_from_ms: number;
    /** When guessing closes, after the round's start (01 §5), when the contract says. */
    guess_close_ms?: number;
  };
  hl: { testnet: boolean; address: string; signer_contract: string; path: string; order_expiry_ms: number };
  runner: string;
  result_source: "REPORTED" | "MEASURED";
  /** Dollars with 6 decimals: the smallest notional a bet may have (01 1.2: "11000000"). */
  min_notional: string;
  /** `lending.mode` (01 1.3 §9.6: "STANDIN" on testnet), for display only; null when the program does not say. */
  lending_mode?: string | null;
}

/**
 * The part of `get_pot` the runner uses: the BRAVE pool now, for the limit base of 01 §3 (1.1), and where its money
 * is (idle, lent: 01 §9.6), which the runner logs around `rebalance`.
 */
export interface Pot {
  brave_total: string;
  brave_idle: string;
  brave_lent: string;
}

export interface RankState {
  rank: RankName;
  status: "EMPLOYED" | "FIRED";
  since_round: number;
}

export interface Round {
  id: number;
  phase: Phase;
  settled: boolean;
  stuck: boolean;
  started_at: number;
  propose_from: number;
  propose_until: number;
  close_from: number;
  ends_at: number;
  rank: RankName;
  status: "EMPLOYED" | "FIRED";
  brave_at_open: string;
  bets_used: number;
  at_risk: string;
  skipped: number;
  refused: number;
  result: string | null;
}

export interface Rulebook {
  round_id: number;
  nonce: string;
  text: string;
}

export interface Position {
  id: number;
  round_id: number;
  market: Market;
  side: Side;
  margin: string;
  leverage: number;
  notional: string;
  status: PositionStatus;
  approved_at: number;
  open_signed_at: number | null;
  close_signed_at: number | null;
  settled_at: number | null;
  sz_e8: string | null;
  returned: string | null;
  result: string | null;
}

export interface SignedAction {
  id: number;
  position_id: number;
  kind: "LEVERAGE" | "OPEN" | "CLOSE";
  /** The exact JSON Hyperliquid expects as "action". */
  action: Record<string, unknown>;
  nonce: number;
  expires_after: number;
  signature: { r: string; s: string; v: number };
  created_at: number;
}

export type ChainVerdict =
  | { verdict: "YES"; position_id: number }
  | { verdict: "SKIP" }
  | { verdict: "NOPE"; refusal_id: number; code: RefusalCode; asked: string | null; limit: string | null };

// ---------------------------------------------------------------- strict field readers

class ShapeError extends Error {}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (!isRecord(v)) throw new ShapeError(`${path}: expected an object`);
  return v;
}
function num(o: Record<string, unknown>, k: string, path: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isSafeInteger(v))
    throw new ShapeError(`${path}.${k}: expected a whole number`);
  return v;
}
function bool(o: Record<string, unknown>, k: string, path: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") throw new ShapeError(`${path}.${k}: expected true or false`);
  return v;
}
function str(o: Record<string, unknown>, k: string, path: string): string {
  const v = o[k];
  if (typeof v !== "string") throw new ShapeError(`${path}.${k}: expected a string`);
  return v;
}
/** A U128 of 01 §2: a whole number written as a decimal string, never a JSON number. */
function u128(o: Record<string, unknown>, k: string, path: string): string {
  const v = str(o, k, path);
  if (!/^(0|[1-9][0-9]*)$/.test(v)) throw new ShapeError(`${path}.${k}: expected a decimal string`);
  return v;
}
/** A Signed of 01 §2: like U128 but may start with "-". */
function signed(o: Record<string, unknown>, k: string, path: string): string {
  const v = str(o, k, path);
  if (!/^-?(0|[1-9][0-9]*)$/.test(v)) throw new ShapeError(`${path}.${k}: expected a signed decimal string`);
  return v;
}
function nullable<T>(o: Record<string, unknown>, k: string, read: () => T): T | null {
  return o[k] === null ? null : read();
}
function oneOf<T extends string>(
  o: Record<string, unknown>,
  k: string,
  values: readonly T[],
  path: string,
): T {
  const v = o[k];
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    throw new ShapeError(`${path}.${k}: expected one of ${values.join(", ")}`);
  }
  return v as T;
}

const RANKS = ["INTERN", "ANALYST", "TRADER"] as const;
const STATUSES = ["EMPLOYED", "FIRED"] as const;
const MARKETS = ["DOGE", "SHIB", "PEPE", "PENGU", "WIF", "TRUMP"] as const;
const SIDES = ["LONG", "SHORT"] as const;

// ---------------------------------------------------------------- readers, one per view

export function readConstants(v: unknown): Constants {
  const p = "get_constants";
  const o = obj(v, p);
  const model = obj(o.model, `${p}.model`);
  const round = obj(o.round, `${p}.round`);
  const hl = obj(o.hl, `${p}.hl`);
  if (!Array.isArray(o.markets)) throw new ShapeError(`${p}.markets: expected a list`);
  if (!Array.isArray(o.ranks)) throw new ShapeError(`${p}.ranks: expected a list`);
  return {
    interface_version: str(o, "interface_version", p),
    network: oneOf(o, "network", ["testnet", "mainnet"] as const, p),
    ranks: o.ranks.map((r, i) => readLimits(r, `${p}.ranks[${i}]`)),
    model: {
      id: str(model, "id", `${p}.model`),
      signing_algo: oneOf(model, "signing_algo", ["ecdsa", "ed25519"] as const, `${p}.model`),
      signer: str(model, "signer", `${p}.model`),
    },
    markets: o.markets.map((m, i) => {
      const mo = obj(m, `${p}.markets[${i}]`);
      const mp = `${p}.markets[${i}]`;
      return {
        market: oneOf(mo, "market", MARKETS, mp),
        hl_name: str(mo, "hl_name", mp),
        hl_asset: num(mo, "hl_asset", mp),
        sz_decimals: num(mo, "sz_decimals", mp),
      };
    }),
    round: {
      genesis_ms: num(round, "genesis_ms", `${p}.round`),
      round_ms: num(round, "round_ms", `${p}.round`),
      propose_from_ms: num(round, "propose_from_ms", `${p}.round`),
      propose_until_ms: num(round, "propose_until_ms", `${p}.round`),
      close_from_ms: num(round, "close_from_ms", `${p}.round`),
      ...(typeof round.guess_close_ms === "number" ? { guess_close_ms: round.guess_close_ms } : {}),
    },
    hl: {
      testnet: bool(hl, "testnet", `${p}.hl`),
      address: str(hl, "address", `${p}.hl`),
      signer_contract: str(hl, "signer_contract", `${p}.hl`),
      path: str(hl, "path", `${p}.hl`),
      order_expiry_ms: num(hl, "order_expiry_ms", `${p}.hl`),
    },
    runner: str(o, "runner", p),
    result_source: oneOf(o, "result_source", ["REPORTED", "MEASURED"] as const, p),
    min_notional: u128(o, "min_notional", p),
    lending_mode: isRecord(o.lending) && typeof o.lending.mode === "string" ? o.lending.mode : null,
  };
}

export function readPot(v: unknown): Pot {
  const p = "get_pot";
  const brave = obj(obj(v, p).brave, `${p}.brave`);
  return {
    brave_total: u128(brave, "total", `${p}.brave`),
    brave_idle: u128(brave, "idle", `${p}.brave`),
    brave_lent: u128(brave, "lent", `${p}.brave`),
  };
}

function list<T extends string>(
  o: Record<string, unknown>,
  k: string,
  values: readonly T[],
  path: string,
): T[] {
  const v = o[k];
  if (!Array.isArray(v)) throw new ShapeError(`${path}.${k}: expected a list`);
  return v.map((x, i) => oneOf({ x }, "x", values, `${path}.${k}[${i}]`));
}

export function readLimits(v: unknown, p = "get_limits"): Limits {
  const o = obj(v, p);
  return {
    rank: oneOf(o, "rank", RANKS, p),
    per_bet_bps: num(o, "per_bet_bps", p),
    max_bets: num(o, "max_bets", p),
    per_round_bps: num(o, "per_round_bps", p),
    sides: list(o, "sides", SIDES, p),
    max_leverage: num(o, "max_leverage", p),
    markets: list(o, "markets", MARKETS, p),
  };
}

export function readRankState(v: unknown): RankState {
  const p = "get_rank";
  const o = obj(v, p);
  return {
    rank: oneOf(o, "rank", RANKS, p),
    status: oneOf(o, "status", STATUSES, p),
    since_round: num(o, "since_round", p),
  };
}

export function readRound(v: unknown): Round {
  const p = "get_round";
  const o = obj(v, p);
  return {
    id: num(o, "id", p),
    phase: oneOf(o, "phase", ["OPEN", "PROPOSE", "HOLD", "CLOSE"] as const, p),
    settled: bool(o, "settled", p),
    stuck: bool(o, "stuck", p),
    started_at: num(o, "started_at", p),
    propose_from: num(o, "propose_from", p),
    propose_until: num(o, "propose_until", p),
    close_from: num(o, "close_from", p),
    ends_at: num(o, "ends_at", p),
    rank: oneOf(o, "rank", RANKS, p),
    status: oneOf(o, "status", STATUSES, p),
    brave_at_open: u128(o, "brave_at_open", p),
    bets_used: num(o, "bets_used", p),
    at_risk: u128(o, "at_risk", p),
    skipped: num(o, "skipped", p),
    refused: num(o, "refused", p),
    result: nullable(o, "result", () => signed(o, "result", p)),
  };
}

export function readRulebook(v: unknown): Rulebook {
  const p = "get_rulebook";
  const o = obj(v, p);
  const nonce = str(o, "nonce", p);
  if (!/^[0-9a-f]{16}$/.test(nonce))
    throw new ShapeError(`${p}.nonce: expected 16 lower-case hex characters`);
  return { round_id: num(o, "round_id", p), nonce, text: str(o, "text", p) };
}

export function readPosition(v: unknown, p = "position"): Position {
  const o = obj(v, p);
  return {
    id: num(o, "id", p),
    round_id: num(o, "round_id", p),
    market: oneOf(o, "market", MARKETS, p),
    side: oneOf(o, "side", SIDES, p),
    margin: u128(o, "margin", p),
    leverage: num(o, "leverage", p),
    notional: u128(o, "notional", p),
    status: oneOf(o, "status", ["APPROVED", "OPEN_SIGNED", "CLOSE_SIGNED", "SETTLED"] as const, p),
    approved_at: num(o, "approved_at", p),
    open_signed_at: nullable(o, "open_signed_at", () => num(o, "open_signed_at", p)),
    close_signed_at: nullable(o, "close_signed_at", () => num(o, "close_signed_at", p)),
    settled_at: nullable(o, "settled_at", () => num(o, "settled_at", p)),
    sz_e8: nullable(o, "sz_e8", () => u128(o, "sz_e8", p)),
    returned: nullable(o, "returned", () => u128(o, "returned", p)),
    result: nullable(o, "result", () => signed(o, "result", p)),
  };
}

export function readPositions(v: unknown): Position[] {
  if (!Array.isArray(v)) throw new ShapeError("get_positions: expected a list");
  return v.map((x, i) => readPosition(x, `get_positions[${i}]`));
}

export function readSignedAction(v: unknown, p = "signed action"): SignedAction {
  const o = obj(v, p);
  const sig = obj(o.signature, `${p}.signature`);
  const r = str(sig, "r", `${p}.signature`);
  const s = str(sig, "s", `${p}.signature`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(r) || !/^0x[0-9a-fA-F]{64}$/.test(s)) {
    throw new ShapeError(`${p}.signature: r and s must be 0x plus 64 hex characters`);
  }
  return {
    id: num(o, "id", p),
    position_id: num(o, "position_id", p),
    kind: oneOf(o, "kind", ["LEVERAGE", "OPEN", "CLOSE"] as const, p),
    action: obj(o.action, `${p}.action`),
    nonce: num(o, "nonce", p),
    expires_after: num(o, "expires_after", p),
    signature: { r, s, v: num(sig, "v", `${p}.signature`) },
    created_at: num(o, "created_at", p),
  };
}

export function readOutbox(v: unknown): SignedAction[] {
  if (!Array.isArray(v)) throw new ShapeError("get_outbox: expected a list");
  return v.map((x, i) => readSignedAction(x, `get_outbox[${i}]`));
}

export function readVerdict(v: unknown): ChainVerdict {
  const p = "propose";
  const o = obj(v, p);
  const verdict = oneOf(o, "verdict", ["YES", "SKIP", "NOPE"] as const, p);
  if (verdict === "YES") return { verdict, position_id: num(o, "position_id", p) };
  if (verdict === "SKIP") return { verdict };
  return {
    verdict,
    refusal_id: num(o, "refusal_id", p),
    code: oneOf(o, "code", REFUSAL_CODES, p),
    asked: nullable(o, "asked", () => str(o, "asked", p)),
    limit: nullable(o, "limit", () => str(o, "limit", p)),
  };
}
