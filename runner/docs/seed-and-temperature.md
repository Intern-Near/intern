# Seed and temperature: can we stop the runner re-asking the AI?

**Short answer: no, not with `temperature` and `seed` alone.** NEAR AI accepts both, and its signature covers them
byte for byte. But three requests with the very same bytes, at temperature 0 and seed 42, gave two different bets.
And the runner writes the user message, so it could change one character and ask again anyway. Known limit 6 of 01
("The proof does not bind the runner. The rank is the only bound.") stays true. Nothing here changes `ai-check`.

Checked on 2026-11-13 by Engine 2, from NEAR AI's docs and 10 real calls.

## The question

01 §6.3: the proof shows which model gave which answer to which request. It does not stop the runner from asking
several times and submitting the answer it likes. Would it help if the signed request had to carry `temperature: 0`
and a fixed `seed`, so that asking again gives the same answer?

## What NEAR AI's docs say

- The chat completions request schema (`docs.near.ai/api-reference/chat/create-chat-completion.md`) lists
  `temperature` (a number). It does not list `seed`, but it allows other fields (`additionalProperties: {}`).
- GLM-5.3 Flash thinks by default, up to 8,192 tokens of reasoning (`docs.near.ai/cloud/reasoning-models.md`).
- The model's signature is over `model:sha256(request body):sha256(response body)`, the exact bytes
  (`docs.near.ai/cloud/verification/cloud-api/response-signatures.md`). So every field in the body is covered.
- Nothing about whether the same request gives the same answer. The docs do say that instances of one model share
  one signing key, including instances with different measured configurations
  (`.../cloud-api/model-attestations.md`): a request may be served by any of them.

## What was run

`src/cli/seed-temperature.ts` sent one fixed question to `z-ai/glm-5.3-flash` (no streaming, `x-no-aliasing`, as
the runner does): 01 §6.1's rulebook for rank INTERN on a $1,000 pool, round 42, nonce `5eed5eed5eed5eed`, and a
user message made from a saved Hyperliquid snapshot (`src/seed-temperature.ts`). The same case always gives the same
bytes. Every exchange is saved in `intern/fixtures/ai/seed-temperature/` (request, response, signature); the tests
in `test/seed-temperature.test.ts` re-check them offline. 10 calls: 9 completions and 1 signature, 2026-11-13
13:51 to 13:58 UTC.

| # | Extra fields in the request | Answer | Reasoning |
|---|---|---|---|
| 1 | `"temperature":0,"seed":42` | PENGU long $11 | 1,612 chars |
| 2 | `"temperature":0,"seed":42` (same bytes) | PENGU long $11 | 1,448 chars, the same as #1 for the first 72 chars |
| 3 | `"temperature":0,"seed":42` (same bytes) | PENGU long **$20** | 1,546 chars, the same as #1 for the first 168 chars |
| 4 | `"temperature":1,"seed":42` | PENGU long $20 | 1,414 chars |
| 5 | `"temperature":1,"seed":42` (same bytes) | PENGU long **$11** | 3,390 chars, the same as #4 for 25 chars |
| 6 | none (what the runner sends today) | PENGU long $20 | 937 chars |
| 7 | none (same bytes) | PENGU long $20 | 1,059 chars, different from the first character |
| 8 | `"temperature":-1` | HTTP 400: `temperature must be between 0 and 2` | |
| 9 | `"seed":"x"` | HTTP 400: `Provider failed for model 'z-ai/glm-5.3-flash': ... Input should be a valid integer` | |
| 10 | the signature of #1 (ed25519) | verified over the exact bytes, by the pinned key `5a0210f2…caff`, `provider_tee` | |

## Findings

1. **Accepted: yes.** Both fields are taken (HTTP 200), and both are read: an invalid temperature is refused (the
   message names no provider, so probably by the gateway; UNVERIFIED), and a seed that is not a whole number is
   refused by the model's provider, which parses it as an integer (#8, #9).
2. **Signed byte for byte: yes.** The signature of #1 verifies over the SHA-256 of the exact request bytes, which
   end in `"stream":false,"temperature":0,"seed":42}`. The same bytes with seed 43, or without the two fields, do
   not verify (test).
3. **Same answer at temperature 0 with the same seed: no.** Three requests with identical bytes gave $11, $11 and
   $20. The reasoning was different each time. Temperature 0 does change something: those three started the same
   way for 72 to 168 characters, while the others differed within the first 25. That fits greedy sampling whose
   result still drifts. Why it drifts is not documented (UNVERIFIED): likely GPU arithmetic that depends on how
   requests are batched, and several serving instances behind the one key.

So a rule "temperature 0 and seed N" would not make asking again pointless: in three tries the runner already had
two different bets to choose from. And even a perfectly repeatable model would not be enough, because the runner
chooses the user message (the market data and its last line) and can change it before asking again.

## Proposal for the owner

**Option A: the small change (not recommended on its own).** 01 §6.3 would say that the request also carries
`"temperature":0` and `"seed":<n>`, with `n` fixed by the contract (for example the rulebook nonce's first 8 hex
digits read as a number, so the runner cannot pick it). `ai-check` would then require exactly those two keys with
exactly those values at check 4, and refuse anything else as `WRONG_RULEBOOK`. Today's `ai-check` refuses any request
that has them (01 §6.3 allows only `model`, `messages`, `stream` and `chat_template_kwargs`), so the interface, the
runner and the contract would change together, and the contract would be redeployed. Effect, from the measurements:
the answers still varied (two different bets in three tries at temperature 0), so re-asking still works. If
adopted, no public text may say it stops re-asking.

**Option B: what would actually narrow it.** The answer has to be fixed before the runner can know it, and every
ask has to be public:

1. Before the proposal window, the runner commits on chain to the hash of its user message.
2. The round's nonce is drawn by the contract after that commitment, from a source the runner cannot predict. How
   the contract draws the nonce today is not checked here (UNVERIFIED).
3. Check 4 also requires the request's user message to match the commitment, and `temperature` 0 with the seed from
   the nonce (option A).
4. One proposal per commitment; a commitment with no proposal by the end of the window is recorded publicly (a
   no-show the site shows).

Even then, finding 3 means the runner could ask the one committed request several times in private and submit the
answer it likes best of those. That stays open until NEAR AI signs something that can be used only once per ask; its
docs describe nothing like it. Until then, known limit 6 is the honest statement, and the
rank stays the only bound.

## Re-running it

From `intern/runner`, with `NEARAI_API_KEY` in the environment (never printed). It spends a little NEAR AI credit:

```
node --env-file=.env src/cli/seed-temperature.ts --case t0-seed42 --case t0-seed42 --sign 1
```

Cases: `default`, `t0-seed42`, `t1-seed42`, `t0`, `bad-temperature`, `bad-seed`. `--sign <n>` also fetches and
checks the n-th call's signature. At most 10 calls per run. New answers will differ from the ones above.
