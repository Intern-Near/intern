/**
 * Sample data for interface 1.7: the automatic consequences, the trick bounty, the rescue fund, challenges,
 * the Intern's stake, NFT earnings, the originals' Hyperliquid accounts, drand luck and the sticker market.
 * Made-up values in the shapes of 01-SHARED-INTERFACE.md sections 8 and 9.9 to 9.18. Nothing here talks to a network.
 */
import type {
  Actions,
  AutoView,
  Bounty,
  Career,
  Chain,
  Challenge,
  Challenges,
  Drand,
  EventData,
  EventName,
  Listing,
  Ms,
  NftEarnings,
  OwnedToken,
  PlayerView,
  Playbook,
  Position,
  Pot,
  RankState,
  RefusalCode,
  Rescue,
  Rewards,
  Round,
  Stake,
  StickerFirst,
  StickerHlSigned,
  Vote,
} from "./types";
import { REFUSAL_CODES } from "./types";

type World17 = {
  rank: RankState;
  round: Round;
  pot: Pot;
  rewards: Rewards;
  positions: Position[];
  votes: Vote[];
  firsts: StickerFirst[];
  owned: Map<string, OwnedToken[]>;
  playbooks: Playbook[];
};

type State = {
  termEndsAt: Ms;
  bounty: Bounty;
  rescue: Rescue;
  stake: Stake;
  earnings: NftEarnings;
  challenges: Challenge[];
  signed: Map<string, StickerHlSigned[]>;
  listings: Listing[];
  units: Map<string, bigint>;
  careers: number;
  paidTricks: Set<string>;
};

const E6 = 1_000_000n;
const DAY = 86_400_000;
const states = new WeakMap<object, State>();
const SAMPLE_ME = "you.testnet";

function stateOf(w: World17, now: Ms): State {
  let s = states.get(w);
  if (!s) {
    const fired = w.rank.status === "FIRED";
    s = {
      termEndsAt: now + 22 * DAY,
      bounty: { pot: "18500000", paid_total: "2100000", added_total: "15000000", from_tricks_total: "5600000", tricks_paid: 9, trick_price: "1000000", bounty_bps: 1000 },
      rescue: fired
        ? { fund: "32000000", target: "50000000", contributors: 3, rescuers: [["carol.testnet", "20000000"], ["dave.testnet", "10000000"], ["erin.testnet", "2000000"]], from_round: 0, until_round: 0, cut_bps: 1000, paid_total: "0", rescues: 0 }
        : { fund: "0", target: "50000000", contributors: 0, rescuers: [], from_round: 0, until_round: 0, cut_bps: 1000, paid_total: "0", rescues: 0 },
      stake: { coins: "4200000", value: "4200000", fee_bps: 500, grew_total: "5100000", burned_total: "900000" },
      earnings: { owed_total: "750000", paid_total: "1500000", tokens: [{ token_id: "original:OVER_TRADE_LIMIT", owed: "500000" }, { token_id: "original:NOT_ON_LIST", owed: "250000" }], careers_minted: 2 },
      challenges: [{ vote_id: 3, position_id: 5, challenger: "dave.testnet", bond: "5000000", reported: "20650000", claimed: "20400000", reason: "The closing fill on Hyperliquid was 0.0412, not 0.0417.", state: "FAILED" }],
      signed: new Map(),
      listings: [
        { id: 2, seller: "carol.testnet", token_id: "golden:OVER_TRADE_LIMIT", amount: "2", price_each: "3000000" },
        { id: 1, seller: "erin.testnet", token_id: "golden:NOT_ON_LIST", amount: "1", price_each: "7500000" },
      ],
      units: new Map([[`${SAMPLE_ME}|golden:OVER_LEVERAGE`, 1n]]),
      careers: 2,
      paidTricks: new Set(),
    };
    states.set(w, s);
  }
  return s;
}

const CARD = (rank: string, status: string, level: number) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400' viewBox='0 0 400 400'><rect width='400' height='400' rx='24' fill='#fff6b8'/><rect x='16' y='16' width='368' height='368' rx='16' fill='none' stroke='#1b1b1b' stroke-width='4'/><text x='200' y='70' font-family='monospace' font-size='28' text-anchor='middle' fill='#1b1b1b'>THE INTERN</text><text x='200' y='118' font-family='monospace' font-size='22' text-anchor='middle' fill='#c0392b'>${rank} · ${status}</text><text x='200' y='200' font-family='monospace' font-size='44' text-anchor='middle' fill='#1b1b1b'>LEVEL ${level}</text><text x='200' y='260' font-family='monospace' font-size='18' text-anchor='middle' fill='#1b1b1b'>42 rounds · 19 bets · 30 refusals</text><text x='200' y='340' font-family='monospace' font-size='14' text-anchor='middle' fill='#1b1b1b'>sample card, not from the program</text></svg>`,
  )}`;

type Views17 = Pick<Chain, "getAuto" | "getBounty" | "getNftEarnings" | "getCareer" | "getChallenges" | "getStickerHl" | "getDrand" | "getStake" | "getRescue" | "getListings" | "getGoldenUnits" | "getTokenOwner">;

export function sampleViews17(w: World17, clock: () => Ms): Views17 {
  const s = () => stateOf(w, clock());
  const copy = <T,>(v: T): T => structuredClone(v);
  return {
    async getAuto(): Promise<AutoView> {
      const open = w.positions.some((p) => p.round_id === w.round.id && p.status !== "SETTLED");
      const stuck = !w.round.settled && clock() > w.round.ends_at;
      return {
        strikes: w.round.refused > 0 ? 2 : 1, strikes_out: 3,
        brake_on: false, brake_until: null, brake_rounds: 7, brake_loss_bps: 100,
        loss_window_result: "-2400000", loss_window_base: "996900000",
        term_ends_at: s().termEndsAt, term_ms: 30 * DAY, dead_man_rounds: 3,
        // On the sample's STUCK scene the wait is already over, so the button can be tried
        abandon_from: open ? (stuck ? w.round.ends_at : w.round.ends_at + 3 * (w.round.ends_at - w.round.started_at)) : null,
      };
    },
    getBounty: async () => copy(s().bounty),
    getNftEarnings: async () => copy(s().earnings),
    async getCareer(): Promise<Career> {
      return { rank: w.rank.rank, status: w.rank.status, level: 6, rounds: 42, bets: 19, refusals: 30, result: "4100000", svg: CARD(w.rank.rank, w.rank.status, 6) };
    },
    async getChallenges(): Promise<Challenges> {
      return { bonds_held: s().challenges.filter((c) => c.state === "OPEN" || c.state === "PASSED").reduce((n, c) => n + BigInt(c.bond), 0n).toString(), bond: "5000000", window_rounds: 3, challenges: copy(s().challenges) };
    },
    async getStickerHl(code) {
      return { code, token_id: `original:${code}`, path: `sticker-${code}`, signed: copy(s().signed.get(code) ?? []) };
    },
    async getDrand(period): Promise<Drand> {
      const base = { chain: "quicknet", chain_hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971", wait_rounds: 2 };
      const now = w.rewards.draw_period;
      if (period === undefined || period === now) return { period: now, state: "OPEN", drand_round: null, source: null, randomness: null, tickets: null, ...base };
      // A made-up beacon: the picks replay correctly from these tickets, but no drand relay knows this round
      if (period === now - 1)
        return { period, state: "HELD", drand_round: 33930398, source: "drand", randomness: "af2bdbe1aa9b6ec1e2ade1d694f41fc71a831d0268e9891562113d8a62add1bf", tickets: [["carol.testnet", "7000000000"], [SAMPLE_ME, "2100000000"]], ...base };
      return { period, state: "HELD", drand_round: null, source: "none", randomness: null, tickets: null, ...base };
    },
    getStake: async () => copy(s().stake),
    getRescue: async () => copy(s().rescue),
    getListings: async () => copy(s().listings),
    async getGoldenUnits(accountId) {
      return REFUSAL_CODES.map((c) => (s().units.get(`${accountId}|golden:${c}`) ?? 0n).toString());
    },
    async getTokenOwner(tokenId) {
      for (const [owner, list] of w.owned) if (list.some((t) => t.token_id === tokenId)) return owner;
      if (tokenId.startsWith("original:")) {
        const f = w.firsts.find((x) => x.code === tokenId.slice(9));
        return f?.claimed ? f.account_id : null;
      }
      return null;
    },
  };
}

type Helpers = {
  who: string;
  clock: () => Ms;
  me: () => { dollars: bigint; registered: boolean; coin: bigint };
  player: () => PlayerView;
  say: <E extends EventName>(event: E, data: EventData[E]) => void;
  need: (ok: boolean, why: string) => void;
  pause: () => Promise<void>;
  mint: (tokenId: string, title: string, description: string) => void;
};

type Actions17 = Pick<
  Actions,
  | "guessWager" | "bankStreak" | "abandon" | "payTrick" | "addToBounty" | "chipInRescue" | "challenge" | "applyCorrection" | "claimNftEarnings" | "claimPlaybookNft"
  | "mintCareerCard" | "refreshCareerCard" | "stickerHlApprove" | "stickerHlWithdraw" | "claimGoldenMt" | "listGolden" | "unlistGolden" | "buyGolden"
>;

export function sampleActions17(w: World17, h: Helpers): Actions17 {
  const { who, need, pause, say } = h;
  const s = () => stateOf(w, h.clock());
  const add = (v: string, d: bigint) => (BigInt(v) + d).toString();
  const usdText = (v: bigint) => `$${(Number(v) / 1e6).toFixed(2)}`;
  /** Takes dollars out of the pretend wallet, or says why not. */
  const spend = (amount: string, least: bigint, what: string) => {
    const v = BigInt(amount);
    need(v >= least, `${what} is at least ${usdText(least)}.`);
    need(v <= h.me().dollars, `You only have ${usdText(h.me().dollars)} in your wallet.`);
    h.me().dollars -= v;
    return v;
  };
  const holds = (tokenId: string) => (w.owned.get(who) ?? []).some((t) => t.token_id === tokenId);
  const unitKey = (account: string, tokenId: string) => `${account}|${tokenId}`;
  return {
    async guessWager(verdict, wager) {
      await pause();
      const p = h.player();
      need(h.clock() < w.rewards.guess_closes_at, "Guessing has closed for this shift. Nothing was sent. Guess again next shift.");
      need(p.guess?.round_id !== w.round.id, "You have already guessed this shift.");
      need(Number.isInteger(wager) && wager >= 0 && wager <= p.points, `You can wager at most the ${p.points} points you hold.`);
      h.me().registered = true;
      p.points -= wager;
      p.guess = { round_id: w.round.id, verdict, wager };
      const i = verdict === "YES" ? 0 : verdict === "NOPE" ? 1 : 2;
      w.rewards.guesses_this_round[i] += 1;
      const pots = w.rewards.wagers_this_round ?? ["0", "0", "0"];
      pots[i] = (BigInt(pots[i]) + BigInt(wager)).toString();
      w.rewards.wagers_this_round = pots;
      say("guessed", { round_id: w.round.id, account_id: who });
    },
    async bankStreak() {
      await pause();
      const p = h.player();
      need(p.guess === null, "A guess of yours is still waiting for its ruling. Bank the streak after it.");
      need(p.streak > 0, "You have no streak to bank.");
      const points = p.streak * p.streak;
      say("streak_banked", { account_id: who, streak: p.streak, points });
      p.points += points;
      p.streak = 0;
    },
    async abandon(roundId) {
      await pause();
      need(roundId === w.round.id && !w.round.settled && h.clock() > w.round.ends_at, "This shift cannot be abandoned yet.");
      let n = 0;
      for (const p of w.positions) {
        if (p.round_id === roundId && p.status !== "SETTLED") {
          Object.assign(p, { status: "SETTLED", returned: "0", result: `-${p.margin}`, result_source: "ABANDONED", settled_at: h.clock() });
          n += 1;
        }
      }
      w.round.settled = true;
      w.rank.status = "FIRED";
      say("abandoned", { round_id: roundId, bets_booked_lost: n });
      say("fired", { round_id: roundId });
    },
    async payTrick(id, amount) {
      await pause();
      need(/^[A-Za-z0-9-]{1,64}$/.test(id), "That payment id is not valid.");
      need(!s().paidTricks.has(id), "This payment id was already used.");
      const v = spend(amount, BigInt(s().bounty.trick_price), "A paid trick");
      s().paidTricks.add(id);
      const half = v / 2n;
      s().bounty.pot = add(s().bounty.pot, half);
      s().bounty.from_tricks_total = add(s().bounty.from_tricks_total, half);
      s().bounty.tricks_paid += 1;
      say("trick_paid", { id, account_id: who, amount, to_bounty: half.toString() });
    },
    async addToBounty(amount) {
      await pause();
      const v = spend(amount, E6, "An addition to the bounty");
      s().bounty.pot = add(s().bounty.pot, v);
      s().bounty.added_total = add(s().bounty.added_total, v);
      say("bounty_grew", { amount, by: who, pot: s().bounty.pot });
    },
    async chipInRescue(amount) {
      await pause();
      need(w.rank.status === "FIRED", "A rescue is only open while the Intern is fired. Nothing was sent.");
      const v = spend(amount, E6, "A rescue payment");
      const r = s().rescue;
      const mine = r.rescuers.find(([a]) => a === who);
      if (mine) mine[1] = add(mine[1], v);
      else {
        r.rescuers.push([who, amount]);
        r.contributors += 1;
      }
      r.fund = add(r.fund, v);
      say("rescue_grew", { amount, by: who, fund: r.fund, target: r.target });
      if (BigInt(r.fund) >= BigInt(r.target)) {
        say("rescued", { round_id: w.round.id, effective_round: w.round.id + 1, fund: r.fund, rescuers: r.contributors });
        w.rank.pending = { rank: "INTERN", status: "EMPLOYED", effective_round: w.round.id + 1 };
        Object.assign(r, { fund: "0", from_round: w.round.id + 1, until_round: w.round.id + 14, rescues: r.rescues + 1 });
        s().termEndsAt = h.clock() + 30 * DAY;
      }
    },
    async challenge(positionId, returned, reason, bond) {
      await pause();
      need(/^\d+$/.test(returned), "Say the dollars back as a plain amount.");
      need(reason.length > 0 && reason.length <= 140, "A reason is 1 to 140 characters.");
      need(!s().challenges.some((c) => c.position_id === positionId), "This bet has already been challenged once.");
      const v = spend(bond, 5n * E6, "A challenge's bond");
      const vote_id = Math.max(0, ...w.votes.map((x) => x.id), ...s().challenges.map((c) => c.vote_id)) + 1;
      const p = w.positions.find((x) => x.id === positionId);
      const reported = p?.returned ?? "0";
      s().challenges.unshift({ vote_id, position_id: positionId, challenger: who, bond: v.toString(), reported, claimed: returned, reason, state: "OPEN" });
      w.votes.unshift({ id: vote_id, kind: "CORRECT", playbook_id: null, opened_by: who, opened_at: h.clock(), closes_at: h.clock() + DAY, yes: "0", no: "0", locked_weight_at_open: "150000000", state: "OPEN", effective_round: null });
      say("result_challenged", { vote_id, position_id: positionId, challenger: who, reported, claimed: returned, bond: v.toString() });
      say("vote_opened", { vote_id, kind: "CORRECT", playbook_id: null, opened_by: who, closes_at: h.clock() + DAY });
    },
    async applyCorrection(voteId) {
      await pause();
      const c = s().challenges.find((x) => x.vote_id === voteId);
      need(c?.state === "PASSED", "Only a challenge whose vote passed can be applied.");
      c!.state = "APPLIED";
      say("result_corrected", { vote_id: voteId, position_id: c!.position_id, from: c!.reported, to: c!.claimed, delta: (BigInt(c!.claimed) - BigInt(c!.reported)).toString(), brave_after: w.pot.brave.total });
    },
    async claimNftEarnings(tokenId) {
      await pause();
      need(holds(tokenId), "Only the holder of this token can collect what it earned.");
      const t = s().earnings.tokens.find((x) => x.token_id === tokenId);
      need(!!t && BigInt(t.owed) > 0n, "This token has earned nothing yet.");
      const owed = BigInt(t!.owed);
      s().earnings.tokens = s().earnings.tokens.filter((x) => x.token_id !== tokenId);
      s().earnings.owed_total = add(s().earnings.owed_total, -owed);
      s().earnings.paid_total = add(s().earnings.paid_total, owed);
      h.player().prize_owed = add(h.player().prize_owed, owed);
      w.rewards.prizes_owed = add(w.rewards.prizes_owed, owed);
      say("nft_earnings_claimed", { token_id: tokenId, account_id: who, amount: owed.toString() });
    },
    async claimPlaybookNft(playbookId) {
      await pause();
      const p = w.playbooks.find((x) => x.id === playbookId);
      need(!!p && p.authors.some((a) => a.account_id === who), "Only an author of this playbook can mint its NFT.");
      need(![...w.owned.values()].flat().some((t) => t.token_id === `playbook:${playbookId}`), "This playbook's NFT was already minted.");
      h.mint(`playbook:${playbookId}`, `Playbook ${playbookId}`, "Whoever holds this gets the playbook's coach cut.");
      say("sticker_claimed", { account_id: who, token_id: `playbook:${playbookId}` });
    },
    async mintCareerCard() {
      await pause();
      const n = (s().careers += 1);
      s().earnings.careers_minted = n;
      h.mint(`career:${n}`, `Career card ${n}`, "The Intern's record when this card was drawn.");
      say("sticker_claimed", { account_id: who, token_id: `career:${n}` });
    },
    async refreshCareerCard(n) {
      await pause();
      need(n >= 1 && n <= s().careers, "There is no career card with that number.");
    },
    async stickerHlApprove(code, agent) {
      await pause();
      need(holds(`original:${code}`), "Only the holder of this original can sign for its account.");
      need(/^0x[0-9a-f]{40}$/.test(agent), "A trading key's address is 0x and 40 lower-case hex characters.");
      keep(code, "approveAgent", { type: "approveAgent", agentAddress: agent, hyperliquidChain: "Testnet" });
    },
    async stickerHlWithdraw(code, destination, amount) {
      await pause();
      need(holds(`original:${code}`), "Only the holder of this original can sign for its account.");
      need(/^0x[0-9a-f]{40}$/.test(destination), "A destination is 0x and 40 lower-case hex characters.");
      need(/^\d+(\.\d{1,6})?$/.test(amount), "An amount is a plain number with at most 6 decimals.");
      keep(code, "usdSend", { type: "usdSend", destination, amount, hyperliquidChain: "Testnet" });
    },
    async claimGoldenMt(code, serial) {
      await pause();
      const p = h.player();
      need(p.goldens.some((g) => g.code === code && g.serial === serial), "That golden sticker isn't yours to claim.");
      p.goldens = p.goldens.filter((g) => !(g.code === code && g.serial === serial));
      const k = unitKey(who, `golden:${code}`);
      s().units.set(k, (s().units.get(k) ?? 0n) + 1n);
    },
    async listGolden(tokenId, amount, priceEach) {
      await pause();
      const n = BigInt(amount);
      const k = unitKey(who, tokenId);
      need(n > 0n && n <= (s().units.get(k) ?? 0n), "You don't hold that many.");
      need(BigInt(priceEach) > 0n, "The price must be above 0.");
      s().units.set(k, (s().units.get(k) ?? 0n) - n);
      s().listings.unshift({ id: Math.max(0, ...s().listings.map((l) => l.id)) + 1, seller: who, token_id: tokenId, amount, price_each: priceEach });
    },
    async unlistGolden(listingId) {
      await pause();
      const l = s().listings.find((x) => x.id === listingId);
      need(!!l && l.seller === who, "Only the seller can take a listing back.");
      s().listings = s().listings.filter((x) => x.id !== listingId);
      const k = unitKey(who, l!.token_id);
      s().units.set(k, (s().units.get(k) ?? 0n) + BigInt(l!.amount));
    },
    async buyGolden(listingId, amount, total) {
      await pause();
      const l = s().listings.find((x) => x.id === listingId);
      const n = BigInt(amount);
      need(!!l, "That listing is gone.");
      need(n > 0n && n <= BigInt(l!.amount), "The listing does not have that many.");
      need(BigInt(total) >= n * BigInt(l!.price_each), "That is less than the price.");
      spend((n * BigInt(l!.price_each)).toString(), 0n, "A purchase");
      l!.amount = (BigInt(l!.amount) - n).toString();
      if (l!.amount === "0") s().listings = s().listings.filter((x) => x.id !== listingId);
      const k = unitKey(who, l!.token_id);
      s().units.set(k, (s().units.get(k) ?? 0n) + n);
    },
  };

  function keep(code: RefusalCode, kind: string, action: object) {
    const list = s().signed.get(code) ?? [];
    list.unshift({ code, kind, action, nonce: h.clock(), r: `0x${"ab".repeat(32)}`, s: `0x${"cd".repeat(32)}`, v: 27, signer: `0x${"12".repeat(20)}`, for_account: who, at: h.clock() });
    s().signed.set(code, list.slice(0, 10));
    say("sticker_hl_signed", { code, kind, account_id: who, signer: `0x${"12".repeat(20)}` });
  }
}
