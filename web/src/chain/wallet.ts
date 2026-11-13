/**
 * Signing in with a real NEAR wallet, and sending the visitor's actions through it.
 * Uses @hot-labs/near-connect 0.12.0, the connector NEAR's docs describe. Calls used, all from
 * its type definitions: new NearConnector({ network }), on("wallet:signIn" | "wallet:signOut"),
 * connect(), disconnect(), getConnectedWallet(), wallet.signAndSendTransaction({ receiverId, actions }).
 *
 * NOT YET TRIED WITH A REAL WALLET: there is no deployed contract that accepts these calls for
 * real, and a wallet cannot be driven from an automated browser. Treat as written-to-spec.
 */
import type { NearConnector } from "@hot-labs/near-connect";
import deployments from "../../../interface/deployments.json";
import { view } from "./near";
import type { Actions, Constants, Pool, RefusalCode, VoteKind } from "./types";

const TGAS = "000000000000";
const GAS = `30${TGAS}`;
const GAS_TRANSFER_CALL = `100${TGAS}`;
/** Cash-out and the dial may first have to bring money back from the lender (interface 1.3, section 9.6). */
const GAS_MAX = `300${TGAS}`;
const NEAR_0_05 = "50000000000000000000000";
const NEAR_0_02 = "20000000000000000000000";
const ONE_YOCTO = "1";

type Call = { method: string; args: object; gas?: string; deposit?: string };

let connector: NearConnector | null = null;

/** The connector is only downloaded when someone actually signs in. */
async function getConnector(onChange: (accountId: string | null) => void): Promise<NearConnector> {
  if (connector) return connector;
  const { NearConnector } = await import("@hot-labs/near-connect");
  connector = new NearConnector({ network: "testnet" });
  connector.on("wallet:signIn", (t) => onChange(t.accounts[0]?.accountId ?? null));
  connector.on("wallet:signOut", () => onChange(null));
  return connector;
}

/** If the visitor signed in on an earlier visit, pick that up without asking again. */
export async function restoreWallet(onChange: (accountId: string | null) => void): Promise<void> {
  try {
    const c = await getConnector(onChange);
    const { accounts } = await c.getConnectedWallet();
    onChange(accounts[0]?.accountId ?? null);
  } catch {
    onChange(null);
  }
}

export async function walletSignIn(onChange: (accountId: string | null) => void): Promise<void> {
  const c = await getConnector(onChange);
  await c.connect();
}

export async function walletSignOut(): Promise<void> {
  await connector?.disconnect();
}

/**
 * A signed message (NEP-413): free, sends no transaction. Used to prove who wrote a trick.
 * near-connect 0.12.0 returns { accountId, publicKey, signature }.
 */
export async function walletSignMessage(message: string, recipient: string, nonce: Uint8Array): Promise<{ accountId: string; publicKey: string; signature: string }> {
  if (!connector) throw new Error("Sign in first.");
  const wallet = await connector.wallet();
  return wallet.signMessage({ message, recipient, nonce });
}

/** Sends one transaction to any contract and hands back the network's answer (Tail or Fade reads a signature out of it). */
export async function walletSendRaw(tx: { receiverId: string; actions: { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } }[] }): Promise<unknown> {
  if (!connector) throw new Error("Sign in first.");
  const wallet = await connector.wallet();
  return wallet.signAndSendTransaction(tx);
}

async function send(receiverId: string, calls: Call[]): Promise<void> {
  if (!connector) throw new Error("Sign in first.");
  const wallet = await connector.wallet();
  await wallet.signAndSendTransaction({
    receiverId,
    actions: calls.map((c) => ({ type: "FunctionCall" as const, params: { methodName: c.method, args: c.args, gas: c.gas ?? GAS, deposit: c.deposit ?? "0" } })),
  });
}

/** The visitor's actions, as the calls of interface section 9. */
export function walletActions(accountId: string, contractId: string, constants: Constants): Actions {
  const rpc = deployments.testnet.rpc;
  const usdc = constants.usdc_token;
  const coin = (method: string, args: object, deposit = "0", gas = GAS) => send(contractId, [{ method, args, deposit, gas }]);
  const pad = constants.launchpad;
  /** The launchpad wants a one-time registration, with 0.05 NEAR. */
  const padRegistration = async (): Promise<Call[]> =>
    (await view<object | null>(rpc, pad, "storage_balance_of", { account_id: accountId })) ? [] : [{ method: "storage_deposit", args: { account_id: accountId }, deposit: NEAR_0_05 }];
  /** Dollars sent to the coin with a note saying what they are for (ft_transfer_call, 1 yocto). */
  const toCoin = (amount: string, msg: object) =>
    send(usdc, [{ method: "ft_transfer_call", args: { receiver_id: contractId, amount, msg: JSON.stringify(msg) }, gas: GAS_TRANSFER_CALL, deposit: ONE_YOCTO }]);
  /** The coin's one-time registration, if this account still needs it. */
  const registration = async (): Promise<Call[]> => {
    if (await view<object | null>(rpc, contractId, "storage_balance_of", { account_id: accountId })) return [];
    const bounds = await view<{ min: string }>(rpc, contractId, "storage_balance_bounds", {});
    return [{ method: "storage_deposit", args: { account_id: accountId }, deposit: bounds.min }];
  };
  const needTickets = (): string => {
    const t = (deployments.testnet as { tickets?: string }).tickets;
    if (!t || contractId !== deployments.testnet.coin) throw new Error("This copy of the program has no sticker market.");
    return t;
  };
  return {
    getDollars: () => view<string>(rpc, usdc, "ft_balance_of", { account_id: accountId }),
    async getTestDollars(amount) {
      // Interface 1.2, section 13: on the stand-in dollar, storage_deposit once, then mint.
      const has = await view<object | null>(rpc, usdc, "storage_balance_of", { account_id: accountId });
      const calls: Call[] = [];
      if (!has) {
        const bounds = await view<{ min: string }>(rpc, usdc, "storage_balance_bounds", {});
        calls.push({ method: "storage_deposit", args: { account_id: accountId }, deposit: bounds.min });
      }
      calls.push({ method: "mint", args: { account_id: accountId, amount } });
      await send(usdc, calls);
    },
    async register() {
      const bounds = await view<{ min: string }>(rpc, contractId, "storage_balance_bounds", {});
      await send(contractId, [{ method: "storage_deposit", args: { account_id: accountId }, deposit: bounds.min }]);
    },
    payIn: (pool: Pool, amount) =>
      send(usdc, [{ method: "ft_transfer_call", args: { receiver_id: contractId, amount, msg: JSON.stringify({ pool }) }, gas: GAS_TRANSFER_CALL, deposit: ONE_YOCTO }]),
    cashOut: (pool, amount, pending) => coin("cash_out", pending ? { pool, amount, pending: true } : { pool, amount }, ONE_YOCTO, GAS_MAX),
    turnDial: (to, amount) => coin("turn_dial", { to, amount }, ONE_YOCTO, GAS_MAX),
    lock: (amount) => coin("lock", { amount }),
    unlock: (amount) => coin("unlock", { amount }),
    openVote: (kind: VoteKind, playbookId?: number) => coin("open_vote", kind === "SET_PLAYBOOK" ? { kind, playbook_id: playbookId ?? 0 } : { kind }),
    cast: (vote_id, support) => coin("cast", { vote_id, support }),
    finishVote: (vote_id) => coin("finish_vote", { vote_id }),
    // Interface 1.3, section 9.5
    submitPlaybook: (text) => coin("submit_playbook", { text, authors: [{ account_id: accountId, share_bps: 10000 }] }, NEAR_0_05),
    tip: (amount) => send(usdc, [{ method: "ft_transfer_call", args: { receiver_id: contractId, amount, msg: JSON.stringify({ tip: {} }) }, gas: GAS_TRANSFER_CALL, deposit: ONE_YOCTO }]),
    claimBadge: () => coin("claim_badge", {}, NEAR_0_02, GAS_TRANSFER_CALL),
    claimOriginal: (code: RefusalCode) => coin("claim_sticker", { code }, NEAR_0_02, GAS_TRANSFER_CALL),
    claimGoalSticker: (fill_id) => coin("claim_goal_sticker", { fill_id }, NEAR_0_02, GAS_TRANSFER_CALL),
    async launch(name, symbol) {
      await send(pad, [...(await padRegistration()), { method: "launch", args: { name, symbol } }]);
    },
    async buyLaunch(token_id, amount, min_out) {
      const reg = await padRegistration();
      if (reg.length) await send(pad, reg);
      await send(usdc, [{ method: "ft_transfer_call", args: { receiver_id: pad, amount, msg: JSON.stringify({ buy: { token_id, min_out } }) }, gas: GAS_TRANSFER_CALL, deposit: ONE_YOCTO }]);
    },
    // Interface 1.4, section 9.7. Guessing needs a registered account, so registration rides along the first time.
    async guess(verdict) {
      const has = await view<object | null>(rpc, contractId, "storage_balance_of", { account_id: accountId });
      const calls: Call[] = [];
      if (!has) {
        const bounds = await view<{ min: string }>(rpc, contractId, "storage_balance_bounds", {});
        calls.push({ method: "storage_deposit", args: { account_id: accountId }, deposit: bounds.min });
      }
      calls.push({ method: "guess", args: { verdict } });
      await send(contractId, calls);
    },
    claimGolden: (code, serial) => coin("claim_golden", { code, serial }, NEAR_0_02, GAS_TRANSFER_CALL),
    enterDraw: () => coin("enter_draw", {}),
    leaveDraw: () => coin("leave_draw", {}),
    addToJackpot: (amount) => send(usdc, [{ method: "ft_transfer_call", args: { receiver_id: contractId, amount, msg: JSON.stringify({ jackpot: {} }) }, gas: GAS_TRANSFER_CALL, deposit: ONE_YOCTO }]),
    claimPrizes: () => coin("claim_prizes", {}, ONE_YOCTO, GAS_TRANSFER_CALL),
    // Interface 1.6, section 9.8. Free; 100 TGas because it may first write a review that is due. Needs a registered account.
    async stampReview(week) {
      const has = await view<object | null>(rpc, contractId, "storage_balance_of", { account_id: accountId });
      const calls: Call[] = [];
      if (!has) {
        const bounds = await view<{ min: string }>(rpc, contractId, "storage_balance_bounds", {});
        calls.push({ method: "storage_deposit", args: { account_id: accountId }, deposit: bounds.min });
      }
      calls.push({ method: "stamp_review", args: { week }, gas: GAS_TRANSFER_CALL });
      await send(contractId, calls);
    },
    // Interface 1.7. Gas and deposits as Engine 1's hand-over note gives them.
    async guessWager(verdict, wager) {
      const calls = await registration();
      calls.push({ method: "guess", args: wager > 0 ? { verdict, wager } : { verdict } });
      await send(contractId, calls);
    },
    bankStreak: () => coin("bank_streak", {}),
    abandon: (round_id) => coin("abandon", { round_id }, "0", `150${TGAS}`),
    payTrick: (id, amount) => toCoin(amount, { trick: { id } }),
    addToBounty: (amount) => toCoin(amount, { bounty: {} }),
    chipInRescue: (amount) => toCoin(amount, { rescue: {} }),
    challenge: (position_id, returned, reason, bond) => toCoin(bond, { challenge: { position_id, returned, reason } }),
    applyCorrection: (vote_id) => coin("apply_correction", { vote_id }, "0", `60${TGAS}`),
    claimNftEarnings: (token_id) => coin("claim_nft_earnings", { token_id }, "0", `50${TGAS}`),
    claimPlaybookNft: (playbook_id) => coin("claim_playbook_nft", { playbook_id }, NEAR_0_02, `60${TGAS}`),
    mintCareerCard: () => coin("mint_career_card", {}, NEAR_0_02, `60${TGAS}`),
    refreshCareerCard: (n) => coin("refresh_career_card", { n }),
    stickerHlApprove: (code, agent) => coin("sticker_hl_approve", { code, agent }, ONE_YOCTO, GAS_MAX),
    stickerHlWithdraw: (code, destination, amount) => coin("sticker_hl_withdraw", { code, destination, amount }, ONE_YOCTO, GAS_MAX),
    claimGoldenMt: (code, serial) => coin("claim_golden_mt", { code, serial }, NEAR_0_02, `60${TGAS}`),
    listGolden: (token_id, amount, price_each) => send(needTickets(), [{ method: "list", args: { token_id, amount, price_each }, deposit: ONE_YOCTO }]),
    unlistGolden: (listing_id) => send(needTickets(), [{ method: "unlist", args: { listing_id }, deposit: ONE_YOCTO }]),
    buyGolden: (listing_id, amount, total) =>
      send(usdc, [{ method: "ft_transfer_call", args: { receiver_id: needTickets(), amount: total, msg: JSON.stringify({ buy: { listing_id, amount } }) }, gas: GAS_TRANSFER_CALL, deposit: ONE_YOCTO }]),
    sellLaunch: (token_id, amount, min_out) => send(pad, [{ method: "sell", args: { token_id, amount, min_out }, deposit: ONE_YOCTO, gas: GAS_TRANSFER_CALL }]),
  };
}
