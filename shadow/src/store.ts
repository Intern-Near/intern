import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { writeNew } from "../../runner/src/exchange.ts";
import { modelSlug } from "../../runner/src/recordings.ts";
import { isTickId } from "./schedule.ts";

/**
 * Where a run keeps its files:
 *
 *   <run-dir>/run.json                         settings, written once by `init`
 *   <run-dir>/models.json                      raw GET /v1/models at `init` (token prices)
 *   <run-dir>/events.jsonl                     one line per event, appended, never rewritten
 *   <run-dir>/ticks/<tick>/prices-pre.json.gz  raw Hyperliquid prices read before the decisions (gzip of the exact body)
 *   <run-dir>/ticks/<tick>/prices-pre.meta.json   when and how they were read
 *   <run-dir>/ticks/<tick>/prices-post.json.gz prices read right after the decisions (paper entry prices)
 *   <run-dir>/ticks/<tick>/<model-slug>/<rank>/  request.bin, response.bin, signature-*.json, meta.json
 *   <run-dir>/ticks/<tick>/tick.json           written last; its absence marks a tick cut short
 *
 * Raw data is never overwritten. The report is derived from these files and can be regenerated at any time.
 */

export function tickDir(runDir: string, id: string): string {
  return join(runDir, "ticks", id);
}

export function exchangeDir(runDir: string, id: string, model: string, rank: string): string {
  return join(tickDir(runDir, id), modelSlug(model), rank);
}

/** The ids of every tick folder, in time order. */
export function listTickIds(runDir: string): string[] {
  const dir = join(runDir, "ticks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isTickId(d.name))
    .map((d) => d.name)
    .sort();
}

/**
 * Appends one event as a JSON line, synchronously, so events reach the disk in order before anything else
 * happens. A crash can leave at most the last line cut short; readers skip it.
 */
export function appendEvent(runDir: string, event: Record<string, unknown>): void {
  mkdirSync(runDir, { recursive: true });
  appendFileSync(join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
}

/** Saves a text body gzipped (lossless; the exact bytes come back out). Never overwrites. */
export async function writeNewGz(path: string, body: string): Promise<void> {
  await writeNew(path, gzipSync(Buffer.from(body, "utf8")));
}

export function readGz(path: string): string {
  return gunzipSync(readFileSync(path)).toString("utf8");
}
