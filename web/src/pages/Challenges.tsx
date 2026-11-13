import { useState } from "react";
import "./v17-mine.css";
import { signIn, toE6, useDoing, useSession } from "../chain/session";
import { getChain, getSource, type Desk } from "../chain/store";
import type { Challenge, Position } from "../chain/types";
import { isBot, shortAccount, titleCase, usd } from "../lib/format";
import { href } from "../lib/nav";
import { useAsync } from "../lib/useAsync";
import { Notice } from "../ui/Notice";

const STATE_WORD: Record<Challenge["state"], string> = {
  OPEN: "Vote open",
  PASSED: "Vote passed",
  APPLYING: "Being applied",
  APPLIED: "Corrected",
  FAILED: "Vote failed",
};
const STATE_LINE: Record<Challenge["state"], string> = {
  OPEN: "The bosses are voting on it.",
  PASSED: "The bosses agreed. Anyone may now apply the correction.",
  APPLYING: "The correction is on its way.",
  APPLIED: "The bet now shows the challenged figure, and the bond went back to the challenger.",
  FAILED: "The bosses did not agree. The bond went to the BRAVE pool.",
};

/**
 * Challenging a reported result (interface 1.7, section 9.14). The runner reports each bet's result; for three
 * shifts afterwards a registered account may put up a bond and say what the right figure is. The bosses vote.
 */
export function Challenges({ desk }: { desk: Desk }) {
  const session = useSession();
  const [bump, setBump] = useState(0);
  const doing = useDoing(() => setBump((b) => b + 1));
  const seq = desk.feed[desk.feed.length - 1]?.seq ?? 0;
  const cur = desk.round.id;
  const data = useAsync(async () => {
    const chain = getChain();
    const ch = await chain.getChallenges();
    const ids = Array.from({ length: ch.window_rounds + 1 }, (_, i) => cur - i).filter((id) => id >= 1);
    const positions = (await Promise.all(ids.map((id) => chain.getPositions(id)))).flat();
    return { ch, positions };
  }, `challenges-${seq}-${bump}`);
  const [pick, setPick] = useState<number | null>(null);
  const [back, setBack] = useState("");
  const [reason, setReason] = useState("");

  // An older copy of the program has no challenges: show nothing rather than an error
  if (!data.data) return null;
  const { ch, positions } = data.data;
  const taken = new Set(ch.challenges.map((c) => c.position_id));
  const open: Position[] = positions.filter((p) => p.result_source === "REPORTED" && p.returned !== null && cur - p.round_id <= ch.window_rounds && !taken.has(p.id));
  const chosen = open.find((p) => p.id === pick) ?? open[0] ?? null;
  const claimed = toE6(back) ?? (back.trim() === "0" ? "0" : null);
  const actions = session.actions;
  const fast = getSource().contractId?.startsWith("coin-fast");

  return (
    <section className="card challenges" aria-labelledby="ch-h">
      <h2 id="ch-h">Challenge a result</h2>
      <p>
        The program cannot read Hyperliquid, so each bet's result is <strong>reported by the runner</strong>. Every order carries an id, so anyone can compare a reported
        result with Hyperliquid's own fills (the <a href={href("proof")}>proof page</a> does). If one looks wrong, you can challenge it for {ch.window_rounds} shifts after
        the bet's shift: put up a {usd(ch.bond)} bond, say how many dollars really came back, and the bosses vote.
      </p>
      <p className="fine">
        If the vote passes, the bet is corrected and your bond comes back as a prize. If it fails, the bond goes to the BRAVE pool. One challenge per bet. Your reason is
        shown here and is never given to the AI. Test dollars: on the test network the pool's difference is made or removed as test dollars.
      </p>

      {(doing.error || doing.done) && (
        <Notice error={doing.error} done={doing.done} onClose={doing.clear} />
      )}

      {ch.challenges.length === 0 ? (
        <p className="pencil">Nobody has challenged a result{fast ? " on this copy" : ""} yet.</p>
      ) : (
        <ul className="ch-list" aria-label="Challenges">
          {ch.challenges.map((c) => (
            <li key={c.vote_id}>
              <p>
                <span className={`ch-state is-${c.state}`}>{STATE_WORD[c.state]}</span>
                <strong>Bet {c.position_id}</strong>: reported <span className="mono">{usd(c.reported)}</span> back,{" "}
                <span title={c.challenger}>
                  {shortAccount(c.challenger)}
                  {isBot(c.challenger) && <span className="bot-tag">BOT</span>}
                </span>{" "}
                says <span className="mono">{usd(c.claimed)}</span>. Bond {usd(c.bond)}.
              </p>
              <p className="pencil">“{c.reason}”</p>
              <p className="fine">
                {STATE_LINE[c.state]} <a href={href("vote")}>Vote {c.vote_id}</a>
                {fast && " · This copy is our test copy: this challenge was a test of the path, not a real dispute."}
              </p>
              {c.state === "PASSED" &&
                (actions ? (
                  <button className="btn" disabled={!!doing.busy} onClick={() => doing.run(`apply-${c.vote_id}`, () => actions.applyCorrection(c.vote_id), `Bet ${c.position_id} is corrected.`)}>
                    {doing.busy === `apply-${c.vote_id}` ? "Applying…" : "Apply the correction"}
                  </button>
                ) : (
                  <p className="fine">Clock in to apply the correction. Anyone may.</p>
                ))}
            </li>
          ))}
        </ul>
      )}

      <h3>Open a challenge</h3>
      {open.length === 0 ? (
        <p className="pencil">No reported result from the last {ch.window_rounds} shifts is open to challenge right now.</p>
      ) : !actions ? (
        <>
          <p>
            {open.length} reported {open.length === 1 ? "result" : "results"} can be challenged. Clock in to open a challenge.
          </p>
          {session.canSignIn && (
            <button className="btn" onClick={signIn}>
              {session.pretend ? "Clock in with a pretend account" : "Clock in with a NEAR wallet"}
            </button>
          )}
        </>
      ) : (
        <form
          className="ch-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!chosen || claimed === null || !reason.trim()) return;
            void doing.run("challenge", () => actions.challenge(chosen.id, claimed, reason.trim(), ch.bond), `Your challenge of bet ${chosen.id} is open. The bosses vote now.`);
          }}
        >
          <label>
            Which bet
            <select value={chosen?.id ?? ""} onChange={(e) => setPick(Number(e.target.value))}>
              {open.map((p) => (
                <option key={p.id} value={p.id}>
                  Bet {p.id}, shift {p.round_id}: {titleCase(p.side)} {p.market}, {usd(p.margin)} in, {usd(p.returned!)} reported back
                </option>
              ))}
            </select>
          </label>
          <label>
            The dollars back I say is right
            <input inputMode="decimal" placeholder={chosen ? (Number(chosen.returned) / 1e6).toFixed(2) : "0.00"} value={back} onChange={(e) => setBack(e.target.value)} />
          </label>
          <label>
            Why (at most 140 characters, shown publicly)
            <textarea rows={2} maxLength={140} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button className="btn" disabled={!!doing.busy || claimed === null || !reason.trim() || claimed === chosen?.returned}>
            {doing.busy === "challenge" ? "Waiting for your wallet…" : `Challenge with a ${usd(ch.bond)} bond`}
          </button>
          <p className="fine">
            One wallet popup: it sends {usd(ch.bond)} of test dollars to the program with your claim. You need a registered account (paying in or guessing once registers
            you). If the challenge cannot be opened, the bond is refunded.
          </p>
        </form>
      )}
    </section>
  );
}
