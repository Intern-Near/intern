import "./pages.css";
import deployments from "../../../interface/deployments.json";
import { accessKeyCount } from "../chain/near";
import { getSource, useDesk, type Desk } from "../chain/store";
import { useAsync } from "../lib/useAsync";
import { INTERFACE_VERSION, REFUSAL_CODES } from "../chain/types";
import { href } from "../lib/nav";
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
    { thing: "The AI's answers", state: sample ? "standin" : "real", note: sample ? "None in sample data." : `From the pinned model ${c.model.id}, with its signature checked by the program.` },
    { thing: "The artwork", state: "real", note: "Made with AI image tools (ChatGPT for stills, Midjourney for clips), then cut out and placed by code." },
  ];
}

const BREAK_IT: { try: string; code: (typeof REFUSAL_CODES)[number] }[] = [
  { try: "Bet more than the rank's share on one bet", code: "OVER_TRADE_LIMIT" },
  { try: "Bet on a coin that is not on the rank's list", code: "NOT_ON_LIST" },
  { try: "Bet on a fall below Trader rank", code: "SHORT_NOT_UNLOCKED" },
  { try: "Ask for more leverage than the rank allows", code: "OVER_LEVERAGE" },
  { try: "Make a second bet when the rank gets one", code: "TOO_MANY_TRADES" },
  { try: "Send an answer the AI did not sign", code: "BAD_MODEL_SIGNATURE" },
  { try: "Show the AI yesterday's rules", code: "WRONG_RULEBOOK" },
  { try: "Send an answer that is not a clean bet slip", code: "MALFORMED_DECISION" },
  { try: "Propose outside betting hours", code: "OUTSIDE_WINDOW" },
  { try: "Propose after the Intern was fired", code: "FIRED" },
];

const LIMITS = [
  "The program cannot read Hyperliquid: not fills, not positions, not the leverage setting. Its bound is on what it signs.",
  "The proof shows which AI model gave which answer to which rules. It does not stop the runner from choosing what it asks, or from asking several times. The rank is the only bound.",
  "Whoever calls the program picks the order's price. A bad price costs at most the bet.",
  "Voting power can be rented for the cost of one day's exposure. Locking and a seven-day weight slow that; the fixed limits cap what a captured vote can do.",
  "Leaving while a bet is open gives up your share of that bet.",
  "If the AI provider changes the model's signing key, the program refuses every proposal from then on. Cash-out still works.",
  "A bet of exactly the rank's maximum can be refused OVER_TRADE_LIMIT if someone cashes out between the shift's opening and the proposal. The rule held; the AI did not break it.",
  "Many small accounts could crowd the payday draw and the jackpot. On the test network the prizes are cents.",
  "A league holds 25 groups of 20 a week; later guessers earn points but have no group.",
  "A vote nobody votes in fails.",
  "The Intern can lose. Most AI traders that have been measured did.",
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

          <section aria-labelledby="break-h">
            <h2 id="break-h">Try to break it</h2>
            <p className="judge-sub">
              Each of these must come back as a NOPE with exactly this code, as a successful transaction that moves no money. The buttons arrive when the contract is
              on testnet; until then this is the list it will be held to.
            </p>
            <div className="table-scroll">
              <table className="judge-table">
                <thead>
                  <tr>
                    <th scope="col">If someone tries to…</th>
                    <th scope="col">The program must answer</th>
                  </tr>
                </thead>
                <tbody>
                  {BREAK_IT.map((b) => (
                    <tr key={b.code}>
                      <th scope="row">{b.try}</th>
                      <td className="mono">{b.code}</td>
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
