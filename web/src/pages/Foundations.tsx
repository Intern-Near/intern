import "./foundations.css";
import { REFUSAL_CODES } from "../chain/types";

const ROOM = [
  ["cream", "#FFF6E5"],
  ["card", "#FFFFFF"],
  ["sticky", "#FFD23F"],
  ["mint", "#19C37D"],
  ["tomato", "#FF5A47"],
  ["sky", "#6BB8FF"],
  ["gum", "#FFB8C6"],
  ["ink", "#1B1A17"],
] as const;

/**
 * Step 0 page: the foundations, so the colours, the three typefaces and the
 * outline style can be checked by eye before any screen is built on them.
 */
export function Foundations() {
  return (
    <main className="foundations">
      <header>
        <p className="mono">STEP 0 · FOUNDATIONS · TEST NETWORK</p>
        <h1>The Intern asked nicely.</h1>
        <p className="lede">
          An AI intern proposes bets. A program checks every one against its rank and answers YES or
          NOPE. This page only checks the paint: colours, type and outlines.
        </p>
      </header>

      <section aria-labelledby="colours">
        <h2 id="colours">Colours</h2>
        <ul className="swatches">
          {ROOM.map(([name, hex]) => (
            <li key={name}>
              <span className="chip" style={{ background: `var(--${name})` }} />
              <span>{name}</span>
              <span className="mono">{hex}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="type">
        <h2 id="type">Three voices</h2>
        <div className="voices">
          <div>
            <p className="label">Display · DynaPuff</p>
            <p className="display">Clock in. NOPE. Promoted!</p>
          </div>
          <div>
            <p className="label">Text · Bricolage Grotesque</p>
            <p>
              Asked to put $450.00 into one bet. An Intern may use $20.00. Refused. Numbers line up:{" "}
              <span className="num">1,000.00 · 980.00 · 20.00</span>
            </p>
          </div>
          <div>
            <p className="label">The program · Departure Mono</p>
            <p className="mono">OVER_TRADE_LIMIT asked 450.00 limit 20.00</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="parts">
        <h2 id="parts">Buttons and verdicts</h2>
        <div className="row">
          <button className="btn">Clock in</button>
          <button className="btn btn-quiet">Cash out</button>
          <span className="verdict yes">YES</span>
          <span className="verdict nope">NOPE</span>
        </div>
      </section>

      <section aria-labelledby="screen">
        <h2 id="screen">A dark screen in the bright room</h2>
        <div className="screen panel">
          <div>
            <p className="mono dim">BRAVE POOL</p>
            <p className="figure">$1,000.00</p>
          </div>
          <div>
            <p className="mono dim">NEXT BET IN</p>
            <p className="figure sticky">04:12:09</p>
          </div>
          <div>
            <p className="mono dim">TODAY</p>
            <p className="figure up">+0.42</p>
          </div>
          <div>
            <p className="mono dim">YESTERDAY</p>
            <p className="figure down">−1.10</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="codes">
        <h2 id="codes">The sixteen NOPE reasons</h2>
        <ol className="codes mono">
          {REFUSAL_CODES.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ol>
      </section>
    </main>
  );
}
