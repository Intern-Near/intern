import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type DecisionRead, readDecisionLine } from "./decision.ts";
import { isRecord } from "./json.ts";
import { SIGNING_ALGOS, type SigningAlgo } from "./nearai.ts";
import { checkSignatureReply, parseSignatureReply, signedText } from "./signature.ts";

/**
 * A recorded, signed AI answer: intern/fixtures/ai/<model-slug>/<case>/ with
 * request.bin, response.bin, signature-ecdsa.json, signature-ed25519.json and meta.json.
 */
export function modelSlug(model: string): string {
  return model.toLowerCase().replaceAll("/", "--");
}

export interface RecordingMeta {
  format: 1;
  model: string;
  case: string;
  what: string;
  recorded_at: string;
  /** What ai-check's `Expected` would hold for this answer. */
  expected: { round_id: number; nonce: string; rulebook: string };
  market_data: { source: string; fetched_at: string; saved_as: string };
  request: { url: string; headers: Record<string, string> };
  response: { status: number; ms: number; headers: Record<string, string>; chat_id: string | null };
  /** Signers read from GET /v1/attestation/report before the completion (hardware evidence not verified). */
  preflight: Record<SigningAlgo, { signing_address: string; nonce: string; fetched_at: string }>;
  signatures: Record<SigningAlgo, { status: number; attempts: number; fetched_at: string } | null>;
  error?: string;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RecordingReport {
  dir: string;
  model: string;
  case: string;
  checks: Check[];
  /** `choices[0].message.content`, exactly as in the response body. */
  answer: string | null;
  decision: DecisionRead | null;
  finish_reason: string | null;
  reasoning_chars: number | null;
}

/** Every recording folder (one that holds a meta.json) under intern/fixtures/ai, sorted. */
export function findRecordings(aiDir: string): string[] {
  if (!existsSync(aiDir)) return [];
  const out: string[] = [];
  for (const model of readdirSync(aiDir, { withFileTypes: true })) {
    if (!model.isDirectory() || model.name === "catalog") continue;
    for (const c of readdirSync(join(aiDir, model.name), { withFileTypes: true })) {
      const dir = join(aiDir, model.name, c.name);
      if (c.isDirectory() && existsSync(join(dir, "meta.json"))) out.push(dir);
    }
  }
  return out.sort();
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** What check 4 needs from the request: the pinned model, the rulebook as the system message, no streaming. */
export function requestProblems(request: Uint8Array, meta: RecordingMeta): string[] {
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(request).toString("utf8"));
  } catch {
    return ["request body is not JSON"];
  }
  if (!isRecord(data)) return ["request body is not a JSON object"];
  const problems: string[] = [];
  if (data.model !== meta.model) problems.push(`model is ${String(data.model)}`);
  if (data.stream !== false) problems.push("stream is not false");
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const [system, user] = messages;
  if (messages.length !== 2) problems.push(`${messages.length} messages, expected system then user`);
  if (!isRecord(system) || system.role !== "system" || system.content !== meta.expected.rulebook) {
    problems.push("first message is not the expected rulebook as the system message");
  }
  if (!isRecord(user) || user.role !== "user" || typeof user.content !== "string") {
    problems.push("second message is not a user message");
  }
  return problems;
}

/** Reads the answer out of a chat completion body. */
export function readAnswer(
  response: Uint8Array,
  chatId: string | null,
): {
  answer: string | null;
  finish_reason: string | null;
  reasoning_chars: number | null;
  problems: string[];
} {
  const none = { answer: null, finish_reason: null, reasoning_chars: null };
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(response).toString("utf8"));
  } catch {
    return { ...none, problems: ["response body is not JSON"] };
  }
  if (!isRecord(data)) return { ...none, problems: ["response body is not a JSON object"] };
  const problems: string[] = [];
  if (data.id !== chatId) problems.push("response id differs from the recorded chat id");
  const choices = Array.isArray(data.choices) ? data.choices : [];
  if (choices.length !== 1) problems.push(`${choices.length} choices`);
  const first: unknown = choices[0];
  const msg = isRecord(first) && isRecord(first.message) ? first.message : null;
  const answer = typeof msg?.content === "string" ? msg.content : null;
  if (answer === null) problems.push("choices[0].message.content is not a string");
  return {
    answer,
    finish_reason: isRecord(first) && typeof first.finish_reason === "string" ? first.finish_reason : null,
    reasoning_chars: typeof msg?.reasoning_content === "string" ? msg.reasoning_content.length : null,
    problems,
  };
}

/** Human-readable lines for one report. */
export function formatReport(r: RecordingReport): string[] {
  const allOk = r.checks.every((c) => c.ok);
  const lines = [`${allOk ? "OK  " : "FAIL"}  ${r.model} / ${r.case}`];
  for (const c of r.checks) lines.push(`        ${c.ok ? "ok  " : "FAIL"}  ${c.name}: ${c.detail}`);
  const shown = r.answer === null ? "(none)" : JSON.stringify(r.answer);
  lines.push(`        answer: ${shown.length > 400 ? `${shown.slice(0, 400)}…` : shown}`);
  lines.push(
    `        finish_reason ${r.finish_reason ?? "-"}, reasoning_content ${r.reasoning_chars ?? "absent"}${r.reasoning_chars === null ? "" : " chars"}`,
  );
  if (r.decision?.ok) {
    const d = r.decision.decision;
    const what =
      d.action === "SKIP" ? "skip" : `bet ${d.market} ${d.side} margin_e6 ${d.margin_e6} x${d.leverage}`;
    lines.push(`        decision line: exact (${what})`);
  } else if (r.decision) {
    lines.push(`        decision line: MALFORMED_DECISION (${r.decision.reason})`);
  }
  return lines;
}

/** One recording's files, as bytes and text. */
export interface RecordingFiles {
  dir: string;
  meta: RecordingMeta;
  request: Buffer;
  response: Buffer;
  /** The raw signature replies; a missing file is absent. */
  signatures: Partial<Record<SigningAlgo, string>>;
}

export function loadRecording(dir: string): RecordingFiles {
  const signatures: Partial<Record<SigningAlgo, string>> = {};
  for (const algo of SIGNING_ALGOS) {
    const path = join(dir, `signature-${algo}.json`);
    if (existsSync(path)) signatures[algo] = readFileSync(path, "utf8");
  }
  return {
    dir,
    meta: JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as RecordingMeta,
    request: readFileSync(join(dir, "request.bin")),
    response: readFileSync(join(dir, "response.bin")),
    signatures,
  };
}

/** Re-verifies one recording from its saved files alone. No network. */
export function verifyRecording(dir: string): RecordingReport {
  return checkRecording(loadRecording(dir));
}

/** The checks of `verifyRecording`, on files already in memory. */
export function checkRecording(files: RecordingFiles): RecordingReport {
  const { dir, meta, request, response } = files;
  const checks: Check[] = [];
  const add = (name: string, problems: string[], okDetail: string): void => {
    checks.push({
      name,
      ok: problems.length === 0,
      detail: problems.length === 0 ? okDetail : problems.join("; "),
    });
  };

  add("request", requestProblems(request, meta), "pinned model, rulebook as system message, stream false");

  const text = signedText(meta.model, request, response);
  for (const algo of SIGNING_ALGOS) {
    const reply = files.signatures[algo];
    let problems: string[];
    try {
      problems =
        reply === undefined
          ? ["file missing"]
          : checkSignatureReply(parseSignatureReply(reply), {
              algo,
              text,
              preflightSigner: meta.preflight[algo].signing_address,
            });
    } catch (e) {
      problems = [message(e)];
    }
    add(`signature ${algo}`, problems, `verified; signer ${meta.preflight[algo].signing_address}`);
  }

  const read = readAnswer(response, meta.response.chat_id);
  add("response", read.problems, "one choice with a text answer");
  return {
    dir,
    model: meta.model,
    case: meta.case,
    checks,
    answer: read.answer,
    decision: read.answer === null ? null : readDecisionLine(read.answer, meta.expected),
    finish_reason: read.finish_reason,
    reasoning_chars: read.reasoning_chars,
  };
}
