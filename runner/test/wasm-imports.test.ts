import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { baseEncode } from "near-api-js";
import { CONTROL_HOST_FUNCTIONS, summarizeImports } from "../src/host-functions.ts";
import type { RpcExchange } from "../src/near-rpc.ts";
import { keepImportsOnly, readImports, readSections, WasmFormatError } from "../src/wasm-imports.ts";
import { readData } from "./support/replay-fetch.ts";

// Real deployed code, read with `view_code` from https://test.rpc.fastnear.com on 2026-11-13 at 15:11 UTC by
// `npm run contract-scan -- --save` (test/data/contract-scan-2026-11-13T151137Z/): the lender's whole wasm as received
// (rpc.json.gz), and the other five contracts cut to their import sections (imports-only.json).
const DIR = "contract-scan-2026-11-13T151137Z";
const SAVED = readData<{ exchanges: RpcExchange[] }>(`${DIR}/rpc.json.gz`);
const LENDER_CODE = (() => {
  const e = SAVED.exchanges.find(
    (x) =>
      x.request.params.request_type === "view_code" &&
      x.request.params.account_id === "lender.desk-lab-2026.testnet",
  );
  if (!e) throw new Error("no lender view_code in the recording");
  return Buffer.from(JSON.parse(e.body).result.code_base64, "base64");
})();
const TRIMMED = readData<{
  contracts: {
    account_id: string;
    code_bytes: number;
    imports: string[];
    imports_only_wasm_base64: string;
  }[];
}>(`${DIR}/imports-only.json`).contracts;
const CONTROL = CONTROL_HOST_FUNCTIONS.map((f) => f.name);

// ---- hand-made modules (WebAssembly binary format: LEB128 numbers, length-prefixed names, id + size sections)
const leb = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
};
const name = (s: string): number[] => {
  const b = [...Buffer.from(s, "utf8")];
  return [...leb(b.length), ...b];
};
const section = (id: number, body: number[]): number[] => [id, ...leb(body.length), ...body];
const wasm = (...sections: number[][]): Uint8Array =>
  Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...sections.flat()]);
const imports = (...entries: number[][]): number[] => section(2, [...leb(entries.length), ...entries.flat()]);
const func = (mod: string, n: string, type = 0): number[] => [...name(mod), ...name(n), 0x00, ...leb(type)];

describe("readImports on the real deployed code", () => {
  it("reads the lender's 35 imports, every one a function from env, and the code hashes to its code_hash", () => {
    assert.equal(
      baseEncode(createHash("sha256").update(LENDER_CODE).digest()),
      "2uAJpQ3nxMsXYA5MHtVHTBMxa1WYjFaB2QAnK9uAu9Em",
    );
    const list = readImports(LENDER_CODE);
    assert.equal(list.length, 35);
    assert.ok(list.every((i) => i.module === "env" && i.kind === "func" && i.type_index !== null));
    const s = summarizeImports(list);
    assert.deepEqual(
      s.control.map((f) => f.name),
      CONTROL,
      "near-sdk's promise code links every control host function",
    );
    assert.deepEqual(s.other_imports, []);
    assert.ok(s.other_actions.includes("promise_batch_action_function_call"));
  });

  it("finds all 11 control host functions in each of the other five contracts too", () => {
    assert.equal(TRIMMED.length, 5);
    for (const c of TRIMMED) {
      const list = readImports(Buffer.from(c.imports_only_wasm_base64, "base64"));
      assert.deepEqual(
        list.map((i) => `${i.module}.${i.name}`),
        c.imports,
        `${c.account_id}: the trimmed module keeps the imports`,
      );
      assert.equal(summarizeImports(list).control.length, CONTROL.length, c.account_id);
    }
  });

  it("keepImportsOnly keeps the header, the type and the import sections byte for byte", () => {
    const only = keepImportsOnly(LENDER_CODE);
    assert.ok(only.length < 2000 && LENDER_CODE.length > 100_000);
    assert.deepEqual(
      readSections(only).map((s) => s.id),
      [1, 2],
    );
    assert.deepEqual(readImports(only), readImports(LENDER_CODE));
    const sec = readSections(LENDER_CODE).find((s) => s.id === 2);
    assert.ok(sec);
    assert.ok(Buffer.from(only).includes(LENDER_CODE.subarray(sec.start, sec.offset + sec.size)));
  });
});

describe("readImports on hand-made modules", () => {
  it("reads every kind of import: function, table, memory, global and tag", () => {
    const m = wasm(
      section(0, [...name("note"), 1, 2, 3]),
      imports(
        func("env", "promise_batch_action_deploy_contract", 3),
        [...name("env"), ...name("table"), 0x01, 0x70, 0x01, ...leb(1), ...leb(10)],
        [...name("env"), ...name("memory"), 0x02, 0x00, ...leb(17)],
        [...name("env"), ...name("g"), 0x03, 0x7f, 0x01],
        [...name("x"), ...name("t"), 0x04, 0x00, ...leb(2)],
        func("other", "f"),
      ),
    );
    assert.deepEqual(readSections(m)[0]?.name, "note");
    const list = readImports(m);
    assert.deepEqual(
      list.map((i) => [i.module, i.name, i.kind, i.type_index]),
      [
        ["env", "promise_batch_action_deploy_contract", "func", 3],
        ["env", "table", "table", null],
        ["env", "memory", "memory", null],
        ["env", "g", "global", null],
        ["x", "t", "tag", 2],
        ["other", "f", "func", 0],
      ],
    );
    const s = summarizeImports(list);
    assert.deepEqual(s.host_functions, ["promise_batch_action_deploy_contract"]);
    assert.deepEqual(
      s.control.map((f) => f.power),
      ["code"],
    );
    assert.deepEqual(s.other_imports, [
      "env.table (table)",
      "env.memory (memory)",
      "env.g (global)",
      "x.t (tag)",
      "other.f (func)",
    ]);
  });

  it("gives no imports for a module without an import section", () => {
    assert.deepEqual(readImports(wasm(section(1, [0]))), []);
    assert.deepEqual(readImports(wasm()), []);
  });

  it("reads a multi-byte LEB128 count and type index", () => {
    const m = wasm(imports(func("env", "input", 300)));
    assert.equal(readImports(m)[0]?.type_index, 300);
  });

  const refuses = (bytes: Uint8Array, why: RegExp) =>
    assert.throws(
      () => readImports(bytes),
      (e) => e instanceof WasmFormatError && why.test(e.message),
    );

  it("refuses what is not a version 1 module", () => {
    refuses(Uint8Array.from([0x00, 0x61, 0x73]), /too short/);
    refuses(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 1, 0, 0, 0]), /magic/);
    refuses(Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x02, 0, 0, 0]), /version 1/);
  });

  it("refuses broken sections and imports instead of reading past them", () => {
    refuses(wasm([2, 50, 0]), /runs past the end/);
    refuses(wasm([14, 0]), /unknown section id 14/);
    refuses(wasm([2, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]), /longer than 5 bytes/);
    refuses(wasm([2, 0x80, 0x80, 0x80, 0x80, 0x10]), /too large/);
    refuses(wasm(imports([...name("env"), 1, 0xff, 0x00, 0x00])), /not valid UTF-8/);
    refuses(wasm(imports([...name("env"), ...name("f"), 0x05, 0x00])), /unknown import kind 0x5/);
    refuses(wasm(section(2, [1, ...func("env", "f"), 0x00])), /left over/);
    refuses(wasm(section(2, [2, ...func("env", "f")])), /unexpected end/);
    refuses(wasm(imports(func("env", "a")), imports(func("env", "b"))), /more than one import section/);
  });
});
