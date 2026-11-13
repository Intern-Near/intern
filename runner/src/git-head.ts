import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The git commit this code was built from, read from the `.git` files themselves (no `git` process): HEAD, the ref it
 * names (a loose ref file, else packed-refs), following a worktree's `.git` file and its `commondir`. Null when there is
 * no `.git` (the runner's Docker image has none). It cannot tell whether the working tree has uncommitted changes.
 */
export interface GitHead {
  commit: string;
  /** The branch, e.g. "refs/heads/main"; null for a detached HEAD. */
  ref: string | null;
}

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const HASH = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function readText(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

export function readGitHead(repo = REPO): GitHead | null {
  const dotGit = join(repo, ".git");
  if (!existsSync(dotGit)) return null;
  let gitDir = dotGit;
  if (statSync(dotGit).isFile()) {
    const pointer = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (pointer === undefined) return null;
    gitDir = isAbsolute(pointer) ? pointer : resolve(repo, pointer);
  }
  const head = readText(join(gitDir, "HEAD"));
  if (head === null) return null;
  if (HASH.test(head)) return { commit: head, ref: null };
  const ref = /^ref: (.+)$/.exec(head)?.[1];
  if (ref === undefined) return null;
  const common = readText(join(gitDir, "commondir"));
  const commonDir = common === null ? gitDir : resolve(gitDir, common);
  for (const dir of [gitDir, commonDir]) {
    const loose = readText(join(dir, ref));
    if (loose !== null && HASH.test(loose)) return { commit: loose, ref };
  }
  const packed = readText(join(commonDir, "packed-refs")) ?? "";
  for (const line of packed.split("\n")) {
    const [hash, name] = line.split(" ");
    if (name === ref && hash !== undefined && HASH.test(hash)) return { commit: hash, ref };
  }
  return null;
}
