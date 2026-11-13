import "../pages/v17-trick.css";
import { REFUSAL_CODES, type RefusalCode } from "../chain/types";
import { LIGHTS, lightFor } from "../lib/refusals";

const TX = "https://testnet.nearblocks.io/txns/";

type Example = { tx: string; where: "live" | "copy"; what: string };

/**
 * A refused transaction for each code that has one, as found by the runner's read-only tool
 * (`cd runner && npm run refusals`, run 2026-11-13) and listed in docs/REAL-VS-STANDIN.md.
 * "copy" is coin-fast, the test copy: its AI check is a stand-in and we proposed those answers ourselves.
 */
const EXAMPLES: Partial<Record<RefusalCode, Example>> = {
  MALFORMED_DECISION: { tx: "55kMk6s7S1BiWebAau1yLvFjkuWYeo9a8sDV8iBpSrvv", where: "live", what: "Shift 55: the real AI answered a visitor's trick with a sentence instead of the one-line format." },
  OVER_TRADE_LIMIT: { tx: "5JND4cTbyXHN5FMEMURukEt2HVnWtjmgRky4fvWBzmtW", where: "live", what: "Shift 2: $10 asked, $1.00 allowed. From before the real AI check was switched on." },
  OUTSIDE_WINDOW: { tx: "5ssSnM69r2rfvnNqpPdwEhw5UW9Wsp91DVMLURUVJeKe", where: "copy", what: "Proposed after the betting window had closed." },
  FIRED: { tx: "DuTxFWRfc9hde1upCbeiDfThcAuzUM9ef7ABbZsJnXBD", where: "copy", what: "Proposed while the Intern was fired." },
  BAD_MODEL_SIGNATURE: { tx: "5Fi38yNYqVpCjmvesyBsWpHq5nck6EQQLWFRqJ6LaeBn", where: "copy", what: "The stand-in check refusing a signature it does not accept." },
  NOT_ON_LIST: { tx: "4VoxFZW92Qyd6ALLE5H7Gp1qgH2y8cJfNr6WCuXZUhrx", where: "copy", what: "WIF, which an Intern-rank may not bet on." },
  SHORT_NOT_UNLOCKED: { tx: "ELpkMweJAGFew4hNqddfqn3uD9gyMEBvT3FSXfiv8JJH", where: "copy", what: "A bet on DOGE falling, below Trader rank." },
  ZERO_MARGIN: { tx: "9jtMYg8AXRWDuwhdnJapJnkdhZ2vGPCPtNL8mAdmc8qY", where: "copy", what: "A bet of $0." },
  OVER_LEVERAGE: { tx: "2VzPaXTJJcEJHJcHuCdvvEzjoQRmfq2qd8fmSJZrGKSK", where: "copy", what: "10x asked, 1x allowed." },
  BAD_QUOTE_SIGNATURE: { tx: "CSP4fb7iDvuymMHMsv4wGNXX3EJaxAtAUmZi2Z1aZSrJ", where: "copy", what: "A funding quote was attached; the quote check is not built, so any quote is refused." },
};

/** Why a code has no refused transaction to show. */
const NO_EXAMPLE: Partial<Record<RefusalCode, string>> = {
  WRONG_RULEBOOK: "The test copy's stand-in check does not read the request, so it cannot be shown there; the live AI has not caused one.",
  TOO_MANY_TRADES: "Needs a bet already open in the same shift.",
  OVER_ROUND_LIMIT: "Needs a bet already open in the same shift.",
  STALE_QUOTE: "The funding-quote check is not built.",
  QUOTE_MISMATCH: "The funding-quote check is not built.",
  TOO_EXPENSIVE: "The funding-quote check is not built.",
};

/** "Try to break it": the sixteen reasons the program refuses a bet, each with a real refused transaction where one exists. */
export function BreakIt() {
  const have = REFUSAL_CODES.filter((c) => EXAMPLES[c]).length;
  return (
    <section className="breakit" aria-labelledby="breakit-h">
      <h2 id="breakit-h">Try to break it: all sixteen reasons</h2>
      <p className="judge-sub">
        The program has sixteen reasons to say NOPE, checked in this order. {have} of them have a refused transaction on the NEAR test network you can open. A refusal is a
        successful transaction that moves no money. All sixteen are also covered by the program's own tests.
      </p>
      <div className="table-scroll">
        <table className="judge-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Reason</th>
              <th scope="col">Check</th>
              <th scope="col">A refused transaction</th>
            </tr>
          </thead>
          <tbody>
            {REFUSAL_CODES.map((code, i) => {
              const e = EXAMPLES[code];
              return (
                <tr key={code}>
                  <td className="mono">{i + 1}</td>
                  <th scope="row" className="mono">
                    {code}
                  </th>
                  <td>{LIGHTS[lightFor(code)]?.name}</td>
                  {e ? (
                    <td>
                      <a href={TX + e.tx} target="_blank" rel="noreferrer" className="mono">
                        {e.tx.slice(0, 10)}…
                      </a>{" "}
                      {e.what}
                      <span className="breakit-where">{e.where === "live" ? "On the live program." : "Test copy, stand-in signature: proposed by us, not by the AI."}</span>
                    </td>
                  ) : (
                    <td className="is-none">No example yet. {NO_EXAMPLE[code]}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="fine">
        "Test copy" is coin-fast.desk-lab-2026.testnet, the same program with 5-minute shifts. Its "really the AI" check is a stand-in, so we wrote those answers ourselves to
        show each rule refusing. Found with the runner's read-only tool (<span className="mono">npm run refusals</span>) on 13 Nov 2026.
      </p>
    </section>
  );
}
