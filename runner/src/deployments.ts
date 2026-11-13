import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isRecord } from "./json.ts";

/** intern/interface/deployments.json (01 §13), written by Engine 1. It is not in the runner's Docker image. */
const DEPLOYMENTS = fileURLToPath(new URL("../../interface/deployments.json", import.meta.url));

/** `testnet.coin` in deployments.json (the live coin), or null when the file or the name is not there. */
export function deployedTestnetCoin(): string | null {
  if (!existsSync(DEPLOYMENTS)) return null;
  const d: unknown = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
  const coin = isRecord(d) && isRecord(d.testnet) ? d.testnet.coin : undefined;
  return typeof coin === "string" && coin !== "" ? coin : null;
}
