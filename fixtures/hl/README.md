# Hyperliquid recordings

Real replies from Hyperliquid, saved as received, and reference digests, for tests.

| Path | What it is |
|---|---|
| `info/<UTC time>/meta-testnet.json`, `meta-mainnet.json` | Raw replies to `POST /info {"type":"meta"}` from `https://api.hyperliquid-testnet.xyz/info` and `https://api.hyperliquid.xyz/info`: every perp market with its size decimals and max leverage. A market's position in `universe` is its asset index. Saved by `npm run check -- --save` in `runner/`. Read-only calls |
| `info/<UTC time>/metaAndAssetCtxs-mainnet.json` | Raw replies to `POST https://api.hyperliquid.xyz/info {"type":"metaAndAssetCtxs"}`: the prices put in the user message of each step 1 recording (`../ai/`). Read-only calls |
| `reference/sdk_digests.py`, `reference/digests.json` | Reference digests for `crates/hl-order`, computed with Hyperliquid's official Python SDK, and the script that computed them |
| `info/2026-11-11T173427Z/` | Read-only replies saved for the runner's tests (step 5): `metaAndAssetCtxs-testnet.json` and `allMids-testnet.json` (testnet prices; the six markets still sit at 01 §4's testnet indexes); `clearinghouseState-`, `userFillsByTime-` and `userFunding-testnet-probe.json` for the research probe's address `0x2837…e040` (no position, no fill, no funding: nothing has ever filled); `userFillsByTime-mainnet-sample.json` and `userFunding-mainnet-sample.json`, the first entries of replies for a busy public mainnet address (address left out), to pin the shapes and the sign of funding (a short at a positive rate receives: `usdc` > 0) |
| `exchange-selftest/<UTC>/`, `exchange-selftest/sign_throwaway.py` | A live check of the runner's delivery code, 2026-11-11: an order signed by a brand-new throwaway key (official SDK 0.24.0, `sign_throwaway.py`; the key was held in memory only and never saved), sent to Hyperliquid testnet with the runner's own `exchangeBody` and `postExchange`. Hyperliquid answered `User or API Wallet 0x275e…4b8e does not exist.`, naming exactly the throwaway key's address (`signed-by.json`): it recovered the right signer from the body the runner builds. The account has no funds, so nothing could trade |
| `exchange/<UTC>-round<n>-position<id>-<kind>-action<id>/` | Written by the runner (step 5) for every signed action it sends to Hyperliquid testnet: `request.json` (the exact body), `reply.json` (the exact reply), `meta.json` (HTTP status, time taken, the action). Round 6 (2026-11-12 09:39–09:49 UTC): the contract's address had no funds; Hyperliquid answered "User or API Wallet 0x46f8…0132 does not exist." to all three. Round 7 (11:39–11:49 UTC, after the owner funded the address): the leverage accepted, the opening order filled (268 DOGE), the closing order filled |
| `exchange/<UTC>-round<n>-position<id>-result/` | Written by the runner just before `report_result`: `info.json`, the `/info` requests (`userFillsByTime`, `userFunding`, `clearinghouseState` for the contract's address) and Hyperliquid's replies exactly as they came; `result.json`, the bet, its order windows and the working (`returned = margin + trading result − fees + funding`). Round 7: returned 17960766 of a 17997883 margin |
| `info/2026-11-12T115243Z/` | Read-only, after round 7: `userFills-testnet-contract.json` (every fill the contract's address ever had: the three of round 7) and `clearinghouseState-testnet-contract.json` (account value 99.962883 of the 100 put in, no position) |

## Reference digests

`reference/digests.json` holds 16 actions. For each: the inputs, nonce, expiry, network, the action as the SDK
builds it (JSON and msgpack bytes), the connection id and the EIP-712 digest that gets signed.

| Cases | Where they come from |
|---|---|
| `probe-order-0` to `-4`, `probe-leverage-0` to `-2` | The 8 cases the research probe cross-checked (`research-scripts/hl_guard_e2e.mjs`). Its output printed the 5 order digests but not the 3 leverage ones; the SDK supplies those |
| `live-*` (6) | Actions really signed through NEAR's signing network on 2026-11-11 and posted to Hyperliquid testnet, which recovered the expected address from each signature (`research-scripts/hl_chainsig_order_output.txt`, `hl_guard_e2e_output.txt`) |
| `mainnet-order-0`, `mainnet-leverage-0` | Two of the probe cases hashed for mainnet (source "a"), so both networks are covered |

All 11 digests the research printed (and its 3 printed connection ids) are reproduced exactly by the SDK; the
script fails if any differs. Nothing here was sent anywhere: no order, no signature.

To recompute (Python 3.9 or newer; 3.12.11 was used):

```
python3 -m venv /tmp/hlsdk && /tmp/hlsdk/bin/pip install hyperliquid-python-sdk==0.24.0
cd intern/fixtures/hl/reference && /tmp/hlsdk/bin/python -I sdk_digests.py > digests.json
```
