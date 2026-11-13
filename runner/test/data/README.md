# Test data

`attestation-*-trimmed.json`: two real responses from `GET https://cloud-api.near.ai/v1/attestation/report`
(`provider=near`), fetched on 2026-11-11 around 14:40 UTC. They are trimmed: every field except
`model_name`, `signing_algo`, `signing_address`, `request_nonce` and `signing_public_key` was replaced with
`<removed: N bytes>`, because each full report is about 300 KB of hardware evidence that these tests do not read.
The kept values are exactly as received.

The untrimmed snapshots that the other tests use are in `intern/fixtures/` (`ai/catalog/`, `hl/info/`).

`derived-public-key-probe.json`: a real read-only view on NEAR testnet, 2026-11-11 18:00 UTC:
`v1.signer-prod.testnet` `derived_public_key` for the research probe (`hlguard1.hackcheck-2026-1103.testnet`, path
`hl-1`, domain 0), and the Hyperliquid address it gives, `0x283779…e040`: the probe's address in the research.

`fills-check-2026-11-13T135610Z/`: one real read-only run of `npm run fills-check -- --coin
coin.desk-lab-2026.testnet --rounds 60 --rpc https://test.rpc.fastnear.com --save …` on 2026-11-13 at 13:56:50 UTC,
while round 52 was open and no bet was in flight. `chain-views.json`: every view it read through
`https://test.rpc.fastnear.com` (get_constants, get_round, get_round_by_id and get_positions for rounds 1 to 52, every
page of get_outbox and get_feed), each with its arguments and the parsed result. `hl-info.json`: the two replies of
`https://api.hyperliquid-testnet.xyz/info` (userFillsByTime and userFunding for `0x46f8…0132`), exactly as received.
`test/fills-check.test.ts` replays them.

`view-access-key-list-2026-11-13.json`: the results of the RPC query `view_access_key_list` for
`intern-runner-ed25519.testnet` and `intern-relayer-ed25519.testnet`, from `https://test.rpc.fastnear.com` on
2026-11-13 at 13:58:50 UTC (public keys only; no secret). `test/key-scope.test.ts` reads them.

`books-check-2026-11-13T150922Z/`: two real read-only runs of `npm run books -- --save …` on 2026-11-13 at 15:09 UTC,
through `https://test.rpc.fastnear.com`, with the lender `lender.desk-lab-2026.testnet` from
`interface/deployments.json`. `coin/rpc.json`: `coin.desk-lab-2026.testnet` at block 277526435; `coin-fast/rpc.json`:
`coin-fast.desk-lab-2026.testnet` at block 277526441. Each file holds every JSON-RPC exchange of that run (`status`,
`block`, then the views at that block: `get_constants`, `get_pot`, `get_rewards`, the test dollar's `ft_balance_of`
of the coin and of the lender, the lender's `get_account` and `get_rate`), each request with the reply body exactly
as received and its own `fetched_at`. `test/books-check.test.ts` replays them.

`supply-log-2026-11-13T150922Z/`: two real read-only runs of `npm run supply-log -- --save …` on 2026-11-13 at
15:09 UTC, through `https://test.rpc.fastnear.com`. `coin/rpc.json`: `coin.desk-lab-2026.testnet` at block 277526446
(feed seq 1 to 313, four pages); `coin-fast/rpc.json`: `coin-fast.desk-lab-2026.testnet` at block 277526452 (feed
seq 1 to 103; its round 23 was due and not yet written). Every exchange as above: `status`, `block`,
`get_constants`, every `get_feed` page, `get_pot`, `get_round`, `ft_total_supply` and `ft_balance_of` of the coin
contract itself. `test/supply-log.test.ts` replays them.

`quote-2026-11-13T151111Z.json`: one real read-only run of `npm run quote -- --market PEPE --side long --margin 20
--leverage 1 --save …` on 2026-11-13 at 15:11 UTC, while round 54 of `coin.desk-lab-2026.testnet` was in its proposal
window and the live runner had just placed bet #35 (PEPE long $15). Every NEAR RPC exchange with
`https://test.rpc.fastnear.com`, exactly as received: `status`, the latest final block (277526635), then six views at
that block (get_constants, get_round, get_rank, get_pot, get_rulebook, get_positions). `test/quote.test.ts` replays it.

`contract-scan-2026-11-13T151137Z/`: one real read-only run of `npm run contract-scan -- --save …` (the default list) on
2026-11-13 at 15:11:37 UTC through `https://test.rpc.fastnear.com`. `rpc.json.gz`: its NEAR RPC exchanges, each request
and reply body exactly as received with its own `fetched_at`: `EXPERIMENTAL_protocol_config`, `view_account` and
`view_access_key_list` for the seven accounts, and `view_code` for `lender.desk-lab-2026.testnet` only (the smallest
contract, 131,977 bytes; gzipped). `imports-only.json`: the other five contracts' code cut to the header, type section
and import section, byte for byte (`keepImportsOnly`: not the whole code, so it does not hash to the code hash), with
the whole code's size and sha256 and the imports read from it at the time. `test/contract-scan.test.ts`,
`test/wasm-imports.test.ts` and `test/proof.test.ts` replay them.

`refusals-2026-11-13T151222Z/replies.json`: one real read-only run of `npm run refusals -- --save …` on 2026-11-13 at
15:12:22 UTC: `get_refusals` of `coin.desk-lab-2026.testnet` and `coin-fast.desk-lab-2026.testnet` and the four `tx`
reads (`https://test.rpc.fastnear.com`; `5JND4c…` from `https://archival-rpc.testnet.fastnear.com`, as the regular node
no longer had it), and the four NearBlocks GETs (`https://api-testnet.nearblocks.io/v3/accounts/<coin>/receipts`), all
exactly as received. `test/refusals.test.ts` and `test/proof.test.ts` replay them.

`proof-bundle-2026-11-13T152437Z.json`: a real bundle written by `npm run proof -- --json …` on 2026-11-13 from
15:24:38 to 15:25:11 UTC (its `generated_at`, `finished_at` and each section's `started_at`), read-only, with no `.env`.
Public data only: public keys, transaction hashes, attestation results. `test/proof.test.ts` checks its shape; the
website can use it as a sample.
