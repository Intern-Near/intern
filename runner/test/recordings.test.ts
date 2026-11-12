import assert from "node:assert/strict";
import { relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkRecording,
  findRecordings,
  loadRecording,
  type RecordingFiles,
  requestProblems,
} from "../src/recordings.ts";
import { buildRulebook } from "../src/rulebook.ts";

// Real signed answers recorded by `npm run record`. Everything here runs offline, from the saved files.
const AI = fileURLToPath(new URL("../../fixtures/ai/", import.meta.url));
const DIRS = findRecordings(AI);

const failed = (files: RecordingFiles): Record<string, string> =>
  Object.fromEntries(
    checkRecording(files)
      .checks.filter((c) => !c.ok)
      .map((c) => [c.name, c.detail]),
  );

function flipByte(bytes: Buffer, at: number): Buffer {
  const copy = Buffer.from(bytes);
  copy[at] = (copy[at] ?? 0) ^ 0x01;
  return copy;
}

/** Changes one hex digit inside the `signature` value of a signature reply. */
function tamperSignature(reply: string): string {
  const data = JSON.parse(reply) as { signature: string };
  const s = data.signature;
  const i = s.length - 10;
  data.signature = `${s.slice(0, i)}${s[i] === "0" ? "1" : "0"}${s.slice(i + 1)}`;
  return JSON.stringify(data);
}

describe("recorded signed answers", () => {
  it("exist", () => assert.ok(DIRS.length > 0, `no recordings under ${AI}`));

  for (const dir of DIRS) {
    it(`${relative(AI, dir)} verifies from its saved files alone`, () => {
      assert.deepEqual(failed(loadRecording(dir)), {});
    });
  }

  const first = DIRS[0];
  if (first === undefined) return;
  const files = loadRecording(first);

  it("one changed byte in the request breaks both signatures", () => {
    const bad = failed({ ...files, request: flipByte(files.request, Math.floor(files.request.length / 2)) });
    assert.match(bad["signature ecdsa"] ?? "", /signed text does not match/);
    assert.match(bad["signature ed25519"] ?? "", /signed text does not match/);
  });

  it("one changed byte in the response breaks both signatures", () => {
    const bad = failed({ ...files, response: flipByte(files.response, files.response.length - 3) });
    assert.match(bad["signature ecdsa"] ?? "", /signed text does not match/);
    assert.match(bad["signature ed25519"] ?? "", /signed text does not match/);
  });

  it("one changed digit in a signature breaks that signature", () => {
    const { ecdsa, ed25519 } = files.signatures;
    assert.ok(ecdsa !== undefined && ed25519 !== undefined);
    const bad = failed({
      ...files,
      signatures: { ecdsa: tamperSignature(ecdsa), ed25519: tamperSignature(ed25519) },
    });
    assert.match(
      bad["signature ecdsa"] ?? "",
      /recovers 0x[0-9a-f]{40}, not signing_address|does not recover/,
    );
    assert.match(bad["signature ed25519"] ?? "", /does not verify/);
  });

  it("a correctly signed request whose system message is not the current rulebook is caught (WRONG_RULEBOOK)", () => {
    const otherNonce =
      files.meta.expected.nonce === "0000000000000000" ? "1111111111111111" : "0000000000000000";
    const current = buildRulebook({
      round_id: files.meta.expected.round_id,
      nonce: otherNonce,
      rank: "INTERN",
      brave_at_open_e6: 1_000_000_000n,
      bets_used: 0,
      at_risk_e6: 0n,
      playbook: null,
    });
    const meta = {
      ...files.meta,
      expected: { ...files.meta.expected, nonce: otherNonce, rulebook: current },
    };
    assert.deepEqual(requestProblems(files.request, meta), [
      "first message is not the expected rulebook as the system message",
    ]);
    // The signatures themselves still verify: the bytes were really signed, just for another rulebook.
    const bad = failed({ ...files, meta });
    assert.deepEqual(Object.keys(bad), ["request"]);
  });
});
