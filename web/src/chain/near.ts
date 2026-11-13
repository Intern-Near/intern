/**
 * Reads the program's views over NEAR's JSON-RPC. Used for the stub and the real contract.
 * Checked against Engine 1's stub on testnet.
 */
import type { Chain, Constants, RankName } from "./types";

type RpcResult = { result?: { result?: number[]; error?: string }; error?: { message?: string; data?: unknown } };

/** How many access keys an account has. Zero means nobody can change the contract or move its funds by key. */
export async function accessKeyCount(rpcUrl: string, accountId: string): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "intern-web", method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: accountId } }),
  });
  const body = (await res.json()) as { result?: { keys?: unknown[] }; error?: { message?: string } };
  if (!body.result?.keys) throw new Error(body.error?.message ?? "no answer");
  return body.result.keys.length;
}

/** One read-only question to any contract. */
export async function view<T>(rpcUrl: string, contractId: string, method: string, args: object = {}): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "intern-web",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  if (!res.ok) throw new Error(`The NEAR network answered ${res.status} for ${method}`);
  const body = (await res.json()) as RpcResult;
  const bytes = body.result?.result;
  if (!bytes) {
    const why = body.result?.error ?? (typeof body.error?.data === "string" ? body.error.data : body.error?.message) ?? "no answer";
    throw new Error(`${contractId} did not answer ${method}: ${why}`);
  }
  return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as T;
}

export function nearChain(rpcUrl: string, contractId: string): Chain {
  const ask = <T,>(method: string, args: object = {}) => view<T>(rpcUrl, contractId, method, args);
  let constants: Promise<Constants> | undefined;
  const consts = () => (constants ??= ask<Constants>("get_constants"));

  return {
    getConstants: () => ask("get_constants"),
    getRank: () => ask("get_rank"),
    getLimits: (rank: RankName) => ask("get_limits", { rank }),
    getRound: () => ask("get_round"),
    getRoundById: (round_id) => ask("get_round_by_id", { round_id }),
    getRulebook: () => ask("get_rulebook"),
    getPositions: (round_id) => ask("get_positions", round_id === undefined ? {} : { round_id }),
    getOutbox: (after_id, limit) => ask("get_outbox", { after_id, limit }),
    getPot: () => ask("get_pot"),
    getAccount: (account_id) => ask("get_account", { account_id }),
    getVotes: (from, limit) => ask("get_votes", { from, limit }),
    getRefusals: (from, limit) => ask("get_refusals", { from, limit }),
    getStickerFirsts: () => ask("get_sticker_firsts"),
    getFeed: (after_seq, limit) => ask("get_feed", { after_seq, limit }),
    getActivePlaybook: () => ask("get_active_playbook"),
    getPlaybooks: (from, limit) => ask("get_playbooks", { from, limit }),
    getGoals: () => ask("get_goals"),
    getGoalFills: (from, limit) => ask("get_goal_fills", { from, limit }),
    getClaimable: (account_id) => ask("get_claimable", { account_id }),
    // The stickers and launchpad contracts are named by the coin itself
    getOwned: async (account_id) => view(rpcUrl, (await consts()).stickers, "nft_tokens_for_owner", { account_id }),
    getLaunches: async () => view(rpcUrl, (await consts()).launchpad, "get_launches", {}),
    getLaunchInfo: async () => view(rpcUrl, (await consts()).launchpad, "get_info", {}),
    getLaunchBalance: async (token_id, account_id) => view(rpcUrl, (await consts()).launchpad, "get_balance", { token_id, account_id }),
    getLaunchQuote: async (token_id, side, amount) => view(rpcUrl, (await consts()).launchpad, "get_quote", { token_id, side, amount }),
    getRewards: () => ask("get_rewards"),
    getPlayer: (account_id) => ask("get_player", { account_id }),
    getDrawResults: (from, limit) => ask("get_draw_results", { from, limit }),
    getJackpotWins: (limit) => ask("get_jackpot_wins", { limit }),
  };
}
