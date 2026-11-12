import { Home } from "./home/Home";
import { Landing } from "./landing/Landing";
import { JudgePage } from "./pages/JudgePage";
import { MoneyPage } from "./pages/MoneyPage";
import { VotePage } from "./pages/VotePage";
import { BetsPage } from "./pages/BetsPage";
import { CastPage } from "./pages/CastPage";
import { CoachPage } from "./pages/CoachPage";
import { GoalsPage } from "./pages/GoalsPage";
import { LaunchPage } from "./pages/LaunchPage";
import { DebugPage } from "./pages/DebugPage";
import { FeedPage } from "./pages/FeedPage";
import { Foundations } from "./pages/Foundations";
import { InternPage } from "./pages/InternPage";
import { NopePage } from "./pages/NopePage";

/** Page switch while the site is being built up: no page = the landing page; ?page=desk | intern | nope | judge | cast | foundations | debug */
export function App() {
  const page = new URLSearchParams(window.location.search).get("page");
  if (page === "foundations") return <Foundations />;
  if (page === "cast") return <CastPage />;
  if (page === "debug") return <DebugPage />;
  if (page === "intern") return <InternPage />;
  if (page === "nope") return <NopePage />;
  if (page === "judge") return <JudgePage />;
  if (page === "bets") return <BetsPage />;
  if (page === "feed") return <FeedPage />;
  if (page === "vote") return <VotePage />;
  if (page === "money") return <MoneyPage />;
  if (page === "coach") return <CoachPage />;
  if (page === "goals") return <GoalsPage />;
  if (page === "launch") return <LaunchPage />;
  if (page === "desk") return <Home />;
  return <Landing />;
}
