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
