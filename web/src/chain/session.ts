import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { getChain, getSource, refreshDesk } from "./store";
import type { Account, Actions, Usdc } from "./types";

/**
 * Who the visitor is, and what they can do.
 * On sample data, signing in gives a pretend account so every button can be tried.
 * On the stub and the real contract, a NEAR wallet supplies the account (see wallet.ts).
 */
export type Session = { accountId: string | null; actions: Actions | null; pretend: boolean; canSignIn: boolean };

const KEY = "intern-signed-in";
let state: Session = { accountId: null, actions: null, pretend: false, canSignIn: false };
const listeners = new Set<() => void>();
let started = false;

function set(next: Session) {
  state = next;
  listeners.forEach((l) => l());
}

/** A real wallet reports who is signed in; turn that into a session. */
async function onWallet(accountId: string | null) {
  const src = getSource();
  if (!accountId || !src.contractId) {
    set({ accountId: null, actions: null, pretend: false, canSignIn: true });
    return;
  }
  const [{ walletActions }, constants] = await Promise.all([import("./wallet"), getChain().getConstants()]);
  set({ accountId, actions: walletActions(accountId, src.contractId, constants), pretend: false, canSignIn: true });
}

function start() {
  if (started) return;
  started = true;
  const src = getSource();
  if (src.sample) {
    let was = false;
    try {
      was = window.sessionStorage.getItem(KEY) === "1";
    } catch {
      was = false;
    }
    set(was ? { accountId: src.sample.accountId, actions: src.sample.act(src.sample.accountId), pretend: true, canSignIn: true } : { ...state, pretend: true, canSignIn: true });
    return;
  }
  // Stub or real contract: a NEAR wallet. Only look for an earlier sign-in if there was one,
  // so visitors who never sign in never download the wallet connector.
  set({ ...state, canSignIn: true });
  let was = false;
  try {
    was = window.localStorage.getItem(KEY) === "wallet";
  } catch {
    was = false;
  }
  if (was) void import("./wallet").then((w) => w.restoreWallet(onWallet));
}

export function signIn() {
  const src = getSource();
  if (src.sample) {
    try {
      window.sessionStorage.setItem(KEY, "1");
    } catch {
      /* not remembered */
    }
    set({ accountId: src.sample.accountId, actions: src.sample.act(src.sample.accountId), pretend: true, canSignIn: true });
    return;
  }
  try {
    window.localStorage.setItem(KEY, "wallet");
  } catch {
    /* not remembered */
  }
  void import("./wallet").then((w) => w.walletSignIn(onWallet)).catch(() => undefined);
}

export function signOut() {
  try {
    window.sessionStorage.removeItem(KEY);
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
  if (!state.pretend) void import("./wallet").then((w) => w.walletSignOut()).catch(() => undefined);
  set({ ...state, accountId: null, actions: null });
}

export function useSession(): Session {
  start();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export type Me = { account: Account; dollars: Usdc } | null;

/** The signed-in person's own numbers, re-read after anything they do. */
export function useMe(accountId: string | null, actions: Actions | null, changeKey: number | string): { me: Me; reload: () => void } {
  const [me, setMe] = useState<Me>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    if (!accountId || !actions) {
      setMe(null);
      return;
    }
    Promise.all([getChain().getAccount(accountId), actions.getDollars()]).then(
      ([account, dollars]) => alive && setMe({ account, dollars }),
      () => alive && setMe(null),
    );
    return () => {
      alive = false;
    };
  }, [accountId, actions, changeKey, tick]);
  return { me, reload: useCallback(() => setTick((t) => t + 1), []) };
}

export type Doing = { busy: string | null; error: string | null; done: string | null; run: (name: string, what: () => Promise<void>, done?: string) => Promise<void> };

/** Runs one action at a time, with busy, done and error states the buttons can show. */
export function useDoing(after: () => void): Doing {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = useCallback(
    async (name: string, what: () => Promise<void>, doneText?: string) => {
      if (busy) return;
      setBusy(name);
      setError(null);
      setDone(null);
      try {
        await what();
        setDone(doneText ?? "Done.");
        refreshDesk();
        after();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [busy, after],
  );
  return { busy, error, done, run };
}

/** "12.5" → "12500000". Returns null for anything that is not a plain positive amount. */
export function toE6(text: string): string | null {
  const t = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const v = BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
  return v > 0n ? v.toString() : null;
}
