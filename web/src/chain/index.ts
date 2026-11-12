import deployments from "../../../interface/deployments.json";
import { nearChain } from "./near";
import { SAMPLE_ACCOUNT, sampleChain } from "./sample";
import { SCENES, type Actions, type Chain, type Scene } from "./types";

export type SourceName = "sample" | "stub" | "live";
export type Source = {
  name: SourceName;
  scene: Scene | null;
  chain: Chain;
  /** On sample data: a pretend account whose actions change the sample world. */
  sample?: { accountId: string; act(accountId: string): Actions };
  /** On the stub and the real contract: the account the site talks to. */
  contractId?: string;
};

const isScene = (v: string | null): v is Scene => v !== null && (SCENES as readonly string[]).includes(v);

/**
 * Where the site's data comes from. The setting is VITE_SOURCE; the address bar can
 * override it, e.g. ?source=sample&scene=REFUSED, so any state can be opened on demand.
 */
export function pickSource(search: string = window.location.search): Source {
  const q = new URLSearchParams(search);
  // The real contract is the default once one is deployed. A `scene` or `stress` in the address
  // asks for sample data; so does VITE_SOURCE=sample or ?source=sample.
  const asksSample = q.has("scene") || q.has("stress");
  const fallback: SourceName = deployments.testnet.coin && !asksSample ? "live" : "sample";
  const wanted = (q.get("source") ?? import.meta.env.VITE_SOURCE ?? fallback) as SourceName;
  // Account names come from intern/interface/deployments.json, which Engine 1 keeps up to date.
  // A setting or the address bar can point somewhere else.
  const net = deployments.testnet;
  const rpc = (import.meta.env.VITE_NEAR_RPC_URL as string | undefined) || net.rpc;
  const contract = q.get("contract") ?? (import.meta.env.VITE_CONTRACT_ID as string | undefined) ?? (wanted === "live" ? net.coin : net.stub);

  if ((wanted === "stub" || wanted === "live") && rpc && contract) {
    return { name: wanted, scene: null, chain: nearChain(rpc, contract), contractId: contract };
  }
  const s = q.get("scene")?.toUpperCase() ?? null;
  const scene = isScene(s) ? s : "QUIET";
  const chain = sampleChain(scene, Date.now, { stress: q.has("stress") });
  return { name: "sample", scene, chain, sample: { accountId: SAMPLE_ACCOUNT, act: chain.act } };
}
