import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { coins, cueFor, type FeedItem, fill, type Lines, signedUsd, usd } from "../src/cues.ts";

const LINES = JSON.parse(
  readFileSync(new URL("../../interface/lines.json", import.meta.url), "utf8"),
) as Lines & {
  events: Record<string, { intern?: unknown; by_kind?: Record<string, string[]> }>;
};
const CODES = (
  JSON.parse(readFileSync(new URL("../../interface/refusal-codes.json", import.meta.url), "utf8")) as {
    codes: { code: string }[];
  }
).codes.map((c) => c.code);

/** One example of every feed event of 01 §10, in its documented shape. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  round_opened: { round_id: 12, rank: "INTERN", status: "EMPLOYED", brave_at_open: "1574694996" },
  paid_in: { account_id: "boss1.desk-lab-2026.testnet", pool: "BRAVE", amount: "1000000000", pending: true },
  coins_minted: { account_id: "boss1.desk-lab-2026.testnet", coins: "424999750", round_id: 12 },
  cashed_out: {
    account_id: "boss1.desk-lab-2026.testnet",
    pool: "BRAVE",
    coins: "424999750",
    paid: "425429570",
  },
  dial_turned: { account_id: "boss1.desk-lab-2026.testnet", to: "SAFE", amount: "10000000" },
  locked: { account_id: "boss1.desk-lab-2026.testnet", amount: "400000000" },
  unlocked: { account_id: "boss1.desk-lab-2026.testnet", amount: "1000000" },
  skipped: { round_id: 9 },
  refused: {
    refusal_id: 5,
    round_id: 12,
    code: "OVER_TRADE_LIMIT",
    asked: "500000000",
    limit: "31493899",
    is_first: false,
  },
  approved: { position_id: 4, round_id: 11, market: "SHIB", side: "LONG", margin: "11000000", leverage: 1 },
  order_signed: { action_id: 7, position_id: 4, kind: "LEVERAGE" },
  result_reported: { position_id: 4, returned: "10967418", result: "-32582", result_source: "REPORTED" },
  settled: { round_id: 11, result: "-32582", brave_after: "574694996" },
  vote_opened: {
    vote_id: 3,
    kind: "FIRE",
    playbook_id: null,
    opened_by: "boss2.desk-lab-2026.testnet",
    closes_at: 1794509340000,
  },
  vote_cast: { vote_id: 3, account_id: "boss1.desk-lab-2026.testnet", support: true, weight: "400000000" },
  vote_finished: { vote_id: 3, state: "PASSED", effective_round: 14 },
  rank_changed: { from: "INTERN", to: "ANALYST", effective_round: 14 },
  fired: { round_id: 12 },
  rehired: { effective_round: 15 },
  outside_income: { source: "launchpad", amount: "99970" },
  playbook_submitted: {
    playbook_id: 1,
    authors: [{ account_id: "a.testnet", share_bps: 10000 }],
    submitted_round: 8,
  },
  playbook_activated: { playbook_id: 1, effective_round: 18 },
  coach_paid: {
    round_id: 16,
    playbook_id: 1,
    amount: "200000",
    paid: [{ account_id: "a.testnet", amount: "200000" }],
  },
  tipped: { account_id: "fan.testnet", amount: "5000000" },
  goal_filled: { fill_id: 1, goal: "TIP_JAR", level: 1, round_id: 8 },
  hype_level: { train: 2, level: 3, points: 12 },
  sticker_claimed: { account_id: "visitor.testnet", token_id: "original:OVER_TRADE_LIMIT" },
  // 1.4: the reward ladder
  guessed: { round_id: 13, account_id: "boss1.desk-lab-2026.testnet" },
  guess_settled: { round_id: 13, verdict: "SKIP", right: 4, wrong: 2 },
  golden_dropped: { account_id: "boss2.desk-lab-2026.testnet", code: "OVER_TRADE_LIMIT", serial: 1 },
  jackpot_grew: { amount: "10000000", source: "tips", jackpot: "110000000" },
  jackpot_won: { round_id: 20, winners: ["boss1.desk-lab-2026.testnet"], each: "110000000" },
  draw_held: {
    period: 2,
    winner: "boss1.desk-lab-2026.testnet",
    prize: "4900000",
    runners_up: ["boss2.desk-lab-2026.testnet"],
    each: "2100000",
    tickets_total: "9000000000",
  },
  prize_paid: { account_id: "boss1.desk-lab-2026.testnet", amount: "114900000" },
  // 1.5: the long shot
  long_shot_allowed: { round_id: 44 },
  // 1.6: leagues and the weekly review
  league_closed: {
    week: 7,
    players: 23,
    groups: 2,
    winners: [
      { group: 0, account_id: "boss1.desk-lab-2026.testnet", points: 5 },
      { group: 1, account_id: "boss2.desk-lab-2026.testnet", points: 3 },
    ],
  },
  review_written: { week: 7, bets: 6, refused: 1, skipped: 1, result: "-1250000", rank_end: "INTERN" },
  review_bar_filled: { week: 7, stamps: 5 },
  // 1.7: automatic consequences
  strikes_out: { round_id: 61, strikes: 3, action: "DEMOTE", to: "INTERN" },
  brake_on: { round_id: 62, result: "-16500000", base: "1572880690", until_round: 69 },
  brake_off: { round_id: 69 },
  term_lapsed: { round_id: 80, term_ended_at: 1797178800000 },
  term_renewed: { term_ends_at: 1799770800000 },
  abandoned: { round_id: 63, bets_booked_lost: 1 },
  streak_banked: { account_id: "boss1.desk-lab-2026.testnet", streak: 4, points: 16 },
  trick_paid: { id: "7f3a", account_id: "boss2.desk-lab-2026.testnet", amount: "1000000", to_bounty: "500000" },
  bounty_grew: { amount: "5000000", by: "boss1.desk-lab-2026.testnet", pot: "12500000" },
  bounty_paid: { account_id: "boss2.desk-lab-2026.testnet", amount: "1250000", refusal_id: 3, code: "OVER_LEVERAGE" },
  rescue_grew: { amount: "20000000", by: "boss1.desk-lab-2026.testnet", fund: "30000000", target: "50000000" },
  rescued: { round_id: 70, effective_round: 71, fund: "50000000", rescuers: ["boss1.desk-lab-2026.testnet"] },
  rescue_paid: { round_id: 72, amount: "120000" },
  nft_earnings_claimed: { token_id: "original:FIRED", account_id: "boss2.desk-lab-2026.testnet", amount: "500000" },
  stake_grew: { round_id: 73, coins: "1500000", fee: "1250000" },
  stake_burned: { round_id: 74, coins: "1500000", covered: "1251000" },
};
const item = (event: string, data: Record<string, unknown>, seq = 1): FeedItem => ({
  seq,
  at: 1794506940000,
  event,
  data,
});

/** Every way an event's lines can be chosen: all variants (by seq) and every branch. */
function everyCue(event: string, data: Record<string, unknown>): ReturnType<typeof cueFor>[] {
  const out = [];
  for (let seq = 0; seq < 6; seq++) out.push(cueFor(item(event, data, seq), LINES, { rank: "INTERN" }));
  return out;
}

const BANNED =
  /revolutionary|seamless|\bunlock(?!ed)|\balpha\b|to the moon|trustless|\bsecure\b|\boops\b|something went wrong|ai-powered|guarantee|profit|\bbuy now\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;

describe("every feed event of 01 §10 has a cue", () => {
  it("lines.json covers exactly the events of the interface", () => {
    assert.deepEqual(Object.keys(LINES.events).sort(), Object.keys(SAMPLES).sort());
  });

  for (const [event, data] of Object.entries(SAMPLES)) {
    it(`${event}: every variant fills every blank`, () => {
      for (const cue of everyCue(event, data)) {
        assert.ok(cue, `${event} gave no cue`);
        assert.doesNotMatch(cue.system, /[{}]/);
        assert.ok(cue.system.length > 0);
        if (cue.speak) {
          assert.ok(cue.intern && !/[{}]/.test(cue.intern), `${event}: ${cue.intern}`);
        } else assert.equal(cue.intern, null);
      }
    });
  }

  it("branches: results by sign, votes by kind, ranks by direction, playbooks cleared or set", () => {
    const r = (result: string) =>
      cueFor(item("result_reported", { ...SAMPLES.result_reported, result }), LINES);
    assert.equal(r("1200000")?.intern_pose, "happy");
    assert.equal(r("-32582")?.intern_pose, "refused");
    assert.equal(r("0")?.intern_pose, "idle");
    assert.match(r("1200000")?.intern ?? "", /\+\$1\.20/);
    for (const kind of ["PROMOTE", "DEMOTE", "FIRE", "REHIRE", "SET_PLAYBOOK", "LONG_SHOT"])
      for (const c of everyCue("vote_opened", { ...SAMPLES.vote_opened, kind, playbook_id: 2 }))
        assert.ok(c?.intern);
    assert.match(
      cueFor(item("vote_opened", { ...SAMPLES.vote_opened, kind: "SET_PLAYBOOK", playbook_id: 2 }), LINES)
        ?.system ?? "",
      /for playbook 2/,
    );
    const rank = (from: string, to: string) =>
      cueFor(item("rank_changed", { from, to, effective_round: 9 }), LINES);
    assert.equal(rank("INTERN", "ANALYST")?.intern_pose, "promoted");
    assert.equal(rank("TRADER", "ANALYST")?.intern_pose, "refused");
    assert.match(
      cueFor(item("playbook_activated", { playbook_id: 0, effective_round: 9 }), LINES)?.intern ?? "",
      /No playbook/,
    );
    assert.match(
      cueFor(item("playbook_activated", { playbook_id: 0, effective_round: 9 }), LINES)?.system ?? "",
      /cleared/,
    );
  });

  it("the payday draw: a winner, or a rollover when nobody was in it", () => {
    const won = cueFor(item("draw_held", SAMPLES.draw_held ?? {}), LINES);
    assert.match(won?.intern ?? "", /\$4\.90/);
    assert.match(won?.system ?? "", /^DRAW — period 2: boss1/);
    const rolled = cueFor(
      item("draw_held", {
        period: 3,
        winner: null,
        prize: "0",
        runners_up: [],
        each: "0",
        tickets_total: "0",
        rolled_over: "120",
      }),
      LINES,
    );
    assert.equal(rolled?.intern_pose, "idle");
    assert.match(rolled?.system ?? "", /nobody in it; \$0\.00 rolls over/);
    assert.match(
      cueFor(item("jackpot_grew", SAMPLES.jackpot_grew ?? {}), LINES)?.system ?? "",
      /from half of a tip, now \$110\.00/,
    );
  });

  it("an event this file does not know yet gives no cue (a newer contract), and the same seq gives the same line", () => {
    assert.equal(cueFor(item("something_new", {}), LINES), null);
    const a = cueFor(item("skipped", { round_id: 3 }, 41), LINES);
    const b = cueFor(item("skipped", { round_id: 3 }, 41), LINES);
    assert.deepEqual(a, b);
  });
});

describe("every refusal code of 01 §7 has lines", () => {
  it("lines.json covers exactly the sixteen codes", () => {
    assert.deepEqual(Object.keys(LINES.refusals).sort(), [...CODES].sort());
  });

  const numbers: Record<string, [string | null, string | null]> = {
    OUTSIDE_WINDOW: ["1260000", "1200000"],
    ZERO_MARGIN: ["10000000", "11000000"],
    OVER_LEVERAGE: ["5", "1"],
    TOO_MANY_TRADES: ["2", "1"],
    OVER_TRADE_LIMIT: ["500000000", "31493899"],
    OVER_ROUND_LIMIT: ["520000000", "31493899"],
    STALE_QUOTE: ["95000", "60000"],
    QUOTE_MISMATCH: ["12000000", "11000000"],
    TOO_EXPENSIVE: ["150", "100"],
  };
  for (const code of CODES) {
    it(`${code}: the Intern's line and the program's caption, numbers with units`, () => {
      const [asked, limit] = numbers[code] ?? [null, null];
      for (const is_first of [false, true]) {
        for (const c of everyCue("refused", { refusal_id: 1, round_id: 12, code, asked, limit, is_first })) {
          assert.ok(c?.intern && c.speak);
          assert.equal(c.mascot, "stamp:nope");
          assert.match(c.system, new RegExp(`^REFUSED — ${code} — `));
          assert.doesNotMatch(`${c.intern} ${c.system}`, /[{}?]|undefined|null/);
          assert.equal(c.intern.endsWith("That's a new sticker for the book."), is_first);
        }
      }
    });
  }

  it("units: dollars, minutes into the round, leverage, seconds, percent", () => {
    const sys = (code: string, asked: string, limit: string) =>
      cueFor(item("refused", { refusal_id: 1, round_id: 12, code, asked, limit, is_first: false }), LINES, {
        rank: "INTERN",
      })?.system;
    assert.equal(
      sys("OVER_TRADE_LIMIT", "500000000", "31493899"),
      "REFUSED — OVER_TRADE_LIMIT — rank INTERN, limit $31.49 per bet, asked $500.00.",
    );
    assert.match(
      sys("OUTSIDE_WINDOW", "1260000", "1200000") ?? "",
      /minute 20:00 of the round, this one at minute 21:00/,
    );
    assert.match(sys("OVER_LEVERAGE", "5", "1") ?? "", /limit 1x, asked 5x/);
    assert.match(sys("STALE_QUOTE", "95000", "60000") ?? "", /limit 60\.0 s, asked 95\.0 s/);
    assert.match(sys("TOO_EXPENSIVE", "150", "100") ?? "", /limit 1\.00% of the margin, asked 1\.50%/);
  });
});

describe("the voice (spec 24.14)", () => {
  const all: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === "string") all.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  collect(LINES.events);
  collect(LINES.refusals);

  it("no hype words, no promises, no emoji, anywhere", () => {
    for (const s of all) {
      assert.doesNotMatch(s, BANNED, s);
      assert.doesNotMatch(s, EMOJI, s);
    }
  });

  it("the program's captions: no exclamation marks, and they name the thing first, in capitals", () => {
    const systems = [
      ...Object.values(LINES.events).map((e) => (e as { system: string }).system),
      ...Object.values(LINES.events).flatMap((e) =>
        Object.values((e as { by_outcome?: Record<string, { system: string }> }).by_outcome ?? {}).map(
          (o) => o.system,
        ),
      ),
      ...Object.values(LINES.refusals).map((r) => r.system),
    ].filter((s) => !s.startsWith("by "));
    for (const s of systems) {
      assert.doesNotMatch(s, /!/, s);
      assert.match(s.replace(/\{[a-z_]+\}/g, "N"), /^[A-Z][A-Z0-9 _]+ —/, s);
    }
  });

  it("the Intern never shouts either", () => {
    for (const s of all) assert.doesNotMatch(s, /!/, s);
  });
});

describe("formatting", () => {
  it("dollars with cents and thousands, signs on results, coins with two decimals", () => {
    assert.equal(usd("1574694996"), "$1,574.69");
    assert.equal(usd("11000000"), "$11.00");
    assert.equal(usd("99970"), "$0.10");
    assert.equal(usd("-32582"), "-$0.03");
    assert.equal(signedUsd("1200000"), "+$1.20");
    assert.equal(signedUsd("0"), "$0.00");
    assert.equal(coins("424999750"), "425.00");
    assert.equal(usd("not a number"), "$?");
  });

  it("an unknown blank is an error, so a typo in lines.json fails the tests", () => {
    assert.throws(() => fill("Hello {nobody}", {}), /no value for \{nobody\}/);
  });
});
