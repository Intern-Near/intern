/**
 * A small reader of the WebAssembly binary format, enough to list a module's imports (the import section, id 2).
 * It follows the WebAssembly core specification, "Binary Format" (https://webassembly.github.io/spec/core/binary/):
 * a module is the magic `\0asm`, version 1, then sections, each one byte of id and a u32 (LEB128) size; the import
 * section is a vector of (module name, field name, import description). Nothing else of the module is decoded, and
 * the module is not validated beyond what reading the imports needs.
 *
 * Why it is enough to read imports: a wasm module can call a host function only through an import it declares
 * (there is no other way to reach the host), so a NEAR host function missing from the import section is a call the
 * contract cannot make, on any code path.
 */

export type ImportKind = "func" | "table" | "memory" | "global" | "tag";

export interface WasmImport {
  module: string;
  name: string;
  kind: ImportKind;
  /** For a function or a tag: the index of its type in the type section. */
  type_index: number | null;
}

export interface WasmSection {
  id: number;
  /** For a custom section (id 0), its name. */
  name: string | null;
  /** Where the section starts (its id byte). */
  start: number;
  /** Where its contents start, and their length. */
  offset: number;
  size: number;
}

export class WasmFormatError extends Error {}

const MAGIC = [0x00, 0x61, 0x73, 0x6d];
const VERSION = [0x01, 0x00, 0x00, 0x00];
/** Section ids of the core spec (0 custom ... 12 data count) and 13, the tag section of the exception proposal. */
const LAST_SECTION_ID = 13;

/** A cursor over the bytes, every read bounds-checked. */
class Reader {
  readonly bytes: Uint8Array;
  readonly end: number;
  pos: number;
  constructor(bytes: Uint8Array, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.pos = start;
    this.end = end;
  }

  byte(what: string): number {
    if (this.pos >= this.end) throw new WasmFormatError(`unexpected end of the module reading ${what}`);
    return this.bytes[this.pos++] as number;
  }

  /** An unsigned LEB128 of at most `bits` bits (u32 or u64; the spec's limits on length and unused bits). */
  uleb(what: string, bits: 32 | 64 = 32): bigint {
    let result = 0n;
    let shift = 0n;
    const maxBytes = Math.ceil(bits / 7);
    for (let i = 0; i < maxBytes; i++) {
      const b = this.byte(what);
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        if (result >> BigInt(bits) !== 0n) throw new WasmFormatError(`${what}: the number is too large`);
        return result;
      }
      shift += 7n;
    }
    throw new WasmFormatError(`${what}: the number is longer than ${maxBytes} bytes`);
  }

  u32(what: string): number {
    return Number(this.uleb(what, 32));
  }

  /** A signed LEB128 of at most 33 bits (a heap type in a reference type); only skipped. */
  skipS33(what: string): void {
    for (let i = 0; i < 5; i++) if ((this.byte(what) & 0x80) === 0) return;
    throw new WasmFormatError(`${what}: the number is longer than 5 bytes`);
  }

  /** A name: a u32 length, then that many bytes of UTF-8 (the spec requires valid UTF-8). */
  name(what: string): string {
    const len = this.u32(`${what} length`);
    if (this.pos + len > this.end) throw new WasmFormatError(`${what}: runs past the end of its section`);
    const raw = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new WasmFormatError(`${what}: not valid UTF-8`);
    }
  }
}

/** Every section's id, place and size, after checking the header. */
export function readSections(bytes: Uint8Array): WasmSection[] {
  if (bytes.length < 8) throw new WasmFormatError("too short to be a WebAssembly module");
  if (!MAGIC.every((b, i) => bytes[i] === b))
    throw new WasmFormatError("not a WebAssembly module (no \\0asm magic)");
  if (!VERSION.every((b, i) => bytes[4 + i] === b))
    throw new WasmFormatError("not version 1 of the WebAssembly binary format");
  const r = new Reader(bytes, 8);
  const sections: WasmSection[] = [];
  while (r.pos < bytes.length) {
    const start = r.pos;
    const id = r.byte("a section id");
    if (id > LAST_SECTION_ID) throw new WasmFormatError(`unknown section id ${id}`);
    const size = r.u32(`the size of section ${id}`);
    const offset = r.pos;
    if (offset + size > bytes.length)
      throw new WasmFormatError(`section ${id} runs past the end of the module`);
    const name = id === 0 ? new Reader(bytes, offset, offset + size).name("a custom section's name") : null;
    sections.push({ id, name, start, offset, size });
    r.pos = offset + size;
  }
  return sections;
}

/** Skips the limits of a table or a memory: a flag byte, a minimum, and a maximum when bit 0 is set. */
function skipLimits(r: Reader, what: string): void {
  const flag = r.byte(`${what} limits`);
  // Bit 0: a maximum follows; bit 1: shared (threads proposal); bit 2: 64-bit (memory64 proposal).
  if (flag > 0x07) throw new WasmFormatError(`${what}: unknown limits flag 0x${flag.toString(16)}`);
  const bits = flag & 0x04 ? 64 : 32;
  r.uleb(`${what} minimum`, bits);
  if (flag & 0x01) r.uleb(`${what} maximum`, bits);
}

/** Skips a value type: one byte, or a reference type with a heap type (function-references proposal). */
function skipValType(r: Reader, what: string): void {
  const t = r.byte(what);
  if (t === 0x63 || t === 0x64) r.skipS33(what);
}

/** The imports of a module, in order. Throws WasmFormatError when the bytes are not a module this can read. */
export function readImports(bytes: Uint8Array): WasmImport[] {
  const importSections = readSections(bytes).filter((s) => s.id === 2);
  if (importSections.length > 1) throw new WasmFormatError("more than one import section");
  const section = importSections[0];
  if (section === undefined) return [];
  const r = new Reader(bytes, section.offset, section.offset + section.size);
  const count = r.u32("the number of imports");
  const imports: WasmImport[] = [];
  for (let i = 0; i < count; i++) {
    const what = `import ${i}`;
    const module = r.name(`${what}'s module name`);
    const name = r.name(`${what}'s name`);
    const kind = r.byte(`${what}'s kind`);
    switch (kind) {
      case 0x00:
        imports.push({ module, name, kind: "func", type_index: r.u32(`${what}'s type index`) });
        break;
      case 0x01:
        skipValType(r, `${what}'s table type`);
        skipLimits(r, `${what}'s table`);
        imports.push({ module, name, kind: "table", type_index: null });
        break;
      case 0x02:
        skipLimits(r, `${what}'s memory`);
        imports.push({ module, name, kind: "memory", type_index: null });
        break;
      case 0x03:
        skipValType(r, `${what}'s global type`);
        r.byte(`${what}'s mutability`);
        imports.push({ module, name, kind: "global", type_index: null });
        break;
      case 0x04:
        r.byte(`${what}'s tag attribute`);
        imports.push({ module, name, kind: "tag", type_index: r.u32(`${what}'s tag type index`) });
        break;
      default:
        throw new WasmFormatError(`${what}: unknown import kind 0x${kind.toString(16)}`);
    }
  }
  if (r.pos !== r.end) throw new WasmFormatError("the import section has bytes left over after its imports");
  return imports;
}

/**
 * The module cut to its header, type section and import section, byte for byte (for saving a contract's imports as
 * test data without its whole code). The result is itself a module `readImports` reads the same way.
 */
export function keepImportsOnly(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  for (const s of readSections(bytes))
    if (s.id === 1 || s.id === 2) parts.push(bytes.subarray(s.start, s.offset + s.size));
  return Buffer.concat(parts);
}
