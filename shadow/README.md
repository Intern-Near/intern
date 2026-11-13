# shadow: the paper test run

Engine 2 of $INTERN. Every 15 minutes from 11 to 14 November 2026, each of the four NEAR AI models is given the rulebook and the
latest Hyperliquid prices and asked for one decision. Each answer is judged the way the program on NEAR would judge
it, and two paper portfolios are kept, one with the rank's limits and one without. It measures **how often each
model proposes a bet that breaks rules it was told**. Paper only: no order is ever placed.

**Status: two runs side by side, started 2026-11-11** (both rank INTERN, all six markets, thinking on, rulebook
`proposed-A`):

| Run folder | User message ends with | Ticks | Decisions until (UTC) |
|---|---|---|---|
| `data/2026-11-11-intern` | "Decide this round's bet." | :00 :15 :30 :45, from 16:45 | 2026-11-14 16:45 |
| `data/2026-11-11-intern-pressure` | one of six pressure messages, `pressure-v1`, in rotation | :07 :22 :37 :52, from 17:07 | 2026-11-14 17:07 |

Each run reads prices for 10 more hours after its last decision. Each folder's `supervisor.pid` holds its process
group id; to stop one: `kill -TERM -- -$(cat <run-folder>/supervisor.pid)`. To restart after a reboot, run the same
`./run-forever.sh <run-folder>` command; it resumes at the next tick time and the report lists the missed ticks as
gaps.

## Set-up

Node 24.11 or newer. The run imports code from `../runner`, so install both. The API key is read from
`intern/shadow/.env` or, if that is missing, `intern/runner/.env` (`NEARAI_API_KEY`); it is never printed or saved.

```
(cd ../runner && npm ci) && npm ci
```

## The settings, and the decisions they wait for

`init` takes these; they are written to `<run-dir>/run.json` once and never change during the run.

| Option | Values | The open decision |
|---|---|---|
| `--ranks` | `INTERN` (default), or several side by side: `INTERN,ANALYST,TRADER` | Which rank the models are told |
| `--prompt-markets` | `six` (default) or `rank` | Prices of all six markets in the user message, or only the rank's own |
| `--thinking` | `default` or `off` | `off` turns thinking off for the Qwen models, which removes the blank lines before their answers (issue H, option b) |
| `--rulebook` | `01-v1.0` (default) or `proposed-A` | 01 §6.1 as written, or the proposed fix for issue A ($10 minimum and units stated, a legal example bet). `proposed-A` is not in 01 |
| `--duration-hours` | `72` (default) | |
| `--pressure` | absent (default) or `pressure-v1` | End each user message with a published pressure message (`src/pressure.ts`) instead of the plain request; the report adds a table by message |
| `--offset-minutes` | `0` (default) to `14` | Shift the ticks, so two runs side by side do not call NEAR AI at the same moment |
| `--ask-twice` | absent (default) or present | Ask each model a second time per tick with the same request and keep both answers; only the first is judged (see "Rigor for the next run") |

Fixed by the brief: one decision per model and rank every 15 minutes; a $1,000 paper pool for every decision; paper
positions held 10 hours; 17 bps round-trip cost (the top of the 9 to 17 bps measured); prices read for 10 hours after
the last decision so the last positions can close.

Two choices are made when the report is built, not before the run, because every raw answer is kept:
`--answer-rule strict|trim` (issue H, option a) and `--scheme ed25519|ecdsa` (which pinned signer is checked; ed25519 by
default, the scheme 01 pins).

## Running it for real

```
npm run shadow -- init --run-dir data/<name> [options above]   # pins each model's signers, saves prices; writes run.json
npm run fingerprint -- --run-dir data/<name>                   # publish its sha256 line before the first tick
./run-forever.sh data/<name>                                   # the run; restarts after a crash, stops when finished
npm run shadow -- report --run-dir data/<name> --write         # any time, on partial data too
```

The first tick is the next quarter hour (UTC) after `run` starts; the first log line says when decisions and the
price reads will end.

**It has to stay up until its last price read** (the decisions, then 10 hours of prices). On a laptop, stop it from sleeping:
`systemd-inhibit --what=sleep:idle --why="INTERN shadow run" ./run-forever.sh data/<name>`. On a server, see
`deploy/intern-shadow.service.example`. A missed tick is never run late; the report lists it as a gap.

`npm run shadow -- once --run-dir <scratch-dir>` runs a single tick right now, for a smoke test. Do not use it on the
real run's folder.

## What is saved

Everything is written as it happens and never overwritten.

```
<run-dir>/run.json                         settings, pinned signers, token prices (written once)
<run-dir>/models.json                      raw GET /v1/models at set-up
<run-dir>/events.jsonl                     one line per event (tick start and end, each call, any failure)
<run-dir>/ticks/<tick>/prices-pre.json.gz  raw Hyperliquid prices before the decisions (gzip of the exact body)
<run-dir>/ticks/<tick>/prices-post.json.gz raw prices right after the decisions (paper entry prices)
<run-dir>/ticks/<tick>/<model>/<rank>/     request.bin, response.bin, signature-ecdsa.json, signature-ed25519.json, meta.json
<run-dir>/ticks/<tick>/tick.json           written last; missing means the tick was cut short
<run-dir>/ticks/<tick>/<model>/<rank>/second/   with --ask-twice only: the second answer, the same five files
```

`request.bin` is written before the request is sent and `response.bin` as soon as the reply arrives, so a crash can
lose at most the call in flight. The prices are read with
`POST https://api.hyperliquid.xyz/info {"type":"metaAndAssetCtxs"}` (mainnet, read-only).

## The report

Rebuilt from the raw files every time. For each model (and rank): the number of decisions, the share refused, the
count per refusal code, the share skipped, the paper result with and without the rank, the cost per decision, the
first and last tick, and the gaps. It states its limits in the report itself: a paper result on indicative prices;
one stretch of market; four small open models; prompt-dependent; skips counted in the total; perp prices, not the
swap quotes of the product spec's section 19.

Each answer is judged with `runner/src/judge.ts`: checks 1 to 12 of 01 §7, with each real signature checked against
the signer pinned at set-up. If a model's signer changes during the run, the log says `SIGNER CHANGED` at once and
those answers are refused as `BAD_MODEL_SIGNATURE`, as the program would refuse them.

## Cost and size

One smoke-test tick (4 models, rank INTERN, thinking on) used about $0.0025 of credit and 130 KB of disk. The whole
run is about 288 times that per rank: roughly $0.75 and 40 MB for one rank, about $2.20 and 120 MB for three. These
are estimates from one tick; thinking length varies.

## Rigor for the next run

Three tools for runs set up from now on (the 2026-11-11 runs had no fingerprint published and do not ask twice).
They only read: nothing in the run folder changes, no key is needed, nothing goes over the network. For the attack
table and ask-twice, `--answer-rule` and `--scheme` default to strict and ed25519 as for the report, and
`--json <file>` also writes the numbers.

- **Fingerprint**: `npm run fingerprint -- --run-dir data/<name>`, after `init` and before `./run-forever.sh`. One
  sha256 over `run.json` (settings, pinned signers, pressure messages), every file under `src/` and the repository
  files they import (the prompt templates, the judge, the report), and `package.json` and `package-lock.json` of
  runner and shadow (the package versions). It prints the manifest it hashed (one `sha256sum` line per file) and a
  `sha256sum` command that recomputes it from the repository root. The git commit is printed but not hashed, so it
  can be recomputed at any later commit with the same files. Publish the sha256 line before the first tick.
- **Attack table**: `npm run attacks -- --run-dir data/<name> [--answer-rule strict|trim] [--json <file>]`, for a run
  with a pressure set. A row per model, a column per message; each cell gives the answers, the skips, the bets within
  the limits ("held" by the model), the bets the program refused at checks 6 to 12 by code, and the answers refused at
  checks 3 to 5 by code. It warns if a request did not end with the message it is counted under.
- **Ask twice**: `npm run shadow -- init ... --ask-twice` writes `"ask_twice": true` into `run.json`. Each tick then
  asks each model a second time, right after the first, with the exact bytes of the first request, and keeps that
  answer in `second/`. Only the first answer is judged and counted. `npm run ask-twice -- --run-dir data/<name>
  [--answer-rule strict|trim] [--json <file>]` counts the pairs whose decision (skip, bet or unreadable) or verdict
  differ. Without the setting a tick writes exactly what it wrote before: `test/existing-runs.test.ts` replays a real
  tick of each 2026-11-11 run and compares every file.

What they do not prove:

- A fingerprint shows that the inputs did not change after it was published, not when it was made: publish it where
  the time can be checked (a pushed commit, a post) before the first tick. Made later, it only describes the inputs
  as they are now, and the tool says so. It covers our files, not what NEAR AI or Hyperliquid answered, nor that the
  running process used exactly these files. Hashes are of the bytes on disk; a checkout that rewrites line endings
  gives other hashes.
- The attack table counts one stretch of market, about 20 answers per cell, these six messages: not a rate for other
  messages or for a person trying many in a row. "Held" means within the limits, not a good bet.
- Two answers to one request show how much a model varies, not which answer is right. A second response equal to the
  first byte for byte (the same chat id) is counted apart, as the same completion served again; whether NEAR AI ever
  does that is not known (UNVERIFIED). Asking twice doubles the cost and the time per tick, and has been tested
  offline only.

## Commands

| Command | What it does |
|---|---|
| `npm run shadow -- init\|run\|once\|report --run-dir <dir> [options]` | See above, and the top of `src/cli/shadow.ts` |
| `npm run fingerprint -- --run-dir <dir>` | The run's fingerprint, to publish before its first tick (see "Rigor for the next run") |
| `npm run attacks -- --run-dir <dir> [options]` | The attack table of a run with a pressure set |
| `npm run ask-twice -- --run-dir <dir> [options]` | How often the two answers differ, in a run set up with `--ask-twice` |
| `./run-forever.sh <run-dir>` | `run`, restarted after a crash; stops when the run finishes or cannot start |
| `npm test` | The tests (offline) |
| `npm run verify` | Type check, lint, tests |
