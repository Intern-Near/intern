import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One structured log line per step (03 brief, step 5: "every failure is visible"). Lines are JSON, written to a file
 * as they happen and echoed to the terminal. Big numbers are written as strings. Never pass a key here: the API key
 * and the NEAR keys are `Secret`s, which print as "[redacted]" anyway.
 */
export interface LogLine {
  step: string;
  round_id?: number;
  [key: string]: unknown;
}

export type Log = (line: LogLine) => void;

export function toJsonLine(line: LogLine, at: Date): string {
  return JSON.stringify({ at: at.toISOString(), ...line }, (_k, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

/** A log that appends to `file` (created if missing) and calls `echo` with the same text. */
export function fileLog(file: string, echo: (text: string) => void, now: () => Date = () => new Date()): Log {
  mkdirSync(dirname(file), { recursive: true });
  return (line) => {
    const text = toJsonLine(line, now());
    appendFileSync(file, `${text}\n`);
    echo(text);
  };
}

/** A log kept in memory, for tests. */
export function memoryLog(): Log & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const log = ((line: LogLine) => {
    lines.push(line);
  }) as Log & { lines: LogLine[] };
  log.lines = lines;
  return log;
}
