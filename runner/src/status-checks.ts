import type { JsonRpcProvider } from "near-api-js";
import { fetchMids } from "./hl-exchange.ts";
import { formatNear } from "./key-scope.ts";
import { MARKETS } from "./markets.ts";
import { fetchModels } from "./nearai.ts";

/**
 * Three more read-only lines for `npm run runner -- status`: whether NEAR AI answers (its model list, GET /v1/models,
 * public, no key sent), whether Hyperliquid testnet's /info answers (allMids, the mid prices the runner prices its
 * orders from), and the relayer's NEAR balance (view_account). A failure becomes a line, never an exception.
 */
export interface StatusLine {
  what: string;
  ok: boolean;
  detail: string;
}

/** Under this the relayer is low: preflight's warning level (each call it sends attaches up to 300 TGas). */
export const RELAYER_LOW_YOCTO = 10n ** 24n / 2n;

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function statusChecks(input: {
  fetchFn: typeof fetch;
  rpc: Pick<JsonRpcProvider, "viewAccount">;
  /** The pinned model, `get_constants().model.id`. */
  model: string;
  /** The relayer's account id, or null when none is named. */
  relayer: string | null;
  now?: () => number;
}): Promise<StatusLine[]> {
  const now = input.now ?? (() => Date.now());
  const lines: StatusLine[] = [];

  let t0 = now();
  try {
    const { models } = await fetchModels(input.fetchFn);
    const listed = models.some((m) => m.id === input.model);
    lines.push({
      what: "NEAR AI",
      ok: listed,
      detail: `reachable in ${now() - t0} ms (GET /v1/models): ${models.length} models listed; the pinned ${input.model} is ${listed ? "listed" : "NOT listed"}`,
    });
  } catch (e) {
    lines.push({ what: "NEAR AI", ok: false, detail: `UNREACHABLE (GET /v1/models): ${reason(e)}` });
  }

  t0 = now();
  try {
    const mids = await fetchMids(input.fetchFn);
    const missing = MARKETS.filter((m) => mids[m.hl_name] === undefined).map((m) => m.hl_name);
    lines.push({
      what: "Hyperliquid testnet /info",
      ok: missing.length === 0,
      detail: `reachable in ${now() - t0} ms (allMids): mid prices for ${MARKETS.length - missing.length} of the ${MARKETS.length} markets${missing.length > 0 ? `; none for ${missing.join(", ")}` : ""}`,
    });
  } catch (e) {
    lines.push({
      what: "Hyperliquid testnet /info",
      ok: false,
      detail: `UNREACHABLE (allMids): ${reason(e)}`,
    });
  }

  if (input.relayer === null) {
    lines.push({
      what: "relayer",
      ok: false,
      detail: "not named: set RELAYER_ACCOUNT_ID or pass --relayer <account>",
    });
  } else {
    try {
      const amount = (await input.rpc.viewAccount({ accountId: input.relayer })).amount;
      const low = amount < RELAYER_LOW_YOCTO;
      lines.push({
        what: "relayer",
        ok: !low,
        detail: `${input.relayer}: ${formatNear(amount)}${low ? " (low: under 0.5 NEAR; each call it sends attaches up to 300 TGas)" : ""}`,
      });
    } catch (e) {
      lines.push({ what: "relayer", ok: false, detail: `${input.relayer}: balance not read: ${reason(e)}` });
    }
  }
  return lines;
}
