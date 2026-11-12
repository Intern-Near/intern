import "./pages.css";
import deployments from "../../../interface/deployments.json";
import { accessKeyCount } from "../chain/near";
import { getSource, useDesk, type Desk } from "../chain/store";
import { useAsync } from "../lib/useAsync";
import { INTERFACE_VERSION, REFUSAL_CODES } from "../chain/types";
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
      note: c.lending.mode === "RHEA" ? "Lent on Rhea Lend." : c.lending.mode === "STANDIN" ? "A stand-in lender paying a fixed test rate. Not real interest." : "The pool is not lent out yet.",
    },
    {
      thing: "Moving bet money to the exchange",
      state: c.funding.mode === "ONECLICK" ? "real" : "standin",
      note: c.funding.mode === "ONECLICK" ? "Sent through NEAR Intents with a verified signed quote." : "Recorded, not moved. NEAR Intents has no test network.",
    },
    {
      thing: "The result of a bet",
      state: c.result_source === "MEASURED" ? "real" : "standin",
      note: c.result_source === "MEASURED" ? "Measured by the program from the dollars that come back." : "Reported by the runner. The program cannot read the exchange and cannot check this number on testnet.",
    },
    {
      thing: "Orders on Hyperliquid",
      state: "notyet",
      note: `The program builds and signs real Hyperliquid test-network orders for ${c.hl.address}. No order has filled yet: that account has no test funds.`,
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
        </main>
      )}
    </div>
  );
}
