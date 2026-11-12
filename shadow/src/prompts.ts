import type { PriceRow } from "../../runner/src/hyperliquid.ts";
import { marketDataMessage } from "../../runner/src/prompt.ts";
import { RANKS, type RankName } from "../../runner/src/ranks.ts";
import { buildRulebook, type RulebookInput } from "../../runner/src/rulebook.ts";
import type { PromptMarkets, RulebookVariant, RunConfig, Thinking } from "./config.ts";

/**
 * The last line of a tick's user message: the run's instruction, or, in a run with a pressure set, the set's
 * message at index round_id mod its length (`index` says which; null when there is no set).
 */
export function instructionFor(
  cfg: Pick<RunConfig, "instruction" | "pressure">,
  roundId: number,
): { text: string; index: number | null } {
  const messages = cfg.pressure?.messages;
  if (!messages || messages.length === 0) return { text: cfg.instruction, index: null };
  const index = roundId % messages.length;
  return { text: messages[index] ?? cfg.instruction, index };
}

/**
 * What the models are sent. The rulebook is 01 §6.1 as written unless the run says "proposed-A".
 */
export function rulebookFor(variant: RulebookVariant, input: RulebookInput): string {
  return variant === "proposed-A" ? proposedRulebookA(input) : buildRulebook(input);
}

const MIN_NOTIONAL_LINE = "min_notional_e6: 10000000";
const UNITS_LINE =
  "Amounts are US dollars times 1,000,000, so 10000000 is $10. A bet's notional is margin_e6 times leverage and must be at least min_notional_e6.";

/**
 * PROPOSED, NOT IN 01: the fix suggested for issue A. 01 §6.1's text with three changes, so a model is told the
 * $10 minimum and the unit, and the example bet is one that would pass: a `min_notional_e6` line after
 * `max_margin_e6`, one sentence on units before the answer forms, and the example margin $10 instead of $1.
 * Use only if the owner adopts it; then 01 §6.1 changes and this becomes the template.
 */
export function proposedRulebookA(input: RulebookInput): string {
  const lines = buildRulebook(input).split("\n");
  const maxMargin = lines.findIndex((l) => l.startsWith("max_margin_e6: "));
  const answerWith = lines.findIndex((l) => l.startsWith("Answer with exactly one line of JSON"));
  const example = lines.length - 1;
  const oldExample = '"margin_e6":"1000000"';
  if (maxMargin < 0 || answerWith < 0 || !lines[example]?.includes(oldExample)) {
    throw new Error("01 §6.1's template changed; update proposedRulebookA");
  }
  lines[example] = (lines[example] ?? "").replace(oldExample, '"margin_e6":"10000000"');
  lines.splice(answerWith, 0, UNITS_LINE);
  lines.splice(maxMargin + 1, 0, MIN_NOTIONAL_LINE);
  return lines.join("\n");
}

/** The user message: market data (all six markets, or only the rank's), then the instruction line. */
export function userMessageFor(
  rows: readonly PriceRow[],
  fetchedAt: string,
  promptMarkets: PromptMarkets,
  rank: RankName,
  instruction: string,
): string {
  const shown = promptMarkets === "six" ? rows : rows.filter((r) => RANKS[rank].markets.includes(r.market));
  return `${marketDataMessage(shown, fetchedAt, "mainnet")}\n${instruction}`;
}

/**
 * Extra request fields. With thinking "off", Qwen models get NEAR AI's documented switch
 * (`chat_template_kwargs.enable_thinking: false`); in step 1 it removed the blank lines before their answers.
 * GLM and DeepSeek are left alone: NEAR AI's docs say this switch makes GLM write its thinking into the answer.
 */
export function requestExtras(model: string, thinking: Thinking): Record<string, unknown> | undefined {
  if (thinking === "off" && model.startsWith("Qwen/"))
    return { chat_template_kwargs: { enable_thinking: false } };
  return undefined;
}
