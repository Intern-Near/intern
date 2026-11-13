// node --env-file=<path to .env> src/cli/seed-temperature.ts --case <case> [--case <case>]... [--sign <n>]...
//
// Research for runner/docs/seed-and-temperature.md (not part of the runner): asks the pinned model the same fixed
// question several times, with and without `temperature` and `seed`, to see whether NEAR AI accepts them, whether
// its signature covers them, and whether the answers repeat. Spends a little NEAR AI credit (one completion per
// --case). Each exchange is saved as it happens in intern/fixtures/ai/seed-temperature/<UTC time>/, never overwritten.
// --sign <n> also fetches the ed25519 signature of the n-th call (1-based) and checks it over the exact bytes.
// The API key is read from NEARAI_API_KEY and never printed.
import { join } from "node:path";
import { writeNew } from "../exchange.ts";
import { answerText } from "../judge.ts";
import { fetchSignature, postCompletion } from "../nearai.ts";
import { FIXTURES_DIR } from "../paths.ts";
import { PINNED_01 } from "../pinned.ts";
import { readSecret } from "../secret.ts";
import { SEED_CASES, seedRequest } from "../seed-temperature.ts";
import { checkSignatureReply, parseSignatureReply, signedText } from "../signature.ts";

function args(name: string): string[] {
  return process.argv.flatMap((a, i) =>
    a === name && process.argv[i + 1] ? [process.argv[i + 1] as string] : [],
  );
}

const cases = args("--case");
const sign = new Set(args("--sign").map(Number));
const unknown = cases.filter((c) => !(c in SEED_CASES));
if (cases.length === 0 || unknown.length > 0) {
  console.error(`--case must be one of: ${Object.keys(SEED_CASES).join(", ")}`);
  process.exit(2);
}
if (cases.length > 10) {
  console.error("at most 10 calls");
  process.exit(2);
}
const apiKey = readSecret("NEARAI_API_KEY", process.env);
if (!apiKey) {
  console.error("NEARAI_API_KEY is not set");
  process.exit(2);
}

const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "").replaceAll("-", "");
const base = join(FIXTURES_DIR, "ai", "seed-temperature", `${stamp}Z`);
const firstAnswer = new Map<string, { content: string | null; reasoning: string | null }>();

for (const [i, name] of cases.entries()) {
  const n = i + 1;
  const dir = join(base, `${String(n).padStart(2, "0")}-${name}`);
  const request = seedRequest(name);
  await writeNew(join(dir, "request.bin"), request);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const reply = await postCompletion(request, apiKey, fetch);
  const ms = Date.now() - t0;
  await writeNew(join(dir, "response.bin"), reply.body);
  const { "set-cookie": _dropped, ...headers } = reply.headers;
  const text = reply.body.toString("utf8");
  let chatId: string | null = null;
  let reasoning: string | null = null;
  let usage: unknown = null;
  let finish: unknown = null;
  try {
    const body = JSON.parse(text) as {
      id?: unknown;
      usage?: unknown;
      choices?: { finish_reason?: unknown; message?: { reasoning_content?: unknown } }[];
    };
    chatId = typeof body.id === "string" ? body.id : null;
    usage = body.usage ?? null;
    const choice = body.choices?.[0];
    finish = choice?.finish_reason ?? null;
    reasoning =
      typeof choice?.message?.reasoning_content === "string" ? choice.message.reasoning_content : null;
  } catch {
    // Not JSON (an error page): kept as it is.
  }
  const content = reply.status === 200 ? answerText(reply.body) : null;
  const record: Record<string, unknown> = {
    case: name,
    what: SEED_CASES[name]?.what,
    started_at: startedAt,
    ms,
    status: reply.status,
    headers,
    chat_id: chatId,
  };
  console.log(
    `[${n}] ${name}: HTTP ${reply.status} in ${ms} ms, chat id ${chatId}, finish ${String(finish)}`,
  );
  if (reply.status !== 200) console.log(`    body: ${text.slice(0, 400)}`);
  console.log(`    answer: ${JSON.stringify(content)}`);
  console.log(
    `    reasoning ${reasoning === null ? "absent" : `${reasoning.length} chars`}; usage ${JSON.stringify(usage)}`,
  );
  const first = firstAnswer.get(name);
  if (first === undefined) {
    firstAnswer.set(name, { content, reasoning });
  } else {
    console.log(
      `    same as the first ${name} call: answer ${first.content === content ? "YES" : "NO"}, reasoning ${first.reasoning === reasoning ? "YES" : "NO"}`,
    );
  }
  if (sign.has(n) && chatId !== null) {
    const s = await fetchSignature(chatId, PINNED_01.algo, apiKey, fetch, (l) => console.log(`    ${l}`));
    await writeNew(join(dir, `signature-${PINNED_01.algo}.json`), s.body);
    record.signature = { status: s.status, attempts: s.attempts, fetched_at: new Date().toISOString() };
    if (s.status === 200) {
      const problems = checkSignatureReply(parseSignatureReply(s.body.toString("utf8")), {
        algo: PINNED_01.algo,
        text: signedText(PINNED_01.model, request, reply.body),
        preflightSigner: PINNED_01.signer,
      });
      console.log(
        `    signature ${PINNED_01.algo}: ${problems.length === 0 ? "verified over the exact request bytes (with these fields) and response bytes, by the pinned signer" : problems.join("; ")}`,
      );
      record.signature_problems = problems;
    } else {
      console.log(`    signature HTTP ${s.status}: ${s.body.toString("utf8").slice(0, 200)}`);
    }
  }
  await writeNew(join(dir, "exchange.json"), `${JSON.stringify(record, null, 2)}\n`);
}
console.log(`saved in ${base}`);
