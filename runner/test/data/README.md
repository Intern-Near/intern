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
