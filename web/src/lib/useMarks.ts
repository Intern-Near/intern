import { useEffect, useState } from "react";

/**
 * Live prices from Hyperliquid's public data, read by the visitor's browser.
 * The program cannot read Hyperliquid, so nothing here is the program's number:
 * it is shown beside the bet, labelled, as an outside reference.
 * Endpoint: POST <api>/info {"type":"metaAndAssetCtxs"} (public, no key).
 */
export type Mark = { mark: number; dayAgo: number; fundingPerHour: number };
export type Marks = { byName: Record<string, Mark>; at: number } | null;

const HOST = { testnet: "https://api.hyperliquid-testnet.xyz", mainnet: "https://api.hyperliquid.xyz" };

type Meta = [{ universe: { name: string }[] }, { markPx: string; prevDayPx: string; funding: string }[]];

export function useMarks(testnet: boolean, everyMs = 10_000): { marks: Marks; error: boolean } {
  const [marks, setMarks] = useState<Marks>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`${testnet ? HOST.testnet : HOST.mainnet}/info`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "metaAndAssetCtxs" }),
        });
        const [meta, ctxs] = (await res.json()) as Meta;
        const byName: Record<string, Mark> = {};
        meta.universe.forEach((u, i) => {
          const c = ctxs[i];
          if (c) byName[u.name] = { mark: Number(c.markPx), dayAgo: Number(c.prevDayPx), fundingPerHour: Number(c.funding) };
        });
        if (alive) {
          setMarks({ byName, at: Date.now() });
          setError(false);
        }
      } catch {
        if (alive) setError(true);
      }
    };
    void read();
    const id = window.setInterval(read, everyMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [testnet, everyMs]);
  return { marks, error };
}

/** A price with as many decimals as its size needs: 0.068924, 1.1315, 73819. */
export function price(n: number): string {
  if (!Number.isFinite(n)) return "–";
  return n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(4) : n.toPrecision(5);
}
