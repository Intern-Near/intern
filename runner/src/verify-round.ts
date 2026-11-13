import { type ChainVerdict, readVerdict } from "./contract.ts";
import { type Decision, readDecisionLine } from "./decision.ts";
import { isRecord } from "./json.ts";
import { answerText } from "./judge.ts";
import { type RpcExchange, rpcCall, viewAt } from "./near-rpc.ts";
import { PINNED_01, RECORDED_ED25519_SIGNERS } from "./pinned.ts";
import type { RefusalCode } from "./rules.ts";
import { eip191Hash, recoverEthAddress, signedText, verifyModelSignature } from "./signature.ts";

/**
 * `verify-round`: re-checks one `propose` transaction from public data alone. It reads the transaction from NEAR
 * RPC (an archival node if the regular one no longer has it), decodes the three byte strings the runner sent
 * (01 §6.3: the exact request, the exact response, the signature), rebuilds the text NEAR AI signed, verifies the
 * signature with the scheme and signer pinned in 01, compares the request's system message with the rulebook the
 * contract served just before the proposal ran (a view at the previous block), reads the AI's decision line, and
 * sets all of that against the verdict the contract returned and logged. Read-only: nothing is signed or sent.
 *
 * What it cannot see: a request whose JSON writes a key twice. `JSON.parse` keeps the last copy; ai-check refuses
 * such a request (WRONG_RULEBOOK). The contract's verdict is shown next to this re-check, so a difference shows.
 */

export interface VerifyRoundInput {
  txHash: string;
  /** The account that signed the transaction (the `tx` method needs it). */
  sender: string;
  /** RPC URLs, tried in order: the regular node first, then archival nodes. */
  rpcs: readonly string[];
  fetchFn: typeof fetch;
  /** The pin to verify against. Default: 01's. */
  pinned?: { model: string; algo: "ecdsa" | "ed25519"; signer: string };
  /** Called with every RPC exchange (for `--save`). */
  record?: (e: RpcExchange) => void;
}

export type Mark = "OK" | "FAIL" | "INFO" | "UNVERIFIED";

export interface VerifyRoundReport {
  lines: string[];
  /** Checks that failed, and differences from the contract's verdict. */
  failures: number;
  /** Parts that could not be checked. */
  unverified: number;
  /** Set when the transaction could not be read or is not a proposal: nothing else was checked. */
  fatal: string | null;
}

/** Strict base64, as the contract decodes it: canonical padding, nothing outside the alphabet. Null otherwise. */
export function strictBase64(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function utf8Json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

const SHAPE_KEYS = new Set(["model", "messages", "stream", "chat_template_kwargs"]);

/**
 * The request shape of 01 §6.3 (1.2), which ai-check enforces at check 4: only the keys `model`, `messages`,
 * `stream` and optionally `chat_template_kwargs`; the pinned model; `stream` false; exactly two messages with exactly
 * `role` and `content` (a string), the system message (the rulebook, when `rulebook` is given) then the user's;
 * `chat_template_kwargs`, if present, exactly `{"enable_thinking": false}`. Returns the problems found.
 */
export function requestShapeProblems(request: Uint8Array, model: string, rulebook: string | null): string[] {
  const data = utf8Json(request);
  if (!isRecord(data)) return ["the request is not a JSON object in UTF-8"];
  const problems: string[] = [];
  const extra = Object.keys(data).filter((k) => !SHAPE_KEYS.has(k));
  if (extra.length > 0) problems.push(`keys 01 §6.3 does not allow: ${extra.join(", ")}`);
  if (data.model !== model) problems.push(`model is ${JSON.stringify(data.model)}, not ${model}`);
  if (data.stream !== false) problems.push("stream is not false");
  const messages = Array.isArray(data.messages) ? data.messages : [];
  if (messages.length !== 2) problems.push(`${messages.length} messages, not 2`);
  messages.forEach((m: unknown, i: number) => {
    if (!isRecord(m) || Object.keys(m).sort().join(",") !== "content,role" || typeof m.content !== "string") {
      problems.push(`message ${i + 1} does not have exactly a role and a text content`);
    }
  });
  const [system, user] = messages as unknown[];
  if (!isRecord(system) || system.role !== "system")
    problems.push("the first message is not the system message");
  else if (rulebook !== null && system.content !== rulebook) {
    problems.push("the system message is not the rulebook");
  }
  if (!isRecord(user) || user.role !== "user") problems.push("the second message is not the user's");
  if ("chat_template_kwargs" in data) {
    const k = data.chat_template_kwargs;
    if (!isRecord(k) || Object.keys(k).join(",") !== "enable_thinking" || k.enable_thinking !== false) {
      problems.push('chat_template_kwargs is not exactly {"enable_thinking": false}');
    }
  }
  return problems;
}

/**
 * For a signature that does not verify with the pin, who signed it, when that can be said: an ECDSA signature
 * (65 bytes) recovers its address; an ed25519 one (64 bytes) can only be tried against the keys recorded for the
 * four signed models, each over the text with that model's name. Null when nothing matches.
 */
export function nameSigner(
  request: Uint8Array,
  response: Uint8Array,
  signature: Uint8Array,
  model: string,
): string | null {
  if (signature.length === 65) {
    try {
      const text = new TextEncoder().encode(signedText(model, request, response));
      return `an ECDSA signature by ${recoverEthAddress(eip191Hash(text), signature)} over the text with ${model}`;
    } catch {
      return null;
    }
  }
  for (const [m, key] of Object.entries(RECORDED_ED25519_SIGNERS)) {
    if (verifyModelSignature("ed25519", key, signedText(m, request, response), signature)) {
      return `${m}'s ed25519 key ${key} (recorded 2026-11-11)`;
    }
  }
  return null;
}

/** The system message's text, if the request has one first. */
function systemMessage(request: Uint8Array): string | null {
  const data = utf8Json(request);
  const first = isRecord(data) && Array.isArray(data.messages) ? data.messages[0] : undefined;
  return isRecord(first) && first.role === "system" && typeof first.content === "string"
    ? first.content
    : null;
}

/** `round: N` and `nonce: X` as a rulebook text states them (01 §6.1), or null. */
export function rulebookRoundAndNonce(text: string): { round_id: number; nonce: string } | null {
  const round = /^round: (\d+)$/m.exec(text)?.[1];
  const nonce = /^nonce: ([0-9a-f]{16})$/m.exec(text)?.[1];
  return round === undefined || nonce === undefined ? null : { round_id: Number(round), nonce };
}

/** A NEP-297 event of the coin (`EVENT_JSON:{"standard":"intern",...}`), as logged by the contract (01 §10). */
export interface CoinEvent {
  event: string;
  data: Record<string, unknown>;
}

export function coinEvents(logs: readonly unknown[]): CoinEvent[] {
  const out: CoinEvent[] = [];
  for (const log of logs) {
    if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(log.slice("EVENT_JSON:".length));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.standard !== "intern" || typeof parsed.event !== "string") continue;
    const items = Array.isArray(parsed.data) ? parsed.data : [];
    for (const d of items) if (isRecord(d)) out.push({ event: parsed.event, data: d });
  }
  return out;
}

const AI_CODES: readonly RefusalCode[] = ["BAD_MODEL_SIGNATURE", "WRONG_RULEBOOK", "MALFORMED_DECISION"];
const BEFORE_AI: readonly RefusalCode[] = ["OUTSIDE_WINDOW", "FIRED"];

/** What checks 3 to 5 say about the proposal, as this re-check sees them. */
type AiOutcome = { code: null; decision: Decision } | { code: RefusalCode; reason: string };

function decisionText(d: Decision): string {
  if (d.action === "SKIP") return "skip";
  const dollars = `$${d.margin_e6 / 1_000_000n}.${(d.margin_e6 % 1_000_000n).toString().padStart(6, "0")}`;
  return `bet ${d.market} ${d.side.toLowerCase()}, margin_e6 ${d.margin_e6} (${dollars}) at ${d.leverage}x`;
}

/**
 * Whether the verdict the contract gave fits this re-check of checks 3 to 5. Returns the problem, or null when it
 * fits, or "not compared" when the contract stopped before check 3 (checks 1 and 2).
 */
export function compareVerdict(v: ChainVerdict, ai: AiOutcome, approved: CoinEvent | null): string | null {
  if (v.verdict === "NOPE" && BEFORE_AI.includes(v.code)) return "not compared";
  if (v.verdict === "NOPE" && AI_CODES.includes(v.code)) {
    if (ai.code === v.code) return null;
    return `the contract refused with ${v.code}; this re-check says ${ai.code ?? "checks 3 to 5 pass"}`;
  }
  // YES, SKIP or a later refusal: the contract found checks 3 to 5 good.
  if (ai.code !== null)
    return `the contract passed checks 3 to 5; this re-check fails ${ai.code} (${ai.reason})`;
  if (v.verdict === "SKIP" && ai.decision.action !== "SKIP")
    return "the contract says SKIP; the answer is a bet";
  if (v.verdict !== "SKIP" && ai.decision.action === "SKIP")
    return `the contract says ${v.verdict}; the answer is a skip`;
  if (v.verdict === "YES" && ai.decision.action === "BET") {
    const d = ai.decision;
    const a = approved?.data;
    if (
      !a ||
      a.market !== d.market ||
      a.side !== d.side ||
      a.margin !== d.margin_e6.toString() ||
      a.leverage !== d.leverage
    ) {
      return "the approved bet in the contract's event is not the decision line's bet";
    }
  }
  return null;
}

/** The event the contract logs with a verdict (01 §10): `approved`, `refused` or `skipped`. */
export function matchingEvent(v: ChainVerdict, events: readonly CoinEvent[]): CoinEvent | undefined {
  if (v.verdict === "YES")
    return events.find((e) => e.event === "approved" && e.data.position_id === v.position_id);
  if (v.verdict === "SKIP") return events.find((e) => e.event === "skipped");
  return events.find(
    (e) => e.event === "refused" && e.data.refusal_id === v.refusal_id && e.data.code === v.code,
  );
}

function verdictText(v: ChainVerdict): string {
  if (v.verdict === "YES") return `YES, position ${v.position_id}`;
  if (v.verdict === "SKIP") return "SKIP";
  return `NOPE ${v.code} (refusal ${v.refusal_id}, asked ${v.asked ?? "-"}, limit ${v.limit ?? "-"})`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Runs the whole re-check. All I/O goes through `input.fetchFn`. */
export async function verifyRound(input: VerifyRoundInput): Promise<VerifyRoundReport> {
  const pinned = input.pinned ?? PINNED_01;
  const lines: string[] = [];
  let failures = 0;
  let unverified = 0;
  const mark = (m: Mark, label: string, detail: string): void => {
    if (m === "FAIL") failures += 1;
    if (m === "UNVERIFIED") unverified += 1;
    lines.push(`  ${m.padEnd(10)} ${label}: ${detail}`);
  };
  const fatal = (why: string): VerifyRoundReport => {
    lines.push(`  ${"FAIL".padEnd(10)} ${why}`);
    return { lines, failures: failures + 1, unverified, fatal: why };
  };

  lines.push(`Transaction ${input.txHash}`);
  // 1. The transaction, with every receipt's outcome. `wait_until: NONE` answers at once: a regular node that no
  //    longer has the transaction says UNKNOWN_TRANSACTION instead of waiting, and the next URL is tried.
  let tx: Record<string, unknown>;
  let txUrl: string;
  try {
    const a = await rpcCall(
      input.rpcs,
      "tx",
      { tx_hash: input.txHash, sender_account_id: input.sender, wait_until: "NONE" },
      input.fetchFn,
      input.record,
    );
    if (!isRecord(a.result)) return fatal("the tx reply has no result");
    tx = a.result;
    txUrl = a.url;
  } catch (e) {
    return fatal(
      `could not read the transaction (looked up with sender ${input.sender}; --sender sets it): ${message(e)}`,
    );
  }
  const t = isRecord(tx.transaction) ? tx.transaction : {};
  const actions = Array.isArray(t.actions) ? t.actions : [];
  const call =
    actions.length === 1 && isRecord(actions[0]) && isRecord(actions[0].FunctionCall)
      ? actions[0].FunctionCall
      : null;
  const contract = typeof t.receiver_id === "string" ? t.receiver_id : "?";
  lines.push(
    `  from ${String(t.signer_id)} to ${contract}, ${call ? `method ${String(call.method_name)}` : `${actions.length} action(s)`}, status ${String(tx.final_execution_status)}; read from ${txUrl}`,
  );
  if (t.signer_id !== input.sender) {
    lines.push(
      `  note: looked up with sender ${input.sender}; the transaction's signer is ${String(t.signer_id)}`,
    );
  }
  if (call?.method_name !== "propose") return fatal("not a single propose call: nothing to verify");

  // 2. The arguments: { request, response, signature, funding?, credited_to? }, the three as base64 (01 §9.3).
  const rawArgs = strictBase64(call.args);
  const args = rawArgs ? utf8Json(rawArgs) : undefined;
  if (!isRecord(args)) return fatal("the propose arguments are not a JSON object");
  const request = strictBase64(args.request);
  const response = strictBase64(args.response);
  const signature = strictBase64(args.signature);
  lines.push(
    `  proposal: request ${request?.length ?? "undecodable"} bytes, response ${response?.length ?? "undecodable"} bytes, signature ${signature?.length ?? "undecodable"} bytes; credited_to ${typeof args.credited_to === "string" ? args.credited_to : "none"}; funding ${args.funding === undefined ? "none" : "attached"}`,
  );

  // 3. The contract's own answer: the propose receipt's return value and its events.
  const txOutcome =
    isRecord(tx.transaction_outcome) && isRecord(tx.transaction_outcome.outcome)
      ? tx.transaction_outcome.outcome
      : {};
  const firstReceipt = isRecord(txOutcome.status) ? txOutcome.status.SuccessReceiptId : undefined;
  const receipts = Array.isArray(tx.receipts_outcome) ? tx.receipts_outcome : [];
  const receipt = receipts.find((r: unknown) => isRecord(r) && r.id === firstReceipt) as
    | Record<string, unknown>
    | undefined;
  const outcome = receipt && isRecord(receipt.outcome) ? receipt.outcome : null;
  if (!receipt || !outcome || typeof receipt.block_hash !== "string") {
    return fatal("the propose receipt's outcome is not in the reply (not executed yet?)");
  }
  const receiptBlock = receipt.block_hash;
  let verdict: ChainVerdict | null = null;
  const status = isRecord(outcome.status) ? outcome.status : {};
  if (typeof status.SuccessValue === "string") {
    try {
      verdict = readVerdict(JSON.parse(Buffer.from(status.SuccessValue, "base64").toString("utf8")));
    } catch (e) {
      mark("FAIL", "verdict", `the return value is not a verdict: ${message(e)}`);
    }
  } else {
    mark("FAIL", "verdict", `the call did not succeed: ${JSON.stringify(outcome.status).slice(0, 300)}`);
  }
  const events = coinEvents(Array.isArray(outcome.logs) ? outcome.logs : []);

  // 4. The block the proposal ran in, and the state just before it (the previous block). These start at the node
  //    that had the transaction: if the regular node no longer had it, it will not have the block either.
  const rpcs = input.rpcs.slice(Math.max(0, input.rpcs.indexOf(txUrl)));
  let prevHash: string | null = null;
  try {
    const b = await rpcCall(rpcs, "block", { block_id: receiptBlock }, input.fetchFn, input.record);
    const header = isRecord(b.result) && isRecord(b.result.header) ? b.result.header : {};
    prevHash = typeof header.prev_hash === "string" ? header.prev_hash : null;
    const ns = typeof header.timestamp_nanosec === "string" ? BigInt(header.timestamp_nanosec) : null;
    const at = ns === null ? "?" : new Date(Number(ns / 1_000_000n)).toISOString();
    lines.push(
      `  ran in block ${String(header.height)} (${receiptBlock}) at ${at}; the state is read at the block before it, ${prevHash ?? "?"}`,
    );
  } catch (e) {
    mark("UNVERIFIED", "block", `could not read the block the proposal ran in: ${message(e)}`);
  }

  let chainRulebook: { round_id: number; nonce: string; text: string } | null = null;
  let chainPin: { id: string; signing_algo: string; signer: string } | null = null;
  if (prevHash !== null) {
    try {
      const r = await viewAt(rpcs, contract, "get_rulebook", {}, prevHash, input.fetchFn, input.record);
      const v = r.value;
      if (
        isRecord(v) &&
        typeof v.text === "string" &&
        typeof v.nonce === "string" &&
        typeof v.round_id === "number"
      ) {
        chainRulebook = { round_id: v.round_id, nonce: v.nonce, text: v.text };
      } else {
        mark("UNVERIFIED", "rulebook", "get_rulebook's answer has an unexpected shape");
      }
    } catch (e) {
      mark("UNVERIFIED", "rulebook", `get_rulebook at the previous block could not be read: ${message(e)}`);
    }
    try {
      const c = await viewAt(rpcs, contract, "get_constants", {}, prevHash, input.fetchFn, input.record);
      const m = isRecord(c.value) && isRecord(c.value.model) ? c.value.model : null;
      if (
        m &&
        typeof m.id === "string" &&
        typeof m.signing_algo === "string" &&
        typeof m.signer === "string"
      ) {
        chainPin = { id: m.id, signing_algo: m.signing_algo, signer: m.signer };
      }
    } catch (e) {
      mark(
        "UNVERIFIED",
        "contract pin",
        `get_constants at the previous block could not be read: ${message(e)}`,
      );
    }
  }

  // 5. Model and signer.
  lines.push("", "Model and signer");
  const requestJson = request ? utf8Json(request) : undefined;
  const named = isRecord(requestJson) && typeof requestJson.model === "string" ? requestJson.model : null;
  mark(
    named === pinned.model ? "OK" : "FAIL",
    "model",
    `${named ?? "(none)"} named in the request; 01 pins ${pinned.model}`,
  );
  if (chainPin) {
    const same =
      chainPin.id === pinned.model &&
      chainPin.signing_algo === pinned.algo &&
      chainPin.signer.toLowerCase().replace(/^0x/, "") === pinned.signer.toLowerCase().replace(/^0x/, "");
    mark(
      same ? "OK" : "FAIL",
      "contract's pin",
      `get_constants().model then: ${chainPin.id}, ${chainPin.signing_algo}, ${chainPin.signer}${same ? " (the same as 01)" : " (differs from 01)"}`,
    );
  }
  let signatureOk = false;
  if (request && response && signature) {
    // 01 §6.3: model:sha256(request):sha256(response), with the pinned model's name, as the contract builds it.
    const text = signedText(pinned.model, request, response);
    lines.push(`  ${"INFO".padEnd(10)} signed text, rebuilt: ${text}`);
    signatureOk = verifyModelSignature(pinned.algo, pinned.signer, text, signature);
    const other = signatureOk ? null : nameSigner(request, response, signature, named ?? pinned.model);
    const fake =
      signature.toString("utf8") === "FAKE"
        ? " (it is the text FAKE: coin-fast's stand-in AI check accepts that; it is not a NEAR AI signature)"
        : other
          ? `; it is ${other}`
          : "; no key recorded for the four signed models verifies it either";
    mark(
      signatureOk ? "OK" : "FAIL",
      "signer",
      signatureOk
        ? `the ${pinned.algo} signature verifies with the pinned key ${pinned.signer}: NEAR AI's ${pinned.model} key signed exactly these bytes`
        : `the ${signature.length}-byte signature does not verify with the pinned ${pinned.algo} key ${pinned.signer}${fake}`,
    );
  } else {
    mark(
      "FAIL",
      "signer",
      "the request, the response or the signature is not valid base64 (the contract records BAD_MODEL_SIGNATURE)",
    );
  }

  // 6. The rulebook and the request's shape (check 4).
  lines.push("", "Rulebook (check 4)");
  const system = request ? systemMessage(request) : null;
  if (request) {
    const shape = requestShapeProblems(request, pinned.model, null);
    mark(
      shape.length === 0 ? "OK" : "FAIL",
      "request shape",
      shape.length === 0
        ? "as 01 §6.3: the pinned model, a system and a user message, stream false"
        : shape.join("; "),
    );
  }
  if (chainRulebook) {
    const same = system === chainRulebook.text;
    mark(
      same ? "OK" : "FAIL",
      "rulebook",
      same
        ? `the system message equals, byte for byte, the rulebook get_rulebook served just before the proposal ran (round ${chainRulebook.round_id}, nonce ${chainRulebook.nonce}, ${Buffer.byteLength(chainRulebook.text)} bytes)`
        : `the system message is not the rulebook get_rulebook served just before the proposal ran (round ${chainRulebook.round_id}, nonce ${chainRulebook.nonce}). If another receipt ran on the contract earlier in the same block, it may have changed the rulebook; the contract's verdict below decides`,
    );
  } else {
    mark(
      "UNVERIFIED",
      "rulebook",
      "the rulebook of that moment could not be read, so the system message was not compared with it",
    );
  }
  if (system !== null) lines.push(`  ${"".padEnd(10)}   ${system.split("\n").slice(1, 11).join(" | ")}`);

  // 7. The AI's answer (check 5), read for the round and nonce the contract expected.
  lines.push("", "The AI's answer (check 5)");
  const expect = chainRulebook ?? (system ? rulebookRoundAndNonce(system) : null);
  const answer = response ? answerText(response) : null;
  let read: ReturnType<typeof readDecisionLine> | null = null;
  if (answer === null) {
    mark("INFO", "decision line", "the response has no single text answer (choices[0].message.content)");
  } else {
    // Shown as it is when it is one line of plain characters; otherwise JSON-quoted, so padding and line breaks show.
    const plain = /^[\x20-\x7e]+$/.test(answer);
    lines.push(
      `  ${"INFO".padEnd(10)} the answer${plain ? "" : " (quoted)"}: ${plain ? answer : JSON.stringify(answer)}`,
    );
    if (expect === null) {
      mark("UNVERIFIED", "decision line", "no round and nonce to read it against");
    } else {
      read = readDecisionLine(answer, expect);
      if (read.ok) {
        mark(
          "OK",
          "decision line",
          `exact, for round ${expect.round_id} and nonce ${expect.nonce}: ${decisionText(read.decision)}`,
        );
      } else {
        mark("INFO", "decision line", `not a decision line, so MALFORMED_DECISION: ${read.reason}`);
      }
    }
  }

  // Checks 3 to 5 as this re-check sees them, in the contract's order; the first failure wins.
  let ai: AiOutcome | null;
  if (!signatureOk) ai = { code: "BAD_MODEL_SIGNATURE", reason: "the signature does not verify" };
  else if (
    request === null ||
    requestShapeProblems(request, pinned.model, chainRulebook?.text ?? system).length > 0
  ) {
    ai = { code: "WRONG_RULEBOOK", reason: "the request is not the pinned model being sent the rulebook" };
  } else if (answer === null) ai = { code: "MALFORMED_DECISION", reason: "no single text answer" };
  else if (read === null)
    ai = null; // nothing to read the answer against
  else
    ai = read.ok
      ? { code: null, decision: read.decision }
      : { code: "MALFORMED_DECISION", reason: read.reason };

  // 8. The contract's verdict, and whether this re-check agrees with it.
  lines.push("", "The contract's verdict");
  if (verdict) mark("INFO", "return value", verdictText(verdict));
  for (const e of events) lines.push(`  ${"INFO".padEnd(10)} event ${e.event}: ${JSON.stringify(e.data)}`);
  const verdictEvent = verdict === null ? undefined : matchingEvent(verdict, events);
  if (verdict) {
    mark(
      verdictEvent ? "OK" : "FAIL",
      "event",
      verdictEvent
        ? `the ${verdictEvent.event} event matches the return value`
        : "no event matches the return value",
    );
    const diff = ai === null ? "not compared" : compareVerdict(verdict, ai, verdictEvent ?? null);
    if (ai === null) {
      mark("UNVERIFIED", "agreement", "the answer could not be read, so the verdict was not compared");
    } else if (diff === "not compared") {
      mark(
        "INFO",
        "agreement",
        `the contract stopped at ${verdict.verdict === "NOPE" ? verdict.code : "?"}, before the AI checks (3 to 5)`,
      );
    } else if (diff === null) {
      mark(
        "OK",
        "agreement",
        ai.code === null
          ? "the contract passed checks 3 to 5, and so does this re-check"
          : `the contract refused with ${ai.code}, and so does this re-check`,
      );
    } else {
      mark("FAIL", "agreement", diff);
    }
  }

  lines.push(
    "",
    failures === 0 && unverified === 0
      ? `RESULT  verified from public data: ${pinned.model} signed this answer to this request, the request carried the rulebook of that moment, and the contract's verdict (${verdict ? verdictText(verdict) : "?"}) fits it`
      : `RESULT  ${failures} problem(s), ${unverified} part(s) not checked; see the lines marked FAIL and UNVERIFIED`,
  );
  return { lines, failures, unverified, fatal: null };
}
