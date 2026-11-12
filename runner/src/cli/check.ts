// npm run check [-- --save]
// Step 0: the NEAR AI key, the four signed models and their signers, and the six Hyperliquid markets on both
// networks against 01 §4. Read-only. With --save, the raw responses go to intern/fixtures/ (never overwritten).
// Exit code: 0 everything matches, 1 differences (or no key), 2 a call failed.
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runCheck } from "../check-run.ts";
import { FIXTURES_DIR } from "../paths.ts";

const save = process.argv.includes("--save")
  ? async (relPath: string, body: string): Promise<void> => {
      const path = join(FIXTURES_DIR, relPath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body, { flag: "wx" });
    }
  : null;

const result = await runCheck({
  fetchFn: fetch,
  env: process.env,
  now: () => new Date(),
  nonce: () => randomBytes(32).toString("hex"),
  save,
});
for (const line of result.lines) console.log(line);
process.exitCode = result.failures > 0 ? 2 : result.problems > 0 ? 1 : 0;
