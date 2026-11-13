import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import "./pages.css";
import "./people.css";
import "./live.css";
import lines from "../../../interface/lines.json";
import { cueFor, type Cue, type FeedItem as CueFeedItem, type Lines } from "../../../stream/src/cues.ts";
import { Intern, INTERN_MOODS, type InternMood } from "../cast/Intern";
import { Shredder } from "../cast/Shredder";
import { Stamp } from "../cast/Stamp";
import { Tin } from "../cast/Tin";
import { useDesk } from "../chain/store";
import type { FeedItem, RankName } from "../chain/types";
import { clock, titleCase } from "../lib/format";
import { href } from "../lib/nav";
import { nextMoment, phaseAt } from "../lib/round";
import { useNow } from "../lib/useNow";
import { sayLine, stopVoice, voiceAvailable } from "../stream/voice";
import { Usd } from "../ui/Usd";
import { Waiting } from "../ui/Waiting";

const LINES = lines as unknown as Lines;

// The Live2D loader and its libraries are only downloaded when a model exists
const Puppet = lazy(() => import("../stream/Puppet").then((m) => ({ default: m.Puppet })));
/** Where the Intern's Live2D model lives. */
const MODEL_URL = "/live2d/intern/intern.model3.json";

/** The model to show, or null when there is none (then the still poses are used). */
function useModelUrl(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // Only our own model is ever shown on the published site. Trying another model by address is a
    // development convenience: a page that loads any model a visitor names would fall under different
    // Live2D terms ("expandable application"), and Live2D warns about malformed model files.
    const wanted = (import.meta.env.DEV ? new URLSearchParams(window.location.search).get("model") : null) ?? MODEL_URL;
    fetch(wanted)
      .then((r) => (r.ok && (r.headers.get("content-type") ?? "").includes("json") ? r.json() : null))
      .then((d: { FileReferences?: { Moc?: string } } | null) => alive && d?.FileReferences?.Moc && setUrl(wanted))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return url;
}
const hhmmss = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });

/** The cue for a feed item, in Engine 1's words. An event the lines file does not know gives nothing. */
function cueOf(item: FeedItem, rank: RankName): Cue | null {
  try {
    return cueFor(item as unknown as CueFeedItem, LINES, { rank });
  } catch {
    return null;
  }
}

/** How long a cue stays up: long enough to read it. */
const holdMs = (c: Cue) => Math.min(9_000, Math.max(3_500, 2_200 + (c.intern ?? c.system).length * 55));

function speak(text: string) {
  try {
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.pitch = 1.3;
    synth.speak(u);
  } catch {
    /* this browser cannot speak; the words are on screen */
  }
}

/**
 * The stream page: the contract's feed, played as a show. Each new event becomes a pose, a line
 * for the Intern and a caption in the program's words (interface/lines.json through stream/cues.ts).
 * It is a web page that follows the feed, not a video stream.
 */
export function StreamPage() {
  const snap = useDesk();
  const now = useNow();
  const { desk } = snap;
  const [current, setCurrent] = useState<Cue | null>(null);
  const [log, setLog] = useState<Cue[]>([]);
  const [sound, setSound] = useState(false);
  const queue = useRef<Cue[]>([]);
  const seen = useRef<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const playing = useRef(false);
  const soundRef = useRef(false);
  soundRef.current = sound;
  const rank = desk?.rank.rank ?? "INTERN";
  const modelUrl = useModelUrl();
  const [puppet, setPuppet] = useState<"loading" | "on" | "off">("loading");
  const [talking, setTalking] = useState(false);

  // The mouth moves for about as long as the line takes to say
  const line = current?.intern ?? null;
  useEffect(() => {
    if (!line) return setTalking(false);
    setTalking(true);
    const id = window.setTimeout(() => setTalking(false), Math.min(8_000, 600 + line.length * 62));
    return () => window.clearTimeout(id);
  }, [line, current?.seq]);

  const play = useCallback(() => {
    window.clearTimeout(timer.current);
    const next = queue.current.shift() ?? null;
    playing.current = next !== null;
    setCurrent(next);
    if (!next) return;
    setLog((l) => [next, ...l.filter((c) => c.seq !== next.seq)].slice(0, 6));
    if (soundRef.current && next.speak && next.intern) {
      const line = next.intern;
      // The real voice if this site has one; the browser's own voice otherwise
      void voiceAvailable().then((real) => (real ? sayLine(line).then((ok) => ok || speak(line)) : speak(line)));
    }
    timer.current = window.setTimeout(play, holdMs(next));
  }, []);

  /** 3 interrupts what is on screen, 2 waits its turn, 1 is dropped when anything else is going on. */
  const add = useCallback(
    (cues: Cue[]) => {
      let interrupt = false;
      for (const c of cues) {
        const busy = playing.current || queue.current.length > 0;
        if (c.priority <= 1 && busy) continue;
        if (c.priority >= 3) {
          queue.current.unshift(c);
          interrupt = true;
        } else {
          queue.current.push(c);
        }
      }
      if (interrupt || !playing.current) play();
    },
    [play],
  );

  // New feed items since the last look become cues. What was already there on arrival is not replayed.
  const feed = desk?.feed;
  useEffect(() => {
    if (!feed) return;
    const last = feed[feed.length - 1]?.seq ?? 0;
    if (seen.current === null) {
      seen.current = last;
      setLog(feed.slice(-6).reverse().map((f) => cueOf(f, rank)).filter((c): c is Cue => c !== null));
      return;
    }
    const fresh = feed.filter((f) => f.seq > seen.current!);
    if (fresh.length === 0) return;
    seen.current = last;
    add(fresh.map((f) => cueOf(f, rank)).filter((c): c is Cue => c !== null));
    // The rank only words the captions; a change of rank alone is not a new event
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed, add]);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      stopVoice();
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* nothing was speaking */
      }
    },
    [],
  );

  if (!desk) return <Waiting error={snap.error} line="Tuning in to the desk…" />;

  const replay = () => {
    queue.current = desk.feed.slice(-12).map((f) => cueOf(f, rank)).filter((c): c is Cue => c !== null);
    play();
  };

  const moment = nextMoment(desk.round, now, desk.rank.status);
  const resting: InternMood = desk.rank.status === "FIRED" ? "fired" : phaseAt(desk.round, now) === "PROPOSE" && !desk.round.settled ? "thinking" : "idle";
  const pose = current?.intern_pose;
  const mood: InternMood = pose && (INTERN_MOODS as readonly string[]).includes(pose) ? (pose as InternMood) : resting;
  const [who, how] = (current?.mascot ?? "").split(":");
  const stamped = who === "stamp" && (how === "yes" || how === "nope") ? how : null;

  return (
    <main id="main" className={`stream${stamped === "nope" ? " is-nope" : ""}`}>
      <header className="stream-top">
        <a className="stream-home" href={href("desk")}>
          <img src="/cast/logo-intern.webp" alt="" width={40} height={40} />
          $INTERN
        </a>
        <span className="pill pill-live">Live from the contract</span>
        <span className="stream-stat">
          Shift <span className="mono">{desk.round.id}</span>
        </span>
        <span className="stream-stat">{desk.rank.status === "FIRED" ? "Fired" : titleCase(desk.rank.rank)}</span>
        <span className="stream-stat">
          Pool{" "}
          <span className="mono">
            <Usd e6={desk.pot.brave.total} />
          </span>
        </span>
        <span className="stream-stat stream-next">
          {moment.label}
          {moment.at !== null && <span className="mono"> {clock(moment.at - now)}</span>}
        </span>
        <span className="stream-buttons">
          <button className="pill pill-in" onClick={replay}>
            Replay the last 12
          </button>
          <button className="pill pill-in" aria-pressed={sound} onClick={() => setSound((s) => !s)}>
            Voice: {sound ? "on" : "off"}
          </button>
        </span>
      </header>

      <div className="stream-stage">
        <div className="stream-side">
          <Tin pose={who === "tin" && how === "rattling" ? "coin" : "resting"} size={150} />
          <Shredder pose={who === "shredder" && how === "awake" ? "awake" : "asleep"} size={150} />
        </div>
        <div className="stream-intern">
          <p className={`stream-bubble${current?.intern ? "" : " is-empty"}`} aria-live="polite" key={current?.seq ?? "quiet"}>
            {current?.intern ?? (resting === "thinking" ? "…" : "")}
          </p>
          {modelUrl && puppet !== "off" && (
            <Suspense fallback={null}>
              <div className={`puppet-box${puppet === "on" ? " is-on" : ""}`}>
                <Puppet url={modelUrl} mood={mood} talking={talking} onReady={(ok) => setPuppet(ok ? "on" : "off")} />
              </div>
            </Suspense>
          )}
          {(!modelUrl || puppet !== "on") && <Intern mood={mood} rank={rank} size={380} />}
        </div>
        <div className={`stream-stamp${stamped ? " is-down" : ""}`} key={stamped ? `s-${current?.seq}` : "s-rest"}>
          {stamped && <span className={`stream-mark is-${stamped}`}>{stamped === "yes" ? "YES" : "NOPE"}</span>}
          <Stamp pose={stamped ? "landed" : "watching"} size={220} />
        </div>
      </div>

      <div className="stream-caption" role="status">
        {current ? (
          <p className="mono" key={current.seq}>
            {current.system}
          </p>
        ) : (
          <p className="mono stream-quiet">
            {snap.error ? "Lost the connection to the program. Trying again every few seconds." : "Nothing new. This page moves when the program announces something."}
          </p>
        )}
      </div>

      <ol className="stream-log" aria-label="Earlier">
        {log
          .filter((c) => c.seq !== current?.seq)
          .slice(0, 5)
          .map((c) => (
            <li key={c.seq}>
              <span className="mono">{hhmmss(c.at)}</span>
              <span className="mono">{c.system}</span>
            </li>
          ))}
      </ol>

      <p className="stream-fine">
        This is a web page following the program's public feed, a few seconds behind. It is not a video stream. The Intern's lines are written lines chosen by event
        number; the captions are the program's facts. Test network, test dollars.
        {modelUrl && puppet === "on" && " The Intern is animated with Live2D (Powered by Live2D)."}
      </p>
    </main>
  );
}
