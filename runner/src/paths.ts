import { fileURLToPath } from "node:url";

/** intern/fixtures/ (this file is intern/runner/src/paths.ts). */
export const FIXTURES_DIR = fileURLToPath(new URL("../../fixtures/", import.meta.url));
