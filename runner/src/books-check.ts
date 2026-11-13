import type { AtBlock, Block } from "./at-block.ts";
import { field, flag, record, six, text, u128, u128Value, whole } from "./view-fields.ts";

/**
 * books-check: do the coin's dollars add up? Read-only. At one block it reads what the coin owes, bucket by bucket,
 * from its own views (01 §8: `get_pot`, and `get_rewards` for the reward ladder's money, 01 §9.7), and what holds
 * it: the test dollar's balance of the coin (`ft_balance_of` on `get_constants().usdc_token`) and what the lender's
 * own books say the coin lent it (the lender's `get_account`, crates/lender). The rule is the one 01 §9.7 states and
 * the contract's sandbox tests assert after every move (crates/coin/sandbox/tests/common/mod.rs `books_match`):
 *
 *   USDC held = brave.total - brave.lent + brave.pending + safe.total + brave.income_waiting
 *               + jackpot + draw_pot + prizes_owed + bounty (1.7)
 *
 * and the part lent (`brave.lent`) is at the lender. Every bucket below is a field of those views; none is added
 * here. The text form is src/books-text.ts.
 */

export interface BooksSnapshot {
  coin: string;
  rpc: string;
  block: Block;
  usdc_token: string;
  network: string;
  interface_version: string;
  lending_mode: string;
  result_source: string;
  hl_address: string;
  hl_testnet: boolean;
  brave: {
    total: bigint;
    lent: bigint;
    in_play: bigint;
    idle: bigint;
    pending: bigint;
    interest: bigint;
    income_waiting: bigint;
  };
  safe: { total: bigint; lent: bigint; idle: bigint };
  coin_supply: bigint;
  coin_price_e6: bigint;
  bosses: number;
  jackpot: bigint;
  draw_pot: bigint;
  prizes_owed: bigint;
  /** 01 1.7: the trick bounty pot (`get_bounty().pot`), 0 on an older contract. */
  bounty: bigint;
  /** 01 1.7: a rescue fund still collecting (`get_rescue().fund`), 0 on an older contract. */
  rescue: bigint;
  /** 01 1.7: what earning NFTs are owed (`get_nft_earnings().owed_total`), 0 on an older contract. */
  nft_owed: bigint;
  /** 01 1.7: challenge bonds held (`get_challenges().bonds_held`), 0 on an older contract. */
  bonds: bigint;
  usdc_of_coin: bigint;
  /** Null when no lender was read (nothing lent, or none named). */
  lender: {
    account: string;
    usdc_held: bigint;
    principal: bigint;
    interest: bigint;
    rate_bps: number;
  } | null;
}

/** Reads every number at the block `at` is pinned to. `lender` is the stand-in lender's account, or null. */
export async function readBooks(at: AtBlock, coin: string, lender: string | null): Promise<BooksSnapshot> {
  const c = record(await at.view(coin, "get_constants"), "get_constants");
  const network = text(c, "network", "get_constants");
  if (network !== "testnet")
    throw new Error(`get_constants().network is ${network}: books-check reads testnet only`);
  const hl = field(c, "hl", "get_constants");
  const usdc = text(c, "usdc_token", "get_constants");
  const pot = record(await at.view(coin, "get_pot"), "get_pot");
  const brave = field(pot, "brave", "get_pot");
  const safe = field(pot, "safe", "get_pot");
  const rw = record(await at.view(coin, "get_rewards"), "get_rewards");
  const b = "get_pot.brave";
  const s = "get_pot.safe";
  const snap: BooksSnapshot = {
    coin,
    rpc: at.rpc,
    block: at.block,
    usdc_token: usdc,
    network,
    interface_version: text(c, "interface_version", "get_constants"),
    lending_mode: text(field(c, "lending", "get_constants"), "mode", "get_constants.lending"),
    result_source: text(c, "result_source", "get_constants"),
    hl_address: text(hl, "address", "get_constants.hl"),
    hl_testnet: flag(hl, "testnet", "get_constants.hl"),
    brave: {
      total: u128(brave, "total", b),
      lent: u128(brave, "lent", b),
      in_play: u128(brave, "in_play", b),
      idle: u128(brave, "idle", b),
      pending: u128(brave, "pending", b),
      interest: u128(brave, "interest", b),
      income_waiting: u128(brave, "income_waiting", b),
    },
    safe: { total: u128(safe, "total", s), lent: u128(safe, "lent", s), idle: u128(safe, "idle", s) },
    coin_supply: u128(pot, "coin_supply", "get_pot"),
    coin_price_e6: u128(pot, "coin_price_e6", "get_pot"),
    bosses: whole(pot, "bosses", "get_pot"),
    jackpot: u128(rw, "jackpot", "get_rewards"),
    draw_pot: u128(rw, "draw_pot", "get_rewards"),
    prizes_owed: u128(rw, "prizes_owed", "get_rewards"),
    bounty: await at
      .view(coin, "get_bounty")
      .then((v) => u128(record(v, "get_bounty"), "pot", "get_bounty"))
      .catch(() => 0n),
    rescue: await at
      .view(coin, "get_rescue")
      .then((v) => u128(record(v, "get_rescue"), "fund", "get_rescue"))
      .catch(() => 0n),
    nft_owed: await at
      .view(coin, "get_nft_earnings")
      .then((v) => u128(record(v, "get_nft_earnings"), "owed_total", "get_nft_earnings"))
      .catch(() => 0n),
    bonds: await at
      .view(coin, "get_challenges")
      .then((v) => u128(record(v, "get_challenges"), "bonds_held", "get_challenges"))
      .catch(() => 0n),
    usdc_of_coin: u128Value(
      await at.view(usdc, "ft_balance_of", { account_id: coin }),
      "ft_balance_of(coin)",
    ),
    lender: null,
  };
  if (lender !== null) {
    const a = record(await at.view(lender, "get_account", { account_id: coin }), "lender get_account");
    const rate = await at.view(lender, "get_rate");
    if (typeof rate !== "number" || !Number.isSafeInteger(rate))
      throw new Error("lender get_rate: expected a whole number of bps");
    snap.lender = {
      account: lender,
      usdc_held: u128Value(
        await at.view(usdc, "ft_balance_of", { account_id: lender }),
        "ft_balance_of(lender)",
      ),
      principal: u128(a, "principal", "lender get_account"),
      interest: u128(a, "interest", "lender get_account"),
      rate_bps: rate,
    };
  }
  return snap;
}

// ---------------------------------------------------------------- the check (pure)

export const COIN_PLACE = "the coin's USDC";
export const LENDER_PLACE = "the lender, for this coin";

export interface OwedRow {
  name: string;
  /** The view field it is read from. */
  source: string;
  amount_e6: string;
  /** Where the money should be; null for the BRAVE pool's own row, whose parts follow it. */
  held_at: typeof COIN_PLACE | typeof LENDER_PLACE | null;
  /** A part of the BRAVE pool (idle, in play, lent), not added again. */
  part: boolean;
  note: string;
}

export interface HeldRow {
  name: string;
  source: string;
  /** Null when it was not read. */
  amount_e6: string | null;
}

export interface PlaceCheck {
  place: typeof COIN_PLACE | typeof LENDER_PLACE;
  rule: string;
  should_hold_e6: string;
  holds_e6: string | null;
  holds_source: string;
  /** holds - should hold; null when not read. */
  difference_e6: string | null;
}

export interface Check {
  ok: boolean;
  rule: string;
  detail: string;
}

/**
 * ADD UP: every place holds exactly what it should. MOVING: the total adds up but the coin and the lender differ by
 * the same amount, a loan or a repayment in flight between them. SURPLUS / SHORT: more / less is held and lent than
 * is owed. NOT CHECKED: money is lent and no lender was read.
 */
export type BooksVerdict = "ADD UP" | "MOVING" | "SURPLUS" | "SHORT" | "NOT CHECKED";

export interface BooksReport {
  tool: "books-check";
  coin: string;
  rpc: string;
  block: { height: number; hash: string; at: string; at_ms: number };
  usdc_token: string;
  lender: string | null;
  rule: string;
  owed: OwedRow[];
  owed_total_e6: string;
  held: HeldRow[];
  held_total_e6: string | null;
  difference_e6: string | null;
  places: PlaceCheck[];
  checks: Check[];
  info: string[];
  gaps: string[];
  verdict: BooksVerdict;
  ok: boolean;
}

export const RULE =
  "USDC held by the coin = brave.total - brave.lent + brave.pending + safe.total + brave.income_waiting + jackpot + " +
  "draw_pot + prizes_owed + the trick bounty, and brave.lent is at the lender (01 §9.7, §9.6)";

const HL_EXPLORER = "https://app.hyperliquid-testnet.xyz/explorer/address/";

export function checkBooks(s: BooksSnapshot): BooksReport {
  const { brave, safe } = s;
  const coin = COIN_PLACE;
  const owed: OwedRow[] = [
    {
      name: "BRAVE pool",
      source: "get_pot.brave.total",
      amount_e6: brave.total.toString(),
      held_at: null,
      part: false,
      note: "the coins' money; its parts follow",
    },
    {
      name: "idle",
      source: "get_pot.brave.idle",
      amount_e6: brave.idle.toString(),
      held_at: coin,
      part: true,
      note: "in the contract, not lent, not on a bet",
    },
    {
      name: "margin on open bets",
      source: "get_pot.brave.in_play",
      amount_e6: brave.in_play.toString(),
      held_at: coin,
      part: true,
      note: "on testnet it never leaves the contract (01 §14.3)",
    },
    {
      name: "lent",
      source: "get_pot.brave.lent",
      amount_e6: brave.lent.toString(),
      held_at: LENDER_PLACE,
      part: true,
      note: "at the stand-in lender, earning a test rate",
    },
    {
      name: "BRAVE pending",
      source: "get_pot.brave.pending",
      amount_e6: brave.pending.toString(),
      held_at: coin,
      part: false,
      note: "paid in, becomes coins at the next round's opening",
    },
    {
      name: "outside income waiting",
      source: "get_pot.brave.income_waiting",
      amount_e6: brave.income_waiting.toString(),
      held_at: coin,
      part: false,
      note: "joins the BRAVE pool at the next round's opening",
    },
    {
      name: "SAFE",
      source: "get_pot.safe.total",
      amount_e6: safe.total.toString(),
      held_at: coin,
      part: false,
      note: "never bet, never lent",
    },
    {
      name: "streak jackpot",
      source: "get_rewards.jackpot",
      amount_e6: s.jackpot.toString(),
      held_at: coin,
      part: false,
      note: "half of each tip, and direct additions",
    },
    {
      name: "payday draw pot",
      source: "get_rewards.draw_pot",
      amount_e6: s.draw_pot.toString(),
      held_at: coin,
      part: false,
      note: "the lender's interest, held for the next draw",
    },
    {
      name: "prizes owed",
      source: "get_rewards.prizes_owed",
      amount_e6: s.prizes_owed.toString(),
      held_at: coin,
      part: false,
      note: "won, not yet claimed",
    },
    {
      name: "trick bounty",
      source: "get_bounty.pot",
      amount_e6: s.bounty.toString(),
      held_at: coin,
      part: false,
      note: "half of each paid trick, and direct additions (01 1.7)",
    },
    {
      name: "rescue fund",
      source: "get_rescue.fund",
      amount_e6: s.rescue.toString(),
      held_at: coin,
      part: false,
      note: "contributions to rescue a fired Intern, waiting for the target (01 1.7)",
    },
    {
      name: "NFT earnings",
      source: "get_nft_earnings.owed_total",
      amount_e6: s.nft_owed.toString(),
      held_at: coin,
      part: false,
      note: "earned by originals and playbook NFTs, not yet claimed (01 1.7)",
    },
    {
      name: "challenge bonds",
      source: "get_challenges.bonds_held",
      amount_e6: s.bonds.toString(),
      held_at: coin,
      part: false,
      note: "bonds of challenges still open or passed and not yet applied (01 1.7)",
    },
  ];
  const atCoin =
    brave.total -
    brave.lent +
    brave.pending +
    safe.total +
    brave.income_waiting +
    s.jackpot +
    s.draw_pot +
    s.prizes_owed +
    s.bounty +
    s.rescue +
    s.nft_owed +
    s.bonds;
  const owedTotal = atCoin + brave.lent;

  const lenderNeeded = brave.lent > 0n || s.lender !== null;
  const held: HeldRow[] = [
    {
      name: COIN_PLACE,
      source: `${s.usdc_token} ft_balance_of(${s.coin})`,
      amount_e6: s.usdc_of_coin.toString(),
    },
  ];
  if (lenderNeeded)
    held.push({
      name: "lent, by the lender's own books",
      source: s.lender ? `${s.lender.account} get_account(${s.coin}).principal` : "no lender read (--lender)",
      amount_e6: s.lender ? s.lender.principal.toString() : null,
    });
  const heldTotal =
    lenderNeeded && s.lender === null ? null : s.usdc_of_coin + (s.lender ? s.lender.principal : 0n);
  const difference = heldTotal === null ? null : heldTotal - owedTotal;

  const places: PlaceCheck[] = [
    {
      place: COIN_PLACE,
      rule: "brave.total - brave.lent + pending + income waiting + SAFE + jackpot + draw pot + prizes owed + trick bounty (01 §9.7)",
      should_hold_e6: atCoin.toString(),
      holds_e6: s.usdc_of_coin.toString(),
      holds_source: `${s.usdc_token} ft_balance_of(${s.coin})`,
      difference_e6: (s.usdc_of_coin - atCoin).toString(),
    },
  ];
  if (lenderNeeded)
    places.push({
      place: LENDER_PLACE,
      rule: "brave.lent (01 §9.6)",
      should_hold_e6: brave.lent.toString(),
      holds_e6: s.lender ? s.lender.principal.toString() : null,
      holds_source: s.lender ? `${s.lender.account} get_account(${s.coin}).principal` : "not read",
      difference_e6: s.lender ? (s.lender.principal - brave.lent).toString() : null,
    });

  const checks: Check[] = [
    {
      ok: brave.idle + brave.in_play + brave.lent === brave.total,
      rule: "brave.idle + brave.in_play + brave.lent = brave.total (01 §9.6: at every moment)",
      detail: `${six(brave.idle)} + ${six(brave.in_play)} + ${six(brave.lent)} = ${six(brave.idle + brave.in_play + brave.lent)}; brave.total ${six(brave.total)}`,
    },
    {
      ok: safe.lent === 0n && safe.idle === safe.total,
      rule: "safe.lent is 0 and safe.idle = safe.total (01 §9.7's rule counts all SAFE money as held by the coin)",
      detail: `safe.lent ${six(safe.lent)}, safe.idle ${six(safe.idle)}, safe.total ${six(safe.total)}`,
    },
  ];
  if (s.lending_mode === "NONE")
    checks.push({
      ok: brave.lent === 0n,
      rule: "nothing is lent while lending.mode is NONE",
      detail: `brave.lent ${six(brave.lent)}`,
    });

  const info = [
    `coin supply ${six(s.coin_supply)}, coin price $${six(s.coin_price_e6)}, ${s.bosses} boss(es) (get_pot)`,
    `interest collected so far ${six(brave.interest)} (get_pot.brave.interest, a running total: since 01 1.4 it ` +
      "goes to the draw pot or is paid as prizes, so it is not a bucket of its own)",
  ];
  if (s.lender !== null)
    info.push(
      `the lender holds ${six(s.lender.usdc_held)} test USDC in all (${s.usdc_token} ft_balance_of(${s.lender.account})), ` +
        "for every account that lends to it; no view lists them",
      `interest the lender has accrued for this coin, not yet collected: ${six(s.lender.interest)} ` +
        `(get_account(${s.coin}).interest, at its fixed test rate of ${s.lender.rate_bps} bps a year). ` +
        "It is not the coin's until collect_interest() moves it into the draw pot",
    );

  const gaps = [
    `Hyperliquid: the bets trade on Hyperliquid testnet from the contract's own address ${s.hl_address}, whose ` +
      "margin was funded by hand, not by the contract: a stand-in (01 §14.3; docs/REAL-VS-STANDIN.md: the live " +
      "coin's address got 100 test USDC once). No margin moves from the contract to Hyperliquid, so brave.in_play " +
      "stays in the coin's USDC while a bet is open, and that account's balance is outside the contract and " +
      `outside these books (${HL_EXPLORER}${s.hl_address}).`,
    `Results are reported by the runner (result_source ${s.result_source}, 01 §14.2), and the contract mints or ` +
      "burns test dollars for each round's result so its USDC follows its books (01 §14.12). So the books add up " +
      "whatever the bets did; whether each reported result matches Hyperliquid's fills is what `npm run fills-check` checks.",
    `The lender is a stand-in (lending.mode ${s.lending_mode}, 01 §9.6) at a fixed test rate. It pays interest from ` +
      "the dollars it holds and, when it holds too few to pay back, mints the shortfall from the test dollar's open " +
      "mint (crates/lender send), so its own USDC can be below what it owes without anyone being short. " +
      "get_constants does not name the lender: this check reads the one in interface/deployments.json, or --lender.",
    `The dollar (${s.usdc_token}) is a test token with an open mint (01 §13): every amount here is worth nothing.`,
    "USDC sent to the coin by a plain ft_transfer (not a pay-in, tip, income or jackpot message) is held but owed " +
      "to nobody, and shows here as a surplus (the contract's sandbox tests call it `ignored`).",
    `Everything is read at block ${s.block.height}. A payment in flight at that block (a cash-out, a prize or a ` +
      "coach cut being paid, a loan to or from the lender, a settlement's test-dollar mint or burn) shows as a " +
      "difference for a block or two: run the check again.",
  ];

  let verdict: BooksVerdict;
  if (difference === null) verdict = "NOT CHECKED";
  else if (difference > 0n) verdict = "SURPLUS";
  else if (difference < 0n) verdict = "SHORT";
  else verdict = places.every((p) => p.difference_e6 === "0") ? "ADD UP" : "MOVING";

  return {
    tool: "books-check",
    coin: s.coin,
    rpc: s.rpc,
    block: {
      height: s.block.height,
      hash: s.block.hash,
      at: new Date(s.block.at_ms).toISOString(),
      at_ms: s.block.at_ms,
    },
    usdc_token: s.usdc_token,
    lender: s.lender?.account ?? null,
    rule: RULE,
    owed,
    owed_total_e6: owedTotal.toString(),
    held,
    held_total_e6: heldTotal === null ? null : heldTotal.toString(),
    difference_e6: difference === null ? null : difference.toString(),
    places,
    checks,
    info,
    gaps,
    verdict,
    ok: verdict === "ADD UP" && checks.every((c) => c.ok),
  };
}
