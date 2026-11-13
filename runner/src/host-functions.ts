import type { WasmImport } from "./wasm-imports.ts";

/**
 * The NEAR host functions a contract can import, sorted by what they can do to an account. NEAR provides every host
 * function in the import module "env". The names below are exactly those of:
 * - nearcore, `runtime/near-vm-runner/src/imports.rs` (crate near-vm-runner 0.38.1, the version in the owner's
 *   Cargo.lock), the list of host functions the runtime links into a contract;
 * - near-sdk-rs, `near-sys/src/lib.rs` (crate near-sys 0.4.1, in the same Cargo.lock), their declarations for contracts.
 * Both read on 2026-11-13.
 *
 * Why these can change who controls an account or its code, and nothing else can (besides its own keys): nearcore's
 * `check_actor_permissions` (runtime/runtime/src/actions.rs, master, read 2026-11-13) refuses DeployContract, AddKey,
 * DeleteKey, DeleteAccount, DeployGlobalContract, UseGlobalContract (and Stake, WithdrawFromGasKey) with
 * ActorNoPermission unless the account itself is the actor (near-primitives 0.38.1, src/errors.rs, says the same of
 * ActorNoPermission). The account acts either through a transaction signed with one of its keys or through its own
 * contract code, and the code can only add those actions to a receipt through the host functions below. A
 * function-call key cannot either: its transaction must be exactly one FunctionCall with no deposit
 * (`verify_function_call_permission`, runtime/runtime/src/verifier.rs, master, read 2026-11-13).
 */
export const HOST_MODULE = "env";

export type Power = "code" | "keys" | "account" | "global contract";

export interface HostFunction {
  name: string;
  power: Power;
  /** What it does, in plain words. */
  does: string;
}

/** The host functions that can change who controls an account or its code. */
export const CONTROL_HOST_FUNCTIONS: readonly HostFunction[] = [
  { name: "promise_batch_action_deploy_contract", power: "code", does: "deploys new code" },
  {
    name: "promise_batch_action_add_key_with_full_access",
    power: "keys",
    does: "adds a full-access key",
  },
  {
    name: "promise_batch_action_add_key_with_function_call",
    power: "keys",
    does: "adds a function-call key",
  },
  {
    name: "promise_batch_action_add_gas_key_with_full_access",
    power: "keys",
    does: "adds a full-access gas key",
  },
  {
    name: "promise_batch_action_add_gas_key_with_function_call",
    power: "keys",
    does: "adds a function-call gas key",
  },
  { name: "promise_batch_action_delete_key", power: "keys", does: "deletes a key" },
  { name: "promise_batch_action_delete_account", power: "account", does: "deletes the account" },
  {
    name: "promise_batch_action_deploy_global_contract",
    power: "global contract",
    does: "publishes code as a global contract, fixed by its hash",
  },
  {
    name: "promise_batch_action_deploy_global_contract_by_account_id",
    power: "global contract",
    does: "publishes code as a global contract that follows this account (it can be replaced later)",
  },
  {
    name: "promise_batch_action_use_global_contract",
    power: "global contract",
    does: "replaces the account's code with a global contract, by hash",
  },
  {
    name: "promise_batch_action_use_global_contract_by_account_id",
    power: "global contract",
    does: "replaces the account's code with the global contract another account publishes, and follows its updates",
  },
];

/**
 * Other actions a contract can put in a receipt. Listed, not flagged: none changes the account's code or keys.
 * The state-init ones set up a new account (nearcore's actions.rs: on an existing account "nothing happens").
 */
export const OTHER_ACTION_HOST_FUNCTIONS: readonly { name: string; does: string }[] = [
  { name: "promise_batch_action_create_account", does: "creates a new sub-account" },
  { name: "promise_batch_action_function_call", does: "calls a contract" },
  { name: "promise_batch_action_function_call_weight", does: "calls a contract" },
  { name: "promise_batch_action_transfer", does: "sends NEAR" },
  { name: "promise_batch_action_stake", does: "stakes NEAR" },
  { name: "promise_batch_action_transfer_to_gas_key", does: "funds a gas key" },
  { name: "promise_batch_action_state_init", does: "sets up a new deterministic account" },
  { name: "promise_batch_action_state_init_by_account_id", does: "sets up a new deterministic account" },
  { name: "promise_batch_action_universal_state_init", does: "sets up a new universal account" },
];

/** Where the facts above come from, for the report. */
export const SOURCES: readonly string[] = [
  "host function names: nearcore runtime/near-vm-runner/src/imports.rs (crate near-vm-runner 0.38.1) and near-sdk-rs near-sys/src/lib.rs (crate near-sys 0.4.1), both in the owner's Cargo.lock; read 2026-11-13",
  "only the account itself may deploy code, add or delete keys, delete itself or use a global contract: nearcore runtime/runtime/src/actions.rs check_actor_permissions (master, read 2026-11-13); near-primitives 0.38.1 src/errors.rs ActorNoPermission",
  "a function-call key signs exactly one FunctionCall with no deposit: nearcore runtime/runtime/src/verifier.rs verify_function_call_permission (master, read 2026-11-13)",
  "near-sdk 5.30.1 links every action host function into any contract that uses its Promise type (as cross-contract calls do): src/promise.rs PromiseAction::add handles every kind of action in one function",
  "global contracts in view_account: near-primitives 0.38.1 src/views.rs AccountView (global_contract_hash, global_contract_account_id)",
];

export interface ImportSummary {
  /** NEAR host functions imported (module "env", functions), in the module's order. */
  host_functions: string[];
  /** Of those, the ones that can change who controls the account or its code. */
  control: HostFunction[];
  /** Other actions the code can send. */
  other_actions: string[];
  /** Imports that are not NEAR host functions (another module, or not a function). */
  other_imports: string[];
}

const OTHER_ACTIONS = new Set(OTHER_ACTION_HOST_FUNCTIONS.map((f) => f.name));

/** Sorts a module's imports into the groups above. */
export function summarizeImports(imports: readonly WasmImport[]): ImportSummary {
  const host = imports.filter((i) => i.module === HOST_MODULE && i.kind === "func").map((i) => i.name);
  return {
    host_functions: host,
    control: CONTROL_HOST_FUNCTIONS.filter((f) => host.includes(f.name)),
    other_actions: host.filter((n) => OTHER_ACTIONS.has(n)),
    other_imports: imports
      .filter((i) => i.module !== HOST_MODULE || i.kind !== "func")
      .map((i) => `${i.module}.${i.name} (${i.kind})`),
  };
}
