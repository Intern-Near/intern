import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { type CheckDeps, runCheck, snapshotStamp } from "../src/check-run.ts";
import { HL_INFO_URL } from "../src/hyperliquid.ts";

// Offline: a fake fetch serves the real responses saved on 2026-11-11 by `npm run check -- --save`.
const CATALOG = new URL("../../fixtures/ai/catalog/2026-11-11T1451Z/", import.meta.url);
const HL = new URL("../../fixtures/hl/info/2026-11-11T1451Z/", import.meta.url);
const read = (base: URL, name: string): string => readFileSync(new URL(name, base), "utf8");

const MODELS = read(CATALOG, "models.json");
const SIGNERS = (
  JSON.parse(read(CATALOG, "signers.json")) as {
    records: { model: string; signing_algo: string; signing_addresses: string[] }[];
  }
).records;
const META = { testnet: read(HL, "meta-testnet.json"), mainnet: read(HL, "meta-mainnet.json") };
const KEY = "sk-test-must-never-appear-0123456789";

interface Fake {
  keyStatus?: number;
  mainnetDown?: boolean;
  /** Every Authorization header seen, with the URL it was sent to. */
  auth: { url: string; value: string }[];
}

function fakeFetch(fake: Fake): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    if (auth !== null) fake.auth.push({ url: url.href, value: auth });

    if (url.href === "https://cloud-api.near.ai/v1/models") return new Response(MODELS);
    if (`${url.origin}${url.pathname}` === "https://cloud-api.near.ai/v1/attestation/report") {
      assert.equal(headers.get("x-no-aliasing"), "true");
      assert.equal(url.searchParams.get("provider"), "near");
      if (auth !== null) return new Response("{}", { status: fake.keyStatus ?? 200 });
      const model = url.searchParams.get("model");
      const algo = url.searchParams.get("signing_algo");
      const rec = SIGNERS.find((r) => r.model === model && r.signing_algo === algo);
      if (!rec) return new Response("unknown model", { status: 404 });
      const candidate = {
        model_name: model,
        signing_algo: algo,
        signing_address: rec.signing_addresses[0],
        request_nonce: url.searchParams.get("nonce"),
      };
      return new Response(JSON.stringify({ gateway_attestation: {}, model_attestations: [candidate] }));
    }
    for (const network of ["testnet", "mainnet"] as const) {
      if (url.href === HL_INFO_URL[network]) {
        assert.equal(init?.method, "POST");
        assert.equal(init?.body, '{"type":"meta"}');
        if (network === "mainnet" && fake.mainnetDown) return new Response("down", { status: 500 });
        return new Response(META[network]);
      }
    }
    throw new Error(`unexpected URL ${url.href}`);
  }) as typeof fetch;
}

function deps(fake: Fake, over: Partial<CheckDeps> = {}): CheckDeps {
  let n = 0;
  return {
    fetchFn: fakeFetch(fake),
    env: {},
    now: () => new Date("2026-11-11T15:30:12.345Z"),
    nonce: () => (n++).toString(16).padStart(64, "0"),
    save: null,
    ...over,
  };
}

describe("npm run check (offline, on saved real responses)", () => {
  it("without a key: everything else matches, and the missing key is the one difference", async () => {
    const r = await runCheck(deps({ auth: [] }));
    assert.equal(r.failures, 0);
    assert.equal(r.problems, 1);
    assert.ok(r.lines.some((l) => l.includes("MISSING  not set")));
    assert.equal(r.lines.filter((l) => l.startsWith("  OK  ")).length, 4 + 8 + 12);
  });

  it("with a valid key: everything matches; the key is sent once, only to NEAR AI, and never printed", async () => {
    const fake: Fake = { auth: [] };
    const r = await runCheck(deps(fake, { env: { NEARAI_API_KEY: KEY } }));
    assert.equal(r.problems, 0);
    assert.equal(r.failures, 0);
    assert.equal(r.lines.at(-1), "RESULT  everything matches");
    assert.equal(fake.auth.length, 1);
    assert.equal(fake.auth[0]?.value, `Bearer ${KEY}`);
    assert.match(fake.auth[0]?.url ?? "", /^https:\/\/cloud-api\.near\.ai\/v1\/attestation\/report\?/);
    assert.ok(!r.lines.join("\n").includes(KEY));
  });

  it("reports a rejected key", async () => {
    const r = await runCheck(deps({ auth: [], keyStatus: 401 }, { env: { NEARAI_API_KEY: KEY } }));
    assert.equal(r.problems, 1);
    assert.ok(r.lines.some((l) => l.includes("rejected: HTTP 401")));
    assert.ok(!r.lines.join("\n").includes(KEY));
  });

  it("reports a failed call without stopping the rest of the check", async () => {
    const r = await runCheck(deps({ auth: [], mainnetDown: true }));
    assert.equal(r.failures, 1);
    assert.ok(r.lines.some((l) => l.startsWith("  FAIL  mainnet: Hyperliquid mainnet /info meta: HTTP 500")));
    assert.equal(r.lines.filter((l) => l.startsWith("  OK    testnet")).length, 6);
  });

  it("with --save, writes each raw response under one stamped folder", async () => {
    const saved = new Map<string, string>();
    await runCheck(
      deps(
        { auth: [] },
        {
          save: async (path, body) => {
            saved.set(path, body);
          },
        },
      ),
    );
    assert.deepEqual(
      [...saved.keys()],
      [
        "ai/catalog/2026-11-11T1530Z/models.json",
        "ai/catalog/2026-11-11T1530Z/signers.json",
        "hl/info/2026-11-11T1530Z/meta-testnet.json",
        "hl/info/2026-11-11T1530Z/meta-mainnet.json",
      ],
    );
    assert.equal(saved.get("ai/catalog/2026-11-11T1530Z/models.json"), MODELS);
    assert.equal(saved.get("hl/info/2026-11-11T1530Z/meta-mainnet.json"), META.mainnet);
  });

  it("names snapshot folders by UTC minute", () => {
    assert.equal(snapshotStamp(new Date("2026-01-02T03:04:59.999Z")), "2026-01-02T0304Z");
  });
});
