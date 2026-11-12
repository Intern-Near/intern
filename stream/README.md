# The Intern's stream cues

Spec 12a (the live stream) and brief 03 step 7 ("the stream event feed" and "the Intern's lines"). Every event the
coin publishes (01 §10, `get_feed`) becomes a **cue**: the Intern's pose, the mascot that reacts, what the Intern
says, and the program's caption. The words are in [`../interface/lines.json`](../interface/lines.json), so the
stream and the site say the same thing for the same event.

```
npm install
npm run cues -- --last 12            # the latest 12 events as cues (JSON lines), then stop
npm run cues -- --follow             # keep polling every 3 s, as the site does
npm run verify                       # typecheck, lint, 53 tests
```

A cue:

```json
{ "seq": 56, "at": 1794507591000, "event": "approved", "speak": true, "priority": 3,
  "intern_pose": "happy", "mascot": "stamp:yes",
  "intern": "They said yes. $11.00 on SHIB, long, 1x. I'll be very calm about this.",
  "system": "APPROVED — SHIB LONG, $11.00 at 1x, round 11, within all limits." }
```

- `intern_pose` is one of the eight moods in `sketches/chatgpt/intern/` (idle, thinking, proposing, waiting, happy,
  refused, promoted, fired); `mascot` is `stamp:watching|yes|nope`, `tin:resting|rattling`, `shredder:asleep|awake`.
- `speak: false` events (coins minted, orders signed, votes cast, locks, the dial, sticker claims) only get a
  caption. `priority` 3 interrupts, 2 queues, 1 can be dropped when the stream is busy.
- A line is chosen by `seq`, never at random. Unknown events (a newer contract) give no cue.

`src/cues.ts` is pure (no network, clock or randomness) and has no dependencies, so the website can import it
together with `lines.json`. Turning `intern` lines into speech, and the stream itself, are not built here.

The lines follow spec 24.14: the Intern speaks in the first person, short and a little anxious, never brags, never
talks prices or advice; the program's captions are dry, exact, with units, never with an exclamation mark. The tests
check every event and every refusal code in every variant, and that no hype word or emoji slips in.
