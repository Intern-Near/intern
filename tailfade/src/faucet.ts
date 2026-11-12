import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  addressOfPrivateKey,
  type Packable,
  SIGNATURE_CHAIN_ID,
  signDigest,
  userActionDigest,
} from "./hash.ts";
import { account, exchange, HL_TESTNET, type Reply } from "./hl.ts";
import { DEFAULT_RPC, hlAddressOf } from "./mpc.ts";

// The Tail or Fade testnet faucet (owner's decision 2026-11-12): a visitor's derived Hyperliquid address must hold
// some USDC before Hyperliquid accepts anything from it ("Must deposit before performing actions"), and on testnet
// only an account that already has test USDC can send it. This sends a fixed amount from the owner's Hyperliquid
// testnet account (key in FAUCET_HL_PRIVATE_KEY), once per NEAR account, with caps. The address is derived here
// from the account name, so a caller cannot point the money anywhere else.

export const FAUCET_DEFAULTS = { usd: 30, maxAccounts: 30, perSenderPerDay: 2 } as const;

/** NEAR's account-id rules (2 to 64 characters, lower-case parts joined by - or _, separated by dots). */
export function isAccountId(s: string): boolean {
  return s.length >= 2 && s.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);
}

export function usdSend(
  destination: string,
  amount: string,
  time: number,
): { action: Record<string, Packable>; digest: Uint8Array } {
  const action = {
    type: "usdSend",
    signatureChainId: SIGNATURE_CHAIN_ID,
    hyperliquidChain: "Testnet",
    destination: destination.toLowerCase(),
    amount,
    time,
  };
  return { action, digest: userActionDigest("HyperliquidTransaction:UsdSend", action) };
}

export interface Grant {
  account_id: string;
  hl_address: string;
  amount: string;
  at: number;
  sender: string;
}

export type GrantResult =
  | { ok: true; account_id: string; hl_address: string; amount: string; reply: Reply }
  | { ok: false; status: number; error: string; hl_address?: string };

export interface FaucetOptions {
  /** The owner's Hyperliquid testnet key; null until it is configured. */
  key: Uint8Array | null;
  file: string;
  usd?: number;
  maxAccounts?: number;
  salt: string;
  now?: () => number;
  hlUrl?: string;
  rpc?: string;
  fetchFn?: typeof fetch;
}

export class Faucet {
  readonly #o: Required<Omit<FaucetOptions, "key">> & { key: Uint8Array | null };
  readonly #grants: Grant[] = [];
  #queue: Promise<unknown> = Promise.resolve();

  constructor(o: FaucetOptions) {
    this.#o = {
      usd: FAUCET_DEFAULTS.usd,
      maxAccounts: FAUCET_DEFAULTS.maxAccounts,
      now: Date.now,
      hlUrl: HL_TESTNET,
      rpc: DEFAULT_RPC,
      fetchFn: fetch,
      ...o,
    };
    mkdirSync(dirname(o.file), { recursive: true });
    if (existsSync(o.file))
      for (const line of readFileSync(o.file, "utf8").split("\n"))
        if (line.trim()) this.#grants.push(JSON.parse(line));
  }

  get address(): string | null {
    return this.#o.key ? addressOfPrivateKey(this.#o.key) : null;
  }

  senderKey(address: string): string {
    return createHash("sha256").update(`${this.#o.salt}:${address}`).digest("hex").slice(0, 24);
  }

  async status(): Promise<{
    configured: boolean;
    address: string | null;
    amount_usd: number;
    granted: number;
    max: number;
    balance_usd: number | null;
  }> {
    const address = this.address;
    let balance: number | null = null;
    if (address) {
      try {
        balance = (await account(address, this.#o.hlUrl, this.#o.fetchFn)).withdrawable;
      } catch {
        balance = null;
      }
    }
    return {
      configured: address !== null,
      address,
      amount_usd: this.#o.usd,
      granted: this.#grants.length,
      max: this.#o.maxAccounts,
      balance_usd: balance,
    };
  }

  /** One grant at a time, so two requests cannot both pass the checks before either is recorded. */
  grant(accountId: string, fromAddress: string): Promise<GrantResult> {
    const run = this.#queue.then(() => this.#grant(accountId, fromAddress));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #grant(accountId: string, fromAddress: string): Promise<GrantResult> {
    const o = this.#o;
    if (!o.key) return { ok: false, status: 503, error: "the faucet has no key yet" };
    if (!isAccountId(accountId))
      return { ok: false, status: 400, error: "account_id is not a NEAR account id" };
    const before = this.#grants.find((g) => g.account_id === accountId);
    if (before)
      return {
        ok: false,
        status: 409,
        error: "this account was already funded",
        hl_address: before.hl_address,
      };
    if (this.#grants.length >= o.maxAccounts)
      return { ok: false, status: 503, error: "the faucet has reached its cap" };
    const sender = this.senderKey(fromAddress);
    const dayAgo = o.now() - 86_400_000;
    if (
      this.#grants.filter((g) => g.sender === sender && g.at > dayAgo).length >=
      FAUCET_DEFAULTS.perSenderPerDay
    )
      return {
        ok: false,
        status: 429,
        error: `at most ${FAUCET_DEFAULTS.perSenderPerDay} accounts a day from one address`,
      };

    // The NEAR account must exist (names cost something to create), and its derived address is the destination.
    const res = await o.fetchFn(o.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "query",
        params: { request_type: "view_account", finality: "final", account_id: accountId },
      }),
    });
    const view = (await res.json()) as { result?: unknown };
    if (!view.result) return { ok: false, status: 404, error: "no such NEAR testnet account" };
    const hl = await hlAddressOf(accountId, o.rpc, o.fetchFn);
    const theirs = await account(hl, o.hlUrl, o.fetchFn);
    if (theirs.accountValue >= o.usd)
      return { ok: false, status: 409, error: "this address already holds funds", hl_address: hl };
    const mine = await account(addressOfPrivateKey(o.key), o.hlUrl, o.fetchFn);
    // A first transfer to a new account costs 1 USDC on top (Hyperliquid's activation fee).
    if (mine.withdrawable < o.usd + 2) return { ok: false, status: 503, error: "the faucet is empty" };

    const time = o.now();
    const amount = String(o.usd);
    const { action, digest } = usdSend(hl, amount, time);
    const reply = await exchange(action, time, signDigest(o.key, digest), {
      l1: false,
      url: o.hlUrl,
      fetchFn: o.fetchFn,
    });
    if (reply.status !== "ok")
      return {
        ok: false,
        status: 502,
        error: `Hyperliquid said: ${JSON.stringify(reply.response)}`,
        hl_address: hl,
      };
    const g: Grant = { account_id: accountId, hl_address: hl, amount, at: time, sender };
    appendFileSync(o.file, `${JSON.stringify(g)}\n`);
    this.#grants.push(g);
    return { ok: true, account_id: accountId, hl_address: hl, amount, reply };
  }
}
