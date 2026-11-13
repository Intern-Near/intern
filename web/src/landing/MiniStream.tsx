import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Intern } from "../cast/Intern";
import { useDesk, type Desk } from "../chain/store";
import { href } from "../lib/nav";
import { useNow } from "../lib/useNow";
import { useRewards } from "../lib/useRewards";
import { ago, useModelUrl, useShow, useViewers } from "../stream/show";

const Puppet = lazy(() => import("../stream/Puppet").then((m) => ({ default: m.Puppet })));

/**
 * A small window onto the stream, on the landing page: the Intern as it is right now, reacting to the
 * program's events and chatting in between. Silent here; the Watch page has the voice. The Live2D model
 * and its libraries are only fetched once this section scrolls into view.
 */
export function MiniStream() {
  const snap = useDesk();
  const now = useNow();
  const desk = snap.desk;
  const error = !!snap.error;
  const box = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const watch = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && setNear(true), { rootMargin: "300px" });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return (
    <section ref={box} className="mini" aria-labelledby="mini-h">
      {near && desk ? <Playing desk={desk} now={now} error={error} /> : <div className="mini-stage" />}
    </section>
  );
}

function Playing({ desk, now, error }: { desk: Desk; now: number; error: boolean }) {
  const rewards = useRewards();
  const viewers = useViewers();
  const show = useShow(desk, now, { sound: false, smallTalk: true, facts: { rewards, viewers, leaguePlayers: null } });
  const modelUrl = useModelUrl();
  const [puppet, setPuppet] = useState<"loading" | "on" | "off">("loading");
  const last = desk.feed[desk.feed.length - 1];
  const { current } = show;
  return (
    <>
      <div className="mini-stage">
        {modelUrl && puppet !== "off" && (
          <Suspense fallback={null}>
            <div className={`mini-puppet${puppet === "on" ? " is-on" : ""}`}>
              <Puppet url={modelUrl} mood={show.mood} talking={show.talking} onReady={(ok) => setPuppet(ok ? "on" : "off")} />
            </div>
          </Suspense>
        )}
        {(!modelUrl || puppet !== "on") && <Intern mood={show.mood} rank={desk.rank.rank} size={260} />}
        {show.stamped && <span className={`stream-mark is-${show.stamped} mini-mark`}>{show.stamped === "yes" ? "YES" : "NOPE"}</span>}
      </div>
      <div className="mini-words">
        <p className="mini-top">
          <span className={`live-badge${error ? " is-off" : ""}`}>
            <span className="live-dot" aria-hidden="true" />
            {error ? "Reconnecting" : "Live"}
          </span>
          {viewers !== null && (
            <span className="mini-count">
              <span className="mono">{viewers}</span> watching
            </span>
          )}
        </p>
        <h2 id="mini-h">The Intern is at its desk right now.</h2>
        <p className="mini-bubble" aria-live="polite" key={current?.seq ?? "quiet"}>
          {current?.intern ?? "…"}
        </p>
        <p className="mini-caption mono">
          {current && !show.smallTalk ? current.system : `Small talk. Nothing new from the program${last ? ` since ${ago(last.at, now)}` : ""}.`}
        </p>
        <a className="btn" href={href("stream")}>
          Watch with sound
        </a>
      </div>
    </>
  );
}
