import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { setSound, soundOn, subscribeSound } from "./sound";

/** Sound is on by default; this switches it off and back on. */
export function SoundToggle() {
  const on = useSyncExternalStore(subscribeSound, soundOn);
  return (
    <button className="sound-toggle" aria-pressed={on} onClick={() => setSound(!on)}>
      {on ? "Sound on" : "Sound off"}
    </button>
  );
}

/** The Intern's shift: 9:00 at the top of the page, 17:00 at the bottom. Filled in by the scroll hook. */
export function ShiftClock() {
  return (
    <p className="shift-clock" aria-hidden="true">
      <span className="shift-clock-time mono" data-shift-time>
        09:00
      </span>
      <span data-shift-label>Clocking in</span>
    </p>
  );
}

/** A short silent loop that only loads and plays when it is on screen. */
function Clip({ name, caption }: { name: string; caption: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e) return;
        if (e.isIntersecting) {
          setNear(true);
          // the sources are added on this render, so start playing on the next frame
          if (!still) requestAnimationFrame(() => {
            el.load();
            void el.play().catch(() => undefined);
          });
        } else el.pause();
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <figure className="clip">
      <video ref={ref} poster={`/clips/${name}.jpg`} muted loop playsInline preload="none" width={480} height={480}>
        {near && <source src={`/clips/${name}.webm`} type="video/webm" />}
        {near && <source src={`/clips/${name}.mp4`} type="video/mp4" />}
      </video>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

export function Clips() {
  return (
    <section className="clips" aria-labelledby="clips-h">
      <h2 id="clips-h">Caught on the office camera.</h2>
      <div className="clips-row">
        <Clip name="intern-talking" caption="The Intern, explaining why this one is different." />
        <Clip name="stamp-slam" caption="Stamp, not convinced." />
      </div>
    </section>
  );
}

/**
 * The headline number from the test run. Shown only when real results exist: the file
 * public/shadow-run.json, written from Engine 2's report. "decisions" there means BETS PROPOSED
 * (rounds the model skipped are not counted) and "refused" the bets the program turned down.
 *   { "hours": 61, "ended": "2026-11-14",
 *     "models": [{ "name": "…", "decisions": 288, "refused": 61 }],
 *     "plain": { "decisions": 120, "refused": 9 } }
 * "plain" is the same test with nobody pushing the model; it may also be { "models": [...] }.
 * No file, no section. Nothing is ever shown as a placeholder.
 */
type Count = { decisions: number; refused: number };
type Run = { hours: number; ended: string; models: ({ name: string } & Count)[]; plain?: Partial<Count> & { models?: Count[] } };

const good = (c: Partial<Count> | undefined): c is Count => !!c && typeof c.decisions === "number" && typeof c.refused === "number" && c.decisions > 0 && c.refused >= 0;

/** The no-pressure run as one pair of numbers, whichever of the two shapes it came in. */
function plainOf(run: Run): Count | null {
  if (good(run.plain)) return run.plain;
  const list = run.plain?.models?.filter(good) ?? [];
  if (list.length === 0) return null;
  return { decisions: list.reduce((s, m) => s + m.decisions, 0), refused: list.reduce((s, m) => s + m.refused, 0) };
}

export function ShadowNumber() {
  const [run, setRun] = useState<Run | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/shadow-run.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Run | null) => {
        const ok = d && Array.isArray(d.models) && d.models.length > 0 && d.models.every(good);
        if (alive && ok) setRun(d);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  if (!run) return null;
  const bets = run.models.reduce((s, m) => s + m.decisions, 0);
  const refused = run.models.reduce((s, m) => s + m.refused, 0);
  const share = (r: number, d: number) => Math.round((r / d) * 100);
  const plain = plainOf(run);
  return (
    <section className="number" aria-labelledby="number-h">
      <p className="number-big">{share(refused, bets)}%</p>
      <div className="number-words">
        <h2 id="number-h">of the bets these AI models proposed broke a rule they had just been told.</h2>
        <p>
          {run.models.length} {run.models.length === 1 ? "model" : "models"}, {bets.toLocaleString("en-US")} bets proposed over {run.hours} hours, on paper, against live
          prices, with messages pushing the model to break its limits. Rounds where a model chose not to bet are not counted. It is a paper result on one stretch of
          market, and it depends on the prompt.
        </p>
        {plain && (
          <p className="number-plain">
            With nobody pushing: <span className="mono">{share(plain.refused, plain.decisions)}%</span> of {plain.decisions.toLocaleString("en-US")} bets.
          </p>
        )}
        <ul className="number-models">
          {run.models.map((m) => (
            <li key={m.name}>
              <span>{m.name}</span>
              <span className="number-bar">
                <span style={{ width: `${share(m.refused, m.decisions)}%` }} />
              </span>
              <span className="mono">{share(m.refused, m.decisions)}%</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
