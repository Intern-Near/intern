// Tools for checking a shadow run (README, "Rigor for the next run"). From shadow/:
//
//   npm run fingerprint -- --run-dir <dir>
//       The sha256 of the run's inputs (run.json, prompt templates, pressure set, pinned signers, code and package
//       versions), the files that went in, and how to recompute it. Publish it before the run's first tick.
//   npm run attacks -- --run-dir <dir> [--answer-rule strict|trim] [--scheme ed25519|ecdsa] [--json <file>]
//       For a run with a pressure set: per model and per message, the answers, skips, bets within the limits and
//       bets refused by the limits, by code.
//   npm run ask-twice -- --run-dir <dir> [--answer-rule strict|trim] [--scheme ed25519|ecdsa] [--json <file>]
//       For a run set up with --ask-twice: how often the two answers to the same request disagree.
//
// They only read: nothing in the run folder changes, no key is needed, nothing goes over the network. --json writes
// the numbers to the file named. Defaults as for the report: strict, ed25519.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AnswerRule } from "../../../runner/src/judge.ts";
import { SIGNING_ALGOS, type SigningAlgo } from "../../../runner/src/nearai.ts";
import { buildAgreement, formatAgreement } from "../agreement.ts";
import { buildAttackTable, formatAttackTable } from "../attacks.ts";
import { fingerprintRun, formatFingerprint } from "../fingerprint.ts";
import { loadRun } from "../report.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function die(message: string): never {
  console.error(message);
  process.exit(2);
}

const command = process.argv[2];
const runDirFlag = flag("--run-dir");
if (command === undefined || runDirFlag === undefined) {
  die("usage: npm run <fingerprint|attacks|ask-twice> -- --run-dir <dir> [options]   (see src/cli/rigor.ts)");
}
const runDir = resolve(runDirFlag);

function judging(): { answerRule: AnswerRule; scheme: SigningAlgo } {
  const answerRule = (flag("--answer-rule") ?? "strict") as AnswerRule;
  const scheme = (flag("--scheme") ?? "ed25519") as SigningAlgo;
  if (answerRule !== "strict" && answerRule !== "trim") die("--answer-rule must be strict or trim");
  if (!SIGNING_ALGOS.includes(scheme)) die("--scheme must be ecdsa or ed25519");
  return { answerRule, scheme };
}

function print(text: string, data: unknown): void {
  process.stdout.write(text);
  const out = flag("--json");
  if (out === undefined) return;
  writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
  console.error(`wrote ${out}`);
}

const commands: Record<string, () => void> = {
  fingerprint: () => {
    const f = fingerprintRun(runDir);
    process.stdout.write(formatFingerprint(f, runDir));
  },
  attacks: () => {
    const table = buildAttackTable(loadRun(runDir), judging());
    print(formatAttackTable(table), table);
  },
  "ask-twice": () => {
    const agreement = buildAgreement(loadRun(runDir), judging());
    print(formatAgreement(agreement), agreement);
  },
};

const handler = commands[command];
if (!handler) die(`unknown command ${command}; use fingerprint, attacks or ask-twice`);
try {
  handler();
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
