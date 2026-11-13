import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isRecord } from "./json.ts";

/**
 * One name from intern/interface/deployments.json (01 §13, written by Engine 1), e.g. "lender" or "usdc". Null when
 * the file or the name is not there (the file is not in the runner's Docker image). src/deployments.ts reads only
 * the coin; this reads any name, for `books-check`.
 */
const DEPLOYMENTS = fileURLToPath(new URL("../../interface/deployments.json", import.meta.url));

export function deployedTestnet(name: string): string | null {
  if (!existsSync(DEPLOYMENTS)) return null;
  const d: unknown = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
  const v = isRecord(d) && isRecord(d.testnet) ? d.testnet[name] : undefined;
  return typeof v === "string" && v !== "" ? v : null;
}
