/**
 * What the Tail or Fade page needs, in one place. The real one wires Engine 1's library (src/tailfade, copied
 * unchanged from intern/tailfade/src) to the visitor's wallet and to
 * the faucet. A pretend one stands in on sample data so every state of the page can be opened.
 */
import { rpcFetch } from "../chain/near";
import { account as hlAccount, type Account, type Reply } from "../tailfade/hl.ts";
import { hlAddressOf, sigFromOutcome, signTransaction } from "../tailfade/mpc.ts";
import { agentFromHex, agentToHex, approveAgent, closePosition, isApproved, newAgent, placeChip, submitApproval, type Agent, type Chip, type Choice, type Leverage } from "../tailfade/tailfade.ts";

export type FaucetStatus = { configured: boolean; address?: string; amount_usd: number; granted: number; max: number; balance_usd: number };
export type Fill = { ok: true; sz: string; px: string } | { ok: false; why: string };
export type { Account, Agent, Chip, Choice, Leverage };

export type Driver = {
  pretend: boolean;
  address(accountId: string): Promise<string>;
  faucetStatus(): Promise<FaucetStatus>;
  /** Asks the faucet for the one-time test dollars. Throws a plain sentence when it says no. */
  faucet(accountId: string): Promise<void>;
  account(address: string): Promise<Account>;
  /** The trading key kept in this browser for this account, made on first use. */
  agent(accountId: string): Agent;
  approved(address: string, agent: Agent): Promise<boolean>;
  /** One wallet popup: the visitor's account asks NEAR's signing network to approve the trading key. */
  approve(accountId: string, agent: Agent): Promise<void>;
  chip(args: { agent: Agent; market: string; choice: Choice; internSide: "LONG" | "SHORT"; chipUsd: Chip; leverage: Leverage }): Promise<Fill>;
  close(args: { agent: Agent; user: string; market: string }): Promise<Fill | null>;
};

/** Hyperliquid's answer to an order, as one of two plain outcomes. */
export function readFill(reply: Reply): Fill {
  if (reply.status !== "ok") return { ok: false, why: typeof reply.response === "string" ? reply.response : JSON.stringify(reply.response) };
  const first = (reply.response as { data?: { statuses?: unknown[] } }).data?.statuses?.[0] as { filled?: { totalSz: string; avgPx: string }; error?: string } | string | undefined;
  if (first && typeof first === "object" && first.filled) return { ok: true, sz: first.filled.totalSz, px: first.filled.avgPx };
  if (first && typeof first === "object" && first.error) return { ok: false, why: first.error };
  return { ok: false, why: "The order did not fill at this price." };
}

const FAUCET_WHY: Record<number, string> = {
  400: "The faucet did not accept that account name. Nothing was sent.",
  404: "The faucet could not find that NEAR account on the test network. Nothing was sent.",
  409: "This account has already had its test dollars, or its betting account already holds some. Nothing more was sent.",
  429: "Two accounts have already been funded from your connection today. Nothing was sent. Try again tomorrow.",
  502: "Hyperliquid refused the transfer. Nothing arrived. Try again in a minute.",
  503: "The faucet is empty or has reached its limit of visitors. Nothing was sent, and there is no other source of test dollars here.",
};

const keyFor = (accountId: string) => `intern-tailfade-key:${accountId}`;

function storedAgent(accountId: string): Agent {
  try {
    const hex = window.localStorage.getItem(keyFor(accountId));
    if (hex) return agentFromHex(hex);
  } catch {
    /* fall through to a fresh key */
  }
  const fresh = newAgent();
  try {
    window.localStorage.setItem(keyFor(accountId), agentToHex(fresh));
  } catch {
    /* kept for this visit only */
  }
  return fresh;
}

/** Some wallets hand back only the transaction's hash; the signature is in the full outcome, so ask the network for it. */
async function fullOutcome(rpc: string, accountId: string, outcome: unknown): Promise<unknown> {
  const o = outcome as { status?: { SuccessValue?: string }; transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | null;
  if (typeof o?.status?.SuccessValue === "string" && o.status.SuccessValue.length > 0) return o;
  const hash = o?.transaction?.hash ?? o?.transaction_outcome?.id;
  if (!hash) return outcome;
  const res = await rpcFetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: hash, sender_account_id: accountId, wait_until: "FINAL" } }),
  });
  return ((await res.json()) as { result?: unknown }).result ?? outcome;
}

export function liveDriver(rpc: string, faucetUrl: string | undefined): Driver {
  const faucetRoot = faucetUrl?.replace(/\/$/, "");
  return {
    pretend: false,
    address: (accountId) => hlAddressOf(accountId, rpc, rpcFetch),
    async faucetStatus() {
      if (!faucetRoot) return { configured: false, amount_usd: 0, granted: 0, max: 0, balance_usd: 0 };
      const res = await fetch(`${faucetRoot}/faucet`);
      if (!res.ok) throw new Error(`The faucet answered ${res.status}.`);
      return (await res.json()) as FaucetStatus;
    },
    async faucet(accountId) {
      if (!faucetRoot) throw new Error("No faucet address is published. Nothing was sent.");
      let res: Response;
      try {
        res = await fetch(`${faucetRoot}/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: accountId }) });
      } catch {
        throw new Error("Couldn't reach the faucet. Nothing was sent. Check your connection and try again.");
      }
      if (!res.ok) throw new Error(FAUCET_WHY[res.status] ?? `The faucet answered ${res.status}. Nothing was sent.`);
    },
    account: (address) => hlAccount(address),
    agent: storedAgent,
    approved: (address, agent) => isApproved(address, agent),
    async approve(accountId, agent) {
      const { action, digest } = approveAgent(agent.address);
      const { walletSendRaw } = await import("../chain/wallet");
      const outcome = await fullOutcome(rpc, accountId, await walletSendRaw(signTransaction(digest)));
      const reply = await submitApproval(action, sigFromOutcome(outcome));
      if (reply.status !== "ok") throw new Error(`Hyperliquid did not accept the approval: ${typeof reply.response === "string" ? reply.response : JSON.stringify(reply.response)}. No bet was placed. Try again.`);
    },
    async chip(args) {
      const r = await placeChip(args);
      if (r.leverage.status !== "ok") return { ok: false, why: `Setting ${args.leverage}x was refused: ${JSON.stringify(r.leverage.response)}` };
      return readFill(r.order);
    },
    async close(args) {
      const r = await closePosition(args);
      return r === null ? null : readFill(r);
    },
  };
}

/** Sample data: a made-up account that behaves like the real steps, so the page can be walked through. Nothing leaves the browser. */
export function pretendDriver(): Driver {
  const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
  let funded = false;
  let ok = false;
  let value = 0;
  let position: Account["positions"][number] | null = null;
  const agent = newAgent();
  return {
    pretend: true,
    address: async () => "0x5a3b1e00000000000000000000000000000de5c0",
    faucetStatus: async () => ({ configured: true, amount_usd: 30, granted: funded ? 2 : 1, max: 9, balance_usd: funded ? 240 : 270 }),
    async faucet() {
      await wait(700);
      funded = true;
      value = 29;
    },
    account: async () => ({ accountValue: value + (position?.unrealizedPnl ?? 0), withdrawable: value - (position?.marginUsed ?? 0), positions: position ? [position] : [] }),
    agent: () => agent,
    approved: async () => ok,
    async approve() {
      await wait(900);
      ok = true;
    },
    async chip({ market, choice, internSide, chipUsd, leverage }) {
      await wait(600);
      const buy = (choice === "TAIL") === (internSide === "LONG");
      const px = 0.0638;
      const sz = Math.round((chipUsd * leverage) / px);
      position = { coin: market, szi: buy ? sz : -sz, entryPx: px, unrealizedPnl: buy ? 0.12 : -0.12, marginUsed: chipUsd };
      return { ok: true, sz: String(sz), px: String(px) };
    },
    async close() {
      if (!position) return null;
      await wait(500);
      const done: Fill = { ok: true, sz: String(Math.abs(position.szi)), px: "0.0639" };
      value += position.unrealizedPnl;
      position = null;
      return done;
    },
  };
}
