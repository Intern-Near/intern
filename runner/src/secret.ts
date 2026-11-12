import { inspect } from "node:util";

const REDACTED = "[redacted]";

/**
 * A secret read from the environment. It prints as "[redacted]" everywhere (String(), template strings,
 * JSON.stringify, console.log), so it cannot leak into a log by accident. Call `reveal()` only at the
 * moment the value goes into an HTTP header or a signer.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

/** Reads an environment variable as a secret. Missing or empty gives null. */
export function readSecret(name: string, env: Record<string, string | undefined>): Secret | null {
  const value = env[name];
  return value === undefined || value === "" ? null : new Secret(value);
}
