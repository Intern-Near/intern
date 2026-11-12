import { useSyncExternalStore } from "react";
import { pickSource, type Source } from "./index";
import type { Constants, FeedItem, Position, Pot, RankState, Refusal, Round, StickerFirst, Vote } from "./types";

export type Desk = {
  constants: Constants;
  rank: RankState;
  round: Round;
  pot: Pot;
  positions: Position[];
  refusals: Refusal[];
  firsts: StickerFirst[];
  votes: Vote[];
  /** Newest last. */
  feed: FeedItem[];
};

export type Snapshot = {
  source: Source["name"];
  scene: Source["scene"];
  desk: Desk | null;
  /** The newest item that arrived while the page was open (not part of the first load). */
  fresh: FeedItem | null;
  /** Set when the program cannot be reached. The last good data stays on screen. */
  error: string | null;
};

const POLL_MS = 2500;
const KEEP = 200;

function createStore(source: Source) {
  let snap: Snapshot = { source: source.name, scene: source.scene, desk: null, fresh: null, error: null };
  const listeners = new Set<() => void>();
  let timer: number | undefined;
  let busy = false;

  const set = (next: Partial<Snapshot>) => {
    snap = { ...snap, ...next };
    listeners.forEach((l) => l());
  };

  async function views(): Promise<Omit<Desk, "constants" | "feed">> {
    const c = source.chain;
    const [rank, round, pot, positions, refusals, firsts, votes] = await Promise.all([
      c.getRank(), c.getRound(), c.getPot(), c.getPositions(), c.getRefusals(undefined, 20), c.getStickerFirsts(), c.getVotes(undefined, 10),
    ]);
    return { rank, round, pot, positions, refusals, firsts, votes };
  }

  async function load() {
    const [constants, rest, feed] = await Promise.all([source.chain.getConstants(), views(), source.chain.getFeed(undefined, 50)]);
    set({ desk: { constants, ...rest, feed }, error: null });
  }

  /** One loop does all the "live": ask for feed items after the last one seen. */
  async function poll() {
    if (busy || document.hidden) return;
    busy = true;
    try {
      if (!snap.desk) {
        await load();
      } else {
        const last = snap.desk.feed[snap.desk.feed.length - 1]?.seq;
        const items = await source.chain.getFeed(last, 50);
        // A phase can change with no event at all, so the round is re-read either way.
        const rest = items.length ? await views() : { round: await source.chain.getRound() };
        const feed = items.length ? [...snap.desk.feed, ...items].slice(-KEEP) : snap.desk.feed;
        set({ desk: { ...snap.desk, ...rest, feed }, fresh: items.length ? items[items.length - 1]! : snap.fresh, error: null });
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      busy = false;
    }
  }

  return {
    get: () => snap,
    poll,
    subscribe(l: () => void) {
      listeners.add(l);
      if (listeners.size === 1) {
        void poll();
        timer = window.setInterval(poll, POLL_MS);
        document.addEventListener("visibilitychange", poll);
      }
      return () => {
        listeners.delete(l);
        if (listeners.size === 0) {
          window.clearInterval(timer);
          document.removeEventListener("visibilitychange", poll);
        }
      };
    },
  };
}

let source: Source | undefined;
let store: ReturnType<typeof createStore> | undefined;

/** The one data source of this page load. Pages that need more than the desk ask it directly. */
export function getChain() {
  source ??= pickSource();
  return source.chain;
}

export function getSource(): Source {
  source ??= pickSource();
  return source;
}

/** Ask for fresh data now, without waiting for the next poll (after the visitor does something). */
export function refreshDesk(): void {
  void store?.poll();
}

/** Everything the screens show, kept fresh by one polling loop. */
export function useDesk(): Snapshot {
  source ??= pickSource();
  store ??= createStore(source);
  return useSyncExternalStore(store.subscribe, store.get);
}
