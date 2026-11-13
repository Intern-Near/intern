// 01 1.7, owner's decision (Engine 2's list, item 22): the payday draw's luck comes from drand.
//
// When a draw period is over the program fixes the tickets and names a drand "quicknet" round about a minute ahead
// (`get_drand`: state WAITING). Once that round is out, anyone may hand its beacon to `submit_drand`; the program
// checks drand's BLS signature itself, so the runner is only a messenger: it cannot choose or change the luck. A
// draw left without its beacon for two of our rounds uses NEAR's block seed instead, and says so.

/** drand quicknet: a beacon every 3 seconds since 2023-08-23T15:09:27Z, signatures on G1 (48 bytes). */
export const DRAND_CHAIN = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
export const DRAND_GENESIS_MS = 1_692_803_367_000;
export const DRAND_PERIOD_MS = 3_000;
/** drand's public relays, tried in order. */
export const DRAND_HOSTS: readonly string[] = [
  "https://api.drand.sh",
  "https://api2.drand.sh",
  "https://api3.drand.sh",
  "https://drand.cloudflare.com",
];

/** When drand publishes `round` (ms). */
export function drandRoundTime(round: number): number {
  return DRAND_GENESIS_MS + (round - 1) * DRAND_PERIOD_MS;
}

/** The beacon's signature (96 hex characters) for `round`, from the first relay that answers with it. */
export async function fetchBeacon(round: number, fetchFn: typeof fetch): Promise<string> {
  const errors: string[] = [];
  for (const host of DRAND_HOSTS) {
    try {
      const res = await fetchFn(`${host}/${DRAND_CHAIN}/public/${round}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const b = (await res.json()) as { round?: unknown; signature?: unknown };
      if (b.round !== round) throw new Error(`answered round ${String(b.round)}`);
      if (typeof b.signature !== "string" || !/^[0-9a-f]{96}$/.test(b.signature))
        throw new Error("no 48-byte signature");
      return b.signature;
    } catch (e) {
      errors.push(`${host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`no drand relay gave round ${round} (${errors.join("; ")})`);
}
