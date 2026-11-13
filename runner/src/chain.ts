import type { Account, JsonRpcProvider } from "near-api-js";
import {
  type ChainVerdict,
  type Constants,
  type Position,
  type Pot,
  type RankState,
  type Round,
  type Rulebook,
  readConstants,
  readOutbox,
  readPositions,
  readPot,
  readRankState,
  readRound,
  readRulebook,
  readSignedAction,
  readVerdict,
  type SignedAction,
} from "./contract.ts";
import { isRecord } from "./json.ts";
import { call, view } from "./near.ts";

/**
 * The program on NEAR, as the runner sees it: the views of 01 §8 it reads and the calls of 01 §9.3 it makes.
 * `NearChain` is the real one. Tests use an in-memory double (test/support/fake-chain.ts), which no command of the
 * runner can select.
 */
export interface Chain {
  readonly contractId: string;
  constants(): Promise<Constants>;
  rank(): Promise<RankState>;
  round(): Promise<Round>;
  rulebook(): Promise<Rulebook>;
  pot(): Promise<Pot>;
  positions(roundId: number): Promise<Position[]>;
  /** Every signed action in the outbox, oldest first. */
  outbox(): Promise<SignedAction[]>;
  propose(p: ProposalArgs): Promise<Sent<ChainVerdict>>;
  /**
   * 01 1.3 §9.6: keeps the Intern's slice idle and lends the rest to the lender (a STAND-IN on testnet), or brings
   * money back. Anyone may call it; the runner does once each round, before proposing. The value is the dollars
   * moved as the program returned them (negative when brought back).
   */
  rebalance(): Promise<Sent<string>>;
  /**
   * 01 1.7: whether `rebalance` would move anything now (`get_rebalance`, a free view): false for "NONE", "BUSY" or
   * "NO_LENDER". Optional: a chain without it (or an older contract) makes the runner call `rebalance` as before.
   */
  rebalanceDue?(): Promise<boolean>;
  /**
   * 01 1.7: the drawdown brake from `get_auto` (`brake_until` when it is on, else null). Optional: without it (or on
   * an older contract) the runner assumes no brake.
   */
  brake?(): Promise<number | null>;
  /**
   * 01 1.4 §9.7: settles the streak jackpots of closed rounds and holds a payday draw that is due. Anyone may call
   * it; the runner does once each round, after rebalance (relayer).
   */
  rewardsTick(): Promise<Sent<unknown>>;
  /**
   * 01 1.7: the drand round a payday draw is waiting for (`get_drand` in state WAITING with no randomness yet), or
   * null. Optional: a chain without it (or an older contract) skips drand.
   */
  drandWaiting?(): Promise<number | null>;
  /** 01 1.7: hands drand quicknet's beacon for `round` to `submit_drand` (relayer); the program verifies it. */
  submitDrand?(round: number, signature: string): Promise<Sent<string>>;
  /** The signed action, or null when NEAR's signing network failed this time: call again (Engine 1's note, 1.2). */
  signNext(positionId: number, pxE8: bigint): Promise<Sent<SignedAction | null>>;
  close(positionId: number, pxE8: bigint): Promise<Sent<SignedAction | null>>;
  reportResult(positionId: number, returnedE6: bigint): Promise<Sent<null>>;
  settle(roundId: number): Promise<Sent<unknown>>;
}

/** 01 §6.3: the exact bytes, each sent as base64. */
export interface ProposalArgs {
  request: Uint8Array;
  response: Uint8Array;
  signature: Uint8Array;
  /**
   * 01 1.3 §9.5: the account of the website visitor whose message the runner used (the trick page). Sent only when
   * set. The program cannot check it; the first credited refusal of each code decides that code's sticker.
   */
  credited_to?: string;
}

export interface Sent<T> {
  txHash: string;
  value: T;
  /** Gas burnt, in TGas, as measured from the outcome; null when not known. */
  tgas: number | null;
}

/**
 * Gas attached to each call, in TGas. 01 gives none. UNVERIFIED: every call logs the gas it really burnt (`tgas`),
 * so the first run on the stub measures it. `sign_next` and `close` ask NEAR's signing network, which the research
 * called with 300 TGas (it burnt about 14).
 */
export const TERA_GAS = {
  propose: 300,
  sign_next: 300,
  close: 300,
  report_result: 30,
  settle: 100,
  /** 01 1.3 §9.6 and Engine 1's note: attach 300 TGas (it may call the lender). */
  rebalance: 300,
  /** 01 1.4: a due draw walks the entrants (at most 200). */
  rewards_tick: 150,
  /** 01 1.7: one BLS pairing check (NEAR's host functions); burnt 12.1 in the sandbox. */
  submit_drand: 30,
} as const;

/**
 * How `px_e8` is written in the arguments of `sign_next` and `close`: a decimal string, like `sz_e8` (01 1.2 §9.3;
 * the program also accepts a JSON number).
 */
export const PX_E8_JSON: "string" | "number" = "string";

export function pxArg(pxE8: bigint, form: "string" | "number" = PX_E8_JSON): string | number {
  if (pxE8 <= 0n) throw new Error(`px_e8 must be positive, got ${pxE8}`);
  if (form === "string") return pxE8.toString();
  if (pxE8 > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`px_e8 ${pxE8} is too big for a JSON number`);
  return Number(pxE8);
}

const OUTBOX_PAGE = 100; // 01 §8: `limit` is capped at 100

/** `sign_next` and `close` return the signed action, or null when the signing network failed (Engine 1's note). */
function signedOrNull(v: unknown, method: string): SignedAction | null {
  return v === null || v === undefined ? null : readSignedAction(v, method);
}

export class NearChain implements Chain {
  readonly contractId: string;
  readonly #rpc: JsonRpcProvider;
  readonly #runner: Account | null;
  readonly #relayer: Account | null;

  /**
   * `runner` signs `propose`, `sign_next` and `report_result` with its function-call key (01 1.1: `sign_next` is
   * runner-only and needs no deposit). `relayer` signs `close`, which attaches 1 yocto, and `settle`. Either may be
   * null for a command that does not need it.
   */
  constructor(rpc: JsonRpcProvider, contractId: string, runner: Account | null, relayer: Account | null) {
    this.#rpc = rpc;
    this.contractId = contractId;
    this.#runner = runner;
    this.#relayer = relayer;
  }

  #view(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return view(this.#rpc, this.contractId, method, args);
  }

  #as(who: "runner" | "relayer"): Account {
    const account = who === "runner" ? this.#runner : this.#relayer;
    if (account === null) {
      const env =
        who === "runner"
          ? "RUNNER_ACCOUNT_ID and RUNNER_PRIVATE_KEY"
          : "RELAYER_ACCOUNT_ID and RELAYER_PRIVATE_KEY";
      throw new Error(`this step needs the ${who} account: set ${env}`);
    }
    return account;
  }

  async constants(): Promise<Constants> {
    return readConstants(await this.#view("get_constants"));
  }
  async rank(): Promise<RankState> {
    return readRankState(await this.#view("get_rank"));
  }
  async round(): Promise<Round> {
    return readRound(await this.#view("get_round"));
  }
  async rulebook(): Promise<Rulebook> {
    return readRulebook(await this.#view("get_rulebook"));
  }
  async pot(): Promise<Pot> {
    return readPot(await this.#view("get_pot"));
  }
  async positions(roundId: number): Promise<Position[]> {
    return readPositions(await this.#view("get_positions", { round_id: roundId }));
  }
  async outbox(): Promise<SignedAction[]> {
    const all: SignedAction[] = [];
    for (let afterId: number | undefined; ; ) {
      const args: Record<string, unknown> = { limit: OUTBOX_PAGE };
      if (afterId !== undefined) args.after_id = afterId;
      const page = readOutbox(await this.#view("get_outbox", args));
      for (const a of page) {
        if (afterId !== undefined && a.id <= afterId) throw new Error("get_outbox: ids do not go up");
        all.push(a);
        afterId = a.id;
      }
      if (page.length < OUTBOX_PAGE) return all;
    }
  }

  async propose(p: ProposalArgs): Promise<Sent<ChainVerdict>> {
    const args: Record<string, string> = {
      request: Buffer.from(p.request).toString("base64"),
      response: Buffer.from(p.response).toString("base64"),
      signature: Buffer.from(p.signature).toString("base64"),
    };
    if (p.credited_to !== undefined) args.credited_to = p.credited_to;
    const r = await call(this.#as("runner"), this.contractId, "propose", args, { teraGas: TERA_GAS.propose });
    return { txHash: r.txHash, value: readVerdict(r.value), tgas: r.tgas };
  }
  /** Sent by the relayer, like rebalance. */
  async brake(): Promise<number | null> {
    const v = await this.#view("get_auto");
    if (!isRecord(v)) throw new Error("get_auto: not an object");
    return v.brake_on === true && typeof v.brake_until === "number" ? v.brake_until : null;
  }
  async rebalanceDue(): Promise<boolean> {
    const v = await this.#view("get_rebalance");
    const action = isRecord(v) && typeof v.action === "string" ? v.action : null;
    if (action === null) throw new Error("get_rebalance: no action");
    return action === "LEND" || action === "RECALL";
  }
  async rewardsTick(): Promise<Sent<unknown>> {
    const r = await call(
      this.#as("relayer"),
      this.contractId,
      "rewards_tick",
      {},
      { teraGas: TERA_GAS.rewards_tick },
    );
    return { txHash: r.txHash, value: r.value, tgas: r.tgas };
  }
  async drandWaiting(): Promise<number | null> {
    const v = await this.#view("get_drand", {});
    if (!isRecord(v)) throw new Error("get_drand: not an object");
    return v.state === "WAITING" && v.randomness === null && typeof v.drand_round === "number"
      ? v.drand_round
      : null;
  }
  /** Sent by the relayer, like rewards_tick: anyone may submit a beacon. */
  async submitDrand(round: number, signature: string): Promise<Sent<string>> {
    const r = await call(
      this.#as("relayer"),
      this.contractId,
      "submit_drand",
      { round, signature },
      { teraGas: TERA_GAS.submit_drand },
    );
    return { txHash: r.txHash, value: typeof r.value === "string" ? r.value : String(r.value), tgas: r.tgas };
  }
  /** Sent by the relayer: anyone may call `rebalance`, and the runner's key stays limited to its three calls. */
  async rebalance(): Promise<Sent<string>> {
    const r = await call(
      this.#as("relayer"),
      this.contractId,
      "rebalance",
      {},
      { teraGas: TERA_GAS.rebalance },
    );
    const v = r.value;
    return {
      txHash: r.txHash,
      value: typeof v === "string" ? v : typeof v === "number" ? String(v) : JSON.stringify(v ?? null),
      tgas: r.tgas,
    };
  }
  async signNext(positionId: number, pxE8: bigint): Promise<Sent<SignedAction | null>> {
    const args = { position_id: positionId, px_e8: pxArg(pxE8) };
    const r = await call(this.#as("runner"), this.contractId, "sign_next", args, {
      teraGas: TERA_GAS.sign_next,
    });
    return { txHash: r.txHash, value: signedOrNull(r.value, "sign_next"), tgas: r.tgas };
  }
  async close(positionId: number, pxE8: bigint): Promise<Sent<SignedAction | null>> {
    const args = { position_id: positionId, px_e8: pxArg(pxE8) };
    const r = await call(this.#as("relayer"), this.contractId, "close", args, {
      teraGas: TERA_GAS.close,
      yoctoDeposit: 1n,
    });
    return { txHash: r.txHash, value: signedOrNull(r.value, "close"), tgas: r.tgas };
  }
  async reportResult(positionId: number, returnedE6: bigint): Promise<Sent<null>> {
    if (returnedE6 < 0n) throw new Error("returned cannot be negative");
    const args = { position_id: positionId, returned: returnedE6.toString() };
    const r = await call(this.#as("runner"), this.contractId, "report_result", args, {
      teraGas: TERA_GAS.report_result,
    });
    return { txHash: r.txHash, value: null, tgas: r.tgas };
  }
  async settle(roundId: number): Promise<Sent<unknown>> {
    const r = await call(
      this.#as("relayer"),
      this.contractId,
      "settle",
      { round_id: roundId },
      {
        teraGas: TERA_GAS.settle,
      },
    );
    return { txHash: r.txHash, value: r.value ?? null, tgas: r.tgas };
  }
}
