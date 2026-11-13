import { useCallback, useEffect, useRef, useState } from "react";
import lines from "../../../interface/lines.json";
import { cueFor, type Cue, type FeedItem as CueFeedItem, type Lines } from "../../../stream/src/cues.ts";
import { INTERN_MOODS, type InternMood } from "../cast/Intern";
import type { Desk } from "../chain/store";
import type { FeedItem, RankName, Rewards } from "../chain/types";
import { dollarLimit, limitsOf } from "../home/Home";
import { titleCase, usd } from "../lib/format";
import { phaseAt } from "../lib/round";
import idle from "./idle.json";
import { sayLine, stopVoice, voiceAvailable } from "./voice";

/**
 * The show: the program's feed played as a pose, a line for the Intern and a caption (Engine 1's
 * stream/cues.ts and interface/lines.json), with small talk in the quiet stretches (./idle.json).
 * Used by the stream page and by the small stream on the landing page.
 */

const LINES = lines as unknown as Lines;
const MODEL_URL = "/live2d/intern/intern.model3.json";
/** One small-talk line per slot of this length; the slot's number picks the line, so every viewer gets the same one. */
const SLOT_MS = 22_000;
/** Quiet time after an event before small talk starts again. */
const QUIET_MS = 6_000;

/** The Live2D model to show, or null when there is none (then the still poses are used). */
export function useModelUrl(): string | null {
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

/** The cue for a feed item, in Engine 1's words. An event the lines file does not know gives nothing. */
export function cueOf(item: FeedItem, rank: RankName): Cue | null {
  try {
    return cueFor(item as unknown as CueFeedItem, LINES, { rank });
  } catch {
    return null;
  }
}

/** How long a cue stays up: long enough to read it. */
const holdMs = (c: Cue) => Math.min(9_000, Math.max(3_500, 2_200 + (c.intern ?? c.system).length * 55));

function browserVoice(text: string) {
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

type IdleLine = { text: string; pose: string; when?: string };
export type ShowFacts = { rewards: Rewards | null; viewers: number | null; leaguePlayers: number | null };

/** The moment of the shift a small-talk line may be tied to. */
function momentOf(desk: Desk, now: number): string {
  if (desk.rank.status === "FIRED") return "FIRED";
  if (desk.round.settled) return "SETTLED";
  return phaseAt(desk.round, now);
}

/**
 * The small-talk line for a time slot, or null if this slot's line cannot be said honestly right now
 * (a number it needs is missing). Deterministic: the same slot and the same state give the same line.
 */
export function idleLine(slot: number, desk: Desk, now: number, facts: ShowFacts): { text: string; pose: string } | null {
  const moment = momentOf(desk, now);
  const pool = (idle.lines as IdleLine[]).filter((l) => (moment === "FIRED" ? l.when === "FIRED" : !l.when || l.when === moment));
  if (pool.length === 0) return null;
  // A spread-out walk through the list, so neighbouring slots do not say neighbouring lines
  const line = pool[(slot * 7919) % pool.length]!;
  const limits = limitsOf(desk);
  const values: Record<string, string | null> = {
    rank: titleCase(desk.rank.rank),
    per_bet: usd(dollarLimit(desk, limits.per_bet_bps)),
    shift: String(desk.round.id),
    jackpot: facts.rewards ? usd(facts.rewards.jackpot) : null,
    viewers: facts.viewers !== null && facts.viewers > 1 ? String(facts.viewers) : null,
    players: facts.leaguePlayers !== null && facts.leaguePlayers > 1 ? String(facts.leaguePlayers) : null,
  };
  let missing = false;
  const text = line.text.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    const v = values[name];
    if (v === null || v === undefined) missing = true;
    return v ?? "";
  });
  return missing ? null : { text, pose: line.pose };
}

export type Show = {
  current: Cue | null;
  /** True for a small-talk line: written chatter, not something the program announced. */
  smallTalk: boolean;
  log: Cue[];
  talking: boolean;
  mood: InternMood;
  /** The mascot reacting to the current cue: "stamp", "tin" or "shredder", and how. */
  who: string;
  how: string;
  stamped: "yes" | "nope" | null;
  replay(): void;
};

export function useShow(desk: Desk | null, now: number, opts: { sound: boolean; smallTalk: boolean; facts: ShowFacts }): Show {
  const [current, setCurrent] = useState<Cue | null>(null);
  const [log, setLog] = useState<Cue[]>([]);
  const [talking, setTalking] = useState(false);
  const queue = useRef<Cue[]>([]);
  const seen = useRef<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const playing = useRef(false);
  const idleNow = useRef(false);
  const quietSince = useRef(Date.now());
  const lastSlot = useRef(0);
  const soundRef = useRef(opts.sound);
  soundRef.current = opts.sound;
  const rank = desk?.rank.rank ?? "INTERN";

  // The mouth moves for about as long as the line takes to say (the real voice, when it plays, takes over in the puppet)
  const line = current?.intern ?? null;
  useEffect(() => {
    if (!line) return setTalking(false);
    setTalking(true);
    const id = window.setTimeout(() => setTalking(false), Math.min(8_000, 600 + line.length * 62));
    return () => window.clearTimeout(id);
  }, [line, current?.seq]);

  const show = useCallback((next: Cue | null, isIdle: boolean) => {
    playing.current = next !== null;
    idleNow.current = next !== null && isIdle;
    setCurrent(next);
    if (!next) {
      quietSince.current = Date.now();
      return;
    }
    if (!isIdle) setLog((l) => [next, ...l.filter((c) => c.seq !== next.seq)].slice(0, 6));
    if (soundRef.current && next.speak && next.intern) {
      const said = next.intern;
      // The real voice if this site has one; the browser's own voice otherwise
      void voiceAvailable().then((real) => (real ? sayLine(said).then((ok) => ok || browserVoice(said)) : browserVoice(said)));
    }
  }, []);

  const play = useCallback(() => {
    window.clearTimeout(timer.current);
    const next = queue.current.shift() ?? null;
    show(next, false);
    if (next) timer.current = window.setTimeout(play, holdMs(next));
  }, [show]);

  /** 3 interrupts what is on screen, 2 waits its turn, 1 is dropped when anything else is going on. Small talk always gives way. */
  const add = useCallback(
    (cues: Cue[]) => {
      let interrupt = false;
      for (const c of cues) {
        const busy = (playing.current && !idleNow.current) || queue.current.length > 0;
        if (c.priority <= 1 && busy) continue;
        if (c.priority >= 3) {
          queue.current.unshift(c);
          interrupt = true;
        } else {
          queue.current.push(c);
        }
      }
      if (interrupt || !playing.current || idleNow.current) play();
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

  // Small talk: when nothing has happened for a moment, one line per time slot
  const slot = Math.floor(now / SLOT_MS);
  useEffect(() => {
    if (!desk || !opts.smallTalk || playing.current || queue.current.length > 0) return;
    if (slot === lastSlot.current || Date.now() - quietSince.current < QUIET_MS) return;
    lastSlot.current = slot;
    const said = idleLine(slot, desk, now, opts.facts);
    if (!said) return;
    const cue: Cue = { seq: -slot, at: now, event: "small_talk", speak: true, priority: 0, intern_pose: said.pose, mascot: null, intern: said.text, system: "SMALL TALK — the Intern chatting. Nothing new from the program." };
    show(cue, true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (idleNow.current) show(null, false);
    }, holdMs(cue));
    // One look per slot; the facts are read as they are at that moment
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot, desk !== null, opts.smallTalk]);

  // Turning small talk off stops the line that is on
  useEffect(() => {
    if (!opts.smallTalk && idleNow.current) {
      window.clearTimeout(timer.current);
      stopVoice();
      show(null, false);
    }
  }, [opts.smallTalk, show]);

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

  const replay = useCallback(() => {
    if (!desk) return;
    queue.current = desk.feed.slice(-12).map((f) => cueOf(f, rank)).filter((c): c is Cue => c !== null);
    play();
  }, [desk, rank, play]);

  const resting: InternMood = !desk ? "idle" : desk.rank.status === "FIRED" ? "fired" : phaseAt(desk.round, now) === "PROPOSE" && !desk.round.settled ? "thinking" : "idle";
  const pose = current?.intern_pose;
  const mood: InternMood = pose && (INTERN_MOODS as readonly string[]).includes(pose) ? (pose as InternMood) : resting;
  const [who = "", how = ""] = (current?.mascot ?? "").split(":");
  const stamped = who === "stamp" && (how === "yes" || how === "nope") ? how : null;
  return { current, smallTalk: current?.event === "small_talk", log, talking, mood, who, how, stamped, replay };
}

/**
 * How many people have this stream open right now, counted by the website's server (a made-up id per
 * browser tab, forgotten after 45 seconds of silence). Null when there is no server to ask.
 */
export function useViewers(): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const id = crypto.randomUUID();
    const ping = () => {
      if (document.hidden) return;
      fetch("/watch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) })
        .then((r) => (r.ok && (r.headers.get("content-type") ?? "").includes("json") ? r.json() : null))
        .then((d: { watching?: number } | null) => alive && setN(typeof d?.watching === "number" ? d.watching : null))
        .catch(() => alive && setN(null));
    };
    ping();
    const every = window.setInterval(ping, 20_000);
    return () => {
      alive = false;
      window.clearInterval(every);
    };
  }, []);
  return n;
}

/** "just now", "40 seconds ago", "6 minutes ago". */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return "just now";
  if (s < 90) return `${s} seconds ago`;
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  return `${Math.round(s / 3600)} hours ago`;
}
