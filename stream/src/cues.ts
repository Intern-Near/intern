// The stream's cue for each feed event (01 §10): which pose the Intern takes, which mascot reacts, what the Intern
// says, and the program's caption, with the words of interface/lines.json. Pure: no network, no clock, no randomness.
// A line is chosen by the event's seq, so the stream and the site say the same thing for the same event.

export interface FeedItem {
  seq: number;
  at: number;
  event: string;
  data: Record<string, unknown>;
}

export interface Cue {
  seq: number;
  at: number;
  event: string;
  /** Spoken lines: true. Silent events still get a caption. */
  speak: boolean;
  /** 3 interrupts, 2 queues, 1 can be dropped when the stream is busy. */
  priority: number;
  /** One of lines.poses.intern, or null to keep the current pose. */
  intern_pose: string | null;
  /** "<mascot>:<pose>", or null. */
  mascot: string | null;
  /** What the Intern says, or null when silent. */
  intern: string | null;
  /** The program's caption (Stamp's line): dry, exact, with units. */
  system: string;
}

/** Extra facts a feed item does not carry. `rank`: the rank now, for refusal captions. */
export interface CueContext {
  rank?: string;
}

type Variants = string[];
interface EventLines {
  speak: boolean;
  priority: number;
  intern_pose: string | null;
  mascot: string | null;
  intern?: Variants | string;
  system: string;
  first_note?: string;
  by_sign?: Record<"up" | "down" | "flat", { intern_pose: string; intern: Variants }>;
  by_kind?: Record<string, Variants>;
  by_direction?: Record<"up" | "down", { intern_pose: string; intern: Variants }>;
  by_cleared?: Record<"yes" | "no", Variants>;
  /** 1.4: the payday draw, with a winner or rolled over. */
  by_outcome?: Record<"won" | "rolled", { intern_pose: string; intern: Variants; system: string }>;
}
type Units = "usd" | "ms_into_round" | "x" | "count" | "ms" | "bps" | null;
interface RefusalLines {
  units: Units;
  intern: Variants;
  system: string;
}
export interface Lines {
  events: Record<string, EventLines>;
  refusals: Record<string, RefusalLines>;
}

const RANK_ORDER = ["INTERN", "ANALYST", "TRADER"];

// ---------------------------------------------------------------- formatting (units on every number)

function big(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return null;
}

/** 6-decimal dollars: "$1,574.69". */
export function usd(v: unknown): string {
  const n = big(v);
  if (n === null) return "$?";
  const neg = n < 0n;
  const a = neg ? -n : n;
  const cents = (a + 5_000n) / 10_000n; // round half up to the cent
  const whole = (cents / 100n).toLocaleString("en-US");
  const frac = (cents % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}$${whole}.${frac}`;
}

/** A result with its sign: "+$1.20", "-$0.03", "$0.00". */
export function signedUsd(v: unknown): string {
  const n = big(v);
  if (n === null) return "$?";
  return n > 0n ? `+${usd(n)}` : usd(n);
}

/** 6-decimal $INTERN coins: "424.99". */
export function coins(v: unknown): string {
  const n = big(v);
  if (n === null) return "?";
  const hundredths = (n + 5_000n) / 10_000n;
  return `${(hundredths / 100n).toLocaleString("en-US")}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}

/** Milliseconds into a round as "m:ss". */
function minutes(v: unknown): string {
  const n = Number(big(v) ?? 0n);
  const s = Math.floor(n / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function clock(ms: unknown): string {
  const n = Number(big(ms) ?? 0n);
  return `${new Date(n).toISOString().slice(11, 16)} UTC`;
}

/** Long account ids are shortened in the middle for captions. */
function account(v: unknown): string {
  const s = String(v ?? "?");
  return s.length <= 28 ? s : `${s.slice(0, 12)}…${s.slice(-12)}`;
}

function byUnits(units: Units, v: unknown): string {
  if (v === null || v === undefined) return "?";
  switch (units) {
    case "usd":
      return usd(v);
    case "ms_into_round":
      return minutes(v);
    case "x":
      return `${String(v)}x`;
    case "count":
      return String(v);
    case "ms":
      return `${(Number(big(v) ?? 0n) / 1000).toFixed(1)} s`;
    case "bps":
      return `${(Number(big(v) ?? 0n) / 100).toFixed(2)}%`;
    default:
      return String(v);
  }
}

const words: Record<string, Record<string, string>> = {
  side: { LONG: "long", SHORT: "short" },
  kind: { LEVERAGE: "leverage", OPEN: "opening", CLOSE: "closing" },
  goal: { BOSS: "boss goal", TIP_JAR: "tip jar", HYPE: "hype train" },
  state: { PASSED: "It passed", FAILED: "It didn't pass", OPEN: "It's still open" },
  source: { launchpad: "launchpad's fees" },
  jackpot_source: { tips: "half of a tip", added: "a direct addition" },
};
const word = (table: string, v: unknown): string => words[table]?.[String(v)] ?? String(v ?? "?");

/** Every value a template may name, worked out from the event's data. */
function values(item: FeedItem, ctx: CueContext): Record<string, string> {
  const d = item.data;
  const s = (k: string) => (d[k] === null || d[k] === undefined ? "?" : String(d[k]));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) if (v === null || typeof v !== "object") out[k] = String(v);
  // Money and coins, formatted.
  for (const k of [
    "amount",
    "paid",
    "margin",
    "returned",
    "brave_at_open",
    "brave_after",
    "prize",
    "each",
    "jackpot",
    "rolled_over",
    "pot",
    "fund",
    "target",
    "fee",
    "covered",
  ])
    if (k in d) out[k] = usd(d[k]);
  if ("result" in d) out.result = signedUsd(d.result);
  if ("coins" in d) out.coins = coins(d.coins);
  if ("weight" in d) out.weight = coins(d.weight);
  if ("account_id" in d) out.account = account(d.account_id);
  else if ("by" in d) out.account = account(d.by); // 1.7: bounty_grew names the giver `by`
  out.amount_coins = coins(d.amount);
  out.rank = ctx.rank ?? s("rank");
  out.side_word = word("side", d.side);
  out.kind_word = word("kind", d.kind);
  out.goal_word = word("goal", d.goal);
  out.state_word = word("state", d.state);
  out.source_word = word("source", d.source);
  out.support_word = d.support === true ? "yes" : d.support === false ? "no" : "?";
  out.pending_note = d.pending === true ? ", waiting for the next round" : "";
  out.playbook_note = d.kind === "SET_PLAYBOOK" ? ` for playbook ${s("playbook_id")}` : "";
  out.effective_note =
    d.effective_round === null || d.effective_round === undefined
      ? ""
      : `, effective round ${s("effective_round")}`;
  out.closes_at = "closes_at" in d ? clock(d.closes_at) : "?";
  out.author_count = Array.isArray(d.authors) ? String(d.authors.length) : "?";
  // 1.4: the reward ladder.
  out.jackpot_source = word("jackpot_source", d.source);
  out.winner = d.winner ? account(d.winner) : "nobody";
  out.winner_count = Array.isArray(d.winners) ? String(d.winners.length) : "?";
  out.runner_count = Array.isArray(d.runners_up) ? String(d.runners_up.length) : "?";
  out.playbook_state = String(d.playbook_id) === "0" ? "cleared" : `playbook ${s("playbook_id")} active`;
  // 1.7: automatic consequences.
  out.strike_word = d.action === "FIRE" ? "fired" : "demoted";
  out.strike_action = d.action === "FIRE" ? "the Intern is fired" : `the Intern is demoted to ${s("to")}`;
  if ("result" in d && "until_round" in d) out.loss = usd(String(d.result).replace(/^-/, ""));
  if ("base" in d) out.base = usd(d.base);
  out.term_end = "term_ends_at" in d ? new Date(Number(d.term_ends_at)).toISOString().slice(0, 10) : "?";
  // 1.6: leagues (the first group's winner).
  const top = Array.isArray(d.winners) ? (d.winners[0] as Record<string, unknown> | undefined) : undefined;
  out.league_winner = top && typeof top === "object" && top.account_id ? account(top.account_id) : "nobody";
  out.league_points = top && typeof top === "object" && top.points !== undefined ? String(top.points) : "0";
  return out;
}

/** Fills {name} placeholders. Throws on a name it does not know, so a wrong template is caught by the tests. */
export function fill(template: string, vals: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    const v = vals[name];
    if (v === undefined) throw new Error(`no value for {${name}} in "${template}"`);
    return v;
  });
}

const pick = (variants: Variants, seq: number): string | null =>
  variants.length === 0 ? null : (variants[seq % variants.length] ?? null);
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The cue for one feed item, or null for an event lines.json does not know (a newer contract). */
export function cueFor(item: FeedItem, lines: Lines, ctx: CueContext = {}): Cue | null {
  const ev = lines.events[item.event];
  if (!ev) return null;
  const vals = values(item, ctx);
  let pose = ev.intern_pose;
  let variants: Variants = Array.isArray(ev.intern) ? ev.intern : [];
  let system = ev.system;
  let note = "";

  if (item.event === "refused") {
    const code = String(item.data.code);
    const r = lines.refusals[code];
    if (!r) return null;
    vals.code = code;
    vals.asked = byUnits(r.units, item.data.asked);
    vals.limit = byUnits(r.units, item.data.limit);
    variants = r.intern;
    system = r.system;
    if (item.data.is_first === true && ev.first_note) note = ` ${ev.first_note}`;
  } else if (ev.by_sign) {
    const n = big(item.data.result) ?? 0n;
    const b = ev.by_sign[n > 0n ? "up" : n < 0n ? "down" : "flat"];
    pose = b.intern_pose;
    variants = b.intern;
  } else if (ev.by_kind) {
    variants = ev.by_kind[String(item.data.kind)] ?? [];
  } else if (ev.by_direction) {
    const up = RANK_ORDER.indexOf(String(item.data.to)) > RANK_ORDER.indexOf(String(item.data.from));
    const b = ev.by_direction[up ? "up" : "down"];
    pose = b.intern_pose;
    variants = b.intern;
  } else if (ev.by_cleared) {
    variants = ev.by_cleared[String(item.data.playbook_id) === "0" ? "yes" : "no"];
  } else if (ev.by_outcome) {
    const b = ev.by_outcome[item.data.winner ? "won" : "rolled"];
    pose = b.intern_pose;
    variants = b.intern;
    system = b.system;
  }

  const line = ev.speak ? pick(variants, item.seq) : null;
  return {
    seq: item.seq,
    at: item.at,
    event: item.event,
    speak: ev.speak && line !== null,
    priority: ev.priority,
    intern_pose: pose,
    mascot: ev.mascot,
    intern: line === null ? null : capital(fill(line, vals)) + note,
    system: fill(system, vals),
  };
}
