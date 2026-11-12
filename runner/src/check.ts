import type { HlAsset } from "./hyperliquid.ts";
import { MARKETS, type Market, type MarketRow, type Network } from "./markets.ts";
import {
  type ListedModel,
  type ModelSigner,
  matchesRecorded,
  RESEARCH_ECDSA_SIGNERS,
  SIGNED_CHAT_MODELS,
  type SigningAlgo,
} from "./nearai.ts";

/** The highest leverage any rank may use (01 §3, TRADER). Every market must allow at least this much. */
export const MAX_RANK_LEVERAGE = 2;

export interface MarketCheck {
  network: Network;
  market: Market;
  hl_name: string;
  expected_index: number;
  found_index: number | null;
  expected_sz_decimals: number;
  found_sz_decimals: number | null;
  max_leverage: number | null;
  /** Empty means the row matches 01 §4. */
  problems: string[];
}

/** Compares 01 §4's market table with Hyperliquid's live list for one network. */
export function checkMarkets(
  network: Network,
  assets: readonly HlAsset[],
  table: readonly MarketRow[] = MARKETS,
): MarketCheck[] {
  return table.map((row): MarketCheck => {
    const expected_index = row.hl_asset[network];
    const base = {
      network,
      market: row.market,
      hl_name: row.hl_name,
      expected_index,
      expected_sz_decimals: row.sz_decimals,
    };
    const hits = assets.flatMap((a, i) => (a.name === row.hl_name ? [i] : []));
    const found_index = hits.includes(expected_index) ? expected_index : hits[0];
    const asset = found_index === undefined ? undefined : assets[found_index];
    if (found_index === undefined || asset === undefined) {
      return {
        ...base,
        found_index: null,
        found_sz_decimals: null,
        max_leverage: null,
        problems: [`"${row.hl_name}" is not listed on ${network}`],
      };
    }
    const problems: string[] = [];
    if (hits.length > 1) problems.push(`listed ${hits.length} times, at indexes ${hits.join(", ")}`);
    if (found_index !== expected_index)
      problems.push(`index is ${found_index}, 01 §4 says ${expected_index}`);
    if (asset.szDecimals !== row.sz_decimals) {
      problems.push(`size decimals are ${asset.szDecimals}, 01 §4 says ${row.sz_decimals}`);
    }
    if (asset.isDelisted) problems.push("delisted");
    if (asset.maxLeverage < MAX_RANK_LEVERAGE) {
      problems.push(
        `max leverage ${asset.maxLeverage} is below ${MAX_RANK_LEVERAGE}, the TRADER rank's limit`,
      );
    }
    return {
      ...base,
      found_index,
      found_sz_decimals: asset.szDecimals,
      max_leverage: asset.maxLeverage,
      problems,
    };
  });
}

export interface ModelCheck {
  model: string;
  owned_by: string | null;
  problems: string[];
}

/** Confirms each required model is listed, and owned by NEAR AI itself (the tier its own hardware signs). */
export function checkModels(
  listed: readonly ListedModel[],
  required: readonly string[] = SIGNED_CHAT_MODELS,
): ModelCheck[] {
  return required.map((model): ModelCheck => {
    const hit = listed.find((m) => m.id === model);
    if (!hit) return { model, owned_by: null, problems: ["not listed by GET /v1/models"] };
    const problems =
      hit.owned_by === "nearai"
        ? []
        : [`owned_by is "${hit.owned_by}", not "nearai"; it may not be TEE-signed`];
    return { model, owned_by: hit.owned_by, problems };
  });
}

export interface SignerCheck {
  model: string;
  algo: SigningAlgo;
  signing_address: string | null;
  note: string;
  problems: string[];
}

/** Judges the signer candidates from one attestation report. Exactly one candidate is required. */
export function checkSigner(model: string, algo: SigningAlgo, signers: readonly ModelSigner[]): SignerCheck {
  const [first] = signers;
  if (first === undefined) {
    return {
      model,
      algo,
      signing_address: null,
      note: "",
      problems: ["no model attestation: answers would not be signed by the model's own hardware"],
    };
  }
  const problems: string[] = [];
  if (signers.length > 1) {
    problems.push(`${signers.length} candidates; a signature must match exactly one (NEAR AI docs)`);
  }
  const recorded = algo === "ecdsa" ? RESEARCH_ECDSA_SIGNERS[model] : undefined;
  let note = "no earlier value to compare with";
  if (recorded) {
    if (matchesRecorded(first.signing_address, recorded.value)) {
      note = `same as research (${recorded.value})`;
    } else {
      problems.push(`signer changed: research recorded ${recorded.value} (${recorded.source})`);
      note = "";
    }
  }
  return { model, algo, signing_address: first.signing_address, note, problems };
}
