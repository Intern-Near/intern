import { lazy, Suspense, type ReactNode } from "react";
import { Home } from "./home/Home";
import { Landing } from "./landing/Landing";
import { JudgePage } from "./pages/JudgePage";
import { MoneyPage } from "./pages/MoneyPage";
import { VotePage } from "./pages/VotePage";
import { CastPage } from "./pages/CastPage";
import { CoachPage } from "./pages/CoachPage";
import { GoalsPage } from "./pages/GoalsPage";
import { LaunchPage } from "./pages/LaunchPage";
import { DebugPage } from "./pages/DebugPage";
import { FeedPage } from "./pages/FeedPage";
import { Foundations } from "./pages/Foundations";
import { InternPage } from "./pages/InternPage";
import { NopePage } from "./pages/NopePage";

// These four carry the Tail or Fade signing code or the stream's lines, so they load only when opened
const BetsPage = lazy(() => import("./pages/BetsPage").then((m) => ({ default: m.BetsPage })));
const StreamPage = lazy(() => import("./pages/StreamPage").then((m) => ({ default: m.StreamPage })));
const TailFadePage = lazy(() => import("./pages/TailFadePage").then((m) => ({ default: m.TailFadePage })));
const RewardsPage = lazy(() => import("./pages/RewardsPage").then((m) => ({ default: m.RewardsPage })));
const WeekPage = lazy(() => import("./pages/WeekPage").then((m) => ({ default: m.WeekPage })));
const ProofPage = lazy(() => import("./pages/ProofPage").then((m) => ({ default: m.ProofPage })));
const TrickPage = lazy(() => import("./pages/TrickPage").then((m) => ({ default: m.TrickPage })));
const MarketPage = lazy(() => import("./pages/MarketPage").then((m) => ({ default: m.MarketPage })));
const StickersPage = lazy(() => import("./pages/StickersPage").then((m) => ({ default: m.StickersPage })));
const later = (page: ReactNode) => <Suspense fallback={null}>{page}</Suspense>;

/** Page switch while the site is being built up: no page = the landing page; ?page=desk | intern | nope | judge | cast | foundations | debug */
export function App() {
  const page = new URLSearchParams(window.location.search).get("page");
  if (page === "foundations") return <Foundations />;
  if (page === "cast") return <CastPage />;
  if (page === "debug") return <DebugPage />;
  if (page === "intern") return <InternPage />;
  if (page === "nope") return <NopePage />;
  if (page === "judge") return <JudgePage />;
  if (page === "bets") return later(<BetsPage />);
  if (page === "feed") return <FeedPage />;
  if (page === "vote") return <VotePage />;
  if (page === "money") return <MoneyPage />;
  if (page === "coach") return <CoachPage />;
  if (page === "goals") return <GoalsPage />;
  if (page === "launch") return <LaunchPage />;
  if (page === "rewards") return later(<RewardsPage />);
  if (page === "week") return later(<WeekPage />);
  if (page === "proof") return later(<ProofPage />);
  if (page === "market") return later(<MarketPage />);
  if (page === "stickers") return later(<StickersPage />);
  if (page === "trick") return later(<TrickPage />);
  if (page === "tailfade") return later(<TailFadePage />);
  if (page === "stream") return later(<StreamPage />);
  if (page === "desk") return <Home />;
  return <Landing />;
}
