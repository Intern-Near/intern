// node scripts/e2e-testnet.ts <near-account> [--faucet <url>] [--market DOGE] [--choice TAIL|FADE]
//
// Tail or Fade end to end on testnet, with a NEAR testnet account whose key the NEAR CLI holds standing in for a
// visitor's wallet: its derived Hyperliquid address gets test USDC from the faucet, it approves a fresh trading key
// through NEAR's signing network (the one wallet transaction), the key places a $10 chip at 2x isolated, then closes
// it. Every reply is saved under fixtures/hl/tailfade-e2e/<UTC time>/ as evidence. Spends testnet NEAR only.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { toHex } from "../src/hash.ts";
import { account } from "../src/hl.ts";
import { hlAddressOf, PATH, SIGNER, sigFromSignResult } from "../src/mpc.ts";
import {
  agentToHex,
  approveAgent,
  closePosition,
  isApproved,
  newAgent,
  placeChip,
  submitApproval,
} from "../src/tailfade.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { faucet: { type: "string" }, market: { type: "string" }, choice: { type: "string" } },
});
const nearAccount = positionals[0];
if (!nearAccount) throw new Error("usage: node scripts/e2e-testnet.ts <near-account>");
const faucetUrl = values.faucet ?? "https://tailfade-faucet-production.up.railway.app";
const market = values.market ?? "DOGE";
const choice = values.choice === "FADE" ? "FADE" : "TAIL";
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "");
const out = join(
  new URL("../../fixtures/hl/tailfade-e2e/", import.meta.url).pathname,
  `${stamp}-${nearAccount}`,
);
mkdirSync(out, { recursive: true });
const save = (name: string, v: unknown) => writeFileSync(join(out, name), `${JSON.stringify(v, null, 2)}\n`);
const say = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. The visitor's own Hyperliquid address.
const user = await hlAddressOf(nearAccount);
say(`${nearAccount} → Hyperliquid ${user}`);

// 2. Test dollars from the faucet (once).
let acct = await account(user);
if (acct.accountValue < 10) {
  const r = await fetch(`${faucetUrl}/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account_id: nearAccount }),
  });
  const grant = await r.json();
  save("1-faucet.json", grant);
  say(`faucet: HTTP ${r.status} ${JSON.stringify(grant).slice(0, 160)}`);
  for (let i = 0; i < 20 && acct.accountValue < 10; i++) {
    await sleep(3_000);
    acct = await account(user);
  }
}
say(`account value $${acct.accountValue}`);
if (acct.accountValue < 10) throw new Error("the address holds under $10; stopping");

// 3. A fresh trading key, approved by the visitor through NEAR's signing network (the wallet's one transaction).
const agent = newAgent();
const { action, digest } = approveAgent(agent.address);
const args = JSON.stringify({
  request: { path: PATH, domain_id: 0, payload_v2: { Ecdsa: toHex(digest).slice(2) } },
});
say(`asking ${SIGNER} to sign the approval of ${agent.address} (about 10 s)`);
const cli = execFileSync(
  "near",
  [
    "contract",
    "call-function",
    "as-transaction",
    SIGNER,
    "sign",
    "json-args",
    args,
    "prepaid-gas",
    "300 Tgas",
    "attached-deposit",
    "1 yoctoNEAR",
    "sign-as",
    nearAccount,
    "network-config",
    "testnet",
    "sign-with-legacy-keychain",
    "send",
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
const json = cli.match(/\{[^{}]*"big_r"[\s\S]*?"recovery_id"\s*:\s*\d\s*\}/)?.[0];
const tx = cli.match(/transactions\/([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1] ?? null;
if (!json) throw new Error("no signature in the NEAR CLI's output");
const sig = sigFromSignResult(JSON.parse(json));
const approval = await submitApproval(action, sig);
save("2-approve-agent.json", { near_tx: tx, action, signature: sig, reply: approval });
say(`approveAgent (NEAR tx ${tx}): ${JSON.stringify(approval)}`);
await sleep(2_000);
say(`trading key approved: ${await isApproved(user, agent)}`);

// 4. The chip: $10 at 2x isolated, the Intern's way (TAIL) or the other (FADE), as if it had gone long.
const chip = await placeChip({ agent, market, choice, internSide: "LONG", chipUsd: 10 });
save("3-chip.json", chip);
say(
  `chip ${choice} ${market}: px ${chip.px} sz ${chip.sz}; leverage ${JSON.stringify(chip.leverage)}; order ${JSON.stringify(chip.order)}`,
);
await sleep(3_000);
acct = await account(user);
save("4-position.json", acct);
say(`position: ${JSON.stringify(acct.positions)}`);

// 5. Close it.
const closed = await closePosition({ agent, user, market });
save("5-close.json", closed);
say(`close: ${JSON.stringify(closed)}`);
await sleep(3_000);
acct = await account(user);
save("6-after.json", acct);
say(`after: account value $${acct.accountValue}, positions ${JSON.stringify(acct.positions)}`);
// The trading key is thrown away: it can only trade, and only for this test address.
save("agent.json", {
  address: agent.address,
  note: "test key, discarded after the run",
  key_hex_length: agentToHex(agent).length,
});
say(`evidence in ${out}`);
