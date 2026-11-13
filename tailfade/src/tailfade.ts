import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  addressOfPrivateKey,
  fromHex,
  l1Digest,
  type Packable,
  SIGNATURE_CHAIN_ID,
  type Sig,
  signDigest,
  toHex,
  userActionDigest,
} from "./hash.ts";
import { account, agentsOf, exchange, HL_TESTNET, type Market, markets, mids, type Reply } from "./hl.ts";

// Tail or Fade (spec 12b, first version): after the Intern's bet opens, a visitor has 10 minutes to put a $10 or
// $25 chip on the same market, the same way (TAIL) or the other way (FADE), at 2x isolated, from their own
// Hyperliquid account. The visitor's wallet approves a trading key once; every chip after that is signed in the
// browser in milliseconds. Nothing of ours holds the visitor's money, and nothing of ours checks their size: the app
// sets it. Testnet only; no platform fee on testnet (owner's decision 2026-11-12).

export const TAIL_OR_FADE = {
  chipsUsd: [10, 25] as const,
  /** The default leverage. */
  leverage: 2,
  /** 1.4 (reward ladder R5): the leverages a visitor may pick, where the market allows (PENGU and WIF stop at 5x). */
  leverages: [2, 5, 10] as const,
  windowMs: 10 * 60_000,
  /** IOC orders cross the mid by this much (1%), so they fill now or not at all. */
  slippageBps: 100,
  /** Hyperliquid refuses an order under $10 of notional. */
  minNotionalUsd: 10,
  agentName: "tailfade",
} as const;

/** The Intern's markets (01 §4) by their Hyperliquid names: SHIB and PEPE trade as kSHIB and kPEPE (1,000 units). */
export const HL_NAME: Readonly<Record<string, string>> = {
  DOGE: "DOGE",
  SHIB: "kSHIB",
  PEPE: "kPEPE",
  PENGU: "PENGU",
  WIF: "WIF",
  TRUMP: "TRUMP",
};
const hlName = (market: string): string => HL_NAME[market] ?? market;

export type Choice = "TAIL" | "FADE";
export type Chip = (typeof TAIL_OR_FADE.chipsUsd)[number];
export type Leverage = (typeof TAIL_OR_FADE.leverages)[number];

/**
 * Roughly how far the price may move against a position, in percent, before it is liquidated: about 1/leverage
 * of the entry, less the maintenance margin. For the page's risk line ("a 9% move against you ends this chip").
 * An estimate, not Hyperliquid's own liquidation price (read that from `account()` once the position is open).
 */
export function liquidationMovePct(leverage: number): number {
  return Math.floor((100 / leverage) * 0.9);
}

// ---------------------------------------------------------------- the trading key the browser keeps

export interface Agent {
  privateKey: Uint8Array;
  address: string;
}

export function newAgent(): Agent {
  const privateKey = secp256k1.utils.randomSecretKey();
  return { privateKey, address: addressOfPrivateKey(privateKey) };
}

/** For keeping the key in the browser (localStorage) between visits. It can trade, never withdraw. */
export const agentToHex = (a: Agent): string => toHex(a.privateKey);
export function agentFromHex(hex: string): Agent {
  const privateKey = fromHex(hex);
  if (privateKey.length !== 32) throw new Error("an agent key is 32 bytes");
  return { privateKey, address: addressOfPrivateKey(privateKey) };
}

/** The visitor's one-time approval of the trading key: the action and the digest their wallet must have signed. */
export function approveAgent(
  agentAddress: string,
  nonce = Date.now(),
): { action: Record<string, Packable>; digest: Uint8Array } {
  const action = {
    type: "approveAgent",
    signatureChainId: SIGNATURE_CHAIN_ID,
    hyperliquidChain: "Testnet",
    agentAddress: agentAddress.toLowerCase(),
    agentName: TAIL_OR_FADE.agentName,
    nonce,
  };
  return { action, digest: userActionDigest("HyperliquidTransaction:ApproveAgent", action) };
}

export function submitApproval(action: Record<string, Packable>, sig: Sig, url = HL_TESTNET): Promise<Reply> {
  return exchange(action, Number(action.nonce), sig, { l1: false, url });
}

export async function isApproved(user: string, agent: Agent, url = HL_TESTNET): Promise<boolean> {
  return (await agentsOf(user, url)).includes(agent.address);
}

// ---------------------------------------------------------------- prices and sizes, Hyperliquid's rules

/** Hyperliquid's wire form of a number: up to 8 decimals, no trailing zeros (the SDK's float_to_wire). */
export function wire(x: number): string {
  const s = x.toFixed(8);
  if (Math.abs(Number(s) - x) >= 1e-12) throw new Error(`${x} would be rounded on the wire`);
  const t = s.replace(/\.?0+$/, "");
  return t === "-0" ? "0" : t;
}

/** A perp price: at most 5 significant figures and at most 6 − szDecimals decimals (integers are always fine). */
export function roundPx(px: number, szDecimals: number): number {
  if (Number.isInteger(px)) return px;
  return Number(Number(px.toPrecision(5)).toFixed(Math.max(0, 6 - szDecimals)));
}

/** A size for `notionalUsd` at `px`, to the market's decimals, never under Hyperliquid's $10 minimum. */
export function sizeFor(notionalUsd: number, px: number, szDecimals: number): number {
  const step = 10 ** -szDecimals;
  let sz = Number((Math.round(notionalUsd / px / step) * step).toFixed(szDecimals));
  while (sz * px < TAIL_OR_FADE.minNotionalUsd) sz = Number((sz + step).toFixed(szDecimals));
  return sz;
}

/** TAIL bets the way the Intern did; FADE the other way. */
export function isBuy(choice: Choice, internSide: "LONG" | "SHORT"): boolean {
  return (choice === "TAIL") === (internSide === "LONG");
}

export function leverageAction(
  m: Market,
  leverage: number = TAIL_OR_FADE.leverage,
): Record<string, Packable> {
  if (leverage > m.maxLeverage) throw new Error(`${m.name} allows at most ${m.maxLeverage}x`);
  return { type: "updateLeverage", asset: m.asset, isCross: false, leverage };
}

export function iocOrder(
  m: Market,
  buy: boolean,
  px: number,
  sz: number,
  reduceOnly: boolean,
): Record<string, Packable> {
  return {
    type: "order",
    orders: [{ a: m.asset, b: buy, p: wire(px), s: wire(sz), r: reduceOnly, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  };
}

/** Signs an L1 action with the trading key and sends it. */
export async function sendL1(
  agent: Agent,
  action: Record<string, Packable>,
  nonce: number,
  url = HL_TESTNET,
): Promise<Reply> {
  return exchange(action, nonce, signDigest(agent.privateKey, l1Digest(action, nonce, true)), {
    l1: true,
    url,
  });
}

export interface ChipResult {
  market: string;
  buy: boolean;
  px: string;
  sz: string;
  leverage: Reply;
  order: Reply;
}

/** Places one chip: isolated 2x on the market, then an IOC order through the mid. */
export async function placeChip(args: {
  agent: Agent;
  market: string;
  choice: Choice;
  internSide: "LONG" | "SHORT";
  chipUsd: Chip;
  /** 2 by default; 5 or 10 where the market allows. */
  leverage?: Leverage;
  url?: string;
  now?: () => number;
}): Promise<ChipResult> {
  const url = args.url ?? HL_TESTNET;
  const now = args.now ?? Date.now;
  const name = hlName(args.market);
  const [all, prices] = await Promise.all([markets(url), mids(url)]);
  const m = all.get(name);
  const mid = Number(prices[name]);
  if (!m || !Number.isFinite(mid)) throw new Error(`Hyperliquid testnet has no market ${name}`);
  const buy = isBuy(args.choice, args.internSide);
  const slip = TAIL_OR_FADE.slippageBps / 10_000;
  const px = roundPx(mid * (buy ? 1 + slip : 1 - slip), m.szDecimals);
  const leverage = args.leverage ?? TAIL_OR_FADE.leverage;
  if (!TAIL_OR_FADE.leverages.includes(leverage))
    throw new Error(`leverage must be one of ${TAIL_OR_FADE.leverages.join(", ")}`);
  const sz = sizeFor(args.chipUsd * leverage, mid, m.szDecimals);
  const lev = await sendL1(args.agent, leverageAction(m, leverage), now(), url);
  const order = await sendL1(args.agent, iocOrder(m, buy, px, sz, false), now() + 1, url);
  return { market: m.name, buy, px: wire(px), sz: wire(sz), leverage: lev, order };
}

/** Closes the visitor's whole position on a market (01 name, as in the feed) with a reduce-only IOC order. Null when there is none. */
export async function closePosition(args: {
  agent: Agent;
  user: string;
  market: string;
  url?: string;
}): Promise<Reply | null> {
  const url = args.url ?? HL_TESTNET;
  const name = hlName(args.market);
  const [acct, all, prices] = await Promise.all([account(args.user, url), markets(url), mids(url)]);
  const p = acct.positions.find((x) => x.coin === name);
  const m = all.get(name);
  if (!p || p.szi === 0 || !m) return null;
  const buy = p.szi < 0; // a short closes by buying
  const slip = TAIL_OR_FADE.slippageBps / 10_000;
  const mid = Number(prices[name]);
  const px = roundPx(mid * (buy ? 1 + slip : 1 - slip), m.szDecimals);
  return sendL1(args.agent, iocOrder(m, buy, px, Math.abs(p.szi), true), Date.now(), url);
}

// ---------------------------------------------------------------- when Tail or Fade is open

export interface FeedItem {
  seq: number;
  at: number;
  event: string;
  data: Record<string, unknown>;
}

export interface Window {
  position_id: number;
  round_id: number;
  market: string;
  side: "LONG" | "SHORT";
  opens_at: number;
  closes_at: number;
}

/**
 * The open window, if any: 10 minutes from the moment the Intern's opening order was signed (feed `order_signed`
 * with kind OPEN), for the market and side of its `approved` bet. The latest one wins.
 */
export function openWindow(feed: FeedItem[], now: number): Window | null {
  for (let i = feed.length - 1; i >= 0; i--) {
    const e = feed[i];
    if (e?.event !== "order_signed" || e.data.kind !== "OPEN") continue;
    if (now - e.at >= TAIL_OR_FADE.windowMs) return null;
    const bet = feed.find((x) => x.event === "approved" && x.data.position_id === e.data.position_id);
    if (!bet) continue;
    return {
      position_id: Number(bet.data.position_id),
      round_id: Number(bet.data.round_id),
      market: String(bet.data.market),
      side: bet.data.side === "SHORT" ? "SHORT" : "LONG",
      opens_at: e.at,
      closes_at: e.at + TAIL_OR_FADE.windowMs,
    };
  }
  return null;
}
