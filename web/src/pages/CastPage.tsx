import { useRef, useState } from "react";
import "./foundations.css";
import "./cast-page.css";
import type { RankName } from "../chain/types";
import { Intern, INTERN_MOODS, type InternMood } from "../cast/Intern";
import { Stamp, STAMP_POSES, type StampPose } from "../cast/Stamp";
import { Tin, TIN_POSES, type TinPose } from "../cast/Tin";
import { Shredder, SHREDDER_POSES, type ShredderPose } from "../cast/Shredder";
import { BossMug } from "../cast/BossMug";

const RANKS: RankName[] = ["INTERN", "ANALYST", "TRADER"];
const BOSSES = ["alice.testnet", "bob.testnet", "carol.testnet", "dave.testnet", "erin.testnet", "frank.testnet"];

function Chips<T extends string>({ label, options, value, onPick }: { label: string; options: readonly T[]; value: T; onPick: (v: T) => void }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      <span className="label">{label}</span>
      {options.map((o) => (
        <button key={o} className="chip-btn" aria-pressed={o === value} onClick={() => onPick(o)}>
          {o.toLowerCase()}
        </button>
      ))}
    </div>
  );
}

/** Step 1 page: every character in every pose, to check that nothing jumps. */
export function CastPage() {
  const [mood, setMood] = useState<InternMood>("idle");
  const [rank, setRank] = useState<RankName>("INTERN");
  const [stamp, setStamp] = useState<StampPose>("watching");
  const [tin, setTin] = useState<TinPose>("resting");
  const [shredder, setShredder] = useState<ShredderPose>("asleep");
  const timers = useRef<number[]>([]);

  const play = (steps: [number, () => void][]) => {
    timers.current.forEach(clearTimeout);
    timers.current = steps.map(([at, fn]) => window.setTimeout(fn, at));
  };
  const playNope = () =>
    play([
      [0, () => (setMood("proposing"), setStamp("watching"))],
      [900, () => setMood("waiting")],
      [1700, () => setStamp("slamming")],
      [1950, () => (setStamp("landed"), setMood("refused"))],
      [4200, () => (setStamp("watching"), setMood("idle"))],
    ]);
  const playYes = () =>
    play([
      [0, () => (setMood("proposing"), setStamp("watching"), setTin("resting"))],
      [900, () => setMood("waiting")],
      [1700, () => (setMood("happy"), setTin("coin"))],
      [3600, () => (setMood("idle"), setTin("resting"))],
    ]);

  return (
    <main className="foundations">
      <header>
        <p className="mono">STEP 1 · THE CAST</p>
        <h1>Everyone at the desk.</h1>
        <p className="lede">Switch poses. The feet should stay on the line and the body should not jump.</p>
      </header>

      <section aria-label="The desk">
        <div className="desk">
          <Tin pose={tin} size={170} />
          <Intern mood={mood} rank={rank} size={300} />
          <Stamp pose={stamp} size={230} />
          <Shredder pose={shredder} size={170} />
        </div>
        <div className="controls">
          <div className="row">
            <button className="btn" onClick={playNope}>
              Play a NOPE
            </button>
            <button className="btn btn-quiet" onClick={playYes}>
              Play a YES
            </button>
          </div>
          <Chips label="Intern" options={INTERN_MOODS} value={mood} onPick={setMood} />
          <Chips label="Rank" options={RANKS} value={rank} onPick={setRank} />
          <Chips label="Stamp" options={STAMP_POSES} value={stamp} onPick={setStamp} />
          <Chips label="Tin" options={TIN_POSES} value={tin} onPick={setTin} />
          <Chips label="Shredder" options={SHREDDER_POSES} value={shredder} onPick={setShredder} />
        </div>
      </section>

      <section aria-labelledby="all">
        <h2 id="all">Every pose</h2>
        <ul className="pose-grid">
          {INTERN_MOODS.map((m) => (
            <li key={m}>
              <Intern mood={m} size={150} />
              <span className="mono">{m}</span>
            </li>
          ))}
          <li>
            <Intern rank="ANALYST" size={150} />
            <span className="mono">analyst</span>
          </li>
          <li>
            <Intern rank="TRADER" size={150} />
            <span className="mono">trader</span>
          </li>
        </ul>
      </section>

      <section aria-labelledby="mugs">
        <h2 id="mugs">One mug per boss</h2>
        <div className="row">
          {BOSSES.map((b) => (
            <BossMug key={b} accountId={b} size={72} />
          ))}
        </div>
      </section>
    </main>
  );
}
