import "../home/home.css";
import { signIn, signOut, useSession } from "../chain/session";
import { shortAccount } from "../lib/format";
import { currentPage, href } from "../lib/nav";

type Props = { source: string; scene: string | null };

export function TopBar({ source, scene }: Props) {
  const page = currentPage();
  const session = useSession();
  return (
    <header className="topbar">
      <a className="skip" href="#main">
        Skip to the content
      </a>
      <a className="brand" href={href("desk")} aria-label="$INTERN, home">
        <img src="/cast/face-intern.webp" alt="" width={44} height={44} />
        <span>$INTERN</span>
      </a>
      <nav className="nav" aria-label="Pages">
        <a href={href("desk")} aria-current={page === "desk" ? "page" : undefined}>
          Desk
        </a>
        <a href={href("bets")} aria-current={page === "bets" ? "page" : undefined}>
          Bets
        </a>
        <a href={href("intern")} aria-current={page === "intern" ? "page" : undefined}>
          The Intern
        </a>
        <a href={href("vote")} aria-current={page === "vote" ? "page" : undefined}>
          Vote
        </a>
        <a href={href("money")} aria-current={page === "money" ? "page" : undefined}>
          Money
        </a>
        <a href={href("coach")} aria-current={page === "coach" ? "page" : undefined}>
          Playbooks
        </a>
        <a href={href("goals")} aria-current={page === "goals" ? "page" : undefined}>
          Goals
        </a>
        <a href={href("launch")} aria-current={page === "launch" ? "page" : undefined}>
          Launch
        </a>
        <a href={href("feed")} aria-current={page === "feed" ? "page" : undefined}>
          Feed
        </a>
        <a href={href("judge")} aria-current={page === "judge" ? "page" : undefined}>
          For judges
        </a>
      </nav>
      <div className="topbar-tags">
        {page === "desk" && (
          <>
            <a className="pill pill-link" href="?page=desk&scene=REFUSED">
              {source === "sample" ? "Play a NOPE" : "Demo: a NOPE"}
            </a>
            <a className="pill pill-link" href="?page=desk&scene=APPROVED">
              {source === "sample" ? "Play a YES" : "Demo: a YES"}
            </a>
          </>
        )}
        {source === "sample" && <span className="pill pill-gum">Sample data · {scene?.toLowerCase().replace("_", " ")}</span>}
        {source === "stub" && <span className="pill pill-gum">Stub contract · canned answers</span>}
        {source === "live" && <span className="pill pill-live">Live contract</span>}
        <span className="pill">Test network</span>
        {session.accountId ? (
          <button className="pill pill-me" onClick={signOut} title="Clock out">
            {shortAccount(session.accountId, 18)} · Clock out
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
