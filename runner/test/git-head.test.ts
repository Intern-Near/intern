import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readGitHead } from "../src/git-head.ts";

// Hand-made `.git` folders in the system's temporary folder, in the layouts git writes (a plain clone, packed refs,
// a detached HEAD, a worktree whose `.git` is a file pointing at its own folder with a `commondir`).
const A = "ea72b1c386dbbdd8bf73225e722a04b8e078d436";
const B = "bc0881b0000000000000000000000000000000ff";
const root = mkdtempSync(join(tmpdir(), "git-head-"));
after(() => rmSync(root, { recursive: true, force: true }));

function repo(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("readGitHead", () => {
  it("follows HEAD to a loose ref", () => {
    const dir = repo("plain", { ".git/HEAD": "ref: refs/heads/main\n", ".git/refs/heads/main": `${A}\n` });
    assert.deepEqual(readGitHead(dir), { commit: A, ref: "refs/heads/main" });
  });

  it("finds a ref in packed-refs", () => {
    const dir = repo("packed", {
      ".git/HEAD": "ref: refs/heads/dev/x\n",
      ".git/packed-refs": `# pack-refs with: peeled fully-peeled sorted\n${B} refs/heads/main\n${A} refs/heads/dev/x\n`,
    });
    assert.deepEqual(readGitHead(dir), { commit: A, ref: "refs/heads/dev/x" });
  });

  it("reads a detached HEAD", () => {
    const dir = repo("detached", { ".git/HEAD": `${B}\n` });
    assert.deepEqual(readGitHead(dir), { commit: B, ref: null });
  });

  it("follows a worktree's .git file and its commondir", () => {
    const main = repo("main", { ".git/refs/heads/dev/proof-kit": `${A}\n` });
    const wt = repo("wt", {
      ".git": `gitdir: ${join(main, ".git/worktrees/wt")}\n`,
    });
    repo("main/.git/worktrees/wt", { HEAD: "ref: refs/heads/dev/proof-kit\n", commondir: "../..\n" });
    assert.deepEqual(readGitHead(wt), { commit: A, ref: "refs/heads/dev/proof-kit" });
  });

  it("gives null without a .git, or with a ref it cannot find", () => {
    assert.equal(readGitHead(join(root, "nothing")), null);
    const dir = repo("dangling", { ".git/HEAD": "ref: refs/heads/gone\n" });
    assert.equal(readGitHead(dir), null);
  });
});
