import { lazy, Suspense, useState } from "react";
import "./pages.css";
import "./people.css";
import "./live.css";
import { Intern } from "../cast/Intern";
import { Shredder } from "../cast/Shredder";
import { Stamp } from "../cast/Stamp";
import { Tin } from "../cast/Tin";
import { getChain, useDesk } from "../chain/store";
import { clock, titleCase } from "../lib/format";
import { href } from "../lib/nav";
import { nextMoment } from "../lib/round";
import { useAsync } from "../lib/useAsync";
import { useNow } from "../lib/useNow";
import { useRewards } from "../lib/useRewards";
import { ago, useModelUrl, useShow, useViewers } from "../stream/show";
import { Usd } from "../ui/Usd";
import { Waiting } from "../ui/Waiting";

// The Live2D loader and its libraries are only downloaded when a model exists
const Puppet = lazy(() => import("../stream/Puppet").then((m) => ({ default: m.Puppet })));
const hhmmss = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });

/**
 * The stream page: the contract's feed, played as a show. Each new event becomes a pose, a line
 * for the Intern and a caption in the program's words; in the quiet stretches the Intern makes small
 * talk from written lines. It is a web page that follows the feed, not a video stream.
 */
export function StreamPage() {
  const snap = useDesk();
  const now = useNow();
  const { desk } = snap;
  const [sound, setSound] = useState(false);
  const [smallTalk, setSmallTalk] = useState(true);
  const rewards = useRewards();
  const viewers = useViewers();
  const week = useAsync(() => getChain().getWeek(), `week-${desk?.round.id ?? 0}`);
  const show = useShow(desk, now, { sound, smallTalk, facts: { rewards, viewers, leaguePlayers: week.data?.league_players ?? null } });
  const modelUrl = useModelUrl();
  const [puppet, setPuppet] = useState<"loading" | "on" | "off">("loading");

  if (!desk) return <Waiting error={snap.error} line="Tuning in to the desk…" />;

  const { current, mood, who, how, stamped } = show;
  const rank = desk.rank.rank;
  const moment = nextMoment(desk.round, now, desk.rank.status);
  const lastEvent = desk.feed[desk.feed.length - 1];

  return (
    <main id="main" className={`stream${stamped === "nope" ? " is-nope" : ""}`}>
      <header className="stream-top">
        <a className="stream-home" href={href("desk")}>
          <img src="/cast/logo-intern.webp" alt="" width={40} height={40} />
          $INTERN
        </a>
        <span className={`live-badge${snap.error ? " is-off" : ""}`}>
          <span className="live-dot" aria-hidden="true" />
          {snap.error ? "Reconnecting" : "Live"}
        </span>
        {viewers !== null && (
          <span className="stream-stat">
            <span className="mono">{viewers}</span> watching
          </span>
        )}
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
          <button className="pill pill-in" onClick={show.replay}>
            Replay the last 12
          </button>
          <button className="pill pill-in" aria-pressed={smallTalk} onClick={() => setSmallTalk((s) => !s)}>
            Small talk: {smallTalk ? "on" : "off"}
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
            {current?.intern ?? ""}
          </p>
          {modelUrl && puppet !== "off" && (
            <Suspense fallback={null}>
              <div className={`puppet-box${puppet === "on" ? " is-on" : ""}`}>
                <Puppet url={modelUrl} mood={mood} talking={show.talking} onReady={(ok) => setPuppet(ok ? "on" : "off")} />
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

      <div className={`stream-caption${show.smallTalk ? " is-talk" : ""}`} role="status">
        {current && !show.smallTalk ? (
          <p className="mono" key={current.seq}>
            {current.system}
          </p>
        ) : (
          <p className="mono stream-quiet">
            {snap.error
              ? "Lost the connection to the program. Trying again every few seconds."
              : `${show.smallTalk ? "Small talk: the Intern chatting, from written lines. " : ""}Nothing new from the program${lastEvent ? ` since ${ago(lastEvent.at, now)}` : ""}.`}
          </p>
        )}
      </div>

      <ol className="stream-log" aria-label="Earlier">
        {show.log
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
        This is a web page following the program's public feed, a few seconds behind. It is not a video stream. The lines in the dark bar are the program's facts.
        What the Intern says is written, not generated live: one line per event, chosen by the event's number, and small talk in between, chosen by the clock, so
        everyone watching gets the same words. Test network, test dollars.
        {modelUrl && puppet === "on" && " The Intern is animated with Live2D (Powered by Live2D)."}
      </p>
    </main>
  );
}
