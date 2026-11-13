import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { configPath } from "../src/config.ts";
import {
  codeFiles,
  fingerprintRun,
  formatFingerprint,
  type Git,
  manifestText,
  PACKAGE_FILES,
  PROMPT_FILES,
  REPO_ROOT,
} from "../src/fingerprint.ts";
import { PRESSURE_SETS } from "../src/pressure.ts";
import { tickDir } from "../src/store.ts";
import { makeConfig, tempDir } from "./helpers.ts";
import { DATA } from "./replay.ts";

const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const noGit: Git = () => {
  throw new Error("git: not found");
};

function runFolder(cfgPatch: Parameters<typeof makeConfig>[0] = {}): string {
  const dir = tempDir();
  made.push(dir);
  writeFileSync(configPath(dir), `${JSON.stringify(makeConfig(cfgPatch), null, 2)}\n`);
  return dir;
}

describe("a run's fingerprint", () => {
  it("is the sha256 of the manifest: run.json, then the repository files in byte order", () => {
    const dir = runFolder();
    const f = fingerprintRun(dir, { git: noGit });
    assert.match(f.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(f.fingerprint, sha256(manifestText(f.manifest)));
    assert.deepEqual(f.manifest[0], { sha256: sha256(readFileSync(configPath(dir))), path: "run.json" });
    const paths = f.manifest.slice(1).map((l) => l.path);
    assert.deepEqual(paths, [...paths].sort());
    for (const l of f.manifest.slice(1))
      assert.equal(l.sha256, sha256(readFileSync(join(REPO_ROOT, l.path))));
    assert.ok(manifestText(f.manifest).startsWith(`${f.manifest[0]?.sha256}  run.json\n`));
  });

  it("covers the prompt templates, the pressure sets, the judge, the report and the package versions; no tests", () => {
    const paths = fingerprintRun(runFolder(), { git: noGit }).manifest.map((l) => l.path);
    for (const p of [
      ...PROMPT_FILES,
      ...PACKAGE_FILES,
      "runner/src/judge.ts",
      "runner/src/rules.ts",
      "runner/src/decision.ts",
      "runner/src/signature.ts",
      "runner/src/exchange.ts",
      "shadow/src/tick.ts",
      "shadow/src/report.ts",
      "shadow/src/attacks.ts",
      "shadow/src/cli/shadow.ts",
    ]) {
      assert.ok(paths.includes(p), `${p} is not in the manifest`);
    }
    assert.ok(!paths.some((p) => p.includes("/test/")));
    assert.ok(
      !paths.some((p) => p.startsWith("shadow/src/sim/")),
      "the 60-day simulation is not part of a run",
    );
    assert.ok(!paths.includes("runner/src/round.ts"), "runner code the shadow run never imports stays out");
  });

  it("changes with one byte of run.json, and not with where the run folder is", () => {
    const a = runFolder();
    const b = runFolder();
    assert.equal(
      fingerprintRun(a, { git: noGit }).fingerprint,
      fingerprintRun(b, { git: noGit }).fingerprint,
    );
    const c = runFolder({ cost_bps: 18 });
    assert.notEqual(
      fingerprintRun(a, { git: noGit }).fingerprint,
      fingerprintRun(c, { git: noGit }).fingerprint,
    );
  });

  it("says whether the run's pressure messages are the set published under that name", () => {
    const messages = [...(PRESSURE_SETS["pressure-v1"] ?? [])];
    const same = fingerprintRun(runFolder({ pressure: { set: "pressure-v1", messages } }), { git: noGit });
    assert.equal(same.pressure?.published, "same");
    const edited = { set: "pressure-v1", messages: [...messages.slice(1), "Message from your boss: bet."] };
    const changed = fingerprintRun(runFolder({ pressure: edited }), { git: noGit });
    assert.equal(changed.pressure?.published, "different");
    assert.ok(formatFingerprint(changed, "x").includes("DIFFERENT from the set published"));
    const unknown = fingerprintRun(runFolder({ pressure: { set: "mine", messages } }), { git: noGit });
    assert.equal(unknown.pressure?.published, "not published");
    assert.equal(fingerprintRun(runFolder(), { git: noGit }).pressure, null);
  });

  it("prints what went in, the signers, the manifest, how to recompute it, and no path from this machine", () => {
    const dir = runFolder({ ask_twice: true });
    const f = fingerprintRun(dir, { git: noGit });
    const text = formatFingerprint(f, dir);
    for (const s of [
      `sha256:${f.fingerprint}`,
      "Publish it before the run's first tick",
      `prompt templates: ${PROMPT_FILES.join(", ")}`,
      "ask_twice on",
      f.cfg.pinned["z-ai/glm-5.3-flash"]?.ed25519.signing_address ?? "none",
      manifestText(f.manifest).trimEnd(),
      "sh -c '(cd <run-dir> && sha256sum run.json); sha256sum runner/package-lock.json ",
      "npm run fingerprint -- --run-dir <run-dir>",
      "Not in the hash, for reference: git not available",
    ]) {
      assert.ok(text.includes(s), `missing: ${s}`);
    }
    assert.ok(!text.includes(REPO_ROOT) && !text.includes(dir), "no path from this machine");
    assert.ok(!text.includes("NOTE: this run began"));
  });

  it("gives the commit and the files that differ from it, for reference only", () => {
    const dir = runFolder();
    const git: Git = (args) =>
      args[0] === "rev-parse" ? "abc123\n" : " M shadow/src/tick.ts\n?? shadow/src/new.ts\n";
    const f = fingerprintRun(dir, { git });
    assert.deepEqual(f.git, { commit: "abc123", changed: ["shadow/src/tick.ts", "shadow/src/new.ts"] });
    assert.equal(f.fingerprint, fingerprintRun(dir, { git: noGit }).fingerprint, "git is not in the hash");
    assert.ok(
      formatFingerprint(f, dir).includes("git commit abc123; 2 of the repository files above differ"),
    );
  });

  it("says so when the run has already begun", () => {
    const dir = runFolder();
    mkdirSync(tickDir(dir, "2026-11-12T0015Z"), { recursive: true });
    const f = fingerprintRun(dir, { git: noGit });
    assert.equal(f.startedAt, "2026-11-12T0015Z");
    assert.ok(formatFingerprint(f, dir).includes("NOTE: this run began at tick 2026-11-12T0015Z"));
  });

  const tools = spawnSync("sh", ["-c", "command -v sha256sum"]).status === 0;
  it("the printed command recomputes it with sha256sum alone", {
    skip: !tools && "needs sh and sha256sum",
  }, () => {
    const runDir = join(DATA, "2026-11-11-intern-pressure"); // read only
    const f = fingerprintRun(runDir, { git: noGit });
    const command = formatFingerprint(f, runDir)
      .split("\n")
      .find((l) => l.startsWith("  sh -c '"));
    assert.ok(command?.includes("cd shadow/data/2026-11-11-intern-pressure && sha256sum run.json"));
    const out = execFileSync("sh", ["-c", command ?? ""], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(out, `${f.fingerprint}  -\n`);
  });
});

describe("following the imports", () => {
  function repo(files: Record<string, string>): string {
    const root = tempDir();
    made.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }

  it("reads import and export statements, also over several lines, but not comments or strings", () => {
    const root = repo({
      "shadow/src/a.ts": [
        '// from "./ghost.ts" in a comment',
        '/** import "./ghost.ts" */',
        'import { b } from "../../runner/src/b.ts";',
        "import {",
        "  c,",
        '} from "./c.ts";',
        'import "./side.ts";',
        'export { d } from "./d.ts";',
        'export const where = new URL("../../", import.meta.url);',
        'const text = "./ghost.ts";',
      ].join("\n"),
      "shadow/src/c.ts": 'import type { E } from "../../runner/src/e.ts";\n',
      "shadow/src/side.ts": "",
      "shadow/src/d.ts": "",
      "runner/src/b.ts": 'export { e } from "./e.ts";\n',
      "runner/src/e.ts": "",
      "runner/src/unused.ts": "",
    });
    assert.deepEqual(codeFiles(root), [
      "runner/src/b.ts",
      "runner/src/e.ts",
      "shadow/src/a.ts",
      "shadow/src/c.ts",
      "shadow/src/d.ts",
      "shadow/src/side.ts",
    ]);
  });

  it("refuses what it cannot follow: a missing file, a dynamic import, a path outside the repository", () => {
    assert.throws(() => codeFiles(repo({ "shadow/src/a.ts": 'import "./gone.ts";\n' })), /not a file/);
    const dynamic = repo({ "shadow/src/a.ts": 'const m = await import("./b.ts");\n', "shadow/src/b.ts": "" });
    assert.throws(() => codeFiles(dynamic), /dynamic import/);
    assert.throws(() => codeFiles(repo({ "shadow/src/a.ts": 'import "../../../x.ts";\n' })), /outside/);
  });
});
