import { generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decisionLine } from "../../runner/src/decision.ts";
import { requestBody } from "../../runner/src/exchange.ts";
import type { Market } from "../../runner/src/markets.ts";
import { signedText } from "../../runner/src/signature.ts";
import type { RunConfig } from "../src/config.ts";
import { rulebookFor } from "../src/prompts.ts";
import { parseTickId, roundIdFor } from "../src/schedule.ts";
import type { ShadowMeta } from "../src/tick.ts";
import { FIXTURES } from "./helpers.ts";

const FILES = ["request.bin", "response.bin", "signature-ecdsa.json", "signature-ed25519.json", "meta.json"];

/**
 * Copies a real signed recording from intern/fixtures/ai/<model-slug>/<case>/ into `dir` (an exchange folder of a
 * test run), changing only meta.json (which no signature covers) with `patch`.
 */
export function copyRecording(
  recording: string,
  dir: string,
  patch: (meta: ShadowMeta) => ShadowMeta = (m) => m,
): void {
  const from = join(FIXTURES, "ai", recording);
  mkdirSync(dir, { recursive: true });
  for (const f of FILES) copyFileSync(join(from, f), join(dir, f));
  const meta = JSON.parse(readFileSync(join(from, "meta.json"), "utf8")) as ShadowMeta;
  writeFileSync(join(dir, "meta.json"), JSON.stringify(patch(meta)));
}

/**
 * An ed25519 signer made in memory for a test and pinned in the test run, so answers written for the test pass check
 * 3 like real signed ones. Its private key never leaves the process.
 */
export function testSigner(): { publicHex: string; signHex: (text: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x ?? "";
  return {
    publicHex: Buffer.from(x, "base64url").toString("hex"),
    signHex: (text) => sign(null, Buffer.from(text, "utf8"), privateKey).toString("hex"),
  };
}

export type Answer =
  | { skip: true; pad?: string }
  | { market: Market; side: "LONG" | "SHORT"; margin_e6: bigint; leverage: number; pad?: string };

/**
 * Writes one exchange into `dir` as a shadow tick would: the request (rulebook and user message for the tick's round
 * and `nonce`), a chat completion whose answer is the decision line (after `pad`, e.g. blank lines), its ed25519
 * signature by `signer`, and meta.json. `userLine` ends the user message; `chatId` is the completion's id.
 */
export function writeSignedExchange(
  dir: string,
  cfg: RunConfig,
  x: {
    model: string;
    tick: string;
    nonce: string;
    answer: Answer;
    signer: ReturnType<typeof testSigner>;
    userLine?: string;
    chatId?: string;
  },
): void {
  const round = roundIdFor(parseTickId(x.tick), cfg.interval_minutes);
  const rulebook = rulebookFor(cfg.rulebook, {
    round_id: round,
    nonce: x.nonce,
    rank: "INTERN",
    brave_at_open_e6: BigInt(cfg.pool_e6),
    bets_used: 0,
    at_risk_e6: 0n,
    playbook: null,
  });
  const request = requestBody(x.model, rulebook, `Market data: none.\n${x.userLine ?? cfg.instruction}`);
  const { pad = "", ...d } = x.answer;
  const line = decisionLine(round, x.nonce, "skip" in d ? { action: "SKIP" } : { action: "BET", ...d });
  const chatId = x.chatId ?? `chat-${x.tick}-${x.nonce}`;
  const response = Buffer.from(
    JSON.stringify({
      id: chatId,
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: `${pad}${line}` } }],
    }),
  );
  const signature = {
    text: signedText(x.model, request, response),
    signature: x.signer.signHex(signedText(x.model, request, response)),
    signing_address: x.signer.publicHex,
    signing_algo: "ed25519",
  };
  const at = new Date(parseTickId(x.tick) + 5_000).toISOString();
  const meta = {
    format: 1,
    model: x.model,
    case: "shadow INTERN",
    what: "written by a test",
    recorded_at: at,
    expected: { round_id: round, nonce: x.nonce, rulebook },
    market_data: { source: "none", fetched_at: at, saved_as: "../../prices-pre.json.gz" },
    request: { url: "https://cloud-api.near.ai/v1/chat/completions", headers: {} },
    response: { status: 200, ms: 1000, headers: {}, chat_id: chatId },
    preflight: cfg.pinned[x.model],
    signatures: { ecdsa: null, ed25519: { status: 200, attempts: 1, fetched_at: at } },
    shadow: {
      run_id: cfg.run_id,
      tick: x.tick,
      rank: "INTERN",
      prompt_markets: "six",
      thinking: "default",
      rulebook: cfg.rulebook,
    },
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "request.bin"), request);
  writeFileSync(join(dir, "response.bin"), response);
  writeFileSync(join(dir, "signature-ed25519.json"), JSON.stringify(signature));
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
}
