import { useEffect, useState } from "react";

export type Async<T> = { data: T | null; error: string | null; loading: boolean };

/** Runs an async read and re-runs it when `key` changes. */
export function useAsync<T>(read: () => Promise<T>, key: string): Async<T> {
  const [state, setState] = useState<Async<T>>({ data: null, error: null, loading: true });
  useEffect(() => {
    let alive = true;
    read().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e: unknown) => alive && setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false }),
    );
    return () => {
      alive = false;
    };
    // `read` is recreated every render; `key` says when the question has changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}
