/** Links between pages. Keeps the data source and scene chosen in the address bar. */
export function href(page: "landing" | "desk" | "bets" | "intern" | "nope" | "judge" | "vote" | "money" | "feed" | "coach" | "goals" | "launch" | "trick" | "tailfade" | "stream" | "rewards" | "week" | "proof", extra: Record<string, string | number> = {}): string {
  const now = new URLSearchParams(window.location.search);
  const q = new URLSearchParams();
  for (const keep of ["source", "scene", "contract"]) {
    const v = now.get(keep);
    if (v) q.set(keep, v);
  }
  if (page !== "landing") q.set("page", page);
  for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "?";
}

export function currentPage(): string {
  return new URLSearchParams(window.location.search).get("page") ?? "landing";
}

/** A day in UTC, e.g. "Tue 10 Nov". */
export function day(at: number): string {
  return new Date(at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}
