import { type JsonRpcProvider, KeyPairSigner } from "near-api-js";
import { isRecord } from "./json.ts";
import type { Log } from "./log.ts";
import type { Secret } from "./secret.ts";

/**
 * Key scope: whether the key the runner (or the relayer) signs with is what the set-up declares, and which other keys
 * its account holds. Read-only: one RPC query, `view_access_key_list` (near-api-js `viewAccessKeyList`; checked by
 * running it against testnet on 2026-11-13).
 *
 * The verdict is about the signing key only:
 * - The runner signs with a function-call key for the coin contract limited to exactly `propose`, `sign_next` and
 *   `report_result` (01 §9.3 and §13: the contract accepts those from the runner only; runner/README "Set-up"). That
 *   is "as declared". A key that can do more (full access, another contract, every method, other methods) is "not as
 *   declared", the only verdict that makes INTERN_KEY_SCOPE=strict refuse to start. A key that can do less, or that is
 *   not on the account, is "unusable": the runner could not make its calls with it.
 * - The relayer signs with a full-access key, because `close` attaches 1 yocto and a function-call key cannot attach
 *   NEAR (NEAR's docs, https://docs.near.org/protocol/access-keys). 01 does not name the relayer (runner/README
 *   "Set-up", .env.example). It has no rights in the contract: if its account is the contract's runner, that is "not
 *   as declared".
 * The account's other keys are listed with a plain note, never as a failure: a NEAR account normally keeps its
 * owner's full-access key, and that is not the key the runner signs with.
 */

/** The calls the runner's function-call key makes (01 §9.3, §13): exactly these, on the contract only. */
export const RUNNER_METHODS = ["propose", "sign_next", "report_result"] as const;

export type Expect = "runner" | "relayer";
export type KeyScopeMode = "off" | "warn" | "strict";
/** How one key compares with the signing key declared: the same, able to do more, or able to do less. */
export type Fit = "as declared" | "broader" | "narrower";
export type Verdict = "as declared" | "not as declared" | "unusable" | "no verdict";

export interface AccessKey {
  public_key: string;
  kind: "full-access" | "function-call" | "unknown";
  /** One of NEAR's newer gas keys (`GasKeyFullAccess`, `GasKeyFunctionCall` in near-api-js 7.4.0's RPC types). */
  gas_key: boolean;
  receiver_id: string | null;
  /** The methods a function-call key may call. Empty is read as every method (NEAR's docs: no list, any method). */
  method_names: string[];
  /** Yocto NEAR the key may still spend on gas, or null for no limit. */
  allowance: string | null;
  /** The permission exactly as the RPC gave it. */
  permission: unknown;
}

export interface JudgedKey extends AccessKey {
  /** Compared with the signing key declared; null when nothing is expected of the account. */
  fit: Fit | null;
  /** Why, in plain words. */
  fit_reason: string;
  /** True for the key the runner (or relayer) signs with. */
  signing: boolean;
  /** Whether this key would pass as the signing key. */
  passes: boolean;
  note: string;
}

export interface KeyScope {
  account_id: string;
  expect: Expect | null;
  contract: string;
  /** The public key the runner (or relayer) signs with, when known. */
  signing_key: string | null;
  keys: JudgedKey[];
  verdict: Verdict;
  /** Why the verdict is not "as declared", or why no key would pass. */
  reasons: string[];
  /** The account's other keys, in plain words: listed, never a failure. */
  notes: string[];
  /** The keys that would pass as the signing key. */
  passing: string[];
}

const NEAR = 10n ** 24n;
export const formatNear = (yocto: bigint): string =>
  `${(Number((yocto * 1000n) / NEAR) / 1000).toFixed(3)} NEAR`;

/** Reads one key's permission as the RPC writes it: "FullAccess", {"FunctionCall": {…}}, or a gas key. */
export function readPermission(publicKey: string, permission: unknown): AccessKey {
  const base: AccessKey = {
    public_key: publicKey,
    kind: "unknown",
    gas_key: false,
    receiver_id: null,
    method_names: [],
    allowance: null,
    permission,
  };
  if (permission === "FullAccess") return { ...base, kind: "full-access" };
  if (!isRecord(permission)) return base;
  if (isRecord(permission.GasKeyFullAccess)) return { ...base, kind: "full-access", gas_key: true };
  const plain = isRecord(permission.FunctionCall) ? permission.FunctionCall : null;
  const fc = plain ?? (isRecord(permission.GasKeyFunctionCall) ? permission.GasKeyFunctionCall : null);
  // The allowance is yocto NEAR as a decimal string (as in the real replies), or absent or null for no limit.
  const a = fc?.allowance;
  if (
    fc === null ||
    typeof fc.receiver_id !== "string" ||
    !Array.isArray(fc.method_names) ||
    !fc.method_names.every((m: unknown) => typeof m === "string") ||
    !(a === undefined || a === null || (typeof a === "string" && /^[0-9]+$/.test(a)))
  ) {
    return base;
  }
  return {
    ...base,
    kind: "function-call",
    gas_key: plain === null,
    receiver_id: fc.receiver_id,
    method_names: fc.method_names as string[],
    allowance: typeof a === "string" ? a : null,
  };
}

export type KeyReader = Pick<JsonRpcProvider, "viewAccessKeyList">;

/** Every access key of `accountId`: the RPC query `view_access_key_list`. */
export async function readAccessKeys(rpc: KeyReader, accountId: string): Promise<AccessKey[]> {
  const reply: unknown = await rpc.viewAccessKeyList({ accountId });
  const keys = isRecord(reply) ? reply.keys : undefined;
  if (!Array.isArray(keys)) throw new Error(`view_access_key_list ${accountId}: no list of keys`);
  return keys.map((k: unknown, i: number) => {
    if (!isRecord(k) || typeof k.public_key !== "string" || !isRecord(k.access_key))
      throw new Error(`view_access_key_list ${accountId}: key ${i} has an unexpected shape`);
    return readPermission(k.public_key, k.access_key.permission);
  });
}

/**
 * The public key of a private key from the environment, the way the runner loads its keys (`KeyPairSigner`, as in
 * src/near.ts and preflight's `checkKey`). Only the public key leaves this function; an error never carries the key's
 * text.
 */
export async function signingPublicKey(key: Secret): Promise<string> {
  try {
    return (await KeyPairSigner.fromSecretKey(key.reveal() as `ed25519:${string}`).getPublicKey()).toString();
  } catch {
    throw new Error("the private key could not be read as a NEAR ed25519 key (its text is never shown)");
  }
}

/** One key in plain words: "a full-access key", or "a function-call key for <contract> (<methods>; <allowance>)". */
export function describeKey(k: AccessKey): string {
  const gas = k.gas_key ? " gas" : "";
  if (k.kind === "full-access") return `a full-access${gas} key`;
  if (k.kind === "unknown")
    return `a key with a permission this check does not know: ${JSON.stringify(k.permission)}`;
  const methods = k.method_names.length === 0 ? "every method" : k.method_names.join(", ");
  const allowance =
    k.allowance === null ? "no allowance limit" : `allowance ${formatNear(BigInt(k.allowance))}`;
  return `a function-call${gas} key for ${k.receiver_id} (${methods}; ${allowance})`;
}

const OWNER_NOTE = "normally the account owner's key; whoever holds it can do anything with this account";

function fitOf(k: AccessKey, expect: Expect, contract: string): { fit: Fit; reason: string } {
  if (k.kind === "unknown") return { fit: "broader", reason: "its permission cannot be checked" };
  if (expect === "relayer") {
    return k.kind === "full-access"
      ? { fit: "as declared", reason: "full access, as declared for the relayer (close attaches 1 yocto)" }
      : { fit: "narrower", reason: "a function-call key cannot attach the 1 yocto that close needs" };
  }
  if (k.kind === "full-access")
    return { fit: "broader", reason: "full access: it can do anything with this account" };
  if (k.receiver_id !== contract)
    return { fit: "broader", reason: `it is for ${k.receiver_id}, not the coin ${contract}` };
  if (k.method_names.length === 0) return { fit: "broader", reason: "it allows every method of the coin" };
  const allowed: readonly string[] = RUNNER_METHODS;
  const extra = k.method_names.filter((m) => !allowed.includes(m));
  if (extra.length > 0) return { fit: "broader", reason: `it also allows ${extra.join(", ")}` };
  const missing = RUNNER_METHODS.filter((m) => !k.method_names.includes(m));
  if (missing.length > 0)
    return {
      fit: "narrower",
      reason: `it lacks ${missing.join(", ")}: the runner could not make all its calls`,
    };
  return { fit: "as declared", reason: "exactly the runner's calls on the coin" };
}

/** A problem with the account itself, whatever key it signs with. */
function accountProblem(p: ScopeInput): { fit: Fit; reason: string } | null {
  if (p.expect === "runner" && p.contractRunner !== null && p.contractRunner !== p.accountId)
    return {
      fit: "narrower",
      reason: `the contract's runner is ${p.contractRunner} (get_constants().runner), not this account: the contract refuses the runner's calls from it`,
    };
  if (p.expect === "relayer" && p.contractRunner === p.accountId)
    return {
      fit: "broader",
      reason:
        "this is the contract's runner (get_constants().runner): the relayer must be a separate account with no rights in the contract",
    };
  return null;
}

export interface ScopeInput {
  accountId: string;
  /** Null: list the keys, no verdict. */
  expect: Expect | null;
  /** The coin contract. */
  contract: string;
  /** `get_constants().runner`, when known. */
  contractRunner: string | null;
  /** The public key the runner (or relayer) signs with; null when not known (then no verdict, only which would pass). */
  signingKey: string | null;
}

function noteFor(
  k: AccessKey,
  fit: { fit: Fit; reason: string } | null,
  signing: boolean,
  passes: boolean,
  p: ScopeInput,
): string {
  const what = describeKey(k);
  // The owner's note fits any full-access key except the one the relayer signs with (or would sign with).
  const owner =
    k.kind === "full-access" && !signing && !(p.signingKey === null && passes) ? ` (${OWNER_NOTE})` : "";
  if (fit === null || p.expect === null) return `${what}${owner}`;
  if (signing) return `the signing key, ${what}: ${fit.fit === "as declared" ? "as declared" : fit.reason}`;
  if (p.signingKey !== null) return `${what}${owner}`;
  if (passes) return `${what}: would pass as the ${p.expect}'s signing key`;
  // A full-access key's note already says why: whoever holds it can do anything with the account.
  return `${what}: would not pass as the ${p.expect}'s signing key${owner === "" ? ` (${fit.reason})` : owner}`;
}

/** The other keys of the account, in plain words (never a failure). */
function otherNotes(others: readonly JudgedKey[]): string[] {
  const notes: string[] = [];
  const full = others.filter((k) => k.kind === "full-access");
  if (full.length > 0)
    notes.push(`also holds ${full.length} full-access key${full.length > 1 ? "s" : ""} (${OWNER_NOTE})`);
  for (const k of others) if (k.kind !== "full-access") notes.push(`also holds ${describeKey(k)}`);
  return notes;
}

/** The verdict on the signing key, the other keys as notes, and which keys would pass (see the top of this file). */
export function judgeKeys(p: ScopeInput, keys: readonly AccessKey[]): KeyScope {
  const account = accountProblem(p);
  const judged: JudgedKey[] = keys.map((k) => {
    const f = p.expect === null ? null : fitOf(k, p.expect, p.contract);
    const signing = p.signingKey !== null && k.public_key === p.signingKey;
    const passes = f?.fit === "as declared" && account === null;
    return {
      ...k,
      fit: f?.fit ?? null,
      fit_reason: f?.reason ?? "",
      signing,
      passes,
      note: noteFor(k, f, signing, passes, p),
    };
  });
  const passing = judged.filter((k) => k.passes).map((k) => k.public_key);
  const reasons: string[] = [];
  let verdict: Verdict = "no verdict";
  if (p.expect !== null && p.signingKey !== null) {
    const fits: Fit[] = [];
    const s = judged.find((k) => k.signing);
    if (s === undefined) {
      fits.push("narrower");
      reasons.push(
        `the signing key ${p.signingKey} is not a key of ${p.accountId}: nothing can be signed with it`,
      );
    } else if (s.fit !== null && s.fit !== "as declared") {
      fits.push(s.fit);
      reasons.push(`the signing key ${s.public_key}: ${s.fit_reason}`);
    }
    if (account !== null) {
      fits.push(account.fit);
      reasons.push(account.reason);
    }
    verdict = fits.includes("broader") ? "not as declared" : fits.length > 0 ? "unusable" : "as declared";
  } else if (p.expect !== null) {
    if (account !== null) reasons.push(account.reason);
    if (passing.length === 0)
      reasons.push(`no key of this account would pass as the ${p.expect}'s signing key`);
  }
  return {
    account_id: p.accountId,
    expect: p.expect,
    contract: p.contract,
    signing_key: p.signingKey,
    keys: judged,
    verdict,
    reasons,
    notes: p.signingKey === null ? [] : otherNotes(judged.filter((k) => !k.signing)),
    passing,
  };
}

/** Reads and judges one account's keys. */
export async function checkKeyScope(rpc: KeyReader, p: ScopeInput): Promise<KeyScope> {
  return judgeKeys(p, await readAccessKeys(rpc, p.accountId));
}

/** One line: the verdict, what is wrong if anything, and the notes on the other keys. */
export function describeScope(s: KeyScope): string {
  const notes = s.notes.length > 0 ? `; ${s.notes.join("; ")}` : "";
  const signing = s.keys.find((k) => k.signing);
  switch (s.verdict) {
    case "as declared":
      return `${s.account_id}: as declared: signs with ${s.signing_key}, ${signing ? describeKey(signing) : "?"}${notes}`;
    case "not as declared":
      return `${s.account_id}: NOT AS DECLARED: ${s.reasons.join("; ")}${notes}`;
    case "unusable":
      return `${s.account_id}: UNUSABLE: ${s.reasons.join("; ")}${notes}`;
    case "no verdict":
      if (s.expect === null)
        return `${s.account_id}: ${s.keys.map((k) => `${k.public_key}: ${k.note}`).join("; ")}`;
      return s.passing.length > 0
        ? `${s.account_id}: no verdict on which key the ${s.expect} uses; would pass as its signing key: ${s.passing.join(", ")}`
        : `${s.account_id}: ${s.reasons.join("; ")}`;
  }
}

/** INTERN_KEY_SCOPE: off, warn or strict. Unset is warn; any other value is warn too, with a note. */
export function keyScopeMode(env: Record<string, string | undefined>): {
  mode: KeyScopeMode;
  note: string | null;
} {
  const v = env.INTERN_KEY_SCOPE;
  if (v === undefined || v === "") return { mode: "warn", note: null };
  if (v === "off" || v === "warn" || v === "strict") return { mode: v, note: null };
  return {
    mode: "warn",
    note: `INTERN_KEY_SCOPE=${JSON.stringify(v)} is not off, warn or strict; using warn`,
  };
}

export interface StartupAccount {
  accountId: string;
  expect: Expect;
  /** The private key it signs with, from the environment; only its public key is used. */
  key: Secret;
}

export interface StartupInput {
  env: Record<string, string | undefined>;
  rpc: KeyReader;
  contract: string;
  contractRunner: string;
  accounts: readonly StartupAccount[];
  log: Log;
}

/**
 * The key-scope check the runner makes at start, behind INTERN_KEY_SCOPE. `off`: nothing. `warn` (the default): one
 * log line per account, with the verdict on its signing key and the account's other keys; it always returns true.
 * `strict`: returns false only when a signing key is "not as declared" (it can do more than declared), and the runner
 * then stops before its first round. A check that cannot run is logged and stops nothing: the key check before it
 * (preflight's `checkKey`, at start) already stops the runner when its key cannot be read.
 */
export async function startupKeyScope(input: StartupInput): Promise<boolean> {
  const { mode, note } = keyScopeMode(input.env);
  if (note !== null) input.log({ step: "key scope", note });
  if (mode === "off") return true;
  let broader = false;
  for (const a of input.accounts) {
    try {
      const s = await checkKeyScope(input.rpc, {
        accountId: a.accountId,
        expect: a.expect,
        contract: input.contract,
        contractRunner: input.contractRunner,
        signingKey: await signingPublicKey(a.key),
      });
      input.log({
        step: "key scope",
        mode,
        account_id: s.account_id,
        expect: s.expect,
        signing_key: s.signing_key,
        verdict: s.verdict,
        reasons: s.reasons,
        notes: s.notes,
        keys: s.keys.map((k) => ({ public_key: k.public_key, key: describeKey(k), signing: k.signing })),
      });
      if (s.verdict === "not as declared") broader = true;
    } catch (e) {
      input.log({
        step: "key scope failed",
        mode,
        account_id: a.accountId,
        reason: e instanceof Error ? e.message : String(e),
        note: "the runner goes on: only a signing key that is not as declared stops it, and only with strict",
      });
    }
  }
  return !(mode === "strict" && broader);
}
