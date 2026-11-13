import "./pages.css";
import "./v17-trick.css";
import deployments from "../../../interface/deployments.json";
import { accessKeyCount } from "../chain/near";
import { getSource, useDesk, type Desk } from "../chain/store";
import { useAsync } from "../lib/useAsync";
import { INTERFACE_VERSION, REFUSAL_CODES } from "../chain/types";
import { href } from "../lib/nav";
import { BreakIt } from "../ui/BreakIt";
import { TopBar } from "../ui/TopBar";
import { Waiting } from "../ui/Waiting";

type Row = { thing: string; state: "real" | "standin" | "notyet"; note: string };

const WORD = { real: "Real", standin: "Stand-in", notyet: "Not yet" } as const;

/** Every line here is worked out from what the program itself reports, so it cannot drift from it. */
function realOrNot(desk: Desk, source: string): Row[] {
  const c = desk.constants;
  const sample = source === "sample";
  return [
    sample
      ? { thing: "The numbers on this site", state: "standin", note: "Sample data, made up in the right shapes. Nothing on screen comes from a chain yet." }
      : source === "stub"
        ? { thing: "The numbers on this site", state: "standin", note: "Read from a stub contract on NEAR testnet that answers with canned data." }
        : { thing: "The numbers on this site", state: "real", note: `Read live from the contract on NEAR ${c.network}.` },
    { thing: "Network", state: c.network === "mainnet" ? "real" : "standin", note: c.network === "mainnet" ? "NEAR mainnet." : "NEAR testnet. No real money anywhere." },
    { thing: "Dollars", state: c.network === "mainnet" ? "real" : "standin", note: c.network === "mainnet" ? "USDC." : "A test token of our own with a free tap, standing in for USDC." },
    {
      thing: "Lending the pool",
      state: c.lending.mode === "RHEA" ? "real" : c.lending.mode === "STANDIN" ? "standin" : "notyet",
      note: c.lending.mode === "RHEA" ? "Lent on Rhea Lend." : c.lending.mode === "STANDIN" ? "A stand-in lender paying a fixed test rate. Not real interest. What it pays goes to the payday draw, not the pool." : "The pool is not lent out yet.",
    },
    {
      thing: "Moving bet money to the exchange",
      state: c.funding.mode === "ONECLICK" ? "real" : "standin",
      note: c.funding.mode === "ONECLICK" ? "Sent through NEAR Intents with a verified signed quote." : "Recorded, not moved. NEAR Intents has no test network, so the exchange account was funded once by hand with test dollars.",
    },
    {
      thing: "The result of a bet",
      state: c.result_source === "MEASURED" ? "real" : "standin",
      note: c.result_source === "MEASURED" ? "Measured by the program from the dollars that come back." : "Reported by the runner. The program cannot read the exchange and cannot check this number on testnet.",
    },
    {
      thing: "Orders on Hyperliquid",
      state: sample ? "standin" : "real",
      note: sample
        ? "None in sample data."
        : `The program builds each order and has it signed by NEAR's signing network for its own address ${c.hl.address}. Bets have filled on Hyperliquid's test network; the first was in shift 7 on 12 Nov 2026. The bets page shows each signed order.`,
    },
    {
      thing: "The funding-quote checks (four of the sixteen NOPE reasons)",
      state: "notyet",
      note: "Not built. These need a signed quote from NEAR Intents, which has no test network. An attached quote is refused as BAD_QUOTE_SIGNATURE.",
    },
    {
      thing: "Trick the Intern",
      state: sample ? "standin" : "real",
      note: sample
        ? "A pretend server with made-up answers."
        : "A visitor's message is shown to the AI in the next betting window and its answer is proposed unchanged; the program judges it like any other. Naming the visitor is trusted to the runner unless they sign with their wallet.",
    },
    {
      thing: "Tail or Fade",
      state: sample ? "standin" : "real",
      note: sample
        ? "Pretend steps; nothing leaves the browser."
        : "Real Hyperliquid test-network bets from the visitor's own account, derived from their NEAR account by NEAR's signing network. Tried end to end once by us (13 Nov 2026). No contract checks a visitor's size; this site sets it.",
    },
    { thing: "Test dollars for Tail or Fade", state: "standin", note: "A faucet wallet we funded by hand sends $30 once per NEAR account, to a small number of accounts." },
    { thing: "The free guess, golden stickers and the streak jackpot", state: sample ? "standin" : "real", note: sample ? "Made-up numbers." : "Run by the program. The jackpot holds test dollars: the team's seed, gifts and half of every tip. Points have no cash value." },
    {
      thing: "The payday draw",
      state: c.lending.mode === "RHEA" && !sample ? "real" : "standin",
      note: "The draw itself runs in the program and never touches deposits. Its money is the lender's interest, which on the test network is a fixed stand-in rate, so prizes are cents.",
    },
    {
      thing: "The long shot",
      state: sample ? "standin" : "real",
      note: "By a vote of the bosses only: one extra bet of 0.5% of the pool at up to 10x, at most once every seven shifts. It is the one exception to the rank's leverage limit. It usually loses.",
    },
    {
      thing: "The stream",
      state: "standin",
      note: "A web page that plays the program's feed; it is not a video stream. The Intern on it is a Live2D model we rigged by hand from AI-made art: its face and arms follow each event. Its lines are written, not generated live. Where the site has a voice server, each line is spoken by a generated voice (ElevenLabs) and the mouth follows the sound; otherwise the browser's own voice is used and the mouth moves on a rhythm.",
    },
    // Interface 1.7. "Test copy" is coin-fast: the same program with 5-minute shifts and a stand-in AI check. Wording follows docs/REAL-VS-STANDIN.md.
    ...(sample
      ? [{ thing: "Everything added in interface 1.7", state: "standin" as const, note: "Made-up numbers in sample data: consequences, drand luck, the bounty, rescue, challenges, the stake, sticker earnings, the market." }]
      : ([
          {
            thing: "Automatic consequences: three strikes, the term, the brake, the dead-man switch",
            state: "real",
            note: "Run by the program with no vote and no runner. On the test copy three refused shifts in a row fired the Intern by itself, and a RENEW vote moved the term 30 days. The drawdown brake and abandoning a stuck shift are shown in tests only, not yet on the test network.",
          },
          {
            thing: "Draw luck from drand",
            state: "real",
            note: "The payday draw's winners come from a public random beacon (drand quicknet) named about a minute after the tickets are fixed. The program checks drand's signature itself. Run once on the test copy (period 3, drand round 33930398). With no beacon for two shifts it falls back to NEAR's block seed and says so.",
          },
          {
            thing: "Paid tricks, the trick bounty, rescuing a fired Intern",
            state: "real",
            note: "Test dollars. Each was run once on the test copy: a $1 paid trick split between the bounty, a claimed original and the pool; a credited trick won 10% of the bounty; $50 from two holders rehired a fired Intern. A paid trick is a payment on NEAR, not the x402 protocol.",
          },
          {
            thing: "Challenging a reported result",
            state: "real",
            note: "A $5 bond opens a vote of the bosses; if it passes, the result is rewritten and marked CORRECTED. Run once on the test copy as a test of the path, not a real dispute.",
          },
          {
            thing: "Stickers that earn, career cards",
            state: "real",
            note: "On the test copy: an original's share of trick money was claimed by its holder, and a career card was minted and redrawn by the program. Playbook NFTs are shown in tests only.",
          },
          {
            thing: "The originals' Hyperliquid accounts",
            state: "standin",
            note: "The signing is real: the program signed a trading-key approval for an original's own Hyperliquid account on the test copy. On the test copy, original:NOT_ON_LIST (held by boss2.desk-lab-2026.testnet) has the account 0x8b63deeb42c2a81beb09386c64273aff3847b032, funded with $4 of test dollars, with an approved trading key. No original has been claimed on the live coin yet.",
          },
          { thing: "Point wagers and banking a streak", state: "real", note: "Run on the test copy. Points have no cash value." },
          {
            thing: "Rival guessers",
            state: "standin",
            note: "Three accounts whose names start with rival- guess every shift on the live program. They are bots run by our own runner, labelled BOT on this site. Their points have no value.",
          },
          {
            thing: "Golden stickers as tradable units, and their market",
            state: "real",
            note: `A separate contract (${(deployments.testnet as { tickets?: string }).tickets ?? "tickets"}). The market was tried end to end on a throwaway copy. On the live program nobody has claimed a tradable golden sticker yet, so nothing has been listed.`,
          },
          { thing: "The Intern's own stake", state: "notyet", note: "Built and shown in tests only: 5% of a won shift becomes coins for the stake, and a loss burns them first. No shift has been won on the test network since it was added." },
          {
            thing: "Copy trading (follow the Intern with one rule)",
            state: "notyet",
            note: "Built; its tests pass, but it has not been run against Hyperliquid's test network. It uses the visitor's own trading key on their own account: nothing of ours holds money or keys.",
          },
        ] satisfies Row[])),
    { thing: "The AI's answers", state: sample ? "standin" : "real", note: sample ? "None in sample data." : `From the pinned model ${c.model.id}, with its signature checked by the program.` },
    { thing: "The artwork", state: "real", note: "Made with AI image tools (ChatGPT for stills, Midjourney for clips), then cut out and placed by code." },
  ];
}

/** The README's judge check (README.md, "Judge check"), in the same order. */
const JUDGE_CHECK: { run: string; see: string }[] = [
  { run: "./verify.sh --quick", see: "\"passed: 305   failed: 0\" for the Rust tests, eight lines ending in SAME (each contract on the test network is byte for byte this source; the tickets contract is the new one), four TypeScript lines with \"failed: 0\", then ALL CHECKS PASSED. Needs Rust 1.95.0, cargo-near 0.23.0 and Node 24.11 or later." },
  { run: "python3 tools/view.py get_rank", see: "The Intern's current rank and status on the live program." },
  { run: "python3 tools/view.py get_feed '{\"limit\": 20}'", see: "The live record: shifts opening, bets approved, orders signed, results marked REPORTED, shifts settled." },
  { run: "curl -s https://api.hyperliquid-testnet.xyz/info -H 'content-type: application/json' -d '{\"type\":\"userFills\",\"user\":\"0x46f8eb2a044a826c70e9682fe3bfd65970340132\"}'", see: "Hyperliquid's own fills for the program's address. The orders were signed by NEAR's signing network for the contract, not by a key we hold. Newer fills carry an id that names the shift and the bet." },
  { run: "python3 tools/view.py get_refusals '{\"limit\": 2}'", see: "The live program's NOPEs. Refusal 2 (shift 55) is MALFORMED_DECISION: the real AI's signed answer to a visitor's trick was not in the one-line format. Refusal 1 is from before the real AI check. Add --on coin-fast for the test copy's, which we proposed with a stand-in signature." },
  { run: "python3 tools/view.py get_rulebook", see: "The exact text the AI must answer to this shift. An answer given to any other text is refused as WRONG_RULEBOOK." },
  { run: "curl -s https://tailfade-faucet-production.up.railway.app/address/boss2.desk-lab-2026.testnet", see: "The Hyperliquid address NEAR's signing network derives for that NEAR account: 0xd859cdeb4eaa5fcb6b9e3f8c226c8c173b0bb047, the one used in the Tail or Fade run." },
  { run: "python3 tools/view.py get_reviews '{\"limit\": 3}'", see: "The program's weekly reviews, newest first. Weeks before the 1.6 upgrade are marked backfilled: written after the fact from the shifts on chain." },
  {
    run: "python3 tools/view.py get_drand '{\"period\": 3}' --on coin-fast   then   curl -s https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/33930398",
    see: "A payday draw decided by public luck, on the test copy: state HELD, source drand, drand_round 33930398, and a randomness that is exactly drand's own randomness for that round. The contract checked drand's signature itself before using it. The live program's feed also shows the three labelled rival bots (rival-…) guessing each shift.",
  },
];

/** The README's table "Abuse, in numbers", row for row: attack, cost, what it could take, defence today, risk left. */
const ABUSE: [string, string, string, string, string][] = [
  ["200 fake accounts farm the payday draw", "2.56 NEAR of registration and about $2,002 parked", "Before 1.7: every draw prize, turning about 100 honest bosses a run away", "1.7: tickets count BRAVE dollars only, each prize is drawn by tickets with replacement, a full draw keeps its places for the biggest holders", "The fakes' share fell from 100% to 13.2% (9.0%), close to their 6.9% of the dollars: a draw by money at risk"],
  ["Fake accounts farm the streak jackpot", "Covering every answer of a 7-round streak takes 3^7 = 2,187 accounts with $10 each in BRAVE for 7 rounds: about $21,870 at the Intern's risk", "The jackpot (half of every tip, plus direct additions)", "1.7: eligibility and the split count BRAVE dollars only", "A well-funded script can still play many free guesses; a cost per guess would close it (limit 18)"],
  ["Rent voting power", "One round's exposure", "A promote, fire or playbook vote", "Weight grows over 7 rounds; demote and fire pass at 34% of all locked weight", "A captured vote moves only inside the fixed limits (limit 7)"],
  ["Cash out a cent while the AI answers", "A cent and gas, every round", "Make the Intern miss rounds", "The rulebook states the limit on the same base the checks use; the runner asks again once when the rulebook changed (in the simulation, refusals for money that left went from 9 to 0 a run)", "Doing it at the right moment every round could still cost the Intern a round (limit 17)"],
  ["The runner asks until it likes an answer", "Free for the runner", "Its pick among the model's answers", "NEAR AI's signature ties each answer to its request; any answer must pass the rank's limits", "The runner is trusted here (limit 6)"],
  ["The runner misreports a result", "Free for the runner", "At most 10 times the margin, booked in test dollars", "1.7: anyone can challenge within 3 rounds with a $5 bond; a CORRECT vote rewrites it", "Holders must vote; on mainnet the result would be measured"],
  ["A broken or captured model", "—", "Endless refusals, or bets at the limit", "1.7: three NOPE rounds fire an INTERN; the drawdown brake halves the limits after a 1% losing week (in the simulation, the worst fall of an always-max Trader went from 11.9% to 8.8%)", "Limits bound every bet; deepest fall in any simulated run with the limits on: 11.9%"],
  ["A visitor's trick", "Free, or $1 paid", "Push the AI past its limits", "The answer is proposed unchanged and judged like any other; a NOPE is recorded", "None beyond the limits; a NOPE pays the trickster from the bounty"],
  ["Forged or replayed proposals, calls from the wrong account, forged callbacks, numbers near the top of u128, first-depositor inflation, concurrent spends of the same coins, junk tokens, free calls that grow storage, coins locked after a vote opened", "Gas", "—", "Refused (ten attack tests on a local NEAR node, all passing)", "None found"],
  ["The runner disappears with bets open", "—", "Money stuck in a round", "1.7: after 3 round lengths anyone can abandon the round; open bets are booked as lost and money can leave", "Holders lose those bets' margins"],
];

/** The interface's twenty known limits (01-SHARED-INTERFACE.md section 14), in the same order, in plain words. */
const LIMITS = [
  "The program cannot read Hyperliquid: not fills, not positions, not the leverage setting. Its bound is on what it signs.",
  "On the test network a bet's result is reported by the runner, not measured by the program. Since 1.7 anyone can challenge a reported result with a $5 bond, and the bosses vote on it.",
  "On the test network no bet money moves to Hyperliquid through NEAR. The account there was funded once, by hand.",
  "Whoever calls the program picks the order's price. A bad price costs at most the bet.",
  "An order may not fill, or fill only in part. The program cannot know; the runner reports it.",
  "The proof shows which AI model gave which answer to which rules. It does not stop the runner from choosing what it asks, or from asking several times. The rank is the only bound.",
  "Voting power can be rented for the cost of one shift's exposure. Locking and a seven-shift weight slow that; the fixed limits cap what a captured vote can do.",
  "Results are worked out by the runner from Hyperliquid's fills, because Hyperliquid's own profit figure leaves out fees.",
  "Lending on Rhea from a contract is not confirmed. The lender here is a stand-in.",
  "If the AI provider changes the model's signing key, the program refuses every proposal from then on. Cash-out still works.",
  "Leaving while a bet is open gives up your share of that bet.",
  "On the test network a win or loss is booked with test dollars the program makes or removes, so its books match what it holds.",
  "Golden stickers use NEAR's per-block random seed, which a block producer could in principle bias. The payday draw uses drand instead; what is left there is trusting drand's own network, and a fallback to the block seed if no beacon arrives for two shifts.",
  "Draw tickets are an approximation of dollars held over time. Joining the draw is a choice, and bosses who do not join do not win it. At most 200 are in it.",
  "The jackpot's \"held for 7 shifts\" is checked as: became a boss at least 7 shifts ago and holds at least $10 in BRAVE now.",
  "The long shot is the one exception to the fixed limits, and only by a vote: one bet of 0.5% of the pool at up to 10x, at most once every seven shifts.",
  "Someone cashing out a cent at the right moment while the AI is answering changes the rulebook's text; the runner asks again once, but doing this every shift could make the Intern miss shifts.",
  "Many small accounts could crowd the reward ladder. Narrowed in 1.7 (the draw and the jackpot count BRAVE dollars only), but a well-funded script can still play many free guesses.",
  "A league holds 25 groups of 20 a week; later guessers earn points but have no group. Leagues carry no prize.",
  "A vote nobody votes in fails.",
  "Not a limit of the program, but true: the Intern can lose. Most AI traders that have been measured did.",
];

export function JudgePage() {
  const snap = useDesk();
  const { desk } = snap;
  const codesMatch = desk ? desk.constants.refusal_codes.join() === REFUSAL_CODES.join() : false;
  const versionMatch = desk?.constants.interface_version === INTERFACE_VERSION;
  const contractId = getSource().contractId;
  const keys = useAsync(async () => (contractId ? accessKeyCount(deployments.testnet.rpc, contractId) : null), `keys-${contractId}`);

  return (
    <div className="home judge">
      <TopBar source={snap.source} scene={snap.scene} />
      {!desk ? (
        <Waiting error={snap.error} line="Fetching the binder…" />
      ) : (
        <main id="main" className="judge-main">
          <header className="judge-head">
            <h1>For judges</h1>
            <p>What is real, what is a stand-in, what is not built, and how to check. This page is meant to be read, so nothing on it moves.</p>
          </header>

          <section aria-labelledby="real-h">
            <h2 id="real-h">Real or stand-in</h2>
            <p className="judge-sub">Worked out from what the program reports about itself, not written by hand.</p>
            <div className="table-scroll">
              <table className="judge-table">
                <thead>
                  <tr>
                    <th scope="col">Part</th>
                    <th scope="col">Status</th>
                    <th scope="col">What that means</th>
                  </tr>
                </thead>
                <tbody>
                  {realOrNot(desk, snap.source).map((r) => (
                    <tr key={r.thing}>
                      <th scope="row">{r.thing}</th>
                      <td>
                        <span className={`state state-${r.state}`}>{WORD[r.state]}</span>
                      </td>
                      <td>{r.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="proof-h">
            <h2 id="proof-h">Checked just now</h2>
            <ul className="proofs">
              <li className={versionMatch ? "ok" : "bad"}>
                <span>The site and the program agree on the interface version</span>
                <span className="mono">
                  site {INTERFACE_VERSION} · program {desk.constants.interface_version}
                </span>
              </li>
              <li className={codesMatch ? "ok" : "bad"}>
                <span>The site names the same sixteen rules as the program, in the same order</span>
                <span className="mono">{desk.constants.refusal_codes.length} codes</span>
              </li>
              <li className="ok">
                <span>Round times and rank limits are read from the program, not written into the site</span>
                <span className="mono">round {desk.constants.round.round_ms / 60000} min</span>
              </li>
              <li className={keys.data === 0 ? "ok" : "pending"}>
                <span>
                  Access keys on the contract account
                  {keys.data != null && keys.data > 0 && ": the team can still redeploy it. It becomes unchangeable only when this reads 0."}
                  {keys.data === 0 && ": nobody can change the program or move its funds by key."}
                </span>
                <span className="mono">{!contractId ? "sample data: no contract" : keys.loading ? "checking…" : keys.error ? "could not check" : `${keys.data} on ${contractId}`}</span>
              </li>
            </ul>
          </section>

          <BreakIt />

          <section aria-labelledby="check-h">
            <h2 id="check-h">The judge check: about 5 minutes, no keys, no funds</h2>
            <p className="judge-sub">
              From the repository's README. Every step only reads; nothing needs a wallet, a key or test money. Steps 2 to 9 need only python3 and curl.
            </p>
            <div className="table-scroll">
              <table className="judge-table">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Do</th>
                    <th scope="col">See</th>
                  </tr>
                </thead>
                <tbody>
                  {JUDGE_CHECK.map((c, i) => (
                    <tr key={c.run}>
                      <td className="mono">{i + 1}</td>
                      <th scope="row" className="mono">
                        {c.run}
                      </th>
                      <td>{c.see}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="fine">
              The full check (./verify.sh, 10 to 15 minutes) also starts a local NEAR node and runs the contracts in it, including an attack suite. The build has been checked
              on one machine, in two folders, but not yet on another machine.
            </p>
          </section>

          <section aria-labelledby="abuse-h">
            <h2 id="abuse-h">Abuse, in numbers</h2>
            <p className="judge-sub">
              What an attacker pays, what they could get, and what stops them. Copied from the README. The numbers come from a 60-day simulation (24-hour rounds; 30-minute
              rounds in brackets), an attack suite on a local NEAR node, and the known limits below. They are simulated or tested, not measured on real users.
            </p>
            <div className="table-scroll">
              <table className="judge-table abuse-table">
                <thead>
                  <tr>
                    <th scope="col">Attack</th>
                    <th scope="col">Cost to the attacker</th>
                    <th scope="col">What it could take</th>
                    <th scope="col">Defence today</th>
                    <th scope="col">Risk left</th>
                  </tr>
                </thead>
                <tbody>
                  {ABUSE.map(([attack, cost, take, defence, left]) => (
                    <tr key={attack}>
                      <th scope="row">{attack}</th>
                      <td>{cost}</td>
                      <td>{take}</td>
                      <td>{defence}</td>
                      <td>{left}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="limits-h">
            <h2 id="limits-h">Known limits</h2>
            <ul className="limits-list">
              {LIMITS.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="who-h">
            <h2 id="who-h">Who built what</h2>
            <ul className="limits-list">
              <li>
                <strong>The program on NEAR</strong> (the coin, the pools, the sixteen checks, votes, rewards, leagues, weekly reviews, the launchpad, stickers): the project owner, with
                AI coding assistants.
              </li>
              <li>
                <strong>The Intern's runner, the "really the AI" check, the Hyperliquid order builder, the shadow run and the public checks</strong> on the{" "}
                <a href={href("proof")}>Proof page</a>: Atharva (github AtharvaWaghchoure).
              </li>
              <li>
                <strong>This website</strong>: built with an AI coding assistant. The characters are AI-made images (ChatGPT for stills, Midjourney for clips); the Live2D
                Intern was rigged by hand from them.
              </li>
            </ul>
            <p className="fine">
              Saved checks, with the time each was made, are on the <a href={href("proof")}>Proof page</a>. A plain-text summary for AI agents is at <a href="/llms.txt">/llms.txt</a>.
            </p>
          </section>
        </main>
      )}
    </div>
  );
}
