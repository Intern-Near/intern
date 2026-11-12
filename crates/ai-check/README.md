# ai-check

Checks 3, 4 and 5 of the program on NEAR (01-SHARED-INTERFACE.md section 7): the model's signature, the rulebook,
the decision line. Engine 2 writes it; Engine 1's contract calls `verify` inside `propose`. The interface is fixed in
01 §11.1.

Pure (no NEAR SDK, no network, no clock, no storage), `no_std` with `alloc`, no `unsafe`. Its only dependency is
Engine 1's `intern/crates/shared` (the `Host` trait and the enums of 01 §11). It never panics: every bad input is one
of the three refusals. Follows 01 version 1.3 (the checks are the same as in 1.2).

## What it checks, in order

| Check | Refusal | Passes when |
|---|---|---|
| 3 | `BAD_MODEL_SIGNATURE` | The signature is the pinned signer's, over `model:sha256(request):sha256(response)` (lower-case hex). ECDSA: the Ethereum "personal sign" hash, `ecrecover`, then the last 20 bytes of the key's keccak256 equal the pinned address. ed25519: `ed25519_verify` over the text with the pinned key |
| 4 | `WRONG_RULEBOOK` | The request is exactly the pinned model being sent the current rulebook: see below |
| 5 | `MALFORMED_DECISION` | `choices[0].message.content` of a response with exactly one choice is a decision line for this round and nonce, written exactly as `decision_line` writes it |

The request (check 4, 01 1.2 §6.3): a JSON object whose only keys are `model`, `messages`, `stream` and,
optionally, `chat_template_kwargs`; `model` is the pinned model; `stream` is `false`; `messages` is exactly two
messages with exactly the keys `role` and `content` (a string), the system message first, its text equal to the
rulebook byte for byte once JSON escapes are decoded, then the user's message; `chat_template_kwargs`, if present,
is exactly `{"enable_thinking": false}`.

## Why it has its own JSON reader

The request and response bodies are JSON, and the risk is that two readers see different things in the same bytes:
NEAR AI's server, which decides what the model was shown, and this program, which decides what it was shown. A
general-purpose parser is built to be forgiving: it may keep one of two copies of a key, accept comments, trailing
commas or odd numbers, or read invalid text somehow. Each of those is a place where the two could disagree.

So `src/json.rs` (about 250 lines) reads only strict RFC 8259 JSON and refuses everything a careful reader could
take two ways: a key written twice in one object, text that is not UTF-8, raw control characters in strings, lone
surrogates, anything outside the grammar, anything after the value. Escapes are decoded (including `\u` surrogate
pairs), so a string is compared by the text it stands for, which is what the model read. Its work grows linearly
with the input; nesting is capped at 64 levels and an object at 256 keys, so no input can exhaust the stack.

The decision line has only two forms, so it is not parsed in general at all: `src/line.rs` matches the exact text
piece by piece, with the variable parts written the canonical way, and `verify` then also compares it with
`decision_line` byte for byte.

## Decisions from 01 version 1.2 that this crate follows

- The request's shape: as above (01 §6.3).
- The decision line (01 §6.2): a margin of `"0"` reads as a bet (the rank checks then refuse it as `ZERO_MARGIN`,
  test case D13); the leverage is a whole number, 1 or more. A leverage of 0, a market outside the six, a margin above
  u128 or a leverage above u32 is `MALFORMED_DECISION`.
- Nothing may stand before or after the line: a blank line, a space or a tab is `MALFORMED_DECISION` (test case
  D12). This is the only rule now; the `strict-answer` build option of handover 1 is gone.
- The form of `v` for ECDSA: NEAR AI writes 27 or 28; `verify` passes `Host::ecrecover` the recovery id 0 or 1, never
  anything else, and does not reject high-s (01 §11).
- The scheme: both work; `Pinned::algo` is the contract's choice. 01 1.2 pins `z-ai/glm-5.3-flash`, ed25519, signer
  `5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff`.
- A size limit: none here. The contract can cap the body sizes before calling `verify`.

## Tests

Run from `intern/` (the crate is a member of the workspace in `intern/Cargo.toml`):

```
cargo test -p ai-check                                                    # 17 tests
cargo build -p ai-check --release --target wasm32-unknown-unknown
```

- every one of the 19 real signed answers recorded in step 1 (`intern/fixtures/ai/`) verifies, with either scheme,
  and gives the decision read by eye;
- one changed byte in the request, the response or the signature gives `BAD_MODEL_SIGNATURE`, for every recording;
  so does another signer, another model, a cut or overlong signature, or a `v` other than 0, 1, 27, 28;
- a genuine signature over a request with another rulebook gives `WRONG_RULEBOOK`, for every recording, and 20
  other request shapes are refused;
- the decision-line cases D1 to D13 of 01 §12, read from Engine 1's `intern/interface/vectors/checks.json`, plus
  more variants of them (a space after each colon, padding of every kind before and after the line);
- the model, scheme and signer pinned in 01 1.2: its four recordings give the decisions read by eye, and every other
  model's recordings are `BAD_MODEL_SIGNATURE`;
- the JSON reader's refusals, its escapes, and its limits (a million `[` does not overflow the stack);
- 20,000 random inputs and 5,000 damaged real bodies: no panic.

The test `Host` is built on ordinary crates (sha2, sha3, k256, ed25519-dalek) and fails the test if `verify` ever
passes a recovery id other than 0 or 1.

## Not done

- Gas was not measured here; Engine 1 measures it in the contract.
