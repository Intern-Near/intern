// npm run shadow -- <command> --run-dir <dir> [options]
//
//   init    Sets up a run folder: pins each model's signers from its attestation report, saves the token prices,
//           writes run.json once. Options: --ranks INTERN[,ANALYST,TRADER] --prompt-markets six|rank
//           --thinking default|off --rulebook 01-v1.0|proposed-A --duration-hours 72 --models a,b
//           --pressure pressure-v1 (end each user message with a published pressure message, src/pressure.ts)
//           --offset-minutes 7 (ticks at :07, :22, :37, :52, so two runs do not call NEAR AI at the same time)
//   run     The shadow run. Restart-safe: resumes at the next tick time. Exits 0 when decisions and the price tail
//           are over. Spends NEAR AI credit; reads Hyperliquid mainnet prices (read-only).
//   once    One tick right now, for a smoke test in a separate run folder. Not for the real run.
//   report  The report, rebuilt from the raw files. Options: --answer-rule strict|trim --scheme ecdsa|ed25519
//           --write (also writes report.md and report.json into the run folder)
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeNew } from "../../../runner/src/exchange.ts";
import { isRecord } from "../../../runner/src/json.ts";
import type { AnswerRule } from "../../../runner/src/judge.ts";
import {
  fetchAttestation,
  fetchModels,
  parseModelSigners,
  SIGNING_ALGOS,
  type SigningAlgo,
} from "../../../runner/src/nearai.ts";
import type { RankName } from "../../../runner/src/ranks.ts";
import { readSecret, type Secret } from "../../../runner/src/secret.ts";
import {
  configPath,
  DEFAULTS,
  type Pin,
  type PromptMarkets,
  type RulebookVariant,
  type RunConfig,
  readConfig,
  type Thinking,
  validateConfig,
} from "../config.ts";
import { runLoop } from "../loop.ts";
import { PRESSURE_SETS } from "../pressure.ts";
import { buildReport, formatReport, loadRun } from "../report.ts";
import { floorTick, tickId } from "../schedule.ts";
import { appendEvent, tickDir } from "../store.ts";
import { runTick, type TickDeps } from "../tick.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function list(name: string): string[] | undefined {
  return flag(name)
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function die(message: string): never {
  console.error(message);
  process.exit(2);
}

const command = process.argv[2];
const runDirFlag = flag("--run-dir");
if (command === undefined || runDirFlag === undefined) {
  die("usage: npm run shadow -- <init|run|once|report> --run-dir <dir> [options]   (see src/cli/shadow.ts)");
}
const runDir = resolve(runDirFlag);

function apiKeyOrDie(): Secret {
  const key = readSecret("NEARAI_API_KEY", process.env);
  return key ?? die("NEARAI_API_KEY is not set (intern/shadow/.env or intern/runner/.env)");
}

function realDeps(cfg: RunConfig, apiKey: Secret): TickDeps & { sleep: (ms: number) => Promise<void> } {
  return {
    fetchFn: fetch,
    apiKey,
    now: () => Date.now(),
    randomHex: (bytes) => randomBytes(bytes).toString("hex"),
    log: (event) => {
      const line = { at: new Date().toISOString(), run_id: cfg.run_id, ...event };
      appendEvent(runDir, line);
      console.log(JSON.stringify(line));
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

async function init(): Promise<void> {
  if (existsSync(runDir) && readdirSync(runDir).length > 0) die(`${runDir} exists and is not empty`);
  const pressureName = flag("--pressure");
  const pressureMessages = pressureName === undefined ? undefined : PRESSURE_SETS[pressureName];
  if (pressureName !== undefined && pressureMessages === undefined) {
    die(`unknown pressure set ${pressureName}; known: ${Object.keys(PRESSURE_SETS).join(", ")}`);
  }
  const pressure =
    pressureName === undefined || pressureMessages === undefined
      ? undefined
      : { set: pressureName, messages: [...pressureMessages] };
  await mkdir(runDir, { recursive: true });
  const models = list("--models") ?? DEFAULTS.models;
  const now = new Date();

  // Token prices, from the public model list (saved as it came).
  const listed = await fetchModels(fetch);
  await writeNew(join(runDir, "models.json"), listed.body);
  const catalog: unknown = JSON.parse(listed.body);
  const entries: unknown[] = isRecord(catalog) && Array.isArray(catalog.data) ? catalog.data : [];
  const prices: RunConfig["prices_per_mtok"] = {};
  for (const model of models) {
    const entry = entries.find((m) => isRecord(m) && m.id === model);
    const pricing = isRecord(entry) && isRecord(entry.pricing) ? entry.pricing : null;
    if (!pricing || typeof pricing.input !== "number" || typeof pricing.output !== "number") {
      die(`${model} is not in GET /v1/models, or has no price`);
    }
    prices[model] = { input: pricing.input, output: pricing.output };
  }

  // The signers this run pins, from each model's attestation report (hardware evidence not verified here).
  const pinned: RunConfig["pinned"] = {};
  for (const model of models) {
    const pins: Partial<Record<SigningAlgo, Pin>> = {};
    for (const algo of SIGNING_ALGOS) {
      const nonce = randomBytes(32).toString("hex");
      const fetched_at = new Date().toISOString();
      const r = await fetchAttestation(model, algo, nonce, fetch);
      if (r.status !== 200) die(`attestation for ${model} ${algo}: HTTP ${r.status}`);
      const signers = parseModelSigners(r.body, { model, algo, nonce });
      const [only] = signers;
      if (signers.length !== 1 || only === undefined)
        die(`${model} ${algo}: ${signers.length} signers, need one`);
      pins[algo] = { signing_address: only.signing_address, nonce, fetched_at };
    }
    pinned[model] = pins as Record<SigningAlgo, Pin>;
  }

  const durationFlag = flag("--duration-hours");
  const offsetFlag = flag("--offset-minutes");
  const cfg = validateConfig({
    ...DEFAULTS,
    format: 1,
    run_id: `${now.toISOString().slice(0, 16).replace(":", "")}Z`,
    created_at: now.toISOString(),
    models,
    ranks: (list("--ranks") as RankName[] | undefined) ?? DEFAULTS.ranks,
    prompt_markets: (flag("--prompt-markets") as PromptMarkets | undefined) ?? DEFAULTS.prompt_markets,
    thinking: (flag("--thinking") as Thinking | undefined) ?? DEFAULTS.thinking,
    rulebook: (flag("--rulebook") as RulebookVariant | undefined) ?? DEFAULTS.rulebook,
    duration_hours: durationFlag === undefined ? DEFAULTS.duration_hours : Number(durationFlag),
    pinned,
    prices_per_mtok: prices,
    ...(offsetFlag === undefined ? {} : { offset_minutes: Number(offsetFlag) }),
    ...(pressure === undefined ? {} : { pressure }),
  });
  await writeNew(configPath(runDir), `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`Run folder ready: ${runDir}`);
  console.log(`  models ${cfg.models.join(", ")}`);
  console.log(
    `  ranks ${cfg.ranks.join(", ")}; prompt markets ${cfg.prompt_markets}; thinking ${cfg.thinking}; rulebook ${cfg.rulebook}`,
  );
  console.log(
    `  ${cfg.duration_hours} h of decisions every ${cfg.interval_minutes} min, then ${cfg.tail_hours} h of prices only`,
  );
  if (cfg.offset_minutes)
    console.log(`  ticks ${cfg.offset_minutes} min after each ${cfg.interval_minutes}-minute mark`);
  if (cfg.pressure)
    console.log(`  pressure set ${cfg.pressure.set}: ${cfg.pressure.messages.length} messages, rotating`);
  console.log(`Start it with: ./run-forever.sh ${runDirFlag}`);
}

async function run(): Promise<void> {
  const cfg = readConfig(runDir);
  await runLoop(runDir, realDeps(cfg, apiKeyOrDie()));
}

async function once(): Promise<void> {
  const cfg = readConfig(runDir);
  const t = floorTick(Date.now(), cfg.interval_minutes, cfg.offset_minutes ?? 0);
  if (existsSync(tickDir(runDir, tickId(t)))) die(`tick ${tickId(t)} already exists in ${runDir}`);
  const summary = await runTick(runDir, cfg, t, "decide", realDeps(cfg, apiKeyOrDie()));
  console.log(JSON.stringify(summary, null, 2));
}

async function report(): Promise<void> {
  const answerRule = (flag("--answer-rule") ?? "strict") as AnswerRule;
  const scheme = (flag("--scheme") ?? "ecdsa") as SigningAlgo;
  if (answerRule !== "strict" && answerRule !== "trim") die("--answer-rule must be strict or trim");
  if (!SIGNING_ALGOS.includes(scheme)) die("--scheme must be ecdsa or ed25519");
  const data = buildReport(loadRun(runDir), { answerRule, scheme, now: Date.now() });
  const text = formatReport(data);
  console.log(text);
  if (process.argv.includes("--write")) {
    await writeFile(join(runDir, "report.md"), text);
    await writeFile(join(runDir, "report.json"), `${JSON.stringify(data, null, 2)}\n`);
    console.error(`wrote ${join(runDir, "report.md")} and report.json`);
  }
}

const commands: Record<string, () => Promise<void>> = { init, run, once, report };
const handler = commands[command];
if (!handler) die(`unknown command ${command}; use init, run, once or report`);
await handler();
