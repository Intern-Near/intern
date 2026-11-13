import { useEffect, useRef } from "react";
import "../home/home.css";
import { signIn, signOut, useSession } from "../chain/session";
import { shortAccount } from "../lib/format";
import { currentPage, href } from "../lib/nav";

type Page = Parameters<typeof href>[0];
/** The pages a visitor comes for, then the rest behind "More". */
const MAIN: [Page, string][] = [
  ["desk", "Desk"],
  ["stream", "Watch"],
  ["trick", "Trick it"],
  ["bets", "Bets"],
  ["tailfade", "Tail or Fade"],
  ["rewards", "Rewards"],
  ["money", "Money"],
];
const MORE: [Page, string][] = [
  ["vote", "Vote"],
  ["week", "League & review"],
  ["intern", "The Intern"],
  ["coach", "Playbooks"],
  ["goals", "Goals"],
  ["launch", "Launch"],
  ["feed", "Feed"],
  ["proof", "Proof"],
  ["judge", "For judges"],
];

type Props = { source: string; scene: string | null };

export function TopBar({ source, scene }: Props) {
  const page = currentPage();
  const session = useSession();
  const more = useRef<HTMLDetailsElement>(null);
  // The menu closes when you click anywhere else or press Escape
  useEffect(() => {
    const shut = (e: Event) => {
      const el = more.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener("click", shut);
    document.addEventListener("keydown", shut);
    return () => {
      document.removeEventListener("click", shut);
      document.removeEventListener("keydown", shut);
    };
  }, []);
  return (
    <header className="topbar">
      <a className="skip" href="#main">
        Skip to the content
      </a>
      <a className="brand" href={href("desk")} aria-label="$INTERN, home">
        <img src="/cast/logo-intern.webp" alt="" width={52} height={52} />
        <span>$INTERN</span>
      </a>
      <nav className="nav" aria-label="Pages">
        {MAIN.map(([to, name]) => (
          <a key={to} href={href(to)} aria-current={page === to ? "page" : undefined}>
            {name}
          </a>
        ))}
      </nav>
      <details className="nav-more" ref={more}>
        <summary aria-current={MORE.some(([to]) => to === page) ? "page" : undefined}>More</summary>
        <nav aria-label="More pages">
          {MORE.map(([to, name]) => (
            <a key={to} href={href(to)} aria-current={page === to ? "page" : undefined}>
              {name}
            </a>
          ))}
          <hr />
          <a href="?page=desk&scene=REFUSED">Demo: watch a NOPE</a>
          <a href="?page=desk&scene=APPROVED">Demo: watch a YES</a>
        </nav>
      </details>
      <div className="topbar-tags">
        {source === "sample" && <span className="pill pill-gum">Sample data · {scene?.toLowerCase().replace("_", " ")}</span>}
        {source === "stub" && <span className="pill pill-gum">Stub contract · canned answers</span>}
        {source === "live" ? <span className="pill pill-live">Live · test network</span> : <span className="pill">Test network</span>}
        {session.accountId ? (
          <button className="pill pill-me" onClick={signOut} title="Clock out">
            {shortAccount(session.accountId, 14)} · Clock out
          </button>
        ) : (
          session.canSignIn && (
            <button className="pill pill-in" onClick={signIn}>
              Clock in
            </button>
          )
        )}
      </div>
    </header>
  );
}
