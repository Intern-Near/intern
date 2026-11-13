import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../runner/src/json.ts";
import { configPath, type RunConfig, validateConfig } from "./config.ts";
import { PRESSURE_SETS } from "./pressure.ts";
import { listTickIds } from "./store.ts";

/**
 * A run's fingerprint: one sha256 over everything that decides what the models are asked and how their answers are
 * judged and counted, to publish before the run's first tick. Anyone can recompute it later from the published files
 * and see that none of them changed after it was published.
 *
 * It is the sha256 of a manifest with one line per file, as `sha256sum` prints it ("<sha256>  <path>\n"):
 * - run.json: the settings, the pinned signers, the token prices and the pressure set's messages (copied in full);
 * - every file under shadow/src except the 60-day simulation (shadow/src/sim, not part of a run), and every
 *   repository file they import (the runner's rulebook, prompt, judge and
 *   rule checks among them), found by following the imports;
 * - package.json and package-lock.json of runner and shadow: the exact package versions.
 * run.json comes first, named by itself so the run folder can live anywhere; then the repository files, by path from
 * the repository root, in byte order. Only file contents count: the git commit is printed for reference, not hashed,
 * so the fingerprint can be recomputed at any later commit where these files are unchanged, or without git.
 */

/** intern/, the repository root: this file is shadow/src/fingerprint.ts. */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The prompt templates (labelled in the output; they are code, so they are in the manifest anyway). */
export const PROMPT_FILES = [
  "runner/src/rulebook.ts",
  "runner/src/prompt.ts",
  "shadow/src/prompts.ts",
  "shadow/src/pressure.ts",
];
export const PACKAGE_FILES = [
  "runner/package.json",
  "runner/package-lock.json",
  "shadow/package.json",
  "shadow/package-lock.json",
];

export interface ManifestLine {
  sha256: string;
  /** "run.json", or a path from the repository root with "/" separators. */
  path: string;
}

/** Runs git with these arguments in the repository root and returns what it printed; throws if it cannot. */
export type Git = (args: string[]) => string;

export interface Fingerprint {
  fingerprint: string;
  manifest: ManifestLine[];
  runFolder: string;
  cfg: RunConfig;
  /** Whether run.json's pressure messages are the set published under that name in src/pressure.ts. */
  pressure: { set: string; messages: number; published: "same" | "different" | "not published" } | null;
  /** Direct dependencies with the versions their lock file resolves, per package. */
  packages: Record<string, string[]>;
  /** For reference, not hashed: the commit checked out, and the manifest's files that differ from it. */
  git: { commit: string; changed: string[] } | null;
  /** The run's first tick, when the run has already begun: a fingerprint made now proves less. */
  startedAt: string | null;
  node: string;
}

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** The text the fingerprint hashes: exactly what `sha256sum` prints for these files, in this order. */
export function manifestText(lines: readonly ManifestLine[]): string {
  return lines.map((l) => `${l.sha256}  ${l.path}\n`).join("");
}

// The relative path of an import statement: `import "…"`, or `import … from "…"` / `export … from "…"` on a line that
// starts with import or export, or the closing `} from "…"` of one written over several lines. Lines that start as
// comments never match. Packages are pinned by the lock files instead.
const IMPORT =
  /^\s*(?:import\s*|(?:import|export)\b[^"'\n]*?\bfrom\s*|\}\s*from\s*)["'](\.{1,2}\/[^"']+)["']/gm;
// An import whose path is computed at run time could not be followed, so a file that has one is refused. The
// formatter (biome) always writes it with no space before the parenthesis.
const DYNAMIC_IMPORT = /\bimport\(/;

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return tsFilesUnder(path);
    return e.isFile() && e.name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Every .ts file under shadow/src and every file they import from the repository, followed to the end. The 60-day
 * simulation (shadow/src/sim) is left out: it is not part of a shadow run, and a change to it changes no run.
 */
export function codeFiles(root: string = REPO_ROOT): string[] {
  const fromRoot = (path: string): string => relative(root, path).split(sep).join("/");
  const seen = new Set<string>();
  const sim = join(root, "shadow", "src", "sim") + sep;
  const todo = tsFilesUnder(join(root, "shadow", "src")).filter((p) => !p.startsWith(sim));
  for (let file = todo.pop(); file !== undefined; file = todo.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    if (DYNAMIC_IMPORT.test(text))
      throw new Error(`${fromRoot(file)} has a dynamic import, which cannot be followed`);
    for (const m of text.matchAll(IMPORT)) {
      const target = resolve(dirname(file), m[1] ?? "");
      if (fromRoot(target).startsWith("../") || isAbsolute(fromRoot(target))) {
        throw new Error(`${fromRoot(file)} imports ${m[1]}, outside the repository`);
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new Error(`${fromRoot(file)} imports ${m[1]}, which is not a file`);
      }
      todo.push(target);
    }
  }
  return [...seen].map(fromRoot).sort();
}

/** The direct dependencies of a package and the versions its package-lock.json resolves. */
function lockedVersions(root: string, pkg: string): string[] {
  const lock: unknown = JSON.parse(readFileSync(join(root, pkg, "package-lock.json"), "utf8"));
  const packages = isRecord(lock) && isRecord(lock.packages) ? lock.packages : {};
  const top = isRecord(packages[""]) ? packages[""] : {};
  const out: string[] = [];
  for (const [field, label] of [
    ["dependencies", ""],
    ["devDependencies", " (dev)"],
  ] as const) {
    const declared = isRecord(top[field]) ? Object.keys(top[field]) : [];
    for (const name of declared.sort()) {
      const entry = packages[`node_modules/${name}`];
      const version =
        isRecord(entry) && typeof entry.version === "string" ? entry.version : "not in the lock";
      out.push(`${name} ${version}${label}`);
    }
  }
  return out;
}

function realGit(root: string): Git {
  return (args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export function fingerprintRun(runDir: string, opts: { root?: string; git?: Git } = {}): Fingerprint {
  const root = opts.root ?? REPO_ROOT;
  const runJson = readFileSync(configPath(runDir));
  const cfg = validateConfig(JSON.parse(runJson.toString("utf8")));
  const repoFiles = [...new Set([...codeFiles(root), ...PACKAGE_FILES])].sort();
  const manifest: ManifestLine[] = [
    { sha256: sha256(runJson), path: "run.json" },
    ...repoFiles.map((path) => ({ sha256: sha256(readFileSync(join(root, path))), path })),
  ];

  let pressure: Fingerprint["pressure"] = null;
  if (cfg.pressure) {
    const published = PRESSURE_SETS[cfg.pressure.set];
    pressure = {
      set: cfg.pressure.set,
      messages: cfg.pressure.messages.length,
      published:
        published === undefined
          ? "not published"
          : JSON.stringify(published) === JSON.stringify(cfg.pressure.messages)
            ? "same"
            : "different",
    };
  }

  let git: Fingerprint["git"] = null;
  try {
    const run = opts.git ?? realGit(root);
    const commit = run(["rev-parse", "HEAD"]).trim();
    const status = run(["status", "--porcelain", "--untracked-files=all", "--", ...repoFiles]);
    const changed = status
      .split("\n")
      .filter((l) => l.length > 3)
      .map((l) => l.slice(3));
    git = { commit, changed };
  } catch {
    git = null; // no git, or not a checkout: the fingerprint does not need it
  }

  const [firstTick] = listTickIds(runDir);
  return {
    fingerprint: sha256(manifestText(manifest)),
    manifest,
    runFolder: basename(runDir),
    cfg,
    pressure,
    packages: { runner: lockedVersions(root, "runner"), shadow: lockedVersions(root, "shadow") },
    git,
    startedAt: firstTick ?? null,
    node: process.version,
  };
}

/** How to name the run folder in the printed commands: from `base` if it is inside it, else a placeholder. */
function shown(base: string, runDir: string): string {
  const rel = relative(base, runDir).split(sep).join("/");
  return rel === "" || rel.startsWith("../") || isAbsolute(rel) ? "<run-dir>" : rel;
}

export function formatFingerprint(f: Fingerprint, runDir: string, root: string = REPO_ROOT): string {
  const c = f.cfg;
  const code = f.manifest.filter((l) => l.path.endsWith(".ts"));
  const L: string[] = [];
  L.push(`Fingerprint of shadow run ${c.run_id} (run folder ${f.runFolder})`);
  L.push("");
  L.push(`  sha256:${f.fingerprint}`);
  L.push("");
  if (f.startedAt !== null) {
    L.push(
      `NOTE: this run began at tick ${f.startedAt}. A fingerprint made now does not show that its inputs were fixed before it began; publish one before the first tick.`,
    );
    L.push("");
  }
  L.push(
    "Publish it before the run's first tick. It is the sha256 of the manifest below: one line per file, as sha256sum prints it.",
  );
  L.push("");
  L.push("What went in");
  L.push("- run.json: the settings, the pinned signers, the token prices and the pressure messages");
  L.push(`- prompt templates: ${PROMPT_FILES.join(", ")}`);
  L.push(
    `- code: every file under shadow/src except the simulation (src/sim), and the repository files they import (${code.length} files)`,
  );
  L.push(`- package versions: ${PACKAGE_FILES.join(", ")}`);
  for (const [pkg, versions] of Object.entries(f.packages)) L.push(`    ${pkg}: ${versions.join(", ")}`);
  L.push("");
  L.push("The run's settings (run.json)");
  L.push(`- models: ${c.models.join(", ")}`);
  L.push(
    `- ranks ${c.ranks.join(", ")}; rulebook ${c.rulebook}; prompt markets ${c.prompt_markets}; thinking ${c.thinking}; ask_twice ${c.ask_twice === true ? "on" : "off"}`,
  );
  L.push(
    `- ${c.duration_hours} h of decisions every ${c.interval_minutes} min${c.offset_minutes ? ` (${c.offset_minutes} min after the mark)` : ""}, then ${c.tail_hours} h of prices; pool ${c.pool_e6} (6 decimals); hold ${c.hold_hours} h; cost ${c.cost_bps} bps`,
  );
  if (f.pressure) {
    const p = f.pressure;
    const verdict =
      p.published === "same"
        ? "the same as the set published under that name in shadow/src/pressure.ts"
        : p.published === "different"
          ? "DIFFERENT from the set published under that name in shadow/src/pressure.ts"
          : "not a set published in shadow/src/pressure.ts";
    L.push(`- pressure set ${p.set}: ${p.messages} messages, ${verdict}`);
  } else {
    L.push(`- no pressure set; the user message ends with: ${c.instruction}`);
  }
  L.push("- pinned signers, from each model's attestation report at set-up:");
  for (const model of c.models) {
    const pins = c.pinned[model];
    L.push(`    ${model}: ecdsa ${pins?.ecdsa.signing_address}, ed25519 ${pins?.ed25519.signing_address}`);
  }
  L.push("");
  L.push("Manifest");
  L.push(manifestText(f.manifest).trimEnd());
  L.push("");
  const fromRoot = shown(root, runDir);
  const fromShadow = shown(join(root, "shadow"), runDir);
  const files = f.manifest.filter((l) => l.path !== "run.json").map((l) => l.path);
  L.push(
    "How to recompute it: from the repository root, with coreutils (on macOS, shasum -a 256 for sha256sum):",
  );
  L.push(`  sh -c '(cd ${fromRoot} && sha256sum run.json); sha256sum ${files.join(" ")}' | sha256sum`);
  L.push(`or in shadow/: npm run fingerprint -- --run-dir ${fromShadow}`);
  L.push("Each manifest line can be checked on its own with sha256sum <file>, to find what changed.");
  L.push("");
  const git =
    f.git === null
      ? "git not available"
      : `git commit ${f.git.commit}${f.git.changed.length === 0 ? " (the repository files above are as committed)" : `; ${f.git.changed.length} of the repository files above differ from it or are not committed: ${f.git.changed.join(", ")}`}`;
  L.push(`Not in the hash, for reference: ${git}; Node ${f.node}.`);
  return `${L.join("\n")}\n`;
}
