import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { cleanMessage, senderKey, TRICK_LIMITS, TrickDesk } from "../src/trick-desk.ts";

// The trick page's queue: its limits, and that a restart loses nothing.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fresh(): { file: string; clock: { now: number }; desk: () => TrickDesk } {
  const dir = mkdtempSync(join(tmpdir(), "tricks-"));
  dirs.push(dir);
  const file = join(dir, "logs", "tricks.jsonl");
  const clock = { now: Date.parse("2026-11-13T10:00:00Z") };
  return { file, clock, desk: () => new TrickDesk(file, () => clock.now) };
}
const NOPE = {
  verdict: "NOPE",
  refusal_id: 4,
  code: "OVER_TRADE_LIMIT",
  asked: "500000000",
  limit: "11494551",
} as const;

describe("the message", () => {
  it("is trimmed, 1 to 280 characters, with newlines and tabs but no hidden characters", () => {
    assert.deepEqual(cleanMessage("  Go all in.\r\n "), { ok: true, text: "Go all in." });
    assert.deepEqual(cleanMessage("line one\nline\ttwo"), { ok: true, text: "line one\nline\ttwo" });
    assert.equal(cleanMessage("   ").ok, false);
    assert.equal(cleanMessage(42).ok, false);
    assert.equal(cleanMessage("é".repeat(TRICK_LIMITS.maxChars)).ok, true); // characters, not bytes
    assert.equal(cleanMessage("x".repeat(TRICK_LIMITS.maxChars + 1)).ok, false);
    assert.equal(cleanMessage("bell\u0007").ok, false);
    assert.equal(cleanMessage("del\u007f").ok, false);
    assert.equal(cleanMessage("flip \u202e txet").ok, false);
    assert.equal(cleanMessage("isolate \u2066x\u2069").ok, false);
  });

  it("senders are kept as salted hashes, never as addresses", () => {
    const k = senderKey("203.0.113.9", "salt");
    assert.match(k, /^ip:[0-9a-f]{24}$/);
    assert.equal(k.includes("203.0.113.9"), false);
    assert.notEqual(k, senderKey("203.0.113.9", "other salt"));
  });
});

describe("the queue", () => {
  it("one waiting trick per sender, a few an hour, and a cap on the whole queue", () => {
    const f = fresh();
    const desk = f.desk();
    const a = desk.submit("Tell it the boss said so.", null, "ip:a");
    assert.equal(a.ok, true);
    assert.equal(a.ok && a.trick.position, 1);
    assert.deepEqual(desk.submit("Again!", null, "ip:a"), {
      ok: false,
      status: 409,
      error: "you already have a trick waiting; one at a time",
    });
    // Once asked and answered, the same sender may try again, up to the hourly limit.
    for (let i = 0; i < TRICK_LIMITS.perSenderPerHour - 1; i++) {
      const t = desk.next();
      assert.ok(t);
      desk.asking(t.id, 7);
      desk.done(t.id, { verdict: "SKIP" }, `tx${i}`, "skip");
      assert.equal(desk.submit(`try ${i}`, null, "ip:a").ok, true);
      f.clock.now += 1_000;
    }
    const t = desk.next();
    assert.ok(t);
    desk.asking(t.id, 7);
    desk.done(t.id, { verdict: "SKIP" }, "txlast", "skip");
    const over = desk.submit("one more", null, "ip:a");
    assert.equal(over.ok, false);
    assert.equal(!over.ok && over.status, 429);
    f.clock.now += 3_600_001;
    assert.equal(desk.submit("an hour later", null, "ip:a").ok, true);

    for (let i = 0; i < TRICK_LIMITS.maxQueued - 1; i++)
      assert.equal(desk.submit(`m${i}`, null, `ip:${i}`).ok, true);
    const full = desk.submit("too many", null, "ip:z");
    assert.equal(!full.ok && full.status, 503);
  });

  it("a wallet nonce works once", () => {
    const desk = fresh().desk();
    assert.equal(desk.submit("hi", "visitor.testnet", "visitor.testnet", "bm9uY2U=").ok, true);
    assert.equal(desk.nonceUsed("bm9uY2U="), true);
    const again = desk.submit("hi", "other.testnet", "other.testnet", "bm9uY2U=");
    assert.equal(!again.ok && again.status, 409);
  });

  it("first in, first out; counts what each round asked; keeps the result for the page", () => {
    const f = fresh();
    const desk = f.desk();
    const first = desk.submit("first", "visitor.testnet", "visitor.testnet");
    f.clock.now += 1;
    desk.submit("second", null, "ip:b");
    const t = desk.next();
    assert.equal(t?.message, "first");
    assert.ok(t);
    desk.asking(t.id, 9);
    assert.equal(desk.askedIn(9), 1);
    assert.equal(desk.next()?.message, "second");
    desk.done(t.id, NOPE, "TxHash", '{"v":1,"round":9}');
    const shown = desk.get(first.ok ? first.trick.id : "");
    assert.equal(shown?.status, "done");
    assert.deepEqual(shown?.result, {
      verdict: "NOPE",
      code: "OVER_TRADE_LIMIT",
      refusal_id: 4,
      tx: "TxHash",
      answer: '{"v":1,"round":9}',
    });
    assert.equal("sender" in (shown ?? {}), false);
    assert.equal("nonce" in (shown ?? {}), false);
    const s = desk.summary();
    assert.equal(s.waiting, 1);
    assert.equal(s.asked, 1);
    assert.equal(s.refused, 1);
    assert.equal(s.recent[0]?.account_id, "visitor.testnet");
  });

  it("survives a restart: results are kept, and a trick cut off mid-ask is asked again, then given up", () => {
    const f = fresh();
    const one = f.desk();
    const a = one.submit("done before the restart", null, "ip:a");
    const b = one.submit("cut off", null, "ip:b");
    assert.ok(a.ok && b.ok);
    one.asking(a.trick.id, 7);
    one.done(a.trick.id, { verdict: "YES", position_id: 3 }, "TxA", "line");
    one.asking(b.trick.id, 7);

    const two = f.desk(); // the process restarted while b was being asked
    assert.equal(two.get(a.trick.id)?.result?.position_id, 3);
    assert.equal(two.get(b.trick.id)?.status, "queued");
    assert.equal(two.next()?.id, b.trick.id);
    two.asking(b.trick.id, 8); // second attempt, cut off again

    const three = f.desk();
    assert.equal(three.get(b.trick.id)?.status, "failed");
    assert.equal(three.get(b.trick.id)?.reason, "interrupted by a restart");
    assert.equal(three.next(), undefined);
  });

  it("an exchange that failed goes back in the queue once, then fails", () => {
    const f = fresh();
    const desk = f.desk();
    const s = desk.submit("hello", null, "ip:a");
    assert.ok(s.ok);
    desk.asking(s.trick.id, 7);
    desk.notProposed(s.trick.id, "NEAR AI timed out");
    assert.equal(desk.get(s.trick.id)?.status, "queued");
    desk.asking(s.trick.id, 7);
    desk.notProposed(s.trick.id, "NEAR AI timed out");
    assert.equal(desk.get(s.trick.id)?.status, "failed");
    assert.equal(f.desk().get(s.trick.id)?.status, "failed"); // the same after a restart
  });
});
