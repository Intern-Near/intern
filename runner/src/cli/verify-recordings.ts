// npm run verify-recordings
// Re-verifies every recording in intern/fixtures/ai from the saved files alone: no network, no key.
// For each: the request carries the pinned model and the rulebook, both signatures verify over
// model:sha256(request):sha256(response) and match the preflight signer, and the answer is read out.
// Exit code 0 when every recording verifies, 1 otherwise (or when there are none).
import { join } from "node:path";
import { FIXTURES_DIR } from "../paths.ts";
import { findRecordings, formatReport, verifyRecording } from "../recordings.ts";

const dirs = findRecordings(join(FIXTURES_DIR, "ai"));
let failed = 0;
for (const dir of dirs) {
  const report = verifyRecording(dir);
  if (!report.checks.every((c) => c.ok)) failed += 1;
  for (const line of formatReport(report)) console.log(line);
}
console.log(`\n${dirs.length} recording(s), ${dirs.length - failed} verified, ${failed} failed`);
process.exitCode = dirs.length === 0 || failed > 0 ? 1 : 0;
