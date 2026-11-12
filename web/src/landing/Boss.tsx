import { useRef, useState, type CSSProperties } from "react";
import { BossMug } from "../cast/BossMug";
import { Intern, type InternMood } from "../cast/Intern";
import type { RankName } from "../chain/types";
import { chime, pop, thud } from "./sound";

const RANKS: { rank: RankName; name: string; facts: string[] }[] = [
  { rank: "INTERN", name: "Intern", facts: ["2% of the pool per bet", "1 bet a day", "Coins going up only"] },
  { rank: "ANALYST", name: "Analyst", facts: ["5% of the pool per bet", "2 bets a day", "Coins going up only"] },
  { rank: "TRADER", name: "Trader", facts: ["10% of the pool per bet", "3 bets a day", "Up or down, up to 2x"] },
];
const FIRED = ["No new bets", "Open bets get closed", "You can still cash out"];
const BOSSES = ["alice.near", "bob.near", "carol.near", "dave.near", "erin.near", "frank.near", "gus.near"];

type Kind = "promote" | "demote" | "fire" | "rehire";
const WORDS: Record<Kind, { doing: string; done: string }> = {
  promote: { doing: "The bosses are voting to promote…", done: "Promoted. A real promotion takes a full day to kick in; here it's instant so you can see it." },
  demote: { doing: "The bosses are voting to demote…", done: "Demoted. That one really is instant: the smaller limits apply at once." },
  fire: { doing: "The bosses are voting to fire…", done: "Fired. It stops betting that minute. Your money stays where it is." },
  rehire: { doing: "The bosses are voting to rehire…", done: "Rehired. It starts again at the bottom." },
};

/** You are the boss: press a button, the mugs vote, the Intern's rank changes. */
export function Boss() {
  const [at, setAt] = useState(0);
  const [fired, setFired] = useState(false);
  const [vote, setVote] = useState<{ kind: Kind; yes: number } | null>(null);
  const [mood, setMood] = useState<InternMood>("idle");
  const [note, setNote] = useState("Press a button. You're one of the bosses.");
  const timers = useRef<number[]>([]);

  const busy = vote !== null;
  const run = (kind: Kind) => {
    if (busy) return;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const later = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));
    setVote({ kind, yes: 0 });
    setNote(WORDS[kind].doing);
    setMood("waiting");
    const quick = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 170;
    BOSSES.forEach((_, i) =>
      later(quick * (i + 1), () => {
        setVote({ kind, yes: i + 1 });
        pop();
      }),
    );
    later(quick * BOSSES.length + 350, () => {
      if (kind === "promote") setAt((a) => Math.min(2, a + 1));
      if (kind === "demote") setAt((a) => Math.max(0, a - 1));
      if (kind === "fire") setFired(true);
      if (kind === "rehire") {
        setFired(false);
        setAt(0);
      }
      if (kind === "fire") thud();
      else chime();
      setMood(kind === "fire" ? "fired" : kind === "demote" ? "refused" : "promoted");
      setNote(WORDS[kind].done);
      setVote(null);
    });
    later(quick * BOSSES.length + 2600, () => setMood((m) => (m === "fired" ? "fired" : "idle")));
  };

  const r = RANKS[at]!;
  const facts = fired ? FIRED : r.facts;
  const name = fired ? "Fired" : r.name;

  return (
    <section className="boss" aria-labelledby="boss-h">
      <div className="boss-stage">
        <p className={`boss-rank${fired ? " is-fired" : ""}`} key={name} aria-hidden="true">
          {name}
        </p>
        <Intern mood={fired ? "fired" : mood} rank={r.rank} size={520} />
        <div className="boss-mugs" aria-hidden="true">
          {BOSSES.map((b, i) => (
            <span key={b} className={`boss-mug${vote && i < vote.yes ? " has-voted" : ""}`} style={{ "--i": i } as CSSProperties}>
              <BossMug accountId={b} size={84} />
            </span>
          ))}
        </div>
        <div className={`vote-bar${busy ? " is-on" : ""}`} aria-hidden="true">
          <span style={{ width: `${((vote?.yes ?? 0) / BOSSES.length) * 100}%` }} />
        </div>
      </div>

      <div className="boss-words">
        <p className="act-kicker">You are the boss</p>
        <h2 id="boss-h">Hold the coin and the Intern works for you.</h2>
        <p className="boss-now">
          Right now it is <strong>{fired ? "fired" : `${/^[AEIOU]/.test(r.name) ? "an" : "a"} ${r.name}`}</strong>.
        </p>
        <ul className="facts" key={name}>
          {facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <div className="vote-buttons">
          {fired ? (
            <button className="vote-btn vote-yes" onClick={() => run("rehire")} disabled={busy}>
              Rehire
            </button>
          ) : (
            <>
              <button className="vote-btn vote-yes" onClick={() => run("promote")} disabled={busy || at === 2}>
                Promote
              </button>
              <button className="vote-btn vote-mid" onClick={() => run("demote")} disabled={busy || at === 0}>
                Demote
              </button>
              <button className="vote-btn vote-no" onClick={() => run("fire")} disabled={busy}>
                Fire
              </button>
            </>
          )}
        </div>
        <p className="boss-note" role="status">
          {note}
        </p>
        <p className="boss-fixed">The numbers in each rank are fixed. No vote can change them. This is a pretend vote; real ones happen at the desk.</p>
      </div>
    </section>
  );
}
