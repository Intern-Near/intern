# Measurements (Engine 1, step 10)

Measured on 2026-11-12. "TGas" is the gas burnt by the whole transaction, all its receipts included.
NEAR allows 300 TGas per transaction. Reproduce the local numbers with `crates/coin/sandbox/run.sh`
(test `measure.rs`); the testnet numbers are read back from the transactions named.

## Gas: on NEAR testnet (real contracts, real signing network)

| Call | TGas burnt | Transaction | Notes |
|---|---|---|---|
| `propose` with the **real AI check** (YES, z-ai/glm-5.3-flash, ed25519) | 4.8 | `25YLUkh7u1hjFTyysHCbtTT8vK4mAt7R6TukXfE4veB7` | Engine 2's round 6 |
| `sign_next`: leverage | 15.6 | `3Jac6BQf4SXtWzXn7xnb7YqksyeCnAmQGyKJA6tRkHr2` | of which about 8.4 in the signing network; attach 300 |
| `sign_next`: opening order | 15.6 | `6eHZ5K7F9cAmmPSjsajigUKo6kqbM83B7BYCCoGDgMez` | signed in about 10 s |
| `close` | 15.6 | `3Qdd2YYYfeVBCMzWmNXTqXH2f3RZ95yXo3MfhN4gJipG` | anyone, 1 yocto |
| `report_result` | 2.5 | `GoPUvXo3gNPjvZ65phWKuu7xvMoQMoqSnKJ8Rh6EL1cX` | |
| `settle` (result 0) | 2.6 | `JDP5J7WkKov3T2VV9wUNtH3yBYvNdc8d8z5a3uxFtHPW` | |
| `rebalance` (lent $98.29 to the STAND-IN lender) | 12.3 | `GrD4NKSEXQcnpntZHKpxtwmNBcitbToFibbNYyrKXSTK` | round 9, sent by Engine 2's relayer before proposing; attach 300 |

Replaying three recorded GLM answers through the deployed real check on a local node: YES 4 TGas,
MALFORMED_DECISION 4 TGas, BAD_MODEL_SIGNATURE (one byte changed) 3 TGas.

## Gas: on a local NEAR node (`measure.rs`)

| Call | TGas burnt | Notes |
|---|---|---|
| `storage_deposit` (register a boss) | 2.35 | 0.0064 NEAR attached |
| pay in BRAVE (`ft_transfer_call` on USDC) | 7.28 | waits as pending |
| pay in SAFE | 7.05 | credited at once |
| `lock` (the first call of a round: opens it and converts pending money) | 3.85 | |
| `lock` | 3.87 | |
| `unlock` | 3.03 | |
| `cash_out` BRAVE, paid from idle money | 8.31 | 60 TGas minimum attached |
| `cash_out` SAFE | 8.06 | |
| `cash_out` BRAVE, money brought back from the lender first | 17.11 | 150 TGas minimum attached |
| `turn_dial` to SAFE / to BRAVE | 3.29 / 3.04 | |
| `rebalance` (lend) | 11.09 | STAND-IN lender |
| `collect_interest` | 11.01 | |
| tip (`ft_transfer_call` on USDC) | 7.61 | fills the tip jar |
| `claim_goal_sticker` / `claim_badge` | 8.84 / 9.11 | 0.02 NEAR attached; mints on the sticker contract |
| `submit_playbook` (300 bytes, two authors) | 3.56 | storage deposit attached |
| `open_vote` / `cast` / `finish_vote` (passed) | 3.41 / 2.99 / 3.32 | |
| `propose`: YES / NOPE (stand-in AI check) | 3.54 / 3.39 | the real check adds about 1 TGas |
| `report_result` | 2.72 | |
| `settle` (a win: test dollars minted, coach cut to two authors) | 17.69 | 135 TGas minimum attached with a coach cut |
| launchpad `storage_deposit` / `launch` | 1.81 / 2.29 | 0.05 NEAR attached to register |
| launchpad buy / sell | 15.80 / 15.65 | the 1% fee goes to the coin as outside income |

Every call burns well under 20 TGas; the minimums attached are for the callbacks that put things back
when something fails.

## Storage

| What | Bytes | Who pays |
|---|---|---|
| One boss with every record at its largest (coin balance, pending money, 4 vote locks, cast votes, SAFE), a 64-character account id | 596 | the boss, once: registration pays for 640 bytes (0.0064 NEAR) |
| A playbook | about 100 + text + 72 per author | the submitter, attached; the rest is refunded |
| A sticker (NEP-171 token with metadata and enumeration) | about 1,050 | the claimer: 0.02 NEAR attached, the unused part refunded |
| A launchpad registration | up to 20 balances and 5 launches | 0.05 NEAR |
| The feed / the outbox | at most 1,000 / 200 items | the contract; old items are dropped |
| Rounds, refusals, votes, goal fills, credited refusals | small, one record each | the contract; each is caused by the runner or by a registered boss |

Calls a stranger can make for free do not grow storage: the attack suite sends 30 of them and the
contract's storage stays the same.

| Contract (testnet) | Code | Storage used | Balance |
|---|---|---|---|
| `coin.desk-lab-2026.testnet` | 540 KB | 555,315 bytes | 7.99 NEAR |
| `stickers.desk-lab-2026.testnet` | 204 KB | 205,870 bytes | 3.02 NEAR |
| `launch.desk-lab-2026.testnet` | 208 KB | 209,300 bytes | 3.10 NEAR |
| `lender.desk-lab-2026.testnet` | 132 KB | 132,486 bytes | 2.00 NEAR |
| `usdc.desk-lab-2026.testnet` | 149 KB | 149,895 bytes | 2.01 NEAR |

## The attack suite (`crates/coin/sandbox/tests/attacks.rs`)

One test per line of the threat table in the product spec, section 18, that code can answer. All pass.

| Threat | What the test does | Result |
|---|---|---|
| First-depositor share inflation | Pay in the minimum, cash out all but one unit, gift $1,000 outside the pay-in path | The gift does not move the price; the next depositor keeps all $100 |
| Reentrancy across async calls | Two cash-outs and a transfer of the same coins, sent at once | One of three succeeds; paid once; books match |
| Forged callbacks | A stranger calls all eight callbacks and `migrate` directly | All refused |
| Junk tokens sent to the pot | Another token sent as BRAVE, SAFE, tip and income | Refunded in full; the pool does not move |
| A replayed proposal | The same signed answer sent twice | The second is NOPE `MALFORMED_DECISION` (the nonce moved) |
| A proposal from the wrong account | A stranger calls `propose`, `sign_next`, `report_result` | Refused; nothing recorded |
| A vote with coins locked after it opened | A whale locks 20 times more after a FIRE vote opened, then votes no | Refused: those coins weigh nothing in that vote |
| A bet outside the window | 1 ms before and 1 ms after the proposal window | NOPE `OUTSIDE_WINDOW`; no position |
| Storage running out | 30 free calls from a stranger with nothing | All refused; the contract's storage did not grow |
| Numbers near the top of u128 | `u128::MAX` margins, a leverage beyond u32, `u128::MAX` lock, cash-outs and dials; payments above $1 trillion | Refusals, no abort, nothing moves; a payment above $1 trillion is refunded |

Threats that code cannot answer are known limits, said plainly (01-SHARED-INTERFACE.md section 14):
the runner can steer inside the rank, a vote can be rented for a round, a change of the model's signing key
stops proposals for good, and on testnet results are reported, not measured.
