import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { baseEncode } from "near-api-js";
import { CONTROL_HOST_FUNCTIONS, type ImportSummary, SOURCES, summarizeImports } from "./host-functions.ts";
import { isRecord } from "./json.ts";
import { type AccessKey, describeKey, formatNear, readAccessKeys } from "./key-scope.ts";
import { rpcCall } from "./near-rpc.ts";
import { keyReader, queryFinal, type RpcReader } from "./rpc-read.ts";
import { readImports } from "./wasm-imports.ts";

/**
 * contract-scan: who can change a NEAR contract account, from public data only. For each account it reads
 * `view_account` (code hash, balance, storage), `view_access_key_list` (its keys) and `view_code` (the deployed wasm),
 * lists the NEAR host functions the wasm imports (src/wasm-imports.ts, src/host-functions.ts), and compares the code
 * hash with the one the repository records (docs/REPRODUCIBLE-BUILD.md). Read-only: nothing is signed or sent.
 *
 * What it can and cannot say: an account's code and keys change only through a full-access key, or through the
 * account's own code calling one of the control host functions (host-functions.ts has the sources). Keys are read
 * exactly. The code is read at the level of imports: a host function the wasm does not import is a call it cannot
 * make, so "imports none" proves there is no such path; "imports some" does not prove there is one. near-sdk links
 * every action host function into any contract that uses its Promise type (host-functions.ts), so for such a
 * contract this scan cannot rule a path out.
 */

/** The code hash of an account with no code: 32 zero bytes in base58 (near-primitives AccountView). */
export const NO_CODE_HASH = "11111111111111111111111111111111";

const ROOT = new URL("../../", import.meta.url);
/** The owner's files, read and never written. Neither is in the runner's Docker image. */
export const DEPLOYMENTS_FILE = fileURLToPath(new URL("interface/deployments.json", ROOT));
export const RECORDED_HASHES_FILE = fileURLToPath(new URL("docs/REPRODUCIBLE-BUILD.md", ROOT));
export const RECORDED_HASHES_NAME = "docs/REPRODUCIBLE-BUILD.md";

/** NEAR's account id rule: 2 to 64 characters and this regex (crate near-account-id 3.0.0, src/validation.rs). */
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const isAccountId = (s: string): boolean => ACCOUNT_ID.test(s);

export interface Target {
  account_id: string;
  /** Its name in deployments.json, when it has one. */
  label: string | null;
}

/** The account ids under `testnet` in deployments.json, labelled by their keys; URLs and other values are left out. */
export function deploymentTargets(deployments: unknown): Target[] {
  const testnet = isRecord(deployments) && isRecord(deployments.testnet) ? deployments.testnet : {};
  return Object.entries(testnet)
    .filter((e): e is [string, string] => typeof e[1] === "string" && isAccountId(e[1]))
    .map(([label, account_id]) => ({ account_id, label }));
}

export function readDeploymentTargets(file = DEPLOYMENTS_FILE): Target[] | null {
  return existsSync(file) ? deploymentTargets(JSON.parse(readFileSync(file, "utf8"))) : null;
}

// ---------------------------------------------------------------- the hashes the repository records

export interface RecordedHash {
  account_id: string;
  hash: string;
  /** The wasm's size in bytes, as the table states it. */
  size: number | null;
}

export interface RecordedHashes {
  file: string;
  /** The heading of the table, which carries its date. */
  heading: string | null;
  rows: RecordedHash[];
}

/**
 * The "expected hashes" table of docs/REPRODUCIBLE-BUILD.md: rows whose first cell names an account in backticks and
 * whose last cell is the code hash in backticks. verify.sh records no hash of its own: it builds the wasm and compares
 * its sha256 with the chain, so this table is the only place the repository writes the hashes down.
 */
export function parseRecordedHashes(markdown: string): { heading: string | null; rows: RecordedHash[] } {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^##\s+The expected hashes/i.test(l));
  if (start < 0) return { heading: null, rows: [] };
  const rows: RecordedHash[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const account = /`([^`]+)`/.exec(cells[0] ?? "")?.[1];
    const hash = /^`([^`]+)`$/.exec(cells[cells.length - 1] ?? "")?.[1];
    if (account === undefined || hash === undefined || !isAccountId(account) || !BASE58_HASH.test(hash))
      continue;
    const size = cells.find((c) => /^[\d,]+$/.test(c));
    rows.push({ account_id: account, hash, size: size ? Number(size.replaceAll(",", "")) : null });
  }
  return { heading: lines[start]?.replace(/^##\s+/, "") ?? null, rows };
}

export function readRecordedHashes(file = RECORDED_HASHES_FILE): RecordedHashes | null {
  if (!existsSync(file)) return null;
  return { file: RECORDED_HASHES_NAME, ...parseRecordedHashes(readFileSync(file, "utf8")) };
}

// ---------------------------------------------------------------- the scan

export type Mark = "ok" | "warn" | "fail";

export interface KeyLine {
  public_key: string;
  kind: AccessKey["kind"];
  gas_key: boolean;
  receiver_id: string | null;
  method_names: string[];
  allowance: string | null;
  /** In plain words (key-scope.ts's describeKey). */
  key: string;
}

export interface CanChange {
  /** Full-access keys (gas keys included): their holders can deploy code, add or delete keys, delete the account. */
  full_access_keys: number;
  /** Keys whose permission this scan does not know: counted as able to. */
  unknown_keys: number;
  /** Function-call keys for the account's own contract: they call its methods as the account itself. */
  own_function_call_keys: number;
  /** The control host functions the code imports: a path that uses them cannot be ruled out. */
  code: string[];
  /** The code could not be read as WebAssembly: no path can be ruled out. */
  code_unread: boolean;
  /** The account whose global contract this account's code follows: it can replace the code. */
  global_owner: string | null;
  /** True when none of the above can change the code or the keys. */
  nobody: boolean;
}

export interface AccountScan {
  account_id: string;
  label: string | null;
  block_height: number | null;
  balance_yocto: string;
  locked_yocto: string;
  storage_usage: number;
  /** NEAR keeps balance + locked ≥ storage_usage × price (nearcore verifier.rs check_storage_stake). */
  storage: { cost_yocto: string; free_yocto: string; room_bytes: number } | null;
  code: {
    hash: string;
    deployed: boolean;
    global_contract_hash: string | null;
    global_contract_account_id: string | null;
    /** Length of the code `view_code` returned; null when not read. */
    bytes: number | null;
    /** sha256 of those bytes, base58: NEAR's code hash. */
    sha256: string | null;
    /** The bytes hash to the account's code_hash (and to view_code's own `hash`). */
    matches_code_hash: boolean | null;
  };
  imports: ImportSummary | null;
  keys: { total: number; full_access: number; function_call: number; unknown: number; list: KeyLine[] };
  recorded: { hash: string | null; size: number | null; same: boolean | null; note: string };
  can_change: CanChange;
  verdict: string;
  status: Mark;
  /** What failed: the status is "fail". */
  problems: string[];
  /** What to say next to the verdict: the status is at least "warn". */
  caveats: string[];
}

export interface ContractScanReport {
  tool: "contract-scan";
  checked_at: string;
  network: string | null;
  rpc: string;
  sources: readonly string[];
  control_host_functions: string[];
  recorded_hashes: { file: string; heading: string | null; rows: number } | null;
  storage_price_per_byte_yocto: string | null;
  accounts: AccountScan[];
  /** Accounts of the default list that hold no contract (not scanned further). */
  skipped: { account_id: string; label: string | null; reason: string }[];
  /** Accounts whose reads failed. */
  failed: { account_id: string; label: string | null; error: string }[];
  /** Counts over the accounts scanned (`contracts` of them hold code). */
  summary: {
    accounts: number;
    contracts: number;
    nobody_can_change: number;
    changeable_by_keys: number;
    code_path_not_ruled_out: number;
    recorded_same: number;
    recorded_different: number;
    not_recorded: number;
    ok: boolean;
  };
}

const short = (name: string): string => name.replace(/^promise_batch_action_/, "");
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The verdict in plain words, from what can change the account (see the top of this file). */
export function verdictOf(c: CanChange, hasCode: boolean): string {
  const total = CONTROL_HOST_FUNCTIONS.length;
  if (c.nobody)
    return hasCode
      ? "0 full-access keys and no code path that deploys code, changes keys or deletes the account: nobody can change it"
      : "no code and 0 full-access keys: nobody can deploy code to it or change its keys";
  const parts: string[] = [];
  if (c.full_access_keys > 0)
    parts.push(
      `${plural(c.full_access_keys, "full-access key")}: the holder can change it (deploy new code, add or delete keys, delete the account)`,
    );
  if (c.unknown_keys > 0)
    parts.push(
      `${plural(c.unknown_keys, "key")} with a permission this scan does not know: it may be able to`,
    );
  if (c.global_owner !== null)
    parts.push(
      `its code is the global contract published by ${c.global_owner}, which that account can replace`,
    );
  if (c.code_unread) {
    parts.push("its code could not be read, so this scan cannot rule out a code path that changes it");
  } else if (c.code.length > 0) {
    const which = c.code.length === total ? `all ${total}` : `${c.code.length} of the ${total}`;
    parts.push(
      `${c.full_access_keys > 0 ? "its code also imports" : "0 full-access keys, but its code imports"} ${which} host functions that can deploy code, change keys or delete the account, so this scan cannot rule out a code path that does`,
    );
  } else if (hasCode) {
    parts.push("its code has no path that can (it imports none of the host functions that do)");
  }
  if (c.own_function_call_keys > 0)
    parts.push(
      `${plural(c.own_function_call_keys, "function-call key")} for its own contract: the holder can call its methods as the account itself`,
    );
  return parts.join("; ");
}

function keyLine(k: AccessKey): KeyLine {
  return {
    public_key: k.public_key,
    kind: k.kind,
    gas_key: k.gas_key,
    receiver_id: k.receiver_id,
    method_names: k.method_names,
    allowance: k.allowance,
    key: describeKey(k),
  };
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string") throw new Error(`view_account: ${k} is not a string`);
  return v;
}

/** One account: its state, keys and code, judged. */
export async function scanAccount(
  r: RpcReader,
  target: Target,
  ctx: { recorded: RecordedHashes | null; pricePerByte: bigint | null },
): Promise<AccountScan> {
  const id = target.account_id;
  const acc = await queryFinal(r, { request_type: "view_account", account_id: id });
  const codeHash = str(acc, "code_hash");
  const globalHash = typeof acc.global_contract_hash === "string" ? acc.global_contract_hash : null;
  const globalOwner =
    typeof acc.global_contract_account_id === "string" ? acc.global_contract_account_id : null;
  const amount = BigInt(str(acc, "amount"));
  const locked = BigInt(str(acc, "locked"));
  const usage = typeof acc.storage_usage === "number" ? acc.storage_usage : Number.NaN;
  if (!Number.isSafeInteger(usage)) throw new Error("view_account: storage_usage is not a whole number");
  const keys = await readAccessKeys(keyReader(r), id);
  const problems: string[] = [];

  const deployed = codeHash !== NO_CODE_HASH || globalHash !== null || globalOwner !== null;
  let bytes: Buffer | null = null;
  let matches: boolean | null = null;
  let sha: string | null = null;
  let imports: ImportSummary | null = null;
  if (deployed) {
    const code = await queryFinal(r, { request_type: "view_code", account_id: id });
    if (typeof code.code_base64 !== "string") throw new Error("view_code: no code_base64");
    bytes = Buffer.from(code.code_base64, "base64");
    sha = baseEncode(createHash("sha256").update(bytes).digest());
    // An account on a global contract has no local code hash (near-primitives AccountView): compare with the global
    // one when it is fixed by hash; one that follows an account has no hash to compare with.
    const expected = codeHash !== NO_CODE_HASH ? codeHash : globalHash;
    matches = expected !== null ? sha === expected && code.hash === expected : null;
    if (matches === false)
      problems.push(
        `the code view_code returned hashes to ${sha}, not the account's code hash ${expected}: the reply is not that code`,
      );
    try {
      imports = summarizeImports(readImports(bytes));
    } catch (e) {
      problems.push(
        `the code could not be read as WebAssembly: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // The hash of the code that runs: the local one, else the global contract's, else that of the code read.
  const running = codeHash !== NO_CODE_HASH ? codeHash : (globalHash ?? sha ?? codeHash);
  const row = ctx.recorded?.rows.find((x) => x.account_id === id) ?? null;
  let recorded: AccountScan["recorded"];
  if (ctx.recorded === null)
    recorded = {
      hash: null,
      size: null,
      same: null,
      note: `${RECORDED_HASHES_NAME} is not here (it is not in the runner's Docker image): not compared`,
    };
  else if (row === null)
    recorded = {
      hash: null,
      size: null,
      same: null,
      note: `the repository records no hash for this account (${ctx.recorded.file})`,
    };
  else {
    const same = row.hash === running;
    recorded = {
      hash: row.hash,
      size: row.size,
      same,
      note: same
        ? `the same hash as ${ctx.recorded.file} records (${ctx.recorded.heading ?? "its table"}): the code on chain is that build`
        : `${ctx.recorded.file} records ${row.hash} (${ctx.recorded.heading ?? "its table"}), but the code on chain is ${running}`,
    };
    if (!same) problems.push(recorded.note);
  }

  const full = keys.filter((k) => k.kind === "full-access").length;
  const unknown = keys.filter((k) => k.kind === "unknown").length;
  const ownFc = keys.filter((k) => k.kind === "function-call" && k.receiver_id === id).length;
  const code = imports?.control.map((f) => f.name) ?? [];
  const unread = deployed && imports === null;
  const canChange: CanChange = {
    full_access_keys: full,
    unknown_keys: unknown,
    own_function_call_keys: ownFc,
    code,
    code_unread: unread,
    global_owner: globalOwner,
    nobody: full === 0 && unknown === 0 && code.length === 0 && !unread && globalOwner === null,
  };
  const caveats: string[] = [];
  if (deployed && recorded.same === null) caveats.push(`not tied to the source: ${recorded.note}`);

  let storage: AccountScan["storage"] = null;
  if (ctx.pricePerByte !== null) {
    const cost = BigInt(usage) * ctx.pricePerByte;
    const free = amount + locked - cost;
    storage = {
      cost_yocto: cost.toString(),
      free_yocto: free.toString(),
      room_bytes: free > 0n && ctx.pricePerByte > 0n ? Number(free / ctx.pricePerByte) : 0,
    };
  }

  return {
    account_id: id,
    label: target.label,
    block_height: typeof acc.block_height === "number" ? acc.block_height : null,
    balance_yocto: amount.toString(),
    locked_yocto: locked.toString(),
    storage_usage: usage,
    storage,
    code: {
      hash: codeHash,
      deployed,
      global_contract_hash: globalHash,
      global_contract_account_id: globalOwner,
      bytes: bytes?.length ?? null,
      sha256: sha,
      matches_code_hash: matches,
    },
    imports,
    keys: {
      total: keys.length,
      full_access: full,
      function_call: keys.filter((k) => k.kind === "function-call").length,
      unknown,
      list: keys.map(keyLine),
    },
    recorded,
    can_change: canChange,
    verdict: verdictOf(canChange, deployed),
    status: problems.length > 0 ? "fail" : !canChange.nobody || caveats.length > 0 ? "warn" : "ok",
    problems,
    caveats,
  };
}

/** The chain id and the storage price per byte (EXPERIMENTAL_protocol_config); nulls when it cannot be read. */
export async function protocolFacts(
  r: RpcReader,
): Promise<{ chainId: string | null; pricePerByte: bigint | null }> {
  try {
    const a = await rpcCall(
      r.urls,
      "EXPERIMENTAL_protocol_config",
      { finality: "final" },
      r.fetchFn,
      r.record,
    );
    const res = isRecord(a.result) ? a.result : {};
    const price = isRecord(res.runtime_config) ? res.runtime_config.storage_amount_per_byte : undefined;
    return {
      chainId: typeof res.chain_id === "string" ? res.chain_id : null,
      pricePerByte: typeof price === "string" && /^\d+$/.test(price) ? BigInt(price) : null,
    };
  } catch {
    return { chainId: null, pricePerByte: null };
  }
}

/**
 * Scans every target. With `skipNonContracts` (the default list), an account with no code is listed as skipped. An
 * account whose reads fail is listed as failed; the others go on.
 */
export async function scanContracts(
  r: RpcReader,
  targets: readonly Target[],
  opts: { recorded: RecordedHashes | null; skipNonContracts: boolean; now: () => Date; network?: string },
): Promise<ContractScanReport> {
  const checkedAt = opts.now().toISOString();
  const { chainId, pricePerByte } = await protocolFacts(r);
  // Stop before reading any account when the RPC serves another network.
  if (opts.network !== undefined && chainId !== opts.network)
    throw new Error(`${r.urls[0]} is ${chainId ?? "not answering"}, not ${opts.network}`);
  const accounts: AccountScan[] = [];
  const skipped: ContractScanReport["skipped"] = [];
  const failed: ContractScanReport["failed"] = [];
  for (const t of targets) {
    try {
      const s = await scanAccount(r, t, { recorded: opts.recorded, pricePerByte });
      if (opts.skipNonContracts && !s.code.deployed)
        skipped.push({ account_id: t.account_id, label: t.label, reason: "no contract code deployed" });
      else accounts.push(s);
    } catch (e) {
      failed.push({
        account_id: t.account_id,
        label: t.label,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const contracts = accounts.filter((a) => a.code.deployed);
  return {
    tool: "contract-scan",
    checked_at: checkedAt,
    network: chainId,
    rpc: r.urls[0] ?? "",
    sources: SOURCES,
    control_host_functions: CONTROL_HOST_FUNCTIONS.map((f) => f.name),
    recorded_hashes:
      opts.recorded === null
        ? null
        : { file: opts.recorded.file, heading: opts.recorded.heading, rows: opts.recorded.rows.length },
    storage_price_per_byte_yocto: pricePerByte?.toString() ?? null,
    accounts,
    skipped,
    failed,
    summary: {
      accounts: accounts.length,
      contracts: contracts.length,
      nobody_can_change: accounts.filter((a) => a.can_change.nobody).length,
      changeable_by_keys: accounts.filter((a) => a.can_change.full_access_keys > 0).length,
      code_path_not_ruled_out: accounts.filter((a) => a.can_change.code.length > 0).length,
      recorded_same: accounts.filter((a) => a.recorded.same === true).length,
      recorded_different: accounts.filter((a) => a.recorded.same === false).length,
      not_recorded: contracts.filter((a) => a.recorded.same === null).length,
      ok: failed.length === 0 && accounts.every((a) => a.status !== "fail"),
    },
  };
}

// ---------------------------------------------------------------- text

const grouped = (n: number): string => n.toLocaleString("en-US");

/** The scan as plain lines, one block per account, then a summary. */
export function renderScan(rep: ContractScanReport): string[] {
  const out = [
    `contract scan, ${rep.checked_at}, ${rep.network ?? "network unknown"} (${rep.rpc}). Read-only: no key, nothing sent.`,
  ];
  for (const a of rep.accounts) {
    out.push("", `${a.account_id}${a.label ? ` (${a.label})` : ""}`);
    const c = a.code;
    if (!c.deployed) out.push("  code       none deployed");
    else
      out.push(
        `  code       ${c.hash}${c.bytes === null ? "" : `, ${grouped(c.bytes)} bytes`}${c.matches_code_hash === false ? "; the bytes read do NOT hash to it" : c.matches_code_hash ? "; the bytes read hash to it" : ""}${c.global_contract_account_id ? `; global contract of ${c.global_contract_account_id}` : ""}${c.global_contract_hash ? `; global contract ${c.global_contract_hash}` : ""}`,
      );
    out.push(
      `  recorded   ${a.recorded.same === true ? "SAME: " : a.recorded.same === false ? "DIFFERENT: " : ""}${a.recorded.note}`,
    );
    const st = a.storage;
    out.push(
      `  storage    ${grouped(a.storage_usage)} bytes${st ? ` (${formatNear(BigInt(st.cost_yocto))} held for it)` : ""}; balance ${formatNear(BigInt(a.balance_yocto))}${st ? `: ${formatNear(BigInt(st.free_yocto))} free, room for about ${grouped(st.room_bytes)} more bytes` : ""}`,
    );
    out.push(
      `  keys       ${a.keys.total === 0 ? "none" : a.keys.list.map((k) => `${k.public_key}: ${k.key}`).join("; ")}`,
    );
    if (a.imports !== null) {
      const ctl = a.imports.control.map((f) => f.name);
      const rest = a.imports.host_functions.filter((n) => !ctl.includes(n));
      out.push(
        `  imports    ${a.imports.host_functions.length} NEAR host functions; ${ctl.length} of the ${CONTROL_HOST_FUNCTIONS.length} that can change control${ctl.length > 0 ? `: ${ctl.map(short).join(", ")}` : ""}`,
        `             the others: ${rest.map(short).join(", ") || "none"}`,
      );
      if (a.imports.other_imports.length > 0)
        out.push(`             not host functions: ${a.imports.other_imports.join(", ")}`);
    }
    for (const p of a.problems) out.push(`  PROBLEM    ${p}`);
    out.push(`  verdict    ${a.verdict}`);
  }
  for (const s of rep.skipped)
    out.push("", `${s.account_id}${s.label ? ` (${s.label})` : ""}: skipped, ${s.reason}`);
  for (const f of rep.failed)
    out.push("", `${f.account_id}${f.label ? ` (${f.label})` : ""}: FAILED: ${f.error}`);
  const s = rep.summary;
  out.push(
    "",
    `SUMMARY  ${s.accounts} account(s) scanned, ${s.contracts} with a contract: ${s.nobody_can_change} nobody can change, ${s.changeable_by_keys} changeable by a full-access key, ${s.code_path_not_ruled_out} whose code imports control host functions; code hash ${s.recorded_same} same as recorded, ${s.recorded_different} different, ${s.not_recorded} not recorded${rep.failed.length > 0 ? `; ${rep.failed.length} could not be read` : ""}`,
  );
  return out;
}
