import type { Bps, Ms, Signed, U128 } from "../chain/types";

const E6 = 1_000_000n;

function group(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "20000000" → "20.00". Whole-number maths only; cents are cut, never rounded up. */
export function amount(e6: U128 | Signed): string {
  const v = BigInt(e6);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const cents = (abs % E6) / 10_000n;
  return `${neg ? "−" : ""}${group(abs / E6)}.${cents.toString().padStart(2, "0")}`;
}

/** "20000000" → "$20.00" */
export function usd(e6: U128): string {
  return `$${amount(e6)}`;
}

/** "-1100000" → "−$1.10", "420000" → "+$0.42" */
export function signedUsd(e6: Signed): string {
  const v = BigInt(e6);
  return `${v < 0n ? "−" : "+"}$${amount((v < 0n ? -v : v).toString())}`;
}

/** 200 → "2%", 250 → "2.5%" */
export function pct(bps: Bps): string {
  const whole = Math.trunc(bps / 100);
  const frac = bps % 100;
  if (frac === 0) return `${whole}%`;
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}%`;
}

/** Share of a total, as a whole percent. */
export function share(part: U128, total: U128): number {
  const t = BigInt(total);
  if (t === 0n) return 0;
  return Number((BigInt(part) * 100n) / t);
}

/** Milliseconds left → "03:12:44". Never negative. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Time of an event, in UTC: "12:00" if it happened today, otherwise the weekday. */
export function when(at: Ms, now: Ms): string {
  const d = new Date(at);
  const sameDay = Math.floor(at / 86_400_000) === Math.floor(now / 86_400_000);
  if (sameDay) {
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }
  return DAYS[d.getUTCDay()]!;
}

/** "alice.testnet" stays; a 64-character account is shortened in the middle. */
export function shortAccount(id: string, max = 22): string {
  if (id.length <= max) return id;
  const keep = Math.floor((max - 1) / 2);
  return `${id.slice(0, keep)}…${id.slice(-keep)}`;
}

export function titleCase(word: string): string {
  return word.charAt(0) + word.slice(1).toLowerCase();
}

/** (1.7) Rival guessers are bots run by our own runner: ordinary accounts whose name starts with "rival-". Always labelled. */
export function isBot(account: string): boolean {
  return account.startsWith("rival-");
}
