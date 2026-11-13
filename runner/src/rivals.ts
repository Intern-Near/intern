// 01 1.7, owner's decision (Engine 2's list, item 17): labelled rival players in the free guess and its leagues.
//
// Each rival is an ordinary registered NEAR account whose function-call key may only call the coin's `guess`. Once a
// round, while guessing is open, the runner guesses for each of them by its strategy:
//   contrarian  always NOPE.
//   copycat     the last round's outcome: YES if it had a bet, NOPE if it only had refusals, else SKIP.
//   glm         asks the model the Intern uses (on NEAR AI) to predict this round's verdict: one AI guessing another.
// They are bots, and named so (their accounts start with "rival-"): the site labels them. Their points have no value.

import type { Secret } from "./secret.ts";

export type Verdict3 = "YES" | "NOPE" | "SKIP";
export type Strategy = "contrarian" | "copycat" | "glm";

export interface RivalConfig {
  account: string;
  strategy: Strategy;
  /** The function-call key (ed25519:...), limited to `guess` on the coin. */
  key: string;
}

export interface Rival {
  account: string;
  strategy: Strategy;
  /** Sends `guess({ verdict })` as this rival; returns the transaction hash. */
  guess: (verdict: Verdict3) => Promise<string>;
}

/** RIVALS: a JSON list of `{ account, strategy, key }`. Empty or missing: no rivals. */
export function parseRivals(raw: string | undefined): RivalConfig[] {
  if (raw === undefined || raw.trim() === "") return [];
  const v: unknown = JSON.parse(raw);
  if (!Array.isArray(v)) throw new Error("RIVALS must be a JSON list");
  return v.map((r, i) => {
    const o = r as Record<string, unknown>;
    if (typeof o.account !== "string" || !o.account.includes("rival"))
      throw new Error(`RIVALS[${i}].account must be a rival's account (its name says "rival")`);
    if (o.strategy !== "contrarian" && o.strategy !== "copycat" && o.strategy !== "glm")
      throw new Error(`RIVALS[${i}].strategy must be contrarian, copycat or glm`);
    if (typeof o.key !== "string" || !o.key.startsWith("ed25519:"))
      throw new Error(`RIVALS[${i}].key must be an ed25519 key`);
    return { account: o.account, strategy: o.strategy, key: o.key };
  });
}

/** The last round's outcome, from its counters: YES if it had a bet, NOPE if only refusals, else SKIP. */
export function copycat(prev: { bets_used: number; refused: number } | null): Verdict3 {
  if (prev === null) return "SKIP";
  if (prev.bets_used > 0) return "YES";
  if (prev.refused > 0) return "NOPE";
  return "SKIP";
}

/** The first of YES, NOPE or SKIP in a model's answer, or SKIP. */
export function readVerdict(text: string): Verdict3 {
  const m = /\b(YES|NOPE|SKIP)\b/i.exec(text);
  return m ? (m[1]?.toUpperCase() as Verdict3) : "SKIP";
}

const NEAR_AI = "https://cloud-api.near.ai/v1/chat/completions";

/** Asks the model to predict the Intern's verdict this round. Plain chat, no signature: it is only a player. */
export async function askGlm(
  model: string,
  rulebook: string,
  apiKey: Secret,
  fetchFn: typeof fetch,
): Promise<Verdict3> {
  const prompt =
    "Another AI trader, the Intern, will now be given the rules below and asked for one decision. A program then " +
    "checks its answer: YES if it is a bet within the rules, NOPE if it breaks a rule or the format, SKIP if it " +
    "skips. Predict the program's verdict. Answer with one word: YES, NOPE or SKIP.\n\n--- the Intern's rules ---\n" +
    rulebook;
  const res = await fetchFn(NEAR_AI, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey.reveal()}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      max_tokens: 400,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!res.ok) throw new Error(`NEAR AI answered HTTP ${res.status}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return readVerdict(body.choices?.[0]?.message?.content ?? "");
}
