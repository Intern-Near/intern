import { useState } from "react";
import { getChain } from "../chain/store";
import type { DrawResult, Drand } from "../chain/types";
import { drandUrl, fetchBeacon, replayDraw } from "../lib/drand";
import { href } from "../lib/nav";
import { useAsync } from "../lib/useAsync";
import { Who } from "../ui/BotTag";

const SOURCE_WORDS = {
  drand: "drand, a public random beacon. The program checked drand's signature itself.",
  block: "NEAR's block seed. No drand beacon was handed in in time, so the program fell back to it.",
  none: "None needed: nobody was in the draw, only one account was, or there was no prize.",
} as const;

const tickets = (t: string) => (Number(BigInt(t)) / 1e6).toLocaleString("en-GB", { maximumFractionDigits: 4 });

/**
 * Where a payday draw's luck comes from, and how to check it (interface 1.7, section 9.18).
 * `period` undefined: the draw period running now. Shows nothing on a copy of the program older than 1.7.
 */
export function DrawLuck({ period, result, sample, changeKey }: { period?: number; result?: DrawResult; sample: boolean; changeKey: string }) {
  const luck = useAsync(() => getChain().getDrand(period), `drand-${period ?? "now"}-${changeKey}`);
  const d = luck.data;
  if (!d) return period === undefined ? null : <p className="pencil">{luck.error ? "This copy of the program does not keep the draw's luck." : "Looking…"}</p>;
  // A draw held before the program kept its luck (interface 1.7) has nothing recorded
  if (result && d.state === "OPEN")
    return (
      <p className="pencil">
        {result.winner
          ? "The program has no record of this draw's luck. It was held before the program started taking its luck from drand, when draws used NEAR's block seed."
          : "Nobody was in this draw, so it needed no luck."}
      </p>
    );
  return (
    <div className="luck">
      <p className="luck-state">
        <span className={`state ${d.state === "HELD" ? "state-real" : "state-standin"}`}>{{ OPEN: "Open", WAITING: "Waiting for luck", HELD: "Held" }[d.state]}</span>{" "}
        {d.state === "OPEN" && "Period " + d.period + " is still running. When it ends, the tickets are fixed first and the luck is named after: a drand round about a minute in the future, which nobody can know yet."}
        {d.state === "WAITING" && (
          <>
            The tickets are fixed. Luck from <strong>drand round {d.drand_round}</strong>, about a minute away. If no beacon arrives within {d.wait_rounds} shifts, the
            program uses NEAR's block seed and says so.
          </>
        )}
        {d.state === "HELD" && d.source && <>Luck from: {SOURCE_WORDS[d.source]}</>}
      </p>
      {d.randomness && (
        <p className="luck-hex">
          <span className="pencil">The random number{d.drand_round ? ` (drand round ${d.drand_round})` : ""}</span>
          <code className="mono">{d.randomness}</code>
        </p>
      )}
      {d.tickets && d.tickets.length > 0 && (
        <details className="luck-tickets" open={d.state === "WAITING"}>
          <summary>
            The frozen tickets: {d.tickets.length} {d.tickets.length === 1 ? "account" : "accounts"}
          </summary>
          <ol>
            {d.tickets.map(([account, t]) => (
              <li key={account}>
                <span>
                  <Who account={account} max={28} />
                </span>
                <span className="mono">{tickets(t)}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
      {d.state === "HELD" && d.source === "drand" && d.drand_round !== null && d.randomness && <Check d={d} result={result} sample={sample} />}
      {d.state === "HELD" && !d.tickets && d.source === "block" && <p className="fine">The program no longer keeps this draw's frozen tickets, so its picks cannot be replayed here.</p>}
    </div>
  );
}

function Check({ d, result, sample }: { d: Drand; result?: DrawResult; sample: boolean }) {
  const [beacon, setBeacon] = useState<{ state: "idle" | "asking" | "match" | "different" | "failed"; theirs?: string; why?: string }>({ state: "idle" });
  const round = d.drand_round!;
  const ours = d.randomness!.toLowerCase();
  const picks = d.tickets ? replayDraw(ours, d.tickets) : [];
  const ask = () => {
    setBeacon({ state: "asking" });
    fetchBeacon(round).then(
      (b) => setBeacon({ state: b.randomness.toLowerCase() === ours ? "match" : "different", theirs: b.randomness }),
      (e: unknown) => setBeacon({ state: "failed", why: e instanceof Error ? e.message : String(e) }),
    );
  };
  return (
    <div className="luck-check">
      <h4>Check it yourself</h4>
      <ol>
        <li>
          Open{" "}
          <a href={drandUrl(round)} target="_blank" rel="noreferrer">
            drand's own page for round {round}
          </a>
          . Its "randomness" must equal the number above.
          {sample ? (
            <span className="luck-verdict">This is sample data: the number here is made up, so drand&apos;s will not match it.</span>
          ) : (
            <>
              {" "}
              <button className="pill pill-in" disabled={beacon.state === "asking"} onClick={ask}>
                {beacon.state === "asking" ? "Asking drand…" : "Compare for me"}
              </button>
            </>
          )}
          {beacon.state === "match" && (
            <span className="luck-verdict is-ok" role="status">
              MATCH. drand published the same number.
            </span>
          )}
          {beacon.state === "different" && (
            <span className="luck-verdict is-bad" role="alert">
              DIFFERENT. drand says <code className="mono">{beacon.theirs}</code>.
            </span>
          )}
          {beacon.state === "failed" && (
            <span className="luck-verdict is-bad" role="alert">
              Couldn't reach drand from this browser. {beacon.why} Open the link instead.
            </span>
          )}
        </li>
        <li>
          Replay the picks: take the first 16 bytes of the number, read backwards (little-endian), modulo the total tickets; walk the ticket list until it falls
          inside an account; then hash the number (sha256) and pick again. The first pick wins the big share; the next ten share the rest.
          {picks.length > 0 ? (
            <>
              <span className="luck-picks">
                {picks.map((a, i) => (
                  <span key={i} className={i === 0 ? "is-first" : ""}>
                    <span className="mono pencil">{i + 1}</span> <Who account={a} max={18} />
                  </span>
                ))}
              </span>
              {result?.winner && (
                <span className={`luck-verdict ${picks[0] === result.winner ? "is-ok" : "is-bad"}`} role="status">
                  {picks[0] === result.winner
                    ? "Replayed in your browser: the first pick is the recorded winner."
                    : `Replayed in your browser: the first pick is ${picks[0]}, but the recorded winner is ${result.winner}.`}
                </span>
              )}
            </>
          ) : (
            <span className="pencil"> (The program no longer keeps this period's frozen tickets, so the picks cannot be replayed on this page.)</span>
          )}
        </li>
      </ol>
    </div>
  );
}

/** A real, checkable draw on the test copy of the program. */
export function RealDrawExample() {
  return (
    <p className="fine">
      A real one to check: on the <strong>test copy</strong> of the program (coin-fast, 5-minute shifts, bets proposed by us), period 3 was drawn from{" "}
      <a href={drandUrl(33930398)} target="_blank" rel="noreferrer">
        drand round 33930398
      </a>
      . <a href={href("rewards", { contract: "coin-fast.desk-lab-2026.testnet" })}>Open this page on the test copy</a>.
    </p>
  );
}
