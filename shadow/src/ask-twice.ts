import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { runExchange, writeNew } from "../../runner/src/exchange.ts";
import { SIGNING_ALGOS } from "../../runner/src/nearai.ts";
import type { RankName } from "../../runner/src/ranks.ts";
import { parseSignatureReply } from "../../runner/src/signature.ts";
import type { RunConfig } from "./config.ts";
import type { ExchangeStatus, ShadowMeta, TickDeps } from "./tick.ts";

/**
 * A run with `ask_twice` asks each model a second time in every tick, to see how far one answer can be trusted: two
 * answers to the same request that disagree show what a single sample hides. Only the first answer is judged, as in
 * every run; the second is kept for comparison (`npm run ask-twice`).
 *
 * The second question sends the exact bytes of the first request, read back from the first exchange's request.bin
 * (written before it was sent): the same rulebook, round, nonce, prices and message. Its files go in `second/` inside
 * the first exchange's folder: request.bin, response.bin, signature-*.json and meta.json (with `shadow.ask` 2).
 */
export const SECOND = "second";

export type SecondStatus = NonNullable<ExchangeStatus["second"]>;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Asks again what the exchange in `firstDir` asked, allowing `timeoutMs` for the answer. Never throws: a problem is
 * logged and returned as "failed", so it cannot change how the first answer is recorded.
 */
export async function askAgain(
  firstDir: string,
  cfg: RunConfig,
  at: { tick: string; model: string; rank: RankName },
  timeoutMs: number,
  deps: TickDeps,
): Promise<SecondStatus> {
  const where = { ...at, ask: 2 };
  try {
    const first = JSON.parse(readFileSync(join(firstDir, "meta.json"), "utf8")) as ShadowMeta;
    const requestBytes = readFileSync(join(firstDir, "request.bin"));
    const dir = join(firstDir, SECOND);
    const recordedAt = new Date(deps.now()).toISOString();
    const result = await runExchange({
      dir,
      requestBytes,
      apiKey: deps.apiKey,
      fetchFn: deps.fetchFn,
      log: (line) => deps.log({ ...where, step: "exchange", detail: line }),
      timeoutMs,
      now: () => new Date(deps.now()),
    });

    // The first answer's record with this answer's parts in their places; this answer's error only, never the first's.
    const { error: _firstError, ...base } = first;
    const meta: ShadowMeta = {
      ...base,
      what: `${first.what} Asked a second time with the same request.`,
      recorded_at: recordedAt,
      market_data: { ...first.market_data, saved_as: posix.join("..", first.market_data.saved_as) },
      request: result.request,
      response: result.response,
      signatures: result.signatures,
      ...(result.error === undefined ? {} : { error: result.error }),
      shadow: { ...first.shadow, ask: 2 },
    };
    await writeNew(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

    // As for the first answer: a signer other than the pinned one would stop every proposal. Say so loudly.
    for (const algo of SIGNING_ALGOS) {
      const path = join(dir, `signature-${algo}.json`);
      if (!existsSync(path)) continue;
      try {
        const signer = parseSignatureReply(readFileSync(path, "utf8")).signing_address;
        const pinned = cfg.pinned[at.model]?.[algo]?.signing_address ?? "";
        const bare = (a: string): string => a.toLowerCase().replace(/^0x/, "");
        if (bare(signer) !== bare(pinned))
          deps.log({ ...where, step: "SIGNER CHANGED", algo, signer, pinned });
      } catch (e) {
        deps.log({ ...where, step: "signature unavailable", algo, detail: message(e) });
      }
    }
    return result.error === undefined ? { status: "ok" } : { status: "failed", detail: result.error };
  } catch (e) {
    deps.log({ ...where, step: "exchange error", detail: message(e) });
    return { status: "failed", detail: message(e) };
  }
}
