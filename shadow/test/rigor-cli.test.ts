import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { modelSlug } from "../../runner/src/recordings.ts";
import type { AttackTable } from "../src/attacks.ts";
import { configPath } from "../src/config.ts";
import { PRESSURE_SETS } from "../src/pressure.ts";
import { exchangeDir } from "../src/store.ts";
import { copyRecording } from "./fixture-run.ts";
import { makeConfig, tempDir } from "./helpers.ts";

// The commands behind `npm run fingerprint|attacks|ask-twice`, run as the scripts in package.json run them.
const CLI = fileURLToPath(new URL("../src/cli/rigor.ts", import.meta.url));
const MODEL = "z-ai/glm-5.3-flash";
let runDir = "";

before(() => {
  runDir = tempDir();
  const cfg = makeConfig({
    models: [MODEL],
    pressure: { set: "pressure-v1", messages: [...(PRESSURE_SETS["pressure-v1"] ?? [])] },
  });
  writeFileSync(configPath(runDir), JSON.stringify(cfg));
  // A real signed answer to pressure-v1's message 0 (step 1's "push" recording).
  copyRecording(
    `${modelSlug(MODEL)}/push`,
    exchangeDir(runDir, "2026-11-11T1530Z", MODEL, "INTERN"),
    (m) => ({
      ...m,
      shadow: { ...m.shadow, pressure_index: 0 },
    }),
  );
});

after(() => rmSync(runDir, { recursive: true, force: true }));

function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("npm run fingerprint, attacks and ask-twice", () => {
  it("fingerprint prints the fingerprint and its manifest", () => {
    const r = cli("fingerprint", "--run-dir", runDir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ {2}sha256:[0-9a-f]{64}$/m);
    assert.match(r.stdout, /^[0-9a-f]{64} {2}run\.json$/m);
  });

  it("attacks prints the table and writes its numbers with --json", () => {
    const out = join(runDir, "attacks.json");
    const r = cli("attacks", "--run-dir", runDir, "--answer-rule", "trim", "--json", out);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`| \`${MODEL}\` | INTERN | 1: skip 0 · held 1 · refused 0 | - | - |`));
    const table = JSON.parse(readFileSync(out, "utf8")) as AttackTable;
    assert.equal(table.answerRule, "trim");
    assert.equal(table.rows[0]?.cells[0]?.held, 1);
    assert.equal(table.attacks[0]?.aimsAt, "OVER_TRADE_LIMIT");
  });

  it("stops with exit code 2 and says why", () => {
    for (const [args, why] of [
      [["ask-twice", "--run-dir", runDir], /does not ask twice/],
      [["attacks", "--run-dir", runDir, "--answer-rule", "loose"], /--answer-rule must be strict or trim/],
      [["attacks", "--run-dir", runDir, "--scheme", "rsa"], /--scheme must be ecdsa or ed25519/],
      [["report", "--run-dir", runDir], /unknown command report/],
      [["attacks"], /usage/],
    ] as const) {
      const r = cli(...args);
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.stderr, why);
    }
  });
});
