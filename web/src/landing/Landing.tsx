import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import "./landing.css";
import { useDesk } from "../chain/store";
import { REFUSAL_CODES, type RefusalCode } from "../chain/types";
import { Intern, type InternMood } from "../cast/Intern";
import { Stamp, type StampPose } from "../cast/Stamp";
import { Tin } from "../cast/Tin";
import { clock, usd } from "../lib/format";
import { href } from "../lib/nav";
import { refusalSentence } from "../lib/refusals";
import { nextMoment } from "../lib/round";
import { useNow } from "../lib/useNow";
import { useRewards } from "../lib/useRewards";
import { Boss } from "./Boss";
import { Clips, ShadowNumber, ShiftClock, SoundToggle } from "./extras";
import { pop, thud } from "./sound";
import { MiniStream } from "./MiniStream";
import { Trick } from "./Trick";
import { Typed } from "./Typed";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Scroll drives the page. Each pinned act gets --p (0 to 1 through the act) and a step
 * number; plain sections get --p for how far they have travelled through the window.
 */
function useScroll(root: React.RefObject<HTMLElement | null>, acts: Record<string, number>) {
  const [steps, setSteps] = useState<Record<string, number>>(() =>
    Object.fromEntries(Object.entries(acts).map(([k, n]) => [k, reducedMotion() ? n - 1 : 0])),
  );
  useEffect(() => {
    const el = root.current;
    if (!el || reducedMotion()) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const vh = window.innerHeight;
      el.style.setProperty("--sy", String(window.scrollY));
      // The Intern's shift: 9:00 at the top of the page, 17:00 at the bottom
      const done = Math.min(1, Math.max(0, window.scrollY / Math.max(1, document.documentElement.scrollHeight - vh)));
      const mins = 540 + Math.round((done * 480) / 5) * 5;
      const time = el.querySelector("[data-shift-time]");
      const label = el.querySelector("[data-shift-label]");
      if (time) time.textContent = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
      if (label) label.textContent = done < 0.02 ? "Clocking in" : done > 0.97 ? "Clocking out" : "The Intern's shift";
      const next: Record<string, number> = {};
      el.querySelectorAll<HTMLElement>("[data-act]").forEach((act) => {
        const r = act.getBoundingClientRect();
        const p = Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - vh)));
        act.style.setProperty("--p", p.toFixed(4));
        const n = acts[act.dataset.act!] ?? 1;
        next[act.dataset.act!] = Math.min(n - 1, Math.floor(p * n));
      });
      el.querySelectorAll<HTMLElement>("[data-view]").forEach((sec) => {
        const r = sec.getBoundingClientRect();
        sec.style.setProperty("--p", Math.min(1, Math.max(0, (vh - r.top) / (vh + r.height))).toFixed(4));
      });
      setSteps((prev) => (Object.keys(next).every((k) => prev[k] === next[k]) ? prev : next));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };
    // `acts` is a constant object; the effect must run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return steps;
}

/** What the Intern says when poked. */
const POKES: { mood: InternMood; say: string }[] = [
  { mood: "happy", say: "Oh! A visitor." },
  { mood: "thinking", say: "Is this about the $450?" },
  { mood: "waiting", say: "I'm working. Honest." },
  { mood: "proposing", say: "What about $449?" },
  { mood: "refused", say: "…that's a NOPE too, isn't it." },
];

/** The opening: the Intern asks, Stamp answers. Poke either of them and they answer back. */
function Hero() {
  const snap = useDesk();
  const rewards = useRewards();
  const now = useNow();
  const [beat, setBeat] = useState(() => (reducedMotion() ? 2 : 0));
  const [poke, setPoke] = useState<{ n: number; i: number } | null>(null);
  const [slam, setSlam] = useState(0);
  const [slamming, setSlamming] = useState<"" | "up" | "down">("");
  const ref = useRef<HTMLElement>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    if (reducedMotion()) return;
    const a = window.setTimeout(() => setBeat(1), 1100);
    const b = window.setTimeout(() => {
      setBeat(2);
      thud();
    }, 1380);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, []);

  const onMove = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType !== "mouse" || reducedMotion()) return;
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", (((e.clientX - r.left) / r.width) * 2 - 1).toFixed(3));
    e.currentTarget.style.setProperty("--my", (((e.clientY - r.top) / r.height) * 2 - 1).toFixed(3));
  };
  const shake = () => {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    el.classList.remove("is-hit");
    void el.offsetWidth;
    el.classList.add("is-hit");
  };
  const pokeIntern = () => {
    if (beat < 2) return;
    pop();
    setPoke((p) => ({ n: (p?.n ?? 0) + 1, i: p ? (p.i + 1) % POKES.length : 0 }));
    timers.current.forEach(clearTimeout);
    timers.current = [window.setTimeout(() => setPoke(null), 3600)];
  };
  const pokeStamp = () => {
    if (beat < 2 || slamming) return;
    if (reducedMotion()) {
      setSlam((n) => n + 1);
      return;
    }
    setSlamming("up");
    window.setTimeout(() => {
      setSlamming("down");
      setSlam((n) => n + 1);
      thud();
      shake();
    }, 230);
    window.setTimeout(() => setSlamming(""), 900);
  };

  const desk = snap.desk;
  const lastNope = desk?.refusals[0];
  const next = desk ? nextMoment(desk.round, now, desk.rank.status) : null;
  const poked = poke ? POKES[poke.i]! : null;
  const intern: InternMood = beat < 2 ? "proposing" : poked ? poked.mood : "refused";
  const stamp: StampPose = beat === 0 ? "watching" : beat === 1 || slamming === "up" ? "slamming" : beat === 2 && (slamming === "down" || slam === 0) ? "landed" : "watching";

  return (
    <section className={`hero${beat === 2 ? " is-landed" : ""}`} ref={ref} onPointerMove={onMove}>
      <div className="hero-room" aria-hidden="true" />
      <div className="hero-text">
        {/* The headline is what the Intern says, so it sits in a speech bubble that points at it */}
        <h1 className="ask bubble">
          <span className="ask-line">“Can I bet</span>
          <span className="ask-line ask-num">
            $450?”
            <span className={`mark mark-nope hero-nope${beat === 2 ? " is-on" : ""}`} aria-hidden="true">
              NOPE
            </span>
          </span>
        </h1>
        <p className="hero-sub">
          That's the Intern. It's an AI that trades memecoins with a slice of a shared pool. It is only an intern, so a program on NEAR checks every bet against its
          rank and says no before any money moves. Hold the coin and you're its boss: promote it, demote it, or fire it.
        </p>
        <div className="hero-cta">
          <a className="btn btn-big" href={href("desk")}>
            Go to the desk
          </a>
          <a className="hero-more" href="#one-bet">
            Watch one bet get stamped
          </a>
        </div>
        <p className="hero-hint" aria-hidden="true">
          Poke the Intern. Poke Stamp, if you dare.
        </p>
      </div>

      <div className="hero-side">
        {/* Things pinned to the office wall. The screen shows live numbers. */}
        <div className="hero-wall">
          {desk && (
            <div className="wall-screen screen">
              <p className="mono dim">{(next?.label ?? "today's bet in").toUpperCase()}</p>
              <p className="wall-clock">{next?.at != null ? clock(next.at - now) : "--:--:--"}</p>
              <p className="wall-row">
                <span>BRAVE pool</span>
                <span className="mono up">{usd(desk.pot.brave.total)}</span>
              </p>
              <p className="wall-row">
                <span>NOPEs today</span>
                <span className="mono">{desk.round.refused}</span>
              </p>
              {rewards && (
                <p className="wall-row">
                  <a href={href("rewards")}>Jackpot{BigInt(rewards.jackpot_added_total) > 0n ? " (seeded by the team)" : ""}</a>
                  <span className="mono">{usd(rewards.jackpot)}</span>
                </p>
              )}
            </div>
          )}
          <p className="note note-a" aria-hidden="true">
            Max 2% a bet.
            <span>Stamp</span>
          </p>
          <img className="pinned pin-a" src="/stickers/over_trade_limit.webp" alt="" width={150} height={150} />
          <img className="pinned pin-b" src="/stickers/not_on_list.webp" alt="" width={130} height={130} />
          <p className="note note-b" aria-hidden="true">
            Rank 1 of 3
            <span>the bosses</span>
          </p>
          <img className="pinned pin-c" src="/stickers/over_leverage.webp" alt="" width={120} height={120} />
        </div>
        <div className="hero-cast">
          <Tin size={190} className="hero-tin" />
          <button className="poke intern-wrap" onClick={pokeIntern} aria-label="Poke the Intern">
            <Intern mood={intern} size={540} />
            {beat < 2 && (
              <span className="slip mono" aria-hidden="true">
                <span>LONG PEPE</span>
                <span>$450.00 · 1x</span>
              </span>
            )}
            {poked && beat === 2 && (
              <span className="poke-say" key={poke!.n}>
                <Typed text={poked.say} />
              </span>
            )}
          </button>
          <button
            className={`poke hero-stamp${beat === 1 || slamming === "up" ? " is-up" : ""}${(beat === 2 && slam === 0) || slamming === "down" ? " is-down" : ""}`}
            onClick={pokeStamp}
            aria-label="Poke Stamp"
          >
            <Stamp pose={stamp} size={330} />
            {slam > 0 && (
              <span className="mark mark-nope poke-nope" key={slam} aria-hidden="true">
                NOPE
              </span>
            )}
          </button>
        </div>
      </div>

      {lastNope && (
        <p className="hero-live">
          <span className="live-dot" aria-hidden="true" />
          <span>
            Last NOPE: {refusalSentence(lastNope.code, lastNope)} <span className="mono">{lastNope.code}</span>
          </span>
        </p>
      )}

    </section>
  );
}

/** The sixteen rule codes on a tilted band that slides as the page scrolls. */
function Ticker() {
  const run = [...REFUSAL_CODES, ...REFUSAL_CODES];
  return (
    <div className="ticker" aria-hidden="true">
      <div className="ticker-run mono">
        {run.map((c, i) => (
          <span key={i}>{c}</span>
        ))}
      </div>
    </div>
  );
}

const BET_STEPS = [
  { title: "Every day the Intern gets to make one bet.", body: "It reads the market, thinks it over, and writes a slip. It can also sit the day out.", intern: "thinking", stamp: "watching" },
  { title: "Today it asked for $450.", body: "Long PEPE. The pool holds $1,000. The Intern is feeling confident.", intern: "proposing", stamp: "watching" },
  { title: "A program checks the slip against its rank.", body: "Is it on time? Is it really the AI? Is the coin allowed? Does the size fit? An Intern may put $20 on one bet.", intern: "waiting", stamp: "watching" },
  { title: "NOPE.", body: "Stamp comes down before any money moves. The broken rule is named, with the numbers, every time: OVER_TRADE_LIMIT, asked 450, limit 20.", intern: "refused", stamp: "landed" },
] as const;

function OneBet({ step }: { step: number }) {
  const s = BET_STEPS[step]!;
  const lights = step < 2 ? [] : step === 2 ? ["ok", "ok", "ok"] : ["ok", "ok", "ok", "fail"];
  return (
    <section className="act" data-act="bet" id="one-bet" style={{ "--steps": BET_STEPS.length } as CSSProperties}>
      <div className="act-pin">
        <div className="act-words">
          <p className="act-kicker">One bet, start to finish</p>
          <div className="captions">
            {BET_STEPS.map((b, i) => (
              <div key={b.title} className={`caption${i === step ? " is-on" : ""}`} aria-hidden={i !== step}>
                <h2>{b.title}</h2>
                <p>{b.body}</p>
              </div>
            ))}
          </div>
          <ol className="dots" aria-hidden="true">
            {BET_STEPS.map((b, i) => (
              <li key={b.title} className={i <= step ? "is-on" : ""} />
            ))}
          </ol>
        </div>
        <div className={`act-stage${step === 3 ? " is-shaking" : ""}`}>
          <div className="act-lights">
            {step >= 2 && (
              <ol className="lights">
                {[0, 1, 2, 3, 4].map((i) => (
                  <li key={i} className={`light light-${lights[i] ?? "off"}`}>
                    <span className="lamp" />
                  </li>
                ))}
              </ol>
            )}
            {step === 3 && <span className="mark mark-nope">NOPE</span>}
          </div>
          <div className="intern-wrap">
            <Intern mood={s.intern} size={420} />
            {step === 1 && (
              <p className="slip mono">
                <span>LONG PEPE</span>
                <span>$450.00 · 1x</span>
              </p>
            )}
          </div>
          <div className={`stamp-wrap${step === 3 ? " is-down" : ""}`}>
            <Stamp pose={s.stamp} size={280} />
          </div>
        </div>
      </div>
    </section>
  );
}

/** What each rule sounds like with real-looking numbers, for the back of its sticker. */
const EXAMPLE: Record<RefusalCode, { asked: string | null; limit: string | null }> = {
  OUTSIDE_WINDOW: { asked: null, limit: null },
  FIRED: { asked: null, limit: null },
  BAD_MODEL_SIGNATURE: { asked: null, limit: null },
  WRONG_RULEBOOK: { asked: null, limit: null },
  MALFORMED_DECISION: { asked: null, limit: null },
  NOT_ON_LIST: { asked: null, limit: null },
  SHORT_NOT_UNLOCKED: { asked: null, limit: null },
  ZERO_MARGIN: { asked: "5000000", limit: "11000000" },
  OVER_LEVERAGE: { asked: "5", limit: "1" },
  TOO_MANY_TRADES: { asked: "2", limit: "1" },
  OVER_TRADE_LIMIT: { asked: "450000000", limit: "20000000" },
  OVER_ROUND_LIMIT: { asked: "90000000", limit: "80000000" },
  BAD_QUOTE_SIGNATURE: { asked: null, limit: null },
  STALE_QUOTE: { asked: "75000", limit: "60000" },
  QUOTE_MISMATCH: { asked: null, limit: null },
  TOO_EXPENSIVE: { asked: "520", limit: "400" },
};

/** One sticker. It leans toward the pointer; a click peels it over to show its rule. */
function WallSticker({ code, i, flipped, onFlip, onPeel }: { code: RefusalCode; i: number; flipped: boolean; onFlip: () => void; onPeel: (code: RefusalCode, e: PointerEvent<HTMLButtonElement>) => void }) {
  const from = useRef<{ x: number; y: number } | null>(null);
  const peeled = useRef(false);
  const tilt = (e: PointerEvent<HTMLButtonElement>) => {
    // Pull a sticker more than a few pixels and it peels off the wall (mouse and pen only; a finger scrolls)
    if (from.current && !peeled.current && e.pointerType !== "touch" && Math.hypot(e.clientX - from.current.x, e.clientY - from.current.y) > 12) {
      peeled.current = true;
      onPeel(code, e);
    }
    if (e.pointerType !== "mouse" || reducedMotion()) return;
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--tx", (((e.clientX - r.left) / r.width) * 2 - 1).toFixed(2));
    e.currentTarget.style.setProperty("--ty", (((e.clientY - r.top) / r.height) * 2 - 1).toFixed(2));
  };
  const rest = (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.style.setProperty("--tx", "0");
    e.currentTarget.style.setProperty("--ty", "0");
  };
  return (
    <li style={{ "--d": ((i * 37) % 9) - 4, "--r": `${((i * 53) % 15) - 7}deg` } as CSSProperties}>
      <button
        className={`flip${flipped ? " is-flipped" : ""}`}
        aria-pressed={flipped}
        onPointerDown={(e) => {
          from.current = { x: e.clientX, y: e.clientY };
          peeled.current = false;
        }}
        onPointerUp={() => (from.current = null)}
        onClick={() => {
          if (!peeled.current) onFlip();
          peeled.current = false;
        }}
        onPointerMove={tilt}
        onPointerLeave={(e) => {
          from.current = null;
          rest(e);
        }}
        draggable={false}
      >
        <span className="flip-inner">
          <span className="flip-front">
            <img src={`/stickers/${code.toLowerCase()}.webp`} alt="" width={200} height={200} loading="lazy" />
            <span className="flip-label mono">{code}</span>
          </span>
          <span className="flip-back">
            <span className="mono flip-code">{code}</span>
            <span className="flip-say">{refusalSentence(code, EXAMPLE[code])}</span>
            <span className="flip-nope">NOPE</span>
          </span>
        </span>
        <span className="sr-only">
          {code}. {flipped ? refusalSentence(code, EXAMPLE[code]) : "Press to read the rule."}
        </span>
      </button>
    </li>
  );
}

type Stuck = { id: number; code: RefusalCode; x: number; y: number; tilt: number };

function StickerWall() {
  const [flipped, setFlipped] = useState<Set<RefusalCode>>(() => new Set());
  const [seen, setSeen] = useState<Set<RefusalCode>>(() => new Set());
  const [drag, setDrag] = useState<{ code: RefusalCode; x: number; y: number } | null>(null);
  const [stuck, setStuck] = useState<Stuck[]>([]);

  const flip = (code: RefusalCode) => {
    pop();
    setFlipped((f) => {
      const n = new Set(f);
      if (n.has(code)) n.delete(code);
      else n.add(code);
      return n;
    });
    setSeen((v) => new Set(v).add(code));
  };

  // While a sticker is in the hand it follows the pointer; letting go sticks it to the page.
  const peel = (code: RefusalCode, e: PointerEvent<HTMLButtonElement>) => {
    setDrag({ code, x: e.clientX, y: e.clientY });
    const move = (ev: globalThis.PointerEvent) => setDrag({ code, x: ev.clientX, y: ev.clientY });
    const up = (ev: globalThis.PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      pop();
      setStuck((s) => [...s.slice(-11), { id: Date.now(), code, x: ev.pageX, y: ev.pageY, tilt: -14 + ((ev.pageX * 13) % 28) }]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const all = seen.size === REFUSAL_CODES.length;
  return (
    <section className={`wall${all ? " is-complete" : ""}`} data-view>
      <div className="wall-words">
        <h2>Sixteen rules. Sixteen stickers.</h2>
        <p>Each one is earned the first time the Intern breaks that rule. Nobody is proud of them. Everybody wants the full set.</p>
        <p className="wall-count" role="status">
          {all ? (
            <>You've read all sixteen. The Intern has not.</>
          ) : seen.size === 0 ? (
            <>Click one to read its rule. Drag one to stick it anywhere.</>
          ) : (
            <>
              <span className="mono">
                {seen.size} / {REFUSAL_CODES.length}
              </span>{" "}
              rules read. Keep peeling.
            </>
          )}
        </p>
        {stuck.length > 0 && (
          <button className="wall-clear" onClick={() => setStuck([])}>
            Take my {stuck.length === 1 ? "sticker" : `${stuck.length} stickers`} back down
          </button>
        )}
      </div>
      <ul className="wall-grid">
        {REFUSAL_CODES.map((code, i) => (
          <WallSticker key={code} code={code} i={i} flipped={flipped.has(code)} onFlip={() => flip(code)} onPeel={peel} />
        ))}
      </ul>
      {drag && <img className="in-hand" src={`/stickers/${drag.code.toLowerCase()}.webp`} alt="" style={{ left: drag.x, top: drag.y }} />}
      {stuck.map((k) => (
        <img
          key={k.id}
          className="stuck"
          src={`/stickers/${k.code.toLowerCase()}.webp`}
          alt=""
          title="Double-click to peel it off"
          style={{ left: k.x, top: k.y, "--tilt": `${k.tilt}deg` } as CSSProperties}
          onDoubleClick={() => setStuck((s) => s.filter((x) => x.id !== k.id))}
        />
      ))}
    </section>
  );
}

const DIAL_RANKS = [
  { name: "Intern", perRound: 200 },
  { name: "Analyst", perRound: 800 },
  { name: "Trader", perRound: 2000 },
] as const;

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Try the dial with a pretend $1,000. The numbers follow the real rank limits. */
function Money() {
  const [brave, setBrave] = useState(30);
  // The Intern only speaks up once the visitor has touched the dial, not while the section is off screen
  const [touched, setTouched] = useState(false);
  const [rank, setRank] = useState(0);
  const total = 1000;
  const braveUsd = (total * brave) / 100;
  const safeUsd = total - braveUsd;
  const r = DIAL_RANKS[rank]!;
  const atRisk = (braveUsd * r.perRound) / 10_000;
  const mood: InternMood = brave === 0 ? "thinking" : brave < 60 ? "idle" : "happy";
  const says =
    brave === 0 ? "Nothing for me? Fair." : brave < 30 ? "A little. I'll be careful." : brave < 60 ? "I can work with that." : brave < 100 ? "Now we're talking." : "All of it?! Okay. Okay okay okay.";

  return (
    <section className="money">
      <div className="money-words">
        <h2>Your money, your dial.</h2>
        <p className="money-lede">Say you bring $1,000. Drag the dial and watch what the Intern is allowed to do with it.</p>

        <div className="dial" style={{ "--brave": brave } as CSSProperties}>
          <div className="dial-track" aria-hidden="true">
            <span className="dial-fill-safe">SAFE</span>
            <span className="dial-fill-brave">BRAVE</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={brave}
            onChange={(e) => {
              setBrave(Number(e.target.value));
              setTouched(true);
            }}
            aria-label="Share of your money in BRAVE"
            aria-valuetext={`${brave}% BRAVE, ${100 - brave}% SAFE`}
          />
        </div>

        <div className="dial-ranks" role="group" aria-label="The Intern's rank">
          <span>If its rank is</span>
          {DIAL_RANKS.map((d, i) => (
            <button key={d.name} className="rank-chip" aria-pressed={i === rank} onClick={() => setRank(i)}>
              {d.name}
            </button>
          ))}
        </div>

        <dl className="dial-out">
          <div className="out-safe">
            <dt>SAFE</dt>
            <dd className="num">{money(safeUsd)}</dd>
            <p>The Intern can never touch it. No bets, no vote.</p>
          </div>
          <div className="out-brave">
            <dt>BRAVE</dt>
            <dd className="num">{money(braveUsd)}</dd>
            <p>You share the Intern's wins and losses{brave > 0 ? ", and you get a vote" : ""}.</p>
          </div>
          <div className="out-risk">
            <dt>Most of yours it can bet in a day</dt>
            <dd className="num">{money(atRisk)}</dd>
            <p>
              {r.perRound / 100}% of BRAVE at {r.name} rank. That number is fixed in the program.
            </p>
          </div>
        </dl>
        <p className="money-fine">
          It's a test network with test dollars right now, so nothing here is real money. The Intern will be wrong sometimes; that is why the stamp exists. You can
          lose what you put in BRAVE, and no profit is promised.
        </p>
      </div>

      <div className="money-stage" aria-hidden="true">
        <p className="says" key={says}>
          <Typed text={says} silent={!touched} />
        </p>
        <div className="money-cast">
          <Tin pose={brave > 0 ? "coin" : "resting"} size={220} />
          <Intern mood={mood} rank={rank === 0 ? "INTERN" : rank === 1 ? "ANALYST" : "TRADER"} size={420} />
        </div>
      </div>
    </section>
  );
}

function Final() {
  return (
    <section className="final">
      <h2>The Intern is at its desk.</h2>
      <p>Go and see what it's asking for today.</p>
      <a className="btn btn-big btn-ink" href={href("desk")}>
        Go to the desk
      </a>
      <div className="final-cast" aria-hidden="true">
        <Tin size={170} />
        <Intern mood="happy" size={300} />
        <Stamp size={210} />
      </div>
      <footer className="lp-foot">
        <span>$INTERN, a NEAR hackathon entry. Test network.</span>
        <span>The characters were made with AI image tools.</span>
        <a href={href("judge")}>For judges: what is real and what is a stand-in</a>
        <a href="https://x.com/intern_live" target="_blank" rel="noreferrer">
          On X: @intern_live
        </a>
      </footer>
    </section>
  );
}

export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  const steps = useScroll(root, { bet: BET_STEPS.length });
  return (
    <div className="lp" ref={root}>
      <header className="lp-top">
        <a className="brand" href={href("landing")} aria-label="$INTERN">
          <img src="/cast/logo-intern.webp" alt="" width={52} height={52} />
          <span>$INTERN</span>
        </a>
        <div className="lp-top-right">
          <SoundToggle />
          <a className="btn" href={href("desk")}>
            Go to the desk
          </a>
        </div>
      </header>
      <main>
        <Hero />
        <Ticker />
        <MiniStream />
        <OneBet step={steps.bet ?? 0} />
        <Trick />
        <ShadowNumber />
        <Boss />
        <StickerWall />
        <Clips />
        <Money />
        <Final />
      </main>
      <ShiftClock />
    </div>
  );
}
