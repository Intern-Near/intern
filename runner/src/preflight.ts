import { randomBytes } from "node:crypto";
import { type JsonRpcProvider, KeyPairSigner } from "near-api-js";
import type { Chain } from "./chain.ts";
import type { Constants, Round } from "./contract.ts";
import { fetchOpenPositions, HL_TESTNET_INFO } from "./hl-exchange.ts";
import { isRecord } from "./json.ts";
import {
  checkKeyScope,
  describeScope,
  type Expect,
  keyScopeMode,
  RUNNER_METHODS,
  signingPublicKey,
} from "./key-scope.ts";
import { addressFromDerivedKey, view } from "./near.ts";
import { fetchAttestation, fetchModels, parseModelSigners } from "./nearai.ts";
import { checkConstants } from "./round.ts";
import { buildRulebookV12, longShotMarginE6, longShotOf } from "./rulebook.ts";
import type { Secret } from "./secret.ts";

/**
 * `preflight`: everything the runner needs from a deployed program, checked read-only in one go, so the first
 * contact with Engine 1's stub (and later the real contract) is one command. Nothing is signed or sent.
 */

export type Mark = "ok" | "warn" | "fail";
export interface Line {
  mark: Mark;
  what: string;
  detail: string;
}

const NEAR = 10n ** 24n;
const near = (yocto: bigint): string => `${(Number((yocto * 1000n) / NEAR) / 1000).toFixed(3)} NEAR`;

/** The rulebook 01 §6.1 would write for this round (the template of 1.2, unchanged in 1.3), compared line by line. */
export function rulebookDifferences(
  text: string,
  round: Round,
  nonce: string,
  playbook: string | null,
  minNotionalE6: bigint,
  braveNowE6?: bigint,
  brakeUntil: number | null = null,
): { line: number; program: string; template: string }[] {
  // 01 1.7: the limit is stated on the smaller of the pool at the opening and the pool now (`get_pot().brave.total`),
  // halved while the drawdown brake is on.
  const atOpen = BigInt(round.brave_at_open);
  const smaller = braveNowE6 !== undefined && braveNowE6 < atOpen ? braveNowE6 : atOpen;
  const base = brakeUntil === null ? smaller : smaller / 2n;
  // 01 1.5: a ticket round's text has a long_shot line; the template states what the program should have computed.
  const ticket = longShotOf(text)
    ? { margin_e6: longShotMarginE6(BigInt(round.brave_at_open)), max_leverage: 10 }
    : undefined;
  const template = buildRulebookV12(
    {
      round_id: round.id,
      nonce,
      rank: round.rank,
      brave_at_open_e6: base,
      bets_used: round.bets_used,
      at_risk_e6: BigInt(round.at_risk),
      playbook,
      ...(ticket ? { long_shot: ticket } : {}),
      ...(brakeUntil === null ? {} : { brake_until: brakeUntil }),
    },
    minNotionalE6,
  ).split("\n");
  const program = text.split("\n");
  const out: { line: number; program: string; template: string }[] = [];
  for (let i = 0; i < Math.max(program.length, template.length); i++) {
    if (program[i] !== template[i]) {
      out.push({ line: i + 1, program: program[i] ?? "(missing)", template: template[i] ?? "(missing)" });
    }
  }
  return out;
}

/** The calls the runner's function-call key makes (01 1.3 §9.3, §13): exactly these, on the contract only. */
export { RUNNER_METHODS };

/** Checks that a key is what the brief says it must be. Returns a problem, or null. */
export async function checkKey(
  rpc: JsonRpcProvider,
  accountId: string,
  key: Secret,
  want: "runner" | "relayer",
  contract: string,
): Promise<{ problem: string | null; detail: string }> {
  const publicKey = await KeyPairSigner.fromSecretKey(key.reveal() as `ed25519:${string}`).getPublicKey();
  const view_ = await rpc.viewAccessKey({ accountId, publicKey });
  const perm = view_.permission;
  if (want === "relayer") {
    // It attaches 1 yocto to close; a function-call key cannot attach a deposit.
    return perm === "FullAccess"
      ? { problem: null, detail: "full-access key" }
      : { problem: "the relayer's key must be able to attach 1 yocto (a full-access key)", detail: "" };
  }
  if (perm === "FullAccess") {
    return {
      problem: `the runner's key is a full-access key; it must be a function-call key limited to ${contract}'s ${RUNNER_METHODS.join(", ")}`,
      detail: "",
    };
  }
  const fc = typeof perm === "object" && perm !== null && "FunctionCall" in perm ? perm.FunctionCall : null;
  if (fc === null) return { problem: "the runner's key is not a function-call key", detail: "" };
  const methods = fc.method_names;
  if (fc.receiver_id !== contract) {
    return { problem: `the runner's key is for ${fc.receiver_id}, not ${contract}`, detail: "" };
  }
  const exact = methods.length === RUNNER_METHODS.length && RUNNER_METHODS.every((m) => methods.includes(m));
  if (!exact) {
    return {
      problem: `the runner's key allows ${methods.length === 0 ? "every method" : methods.join(", ")}; it must allow exactly ${RUNNER_METHODS.join(", ")}`,
      detail: "",
    };
  }
  const allowance =
    fc.allowance === undefined || fc.allowance === null ? "no limit" : near(BigInt(String(fc.allowance)));
  return {
    problem: null,
    detail: `function-call key for ${contract} (${methods.join(", ")}), allowance ${allowance}`,
  };
}

export interface PreflightInput {
  rpc: JsonRpcProvider;
  chain: Chain;
  fetchFn: typeof fetch;
  env: Record<string, string | undefined>;
  runner: { id: string; key: Secret } | null;
  relayer: { id: string; key: Secret } | null;
}

/** Runs every check; a check that cannot run is a failure with its reason. */
export async function preflight(input: PreflightInput): Promise<Line[]> {
  const lines: Line[] = [];
  const add = (mark: Mark, what: string, detail: string) => lines.push({ mark, what, detail });
  const attempt = async (what: string, f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      add("fail", what, e instanceof Error ? e.message : String(e));
    }
  };
  const { chain, rpc, fetchFn } = input;

  let c: Constants | null = null;
  await attempt("get_constants", async () => {
    c = await chain.constants();
    add(
      "ok",
      "get_constants",
      `interface ${c.interface_version}, ${c.network}, model ${c.model.id} (${c.model.signing_algo})`,
    );
    for (const p of checkConstants(c))
      add(p.startsWith("warning:") ? "warn" : "fail", "constants against 01", p);
  });
  const constants = c as Constants | null;
  if (constants === null) return lines;

  let round: Round | null = null;
  await attempt("get_rank", async () => {
    const r = await chain.rank();
    add("ok", "get_rank", `${r.rank}, ${r.status}, since round ${r.since_round}`);
  });
  await attempt("get_round", async () => {
    round = await chain.round();
    add(
      "ok",
      "get_round",
      `round ${round.id}, phase ${round.phase}, pool at open $${Number(BigInt(round.brave_at_open) / 10_000n) / 100}`,
    );
  });
  // 01 1.3 §9.6: where the BRAVE money is. The runner calls `rebalance` once each round, before proposing.
  await attempt("get_pot", async () => {
    const pot = await chain.pot();
    const usd = (v: string) => `$${Number(BigInt(v) / 10_000n) / 100}`;
    add(
      "ok",
      "get_pot",
      `BRAVE ${usd(pot.brave_total)}: idle ${usd(pot.brave_idle)}, lent ${usd(pot.brave_lent)} (lending ${constants.lending_mode ?? "not stated"})`,
    );
  });
  const current = round as Round | null;
  if (current !== null) {
    await attempt("get_positions", async () => {
      const ps = await chain.positions(current.id);
      add("ok", "get_positions", `${ps.length} bet(s) this round`);
    });
    await attempt("get_rulebook", async () => {
      const rb = await chain.rulebook();
      if (rb.round_id !== current.id)
        add("fail", "get_rulebook", `for round ${rb.round_id}, not the current ${current.id}`);
      const pb = await view(rpc, chain.contractId, "get_active_playbook");
      const playbook = isRecord(pb) && typeof pb.text === "string" ? pb.text : null;
      const braveNow = BigInt((await chain.pot()).brave_total);
      const brakeUntil = chain.brake ? await chain.brake().catch(() => null) : null;
      const diffs = rulebookDifferences(
        rb.text,
        current,
        rb.nonce,
        playbook,
        BigInt(constants.min_notional),
        braveNow,
        brakeUntil,
      );
      if (diffs.length === 0)
        add(
          "ok",
          "get_rulebook",
          `byte for byte the text of 01 1.3 §6.1 for this round (playbook: ${playbook === null ? "none" : "the active one"})`,
        );
      else {
        add(
          "warn",
          "get_rulebook",
          `differs from 01 1.3 §6.1 in ${diffs.length} line(s): ${diffs
            .map((d) => `line ${d.line}: program "${d.program}" / 01 "${d.template}"`)
            .join("; ")}`,
        );
      }
    });
  }
  await attempt("get_outbox", async () => {
    const out = await chain.outbox();
    add("ok", "get_outbox", `${out.length} signed action(s)`);
  });

  // The program's Hyperliquid address is the one NEAR's signing network gives the contract for its path.
  await attempt("Hyperliquid address", async () => {
    const derived = await view(rpc, constants.hl.signer_contract, "derived_public_key", {
      path: constants.hl.path,
      predecessor: chain.contractId,
      domain_id: 0,
    });
    const address = addressFromDerivedKey(String(derived));
    if (address === constants.hl.address.toLowerCase()) {
      add("ok", "Hyperliquid address", `${address} is the contract's own key at path "${constants.hl.path}"`);
    } else {
      add(
        "fail",
        "Hyperliquid address",
        `get_constants says ${constants.hl.address}; ${constants.hl.signer_contract} derives ${address}`,
      );
    }
  });
  await attempt("Hyperliquid testnet account", async () => {
    const res = await fetchFn(HL_TESTNET_INFO, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: constants.hl.address.toLowerCase() }),
      signal: AbortSignal.timeout(30_000),
    });
    const data: unknown = await res.json();
    const value =
      isRecord(data) && isRecord(data.marginSummary) ? String(data.marginSummary.accountValue) : "?";
    const open = await fetchOpenPositions(constants.hl.address.toLowerCase(), fetchFn);
    const funded = Number(value) > 0;
    add(
      funded ? "ok" : "warn",
      "Hyperliquid testnet account",
      funded
        ? `account value $${value}; open positions: ${Object.keys(open).join(", ") || "none"}`
        : "no test dollars: signed orders will be refused until step 6 funds this address",
    );
  });

  // The pinned model and signer, against NEAR AI.
  await attempt("NEAR AI model", async () => {
    const { models } = await fetchModels(fetchFn);
    if (!models.some((m) => m.id === constants.model.id)) {
      add("fail", "NEAR AI model", `${constants.model.id} is not in NEAR AI's model list`);
      return;
    }
    const nonce = randomBytes(32).toString("hex");
    const att = await fetchAttestation(constants.model.id, constants.model.signing_algo, nonce, fetchFn);
    if (att.status !== 200) throw new Error(`attestation report HTTP ${att.status}`);
    const signers = parseModelSigners(att.body, {
      model: constants.model.id,
      algo: constants.model.signing_algo,
      nonce,
    });
    const pinned = constants.model.signer.toLowerCase().replace(/^0x/, "");
    const match = signers.some((s) => s.signing_address.replace(/^0x/, "") === pinned);
    add(
      match ? "ok" : "fail",
      "NEAR AI model",
      match
        ? `${constants.model.id} is listed, and its ${constants.model.signing_algo} signer is the pinned one`
        : `the pinned signer ${constants.model.signer} is not among the ${signers.length} signer(s) NEAR AI reports now`,
    );
  });
  add(
    input.env.NEARAI_API_KEY ? "ok" : "fail",
    "NEARAI_API_KEY",
    input.env.NEARAI_API_KEY ? "set" : "not set",
  );

  // The two accounts.
  if (input.runner === null)
    add("fail", "runner account", "RUNNER_ACCOUNT_ID and RUNNER_PRIVATE_KEY are not set");
  else {
    const r = input.runner;
    await attempt("runner account", async () => {
      if (r.id !== constants.runner) {
        add("fail", "runner account", `${r.id} is not the program's runner (${constants.runner})`);
        return;
      }
      const k = await checkKey(rpc, r.id, r.key, "runner", chain.contractId);
      const balance = (await rpc.viewAccount({ accountId: r.id })).amount;
      add(
        k.problem ? "fail" : "ok",
        "runner account",
        k.problem ?? `${r.id}: ${k.detail}; balance ${near(balance)}`,
      );
    });
  }
  if (input.relayer === null)
    add(
      "warn",
      "relayer account",
      "RELAYER_ACCOUNT_ID and RELAYER_PRIVATE_KEY are not set (needed by once and loop, for close and settle)",
    );
  else {
    const r = input.relayer;
    await attempt("relayer account", async () => {
      if (input.runner !== null && r.id === input.runner.id) {
        add("fail", "relayer account", "the relayer must be a separate account from the runner");
        return;
      }
      const k = await checkKey(rpc, r.id, r.key, "relayer", chain.contractId);
      const balance = (await rpc.viewAccount({ accountId: r.id })).amount;
      const low = balance < NEAR / 2n;
      add(
        k.problem ? "fail" : low ? "warn" : "ok",
        "relayer account",
        k.problem ??
          `${r.id}: ${k.detail}; balance ${near(balance)}${low ? " (low: each signing call attaches up to 300 TGas)" : ""}`,
      );
    });
  }

  // Key scope, as the runner checks it at start (INTERN_KEY_SCOPE: off, warn, strict; default warn): the key the runner
  // and the relayer sign with (the public key of RUNNER_PRIVATE_KEY, RELAYER_PRIVATE_KEY) against what is declared,
  // and their accounts' other keys as notes (src/key-scope.ts). A signing key that can do more than declared is a
  // warning, a failure with strict; one that cannot do the calls is a failure; with no private key set, the keys that
  // would pass are listed.
  const scope = keyScopeMode(input.env);
  if (scope.note !== null) add("warn", "key scope", scope.note);
  if (scope.mode === "off") add("warn", "key scope", "not checked (INTERN_KEY_SCOPE=off)");
  else {
    const targets: { expect: Expect; accountId: string; key: Secret | null }[] = [
      { expect: "runner", accountId: input.runner?.id ?? constants.runner, key: input.runner?.key ?? null },
    ];
    const relayerId = input.relayer?.id ?? (input.env.RELAYER_ACCOUNT_ID || null);
    if (relayerId !== null)
      targets.push({ expect: "relayer", accountId: relayerId, key: input.relayer?.key ?? null });
    for (const t of targets) {
      await attempt(`${t.expect} key scope`, async () => {
        const s = await checkKeyScope(rpc, {
          accountId: t.accountId,
          expect: t.expect,
          contract: chain.contractId,
          contractRunner: constants.runner,
          signingKey: t.key === null ? null : await signingPublicKey(t.key),
        });
        const mark: Mark =
          s.verdict === "as declared"
            ? "ok"
            : s.verdict === "not as declared"
              ? scope.mode === "strict"
                ? "fail"
                : "warn"
              : s.verdict === "unusable" || s.passing.length === 0
                ? "fail"
                : "warn";
        add(mark, `${t.expect} key scope`, describeScope(s));
      });
    }
  }
  return lines;
}
