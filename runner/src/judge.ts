import { type Decision, readDecisionLine } from "./decision.ts";
import { isRecord } from "./json.ts";
import type { SigningAlgo } from "./nearai.ts";
import { nope, type RoundState, rankChecks, type Verdict, windowAndStatus } from "./rules.ts";
import { signedText, verifyModelSignature } from "./signature.ts";

/**
 * A TypeScript copy of checks 3 to 5 of 01-SHARED-INTERFACE.md section 7 (what `ai-check` does on-chain), and the
 * whole chain of checks 1 to 12 for one proposal. Used by the shadow run to classify answers, and by tests.
 *
 * Follows 01 version 1.2: the request's allowed shape (§6.3), the decision line's edge cases (§6.2), and nothing
 * before or after the line (the "strict" answer rule, the default). The "trim" rule is kept only so the shadow
 * report can count answers that were refused for padding alone.
 */

/** The model the contract trusts: `get_constants().model`. `signer` is hex (20-byte address or 32-byte key). */
export interface Pinned {
  model: string;
  algo: SigningAlgo;
  signer: string;
}

/** What the contract expects for this proposal: the rulebook it wrote, the round, the nonce. */
export interface Expected {
  rulebook: string;
  round_id: number;
  nonce: string;
}

/** A proposal as 01 §6.3 defines it: the exact request and response bytes, and the raw signature bytes. */
export interface Proposal {
  request: Uint8Array;
  response: Uint8Array;
  signature: Uint8Array;
}

export type AiCheck =
  | { ok: true; decision: Decision }
  | { ok: false; code: "BAD_MODEL_SIGNATURE" | "WRONG_RULEBOOK" | "MALFORMED_DECISION"; reason: string };

/**
 * How the answer text is compared with the decision line:
 * - "strict": 01 §6.2 (1.2): nothing before or after the line, not even a blank line. What the contract does.
 * - "trim": spaces, tabs and line breaks before and after the line are ignored. Analysis only (shadow report).
 */
export type AnswerRule = "strict" | "trim";

export interface JudgeOptions {
  answerRule?: AnswerRule;
}

export function applyAnswerRule(answer: string, rule: AnswerRule): string {
  return rule === "trim" ? answer.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "") : answer;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** The answer text of a chat completion: `choices[0].message.content` of its only choice. */
export function answerText(response: Uint8Array): string | null {
  const data = parseJson(response);
  if (!isRecord(data) || !Array.isArray(data.choices) || data.choices.length !== 1) return null;
  const choice: unknown = data.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return null;
  return typeof choice.message.content === "string" ? choice.message.content : null;
}

/** Checks 3, 4 and 5, in that order. Returns the decision, or the first check that fails. */
export function aiCheck(pinned: Pinned, expected: Expected, p: Proposal, opts: JudgeOptions = {}): AiCheck {
  // 3. The signature over model:sha256(request):sha256(response), against the pinned signer.
  if (
    !verifyModelSignature(
      pinned.algo,
      pinned.signer,
      signedText(pinned.model, p.request, p.response),
      p.signature,
    )
  ) {
    return {
      ok: false,
      code: "BAD_MODEL_SIGNATURE",
      reason: "the signature does not match the pinned signer",
    };
  }

  // 4. The request names the pinned model and carries the rulebook as its one system message, first.
  const request = parseJson(p.request);
  if (!isRecord(request) || request.model !== pinned.model) {
    return { ok: false, code: "WRONG_RULEBOOK", reason: "the request does not name the pinned model" };
  }
  const messages: unknown[] = Array.isArray(request.messages) ? request.messages : [];
  const systems = messages.filter((m) => isRecord(m) && m.role === "system");
  const first = messages[0];
  if (
    systems.length !== 1 ||
    !isRecord(first) ||
    first.role !== "system" ||
    first.content !== expected.rulebook
  ) {
    return { ok: false, code: "WRONG_RULEBOOK", reason: "the system message is not the current rulebook" };
  }

  // 5. The answer is exactly a decision line for this round and nonce.
  const answer = answerText(p.response);
  if (answer === null) return { ok: false, code: "MALFORMED_DECISION", reason: "no single text answer" };
  const read = readDecisionLine(applyAnswerRule(answer, opts.answerRule ?? "strict"), expected);
  if (!read.ok) return { ok: false, code: "MALFORMED_DECISION", reason: read.reason };
  return { ok: true, decision: read.decision };
}

/** Checks 1 to 12 of 01 §7 for one proposal with no funding quote. One proposal gets one verdict. */
export function judge(
  state: RoundState,
  pinned: Pinned,
  expected: Expected,
  p: Proposal,
  opts: JudgeOptions = {},
): Verdict {
  const early = windowAndStatus(state);
  if (early) return early;
  const ai = aiCheck(pinned, expected, p, opts);
  if (!ai.ok) return nope(ai.code);
  return rankChecks(state, ai.decision);
}
