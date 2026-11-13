import { sha256 } from "@noble/hashes/sha2.js";
import type { AccountId, U128 } from "../chain/types";

/** drand "quicknet": the public random beacon the payday draw takes its luck from (interface 1.7, section 9.18). */
export const DRAND_CHAIN_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
export const drandUrl = (round: number) => `https://api.drand.sh/${DRAND_CHAIN_HASH}/public/${round}`;

const fromHex = (hex: string) => new Uint8Array((hex.match(/../g) ?? []).map((b) => parseInt(b, 16)));

/**
 * Replays a payday draw from its random number and the frozen tickets, by the rule of section 9.18: for each pick,
 * take the first 16 bytes of the seed as a little-endian number modulo the total tickets, walk the list
 * subtracting each account's tickets until the number falls inside one; then the seed becomes sha256(seed).
 * The first pick wins 70%; the next ten share the rest. An account alone takes everything (one pick).
 */
export function replayDraw(randomnessHex: string, tickets: [AccountId, U128][], picks = 11): AccountId[] {
  const total = tickets.reduce((n, [, t]) => n + BigInt(t), 0n);
  if (total === 0n || !/^[0-9a-f]{64}$/i.test(randomnessHex)) return [];
  if (tickets.length === 1) return [tickets[0]![0]];
  let seed = fromHex(randomnessHex);
  const out: AccountId[] = [];
  for (let i = 0; i < picks; i++) {
    let x = 0n;
    for (let b = 15; b >= 0; b--) x = (x << 8n) | BigInt(seed[b]!);
    x %= total;
    for (const [account, t] of tickets) {
      if (x < BigInt(t)) {
        out.push(account);
        break;
      }
      x -= BigInt(t);
    }
    seed = sha256(seed);
  }
  return out;
}

/** Asks a public drand relay for a beacon. Its `randomness` must equal the program's. */
export async function fetchBeacon(round: number): Promise<{ round: number; randomness: string; signature: string }> {
  const res = await fetch(drandUrl(round));
  if (!res.ok) throw new Error(`drand answered ${res.status} for round ${round}`);
  return (await res.json()) as { round: number; randomness: string; signature: string };
}
