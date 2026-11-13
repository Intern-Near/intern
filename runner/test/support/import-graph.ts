import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The modules a source file loads at run time, read from its text: every `import … from "…"` and `export … from
 * "…"` that is not type-only (type-only imports are erased before running), side-effect imports, and any dynamic
 * `import(`. Biome's formatting keeps each of these at the start of a line, which is what makes the pattern enough.
 */
export function imports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/^(?:import|export)\s+(type\s+)?[\w\s{},*]*?\s*from\s+"([^"]+)";/gm)) {
    if (m[1] === undefined) out.push(m[2] as string);
  }
  for (const m of src.matchAll(/^import\s+"([^"]+)";/gm)) out.push(m[1] as string);
  if (/\bimport\s*\(/.test(src)) out.push("import()");
  return out;
}

/** Every module `entry` loads at run time, following relative imports: files under src/, and what is outside. */
export function graph(entry: string): { files: string[]; outside: string[] } {
  const files = new Set<string>();
  const outside = new Set<string>();
  const walk = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of imports(file)) {
      if (spec.startsWith("./") || spec.startsWith("../")) walk(join(dirname(file), spec));
      else outside.add(spec);
    }
  };
  walk(entry);
  return {
    files: [...files].map((f) => f.slice(f.lastIndexOf("/src/") + 5)).sort(),
    outside: [...outside].sort(),
  };
}
