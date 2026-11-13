// npm run attestation-check -- [--model z-ai/glm-5.3-flash] [--algo ed25519] [--save <dir>]
// Fetches a fresh NEAR AI attestation report for the model with a random nonce and checks it (src/attestation-check.ts):
// the nonce, the signer against 01's pin, the Intel TDX quote and the NVIDIA GPU evidence, then lists what stays
// UNVERIFIED. Public endpoints only (NEAR AI, NVIDIA's attestation service); no key, no completion, no credit.
// With --save, the replies it read go to <dir> (the report trimmed, NVIDIA's reply, the NVIDIA keys used).
// Exit code: 0 every check passed; 1 a check failed; 2 a call failed.
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAttestationCheck } from "../attestation-check.ts";
import { SIGNING_ALGOS, type SigningAlgo } from "../nearai.ts";
import { PINNED_01 } from "../pinned.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const model = flag("--model") ?? PINNED_01.model;
const algo = (flag("--algo") ?? PINNED_01.algo) as SigningAlgo;
if (!SIGNING_ALGOS.includes(algo)) {
  console.error(`--algo must be one of ${SIGNING_ALGOS.join(", ")}`);
  process.exit(2);
}
const dir = flag("--save");
if (dir !== undefined) await mkdir(dir, { recursive: true });
let nonce = "";
const result = await runAttestationCheck(
  { model, algo },
  {
    fetchFn: fetch,
    now: () => new Date(),
    nonce: () => {
      nonce = randomBytes(32).toString("hex");
      return nonce;
    },
    save: dir === undefined ? null : (name, body) => writeFile(join(dir, name), body, { flag: "wx" }),
  },
);
for (const line of result.lines) console.log(line);
if (dir !== undefined) {
  const source = {
    what: "Saved by `npm run attestation-check -- --save`: GET https://cloud-api.near.ai/v1/attestation/report (provider=near, include_tls_fingerprint=false), trimmed to the fields the check reads; NVIDIA NRAS's reply to POST https://nras.attestation.nvidia.com/v3/attest/gpu with the candidate's nvidia_payload; the keys of https://nras.attestation.nvidia.com/.well-known/jwks.json that the reply's tokens name.",
    model,
    signing_algo: algo,
    nonce,
    fetched_at: new Date().toISOString(),
  };
  await writeFile(join(dir, "source.json"), `${JSON.stringify(source, null, 2)}\n`, { flag: "wx" });
  console.log(`saved in ${dir}`);
}
process.exitCode = result.callFailures > 0 ? 2 : result.failures > 0 ? 1 : 0;
