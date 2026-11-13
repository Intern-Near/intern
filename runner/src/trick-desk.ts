import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChainVerdict } from "./contract.ts";

// The trick page's queue (spec 24.G): visitors write a message, the runner puts it after the market data in the
// next proposal window and proposes whatever the model answers. The program judges it like any other proposal.
// Every step is appended to one JSONL file, so a restart loses nothing and the page can always show a result.

export const TRICK_LIMITS = {
  /** A visitor's message is published on chain inside the proposal's request bytes: keep it short. */
  maxChars: 280,
  /** Tricks asked in one proposal window, after the Intern's own decision. */
  perWindow: 3,
  /** Tricks waiting at once, all senders together. */
  maxQueued: 30,
  /** Submissions per sender (a wallet account, or a salted hash of the address it came from) per hour. */
  perSenderPerHour: 6,
  /** A trick interrupted by a restart is asked again at most this many times in all. */
  maxAttempts: 2,
} as const;

export type TrickStatus = "queued" | "asking" | "done" | "failed";

export interface TrickResult {
  verdict: ChainVerdict["verdict"];
  /** NOPE: the refusal code and the refusal's id on chain. */
  code?: string;
  refusal_id?: number;
  /** YES: the position the program opened. */
  position_id?: number;
  /** The `propose` transaction. */
  tx: string;
  /** What the model answered (its one line), or null if it could not be read. */
  answer: string | null;
}

export interface Trick {
  id: string;
  at: number;
  message: string;
  /** The visitor's NEAR account, only when they proved it with a wallet signature (NEP-413). Sent as credited_to. */
  account_id: string | null;
  /** Who it counts against for the limits: the account, or a salted hash of the address. Never shown. */
  sender: string;
  /** The NEP-413 nonce (base64), so one signature cannot be used twice. */
  nonce: string | null;
  /**
   * 01 1.7: the id of a payment the visitor made on chain for this trick (`get_trick_payment`): a paid trick goes
   * ahead of free ones. One payment, one trick.
   */
  paid?: string;
  status: TrickStatus;
  attempts: number;
  round_id?: number;
  asked_at?: number;
  done_at?: number;
  result?: TrickResult;
  reason?: string;
}

/** What the page may see of a trick: everything but the sender and the nonce. */
export type PublicTrick = Omit<Trick, "sender" | "nonce"> & { position?: number };

type Event =
  | { type: "queued"; trick: Trick }
  | { type: "asking"; id: string; round_id: number; at: number }
  | { type: "done"; id: string; result: TrickResult; at: number }
  | { type: "failed"; id: string; reason: string; at: number };

export type Submitted = { ok: true; trick: PublicTrick } | { ok: false; status: number; error: string };

/** The message as it will be sent, or why it cannot be. */
export function cleanMessage(text: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof text !== "string") return { ok: false, error: "message must be a string" };
  const t = text.replace(/\r\n?/g, "\n").trim();
  const chars = Array.from(t).length;
  if (chars === 0) return { ok: false, error: "message is empty" };
  if (chars > TRICK_LIMITS.maxChars)
    return { ok: false, error: `message is longer than ${TRICK_LIMITS.maxChars} characters` };
  // Control characters and the invisible direction overrides could hide text from the page or from a reader of
  // the chain; plain newlines and tabs are fine.
  if (Array.from(t).some(hidden)) return { ok: false, error: "message contains control characters" };
  return { ok: true, text: t };
}

/** A control character other than newline and tab, DEL, or a Unicode direction override or isolate. */
function hidden(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  if (c === 0x0a || c === 0x09) return false;
  return c < 0x20 || c === 0x7f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
}

/** A sender key that does not keep the address itself. */
export function senderKey(address: string, salt: string): string {
  return `ip:${createHash("sha256").update(`${salt}:${address}`).digest("hex").slice(0, 24)}`;
}

export class TrickDesk {
  readonly #file: string;
  readonly #now: () => number;
  readonly #tricks = new Map<string, Trick>();
  readonly #nonces = new Set<string>();
  readonly #payments = new Set<string>();

  constructor(file: string, now: () => number) {
    this.#file = file;
    this.#now = now;
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        this.#apply(JSON.parse(line) as Event);
      }
    }
    // A trick that was being asked when the process stopped: ask it again, or give up after maxAttempts.
    for (const t of this.#tricks.values()) {
      if (t.status !== "asking") continue;
      if (t.attempts >= TRICK_LIMITS.maxAttempts)
        this.#write({ type: "failed", id: t.id, reason: "interrupted by a restart", at: this.#now() });
      else {
        t.status = "queued";
        delete t.round_id;
        delete t.asked_at;
      }
    }
  }

  #apply(e: Event): void {
    if (e.type === "queued") {
      this.#tricks.set(e.trick.id, { ...e.trick });
      if (e.trick.nonce !== null) this.#nonces.add(e.trick.nonce);
      if (e.trick.paid !== undefined) this.#payments.add(e.trick.paid);
      return;
    }
    const t = this.#tricks.get(e.id);
    if (!t) return;
    if (e.type === "asking") {
      t.status = "asking";
      t.round_id = e.round_id;
      t.asked_at = e.at;
      t.attempts += 1;
    } else if (e.type === "done") {
      t.status = "done";
      t.result = e.result;
      t.done_at = e.at;
    } else {
      t.status = "failed";
      t.reason = e.reason;
      t.done_at = e.at;
    }
  }

  #write(e: Event): void {
    appendFileSync(this.#file, `${JSON.stringify(e)}\n`);
    this.#apply(e);
  }

  /** Waiting tricks in the order they will be asked: paid ones first (01 1.7), then by time. */
  #queued(): Trick[] {
    return [...this.#tricks.values()]
      .filter((t) => t.status === "queued")
      .sort((a, b) => Number(b.paid !== undefined) - Number(a.paid !== undefined) || a.at - b.at);
  }

  /** Whether a payment id was already used for a trick. */
  paymentUsed(id: string): boolean {
    return this.#payments.has(id);
  }

  #public(t: Trick): PublicTrick {
    const { sender: _s, nonce: _n, ...rest } = t;
    const position = t.status === "queued" ? this.#queued().findIndex((x) => x.id === t.id) + 1 : undefined;
    return position === undefined ? { ...rest } : { ...rest, position };
  }

  nonceUsed(nonce: string): boolean {
    return this.#nonces.has(nonce);
  }

  /**
   * Queues a visitor's message. `accountId` must already be proven (a NEP-413 signature checked by the caller);
   * `sender` is that account, or a salted hash of the address the request came from.
   */
  submit(
    message: unknown,
    accountId: string | null,
    sender: string,
    nonce: string | null = null,
    paid: string | null = null,
  ): Submitted {
    const m = cleanMessage(message);
    if (!m.ok) return { ok: false, status: 400, error: m.error };
    if (paid !== null && this.#payments.has(paid))
      return { ok: false, status: 409, error: "this payment was already used for a trick" };
    if (nonce !== null && this.#nonces.has(nonce))
      return { ok: false, status: 409, error: "this signature was already used" };
    const mine = [...this.#tricks.values()].filter((t) => t.sender === sender);
    if (mine.some((t) => t.status === "queued" || t.status === "asking"))
      return { ok: false, status: 409, error: "you already have a trick waiting; one at a time" };
    const hourAgo = this.#now() - 3_600_000;
    if (mine.filter((t) => t.at > hourAgo).length >= TRICK_LIMITS.perSenderPerHour)
      return { ok: false, status: 429, error: `at most ${TRICK_LIMITS.perSenderPerHour} tricks an hour` };
    if (this.#queued().length >= TRICK_LIMITS.maxQueued)
      return { ok: false, status: 503, error: "the queue is full; try again after the next proposal window" };
    const trick: Trick = {
      id: randomUUID(),
      at: this.#now(),
      message: m.text,
      account_id: accountId,
      sender,
      nonce,
      ...(paid === null ? {} : { paid }),
      status: "queued",
      attempts: 0,
    };
    this.#write({ type: "queued", trick });
    return { ok: true, trick: this.#public(trick) };
  }

  /** The oldest waiting trick, if any. */
  next(): Trick | undefined {
    return this.#queued()[0];
  }

  /** Tricks asked (or being asked) in this round. */
  askedIn(roundId: number): number {
    return [...this.#tricks.values()].filter((t) => t.round_id === roundId).length;
  }

  asking(id: string, roundId: number): void {
    this.#write({ type: "asking", id, round_id: roundId, at: this.#now() });
  }

  done(id: string, verdict: ChainVerdict, tx: string, answer: string | null): void {
    const result: TrickResult = { verdict: verdict.verdict, tx, answer };
    if (verdict.verdict === "NOPE") {
      result.code = verdict.code;
      result.refusal_id = verdict.refusal_id;
    }
    if (verdict.verdict === "YES") result.position_id = verdict.position_id;
    this.#write({ type: "done", id, result, at: this.#now() });
  }

  /** Asked but nothing was proposed (the exchange failed): it goes back in the queue, or fails for good. */
  notProposed(id: string, reason: string): void {
    const t = this.#tricks.get(id);
    if (!t) return;
    if (t.attempts >= TRICK_LIMITS.maxAttempts) {
      this.#write({ type: "failed", id, reason, at: this.#now() });
      return;
    }
    // Back to the queue in place: a fresh "queued" event with the same trick.
    const { round_id: _round, asked_at: _asked, ...rest } = t;
    this.#write({ type: "queued", trick: { ...rest, status: "queued" } });
  }

  get(id: string): PublicTrick | undefined {
    const t = this.#tricks.get(id);
    return t ? this.#public(t) : undefined;
  }

  /** Counters and the latest results, for the page. */
  summary(recent = 20): {
    waiting: number;
    asked: number;
    refused: number;
    yes: number;
    skipped: number;
    recent: PublicTrick[];
  } {
    const all = [...this.#tricks.values()];
    const done = all.filter((t) => t.status === "done").sort((a, b) => (b.done_at ?? 0) - (a.done_at ?? 0));
    return {
      waiting: this.#queued().length,
      asked: done.length,
      refused: done.filter((t) => t.result?.verdict === "NOPE").length,
      yes: done.filter((t) => t.result?.verdict === "YES").length,
      skipped: done.filter((t) => t.result?.verdict === "SKIP").length,
      recent: done.slice(0, recent).map((t) => this.#public(t)),
    };
  }
}
