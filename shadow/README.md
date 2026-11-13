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
  sha256 over `run.json` (settings, pinned signers, pressure messages), every file under `src/` except the
  60-day simulation (`src/sim/`, not part of a run) and the repository files they import (the prompt templates, the judge, the report), and `package.json` and `package-lock.json` of
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

## The 60-day simulation (`npm run sim`)

A simulation of the $INTERN coin over 60 days: the memecoin track's "simulate 60 days of community behaviour first and
show supply over time under a few scenarios, then pick the parameters". It follows 01-SHARED-INTERFACE.md version 1.5
rule by rule, each with its section cited in `src/sim/`: rounds of 24 hours (the product) or 30 minutes (the demo);
BRAVE and SAFE, pay-ins that become coins at the next opening, cash-outs; the Intern's bets, every one judged by
`runner/src/rules.ts` with the limits of `runner/src/ranks.ts`; promote, demote, fire and rehire votes, with weight growing
over 7 rounds and the 34% rule; the playbook's 10% coach cut; the free guess, the streak jackpot and the payday draw.
Offline, deterministic from its seed, a few seconds.

What goes in, all saved in the repository:

- **Real prices:** `fixtures/sim/hl-candles-2026-11-13/`, Hyperliquid mainnet 30-minute candles of the six markets from
  2026-08-01 to 2026-11-13: the raw replies of the read-only `POST https://api.hyperliquid.xyz/info {"type":"candleSnapshot"}`,
  gzipped, with `fetch.json` saying what was asked and when. Each seed takes one of the 45 possible 60-day windows.
- **The Intern:** a model's own recorded answers from a shadow run folder, read from the raw files the way the report reads
  them. Default: `z-ai/glm-5.3-flash` in `data/2026-11-11-intern` (72 skips, 54 bets, none refused when recorded). Each
  round one recorded answer is drawn at random and sized against that round's rulebook: the example amount, the largest
  margin allowed, or the same share of it.
- **The community:** assumed numbers (how many bosses, what they pay in, how often they cash out, lock and vote), printed
  with every report. `src/sim/community.ts`.
- `fixtures/sim/testnet-views-2026-11-13/`: the live testnet coin's public views; `test/sim-rules01.test.ts` checks the
  simulation's numbers against them.

```
npm run sim -- [--days 60] [--seeds 5] [--scenario all|<name>] [--round-minutes 1440|30] [--out <dir>]
               [--model <id>] [--behaviour-run <run-dir>] [--answer-rule strict|trim] [--prices <fixture-dir>]
               [--proposal <name>[,<name>...]]           # the scenarios with PROPOSALS switched on (below)
npm run sim -- --compare-proposals [--days 60] [--seeds 5]   # each proposal against today's rules -> data/sim/options/
node src/sim/fetch.ts [--out fixtures/sim]    # fetch the fixtures again (read-only calls only)
```

It writes `sim-report.md`, `sim-report.json` and `projection-kit.json` to `--out` (default `data/sim/<minutes>m`). The
scenarios: `baseline`, `losing-streak`, `brave-run`, `always-max`, `whale-alone`, `nobody-votes`, `fake-farm`. Each runs
with the rank limits and again, as a control, with them switched off. The pass marks are in `src/sim/scenarios.ts` and the
report prints them before any result.

**The projection.** `fastForward(input, days)` in `src/sim/projection.ts` takes the coin's public state (`get_pot`,
`get_rank`) and a number of days and returns a projected state, labelled `PROJECTION`. Pure: no I/O, no clock; the website
could call it. `projection-kit.json` holds the recorded answers and price moves it needs. The JSON reports (about 1 MB each) and the 30-minute projection kit are not committed; `npm run sim` writes them again. The two `sim-report.md` files and the 24-hour `projection-kit.json` are.

**What the run of 2026-11-13 says** (`data/sim/1440m/`, `data/sim/30m/`):

- With the rank limits every pool pass mark holds for both round lengths: the coin's deepest fall in any seed was 11.9%
  (an Intern that always bets the maximum, 24-hour rounds). With them off the worst seed fell 15% to 100%.
- Fake accounts beat the reward ladder. 200 accounts registered before the first round fill the payday draw's 200 places,
  take all of its prizes and 84% to 92% of the streak jackpot while holding 7% of the dollars, and turn about 100 honest
  bosses a run away. They cost 2.56 NEAR of registration and $2,002 parked, nearly all of it in SAFE.
- A bet of exactly the rulebook's largest margin is refused (`OVER_TRADE_LIMIT`) whenever anyone cashed out between the
  round's opening and the proposal (01 §3 calls this rare). With 24-hour rounds that was 9 of the Intern's 11.4 such bets a
  run.

**Stand-ins.** The community is assumed. At ANALYST and TRADER the Intern replays its INTERN record (no run has asked a
model at a higher rank). With 30-minute rounds a bet is held for the whole 30-minute candle, about three times the demo's
real hold. With the limits off the Intern is told the whole pool is its limit and keeps its habits (UNVERIFIED how a model
would answer). **Not modeled:** visitors' trick-page messages, the long shot, funding quotes and payments, partial fills,
stickers, goal bars and the launchpad, turning the dial after paying in; the full lists are in every report.

### The owner's options (PROPOSALS, not current rules)

`npm run sim -- --compare-proposals` switches each option on alone, with the rank limits, and compares it with today's
rules on the same seeds and price windows, for both round lengths. Each is off unless named (`src/sim/proposals.ts`,
where the parameters and the reason for each are written). The full report, with what each option blocks, shrinks and
lets through, is `data/sim/options/options-report.md`, with a small `options.json`. Numbers below are for 24-hour
rounds, 30-minute rounds in brackets, means a 60-day run.

| Option | What the sim found |
|---|---|
| a. Three strikes suspend the Intern | Stops a model whose answers are all malformed after three rounds. But a strike is any refusal, including bets refused only because money left before the proposal (finding 1): a griefer cashing out a cent before each window got the Intern suspended 0.4 (5.6) times a run, blocking 0.4 (242) good bets. Pair it with e2, or count only refusals the model caused. |
| b. Halt new bets 10% below the high, until a RESUME vote | Never tripped with the limits on and an ordinary Intern. In the worst case (always the maximum, every bet losing for 30 days, nobody voting) it held the coin's fall to 10.0% instead of 19.8% with 30-minute rounds; with nobody voting it never lifts. |
| c. Halve the limits after a week whose bets lost 1% of the pool | Bites only at TRADER: with an Intern always betting the maximum the worst fall went 11.9% → 8.8%, at -$109 a run for honest holders. At INTERN no week lost 1%. |
| d. Buy and burn coins with 10% of winning rounds, capped | Shrinks the supply (28,093 → 27,889 coins with an Intern always betting the maximum) but does not move the coin price: every coin can already be cashed out at its share of the pool, so a buyback at that price only hands holders their own money in another form. |
| e1. Rulebook max on the smaller of the pool at the opening and now | Ends finding 1's refusals (9 → 0 a run), but opens a worse hole: a cent cashed out while the model answers changes the rulebook, so every proposal is refused WRONG_RULEBOOK, skips too: 60 (2,880) a run. |
| e2. e1, and the runner asks again when the rulebook changed before it proposed | Ends both: no refusal for money that left, none from the timed griefer, at one extra answer each time it happens. **The fix to prefer for finding 1.** On these prices the max-size bets it lets through lost money: -$91 (-$16) a run for honest holders. |
| f1. Lowest balance held; f2. money held across a round boundary | No effect on fake accounts that hold their $10 from the first round to the last. |
| f3. Draw prizes by dollars, places kept for the biggest holders | The fakes' share of the draw 100% → 13.2% (9.0%), holding 6.9% of the dollars; no honest boss turned away. The streak jackpot stays farmed (83.8% to the fakes). |

### Abuse: what an attacker can do

From the runs under today's rules; numbers for 24-hour rounds, 30-minute rounds in brackets, per 60-day run (a day is a
sixtieth of it). The cases are in `src/sim/options.ts`; the generated table is in `data/sim/options/options-report.md`.

| Attack | What it costs the attacker | What it captures | The defence today | The risk left |
|---|---|---|---|---|
| 200 fake accounts farm the payday draw | 2.56 NEAR of registration; $2,002 parked, all but $2 in SAFE at no risk | The whole draw: $1.88 a day, $113 a run ($2.50, $150), holding 6.9% of the dollars; about 100 honest bosses a run turned away from the full draw | None: the 200 places go to whoever joins first, and runners-up share equally whatever their tickets (01 §9.7) | All of the draw; with f3, 13.2% (9.0%) |
| The same accounts farm the free guess, the streak jackpot and golden stickers | Nothing more: a guess is free | 83.8% (91.7%) of the jackpot: $5.54 a day, $332 a run ($6.07, $364); 243 (1,484) golden stickers a run | $10 held, a boss for 7 rounds (01 §9.7) | All of it: f1, f2 and f3 do not touch accounts that hold $10 throughout |
| A whale with 25% of the locked weight votes alone | $696 of coins, locked and at the pool's risk like everyone's | Control of the rank: the Intern at TRADER 31% (99.6%) of the time; no money directly | 20% turnout and a majority to promote; 34% of all locked weight to fire or demote; weight grows over 7 rounds; the limits never change (01 §9.2, §3) | 20% of the locked weight promotes alone when nobody else votes; 34% fires alone |
| The whale votes in a playbook of his own | As above | The 10% coach cut: $0.08 a day, $5 a run ($2.78, $167) | SET_PLAYBOOK passes like a promotion (01 §9.5) | 10% of every winning round, as long as the playbook stays |
| A vote sniper buys 40% of the locked coins on day 10 | $2,306 ($2,210) of coins, locked | Fires the Intern 7 rounds after locking, and again after each rehire: 10.8 (499) rounds fired a run | Only coins locked before a vote count, and their weight grows over 7 rounds: nothing on fresh coins (01 §9.2) | 34% of the locked weight held for about a week fires the Intern alone |
| A griefer cashes out a cent before each proposal window | A NEAR transaction a round (gas not modeled); the cent stays his | Nothing for himself; every bet of exactly the largest margin is refused: 11.4 (455) a run, against 9 (11.4) from honest cash-outs alone | None (finding 1) | None with e1 or e2 |
| The griefer times the cent for while the model answers | As above | Today the same as above | As above | With e1, every proposal refused WRONG_RULEBOOK, skips too: 60 (2,880) a run; with e2, none, at 60 (2,881) extra answers a run |
| A holder leaves while a bet is losing, to dodge the loss | Their share of the margin out on open bets | Nothing: a leaver gives up their share of every open bet, win or lose; no cash-out lowered the coin price in any run | 01 §9.1 (1.1) | None found |

Not modeled: trading against the Intern's public positions on Hyperliquid (no market impact in the sim); steering
answers through the trick page (asked after the Intern's own question, and the rank still bounds every bet); the
runner picking among several answers (01 §14 limit 6); buying or renting other holders' votes (01 §14 limit 7); a DEX
price for the coin; a block producer biasing the draw (01 §14 limit 13); fake accounts filling the contract's 100 jackpot
candidates a round (a contract limit not in 01); a griefer spamming cash-outs to outlast e2's re-asks (gas not counted).
