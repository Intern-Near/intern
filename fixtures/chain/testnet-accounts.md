# Testnet accounts (Engine 1)

No secrets in this file. Every private key lives only in `~/.near-credentials/testnet/` on the
owner's machine (the "legacy keychain" the `near` command line and near-api-js both read), with
owner-only file permissions. Testnet only: none of these hold real money.

| Account | What it is | Key file | Created |
|---|---|---|---|
| `desk-lab-2026.testnet` | **Neutral parent** for the real contracts (step 3 on): `coin.`, `usdc.` and test accounts go under it | `~/.near-credentials/testnet/desk-lab-2026.testnet.json` | 2026-11-11, by the testnet faucet with 10 NEAR. Tx `BZg8CTWsHWpz6u41vMsYsbL9jak6xjgxz5skZK5c11i5` |
| `usdc.desk-lab-2026.testnet` | **mock-usdc**, the test dollar (STAND-IN, worth nothing; open `mint`). Also in `interface/deployments.json` | `~/.near-credentials/testnet/usdc.desk-lab-2026.testnet.json` | 2026-11-11 with 2 NEAR from the parent. Tx `5QMTVXUHGS88AZ44sKFHPyTXF6ieeDqLWKRvwwJ49Aoe`; deployed tx `BDM9EF9gkmjmFFifo1FVNchhMTWxemcRWd5K5nPQVenQ`; `burn` added tx `D2QwHGY7zwQjaMPKyj77xKEvncPZCNPbWBDFya9BGxer` |
| `coin.desk-lab-2026.testnet` | The **real coin contract** (in `interface/deployments.json` under `coin` from step 4). Step 4 build: propose with all 16 checks, the AI check is the STAND-IN `fake-ai-check` (signature "FAKE"); demo 30-minute rounds | `~/.near-credentials/testnet/coin.desk-lab-2026.testnet.json` | 2026-11-11 with 5 NEAR. Tx `AV26xh2ywAfEjX1wE8vHCm3yaiMSNaqNZvtw9RhU4aKq`; step 3 deploy `HgQcXU46no5LEhErLrvBMbmbAuZSEJ4BVaQS6ym7ADov`; step 3 code match `CJVExnG6bZAZyNZitpPU8WmhJFUbLCi7R1SP3WWJwJj6`; **step 4 upgrade + migrate** `6AtazNz4PNhoHX5XVXNwTZu8pP41eqj3arDhoYgZtLfm`; step 4 code match `8fRxvsgkp4NVBQ5akrPhfp8VbaRiPaEjxTqjFo3u2S8` (code hash `4CyeVwurRFUGiEM3yK8hQR2GfXAazuYutRSnuZ6qWA7Z`). **Step 5 upgrade + migrate** (votes) `DTquGBSn6Pe4hT3G11oEKDgM47jzyTSCHC4y21HjLEBR` (code hash `HrtG1dZHUENwHfjmE1gkd3KrqeX9TpNKpxYNXVbVE9ST`). **Step 6 upgrade + migrate** (SAFE, dial) `HsFuQgxDKU5EDpeuuCJ9LRxgPoRd2ECrpRL8xhQqbJqf` (code hash `2gC5ya3Hvx7yMC6ABARoyC7n3gPZJkg9hmCLXL8htvbi`). **Step 7 upgrade + migrate** (real AI check: Engine 2's ai-check, GLM-5.3-flash ed25519 pinned; real order signing; runner switched to `intern-runner-ed25519.testnet`; Hyperliquid address `0x46f8eb2a044a826c70e9682fe3bfd65970340132`, path `intern-1`) `36eornpj43JwEhGa6SfrcoY6XdbcRtMdVF7Rv8GaPV6m` (code hash `4iJgzJqhMGfE4DxmV7p77AWWYsP5UsA68zmZosLEd36W`); 1 NEAR added for storage `HCf9CMm1zoNmX2gRXuWJG4xj8s8KbJCwpYuEDNsfT78T`. Step 6 check: boss2 SAFE pay-in `9MaiSnbhv1fma8Mr5R4QCXBYhS21sqEF8ft7PAVZL73z`, boss1 dial to SAFE `84xRm8GibdMczFxVJa9LLUJQH3CLKubzy8z9xoa3EkPh`, boss2 dial to BRAVE `72FbSCCwjv3hzaza5cbt6wNHF5N93jLxPKCEGe6akmTY`, boss2 SAFE cash-out `Dwj5y1DRAcTfBM2Zwk2rhXqUeNExcsvz38EZKyrx89gb`. Step 4 check: NOPE `5JND4cTbyXHN5FMEMURukEt2HVnWtjmgRky4fvWBzmtW`, YES `BYqb9gFTYVuC11iAybuW9Frd4M9LEvNV8ou83AR6S2jQ`, report `Bb8owBz1HGqQEgwtx2ZdD9KXD3fQem6JvvYtEEu2Ke9z`, settle with test-dollar mint `ChwpjYF8HuE2yaC5N6pb4RpEG6ruPtqKzXWdpjthxc9P` **Steps 8+9 upgrade + migrate** `59itBJ8HBe6Fs7fYuTPK4S3mU12nWLr5PZ6SabzQiPDr`, then `rebalance` added `1RbgBz94gtwnN6MGS6pWVrG7G5QcX1QGXKUeFCB9mas` (code hash `H3KSpSw4erMtQWfZ9qmF7RwX2eNvWZNLiigTcUjwkay3`); +2 NEAR `FAT5iqmLAkjigenHCZgA9sMrdEETbsM6aXpCwMtqpSpC`. Steps 8+9 check (boss1/boss2): lend `5vzrJFhf7S2a8e1bYCHVEBT5wskgdW8V13HbN4ypZqAj`, tip `2ATu4S2Heg5wfH9SUwM5PTTA1fkezsbhYGC6c9w5Dzqz`, goal sticker `8FyC5Eo1YRhjAwwo4avFKtoHrh1eYRE7H5LPPuUtK1ou`, badge `FJQCS8ZC6dffgSSgsjtAoVm4AYJsBKi9aom2iYUffyvD`, launch `H5Jd1RqF2o5u29qYULYVVYgmqjyUuAUwZXGYMqp9GTNE`, buy `HsgdvTXeURRrbC1MUZGFCr8yP5wqcJPkS4QfhqX4u7ce`, sell `EpQEj3thMjva34jUTKVm1C2Ehkv8xyJuhPg4g6xFAday`, cash-out through the lender `Aqfa7hTjnCYoGjnyTQME4W1uXj54SnXvSM3qeJHEu4EB`, interest `9CGgDE89Uj4QWrmmFq45EiEqFqN6Rue1m2oasiAQedpd`, playbook `8pMMrYYScbnC7dDTD3dX6qc2S4D5HoLb3sphqpm4i5mR`, rebalance (brought back the slice) `CG9s3rvyYRte6FZU9AXEHL17wSJFfeBCh23vQZwwikAg` |
| `lender.desk-lab-2026.testnet` | The **STAND-IN lender** (step 8): takes the test dollar, pays a fixed 5%/year test rate minted from the open tap. Worth nothing. In `deployments.json` as `lender` | `~/.near-credentials/testnet/lender.desk-lab-2026.testnet.json` | 2026-11-12 with 2 NEAR. Tx `DPieFji2FDk4Hik5uvHTu71nEyVRuibqNCBHDNefcJsZ`; deployed `26FUeuHXcMsqAqDtKqYLQxLPJNVLHzNG19T9WyYW6mbD` |
| `stickers.desk-lab-2026.testnet` | The **sticker NFTs** (NEP-171/177/181; step 9): boss badges (not transferable), the sixteen originals, goal stickers; only the coin mints | `~/.near-credentials/testnet/stickers.desk-lab-2026.testnet.json` | 2026-11-12 with 3 NEAR. Tx `9JmoKSMhunaME2YW5L94x8D8Kt9FMMFAmPa8mY9istTe`; deployed `8xbXRkX8PjL9SqnrMFJdy4iq78b6EAZWhGBWaqs63N1g` |
| `launch.desk-lab-2026.testnet` | The **launchpad** (step 9): launch, buy and sell memecoins on a curve; 1% fee to the BRAVE pool as outside income | `~/.near-credentials/testnet/launch.desk-lab-2026.testnet.json` | 2026-11-12 with 3 NEAR. Tx `F3kVYHfApMVZU8k6QC5XX2tu6p6DWfue7bTan8ML2Mj3`; deployed `3krSKg6BkfHteiHA3Fm1PBpGcph9tXrsDFfTrUCoYu6u` |
| `desk-lab-2026-c.testnet`, `desk-lab-2026-d.testnet` | Faucet accounts: 9.9 NEAR each moved to the parent (`HP4wJGRgkmxsEUBfv4o3Agz19JVVb5n59UCp1HGYazbx`, `98k1Ak8xj6i2WbW95J4BNKy4LJxaWMiNfuppzzSFwPsF`) | `~/.near-credentials/testnet/` | 2026-11-12 by the faucet |
| `coin-fast.desk-lab-2026.testnet` | A **second copy of the coin with 5-minute rounds**, for checks that need many rounds (the step 5 vote cycle). Same code as `coin.`; NOT the product's address | `~/.near-credentials/testnet/coin-fast.desk-lab-2026.testnet.json` | 2026-11-12 with 4.5 NEAR. Tx `HE3TGGiAunG3uyiUP8iFGvPgPiZ3dNvcitFF2tkyMLH9`; deployed + init `9dCXG826k2Yzxsr7ZmSsVHcxQJ3ePr1a9wPCnKT6ndT1`. Step 6 upgrade `BDLe5gingVEH73TKoJUKWvamJQuDQtotrSzAQpmPv6yw`. REHIRE vote 3 passed `8pSdQwSZM6Pyb1GUq1uVSy1HmbHkbNmrasG4EA7r5A4R`, back to INTERN in round 11. **Step 7 upgrade** (stand-in AI check, runner still `runner.desk-lab-2026.testnet`, Hyperliquid address `0xb11e93a0c0145ddd7f17536afb1631342aea3453`) `22skoMksBqUNdahnCSc2Ue4RmbhQGw3EDECP8N9sHMRG`; 1 NEAR added `D1swbsjj5xVBivXprai1tYegoy9AS8UcN37b1Krmaouc`. **Step 7 check** (real NEAR signing network): YES `DTDdEiHc8MNTTqBhq3HGTg6kHRi2WuiYcwgAYmRQbn9t`, sign_next leverage `5vf8AfV5ozLjRGuxn9RfkJVRpmRoHHYTd6bsqgYifyZC`, sign_next open `E2g97Ao2pDAbJmvByUidEGiYGjCEKDPyLtyLUNs5X1RK`, close `Ngt6ZDHQHfyWmApBU9Cg4ewiSei7y3sj4jRn3kb7k2S` (all three: Hyperliquid testnet recovered `0xb11e…3453`), report `HP8WMH2xd74jzc7G2Ery2ZxxJkwke5bW2Xd226iQPYeX`, settle `CWaW112f2xdpQRreyZStEmhWx12JtVfNpuaxguULdr7x`. Step 5 check: PROMOTE opened `HgeHNBSQw2asqSRVXVuZqTUasrxcSNwhYEm6RF5p3EK6`, finished PASSED (effective round 7) `HNeLx7HRQz6NyrFL1sgsT1uepEVeuixXqrDHnD5kZRjA`, ANALYST from round 7; FIRE opened `FQcJDZXLDsSRSk52ZAtixzjRu5NH9oBKURDT6BpT8drA`, finished early `8FAwADuKsagqhUJ71LNukGJYAZMnDNyGTWZUiXECWrx`; propose refused FIRED same round `DuTxFWRfc9hde1upCbeiDfThcAuzUM9ef7ABbZsJnXBD`. Left FIRED (a test copy) |
| `boss2.desk-lab-2026.testnet` | A second **test boss** (step 5 vote check) | `~/.near-credentials/testnet/boss2.desk-lab-2026.testnet.json` | 2026-11-12 with 0.5 NEAR. Tx `GqDQsNtzMFLeYEAQPh3jaKWNk6dgp2YwHr3qjhLZjKdv` |
| `runner.desk-lab-2026.testnet` | Engine 1's test runner. Was the live coin's runner until step 7; now the runner of `coin-fast` only. The live coin's runner is Engine 2's `intern-runner-ed25519.testnet` | `~/.near-credentials/testnet/runner.desk-lab-2026.testnet.json` | 2026-11-12 with 1 NEAR. Tx `BVA7w93YZk57NwFvA2TL9ZYoZhokssFmAwFE3REeocGr` |
| `desk-lab-2026-b.testnet` | Faucet account: its 10 NEAR were moved to the parent (9.9 NEAR, tx `BHdAKYQcbJnaLkc2rmpdDVAmUBMtvdtNYVQC35C2XX4M`) | `~/.near-credentials/testnet/desk-lab-2026-b.testnet.json` | 2026-11-12 by the faucet. Tx `B2XPTtiYKSRH5HZx4GgyWUeXCpnH9NtgELdfbB7MJXGh` |
| `boss1.desk-lab-2026.testnet` | A **test boss**: used for the step 3 check (paid in $100, held coins, cashed out half) | `~/.near-credentials/testnet/boss1.desk-lab-2026.testnet.json` | 2026-11-11 with 0.5 NEAR. Pay-in tx `Etp5doaPNv9vXZ7GGxGg9K2fFgFNYYShnfXtfaiAX4MW`; cash-out tx `C6dzw5yBEA8zCMugzPmRRWGyGoT1zCm7RXFmwcVxrZ6F` |
| `stub.hackcheck-2026-1103.testnet` | The **stub** contract (STAND-IN, step 1). Address also in `interface/deployments.json` | `~/.near-credentials/testnet/stub.hackcheck-2026-1103.testnet.json` | 2026-11-11 with 5.5 NEAR. Tx `8NVLs4KUHQDEqgrA6K48LgH3ZRaxPobg4N7LJxBv3sNh`; deployed tx `6CTmL6NcF4KsdEvaFqXR5YfJfECKaz4y9ZV5AFxVrXrY`; code upgraded (round follows the clock) tx `CHn4VBpW5j1e51CCHs3CRPYdFRkBf8HTXAuF7aW6XyHc` |
| `hackcheck-2026-1103.testnet` | Older research account; parent of the stub. Has its own 508 KB contract | `~/.near-credentials/testnet/hackcheck-2026-1103.testnet.json` | Before this build. Received 5 NEAR from wotsbench on 2026-11-11, tx `4VpqB7Lys9WqAFqNxyzHqF3y6GFii9FBAwmXnE5MZ4ow` |
| `wotsbench1794307171.testnet` | Older research account; spare testnet NEAR | `~/.near-credentials/testnet/wotsbench1794307171.testnet.json` | Before this build |

RPC used: `https://test.rpc.fastnear.com`.

## Step 10 code redeploys (2026-11-12)

Every contract whose freshly built code differed from what was on chain was redeployed: the coin and
coin-fast (attack-suite fixes: numbers near the top of u128, payments above $1 trillion refunded), the launchpad
(checked math) and the stub (rebuilt from the current source). Balances and state kept; `./verify.sh --quick` then printed `SAME` for every contract
(hashes in `docs/REPRODUCIBLE-BUILD.md`).

| Account | Deploy tx | Code hash now |
|---|---|---|
| `coin.desk-lab-2026.testnet` | `AGfs1bxhww3tajthTyqbdL877oupYsojBkudej2sqQnk` | `3yDwSmrChLAwwYX6fLq3VLsuo9QjZdkhtRc3U8Z4GkDb` |
| `coin-fast.desk-lab-2026.testnet` | `GuyNRRpXwVxtPknsQTECs3q8SMYN2tyQzyDWA6C6AP7B` | `9pJfHuEPH7H4qUunU3wrxMcvak5iHwwRc6CdEXnTmUv5` |
| `launch.desk-lab-2026.testnet` | `HqNovoZXb4CwteMkac3pSPBvS3coC2RyhpWzbdiSTMqt` | `Drf72TPyCMNRw7G2YVUsj6h2k8WWxWFjXjAmEo1P82DT` |
| `stub.hackcheck-2026-1103.testnet` | `EVJrvpSuWENaun4N5jZysuFM7mPmn1cQrYDTZGFNnVmC` | `FArWUwVDh57zyMX9cfLQHRY8x5yMMPqi4NdBZvfKkesB` |

## Pool top-up (2026-11-12)

So the Intern's 2% limit is clear of the $11 minimum bet: `boss1.desk-lab-2026.testnet` minted 1,000 test dollars
(tx `2N8HC7pts53KPUgFxmd71gGvjjvd7oS4f8M5QcAvGzi7`) and paid them into BRAVE (tx
`GN9KQhByXUfjqNVqHXwPcumBbXMfkKSdYSND4nQua7BC`, 17:26 UTC; it opened round 11, so the money converts at round 12).
From then on the Intern runs on Railway (project `intern-runner`), not from a laptop.

## Interface 1.4: the reward ladder (2026-11-13)

`migrate_rewards` upgraded both coins in place (balances, locks and records kept; tested first on a local node from
coin-fast's exact 1.3 code). The runner on Railway was redeployed first so it accepts 1.4 and calls `rewards_tick`.

| What | Transaction | Code hash now |
|---|---|---|
| `coin-fast` upgraded to 1.4 | `3GrpWAJNzu6cAucStsGSW4s7rFDKcEP4jDLwJgbtJVYK` | `4GgRc46n6fSQXuep8dfHWwvRsuVJhaEZhV1PAhdejYiZ` |
| `coin` (live) upgraded to 1.4, after round 37 settled | `2hTuWk81QPYtpqWUF5bnVnBXqDBKPVJH8yKo8t9A9xq5` | `4yqGNWQ9evz9exRC4zkt1xiua1UkJL1czDDtxm9K9XCT` |
| `stub` redeployed (reports 1.4) | `DmeHdMk2xkgAkU9Uuz1gqrjMvuedSVyzsyyVZYt96UNf` | `4d4Pp3gzwXwPjBSvK66G4wcdDQ1HgaXENx6jz3hfHiYu` |
| The team's $100 jackpot seed (`boss1`, `{"jackpot":{}}`) | `6QEKWRguHaQ2m7c6Ud771sC45q4BdNsiH8EwbDYQiKy9` | |
| coin-fast checks: a $2 tip ($1 to the jackpot), `enter_draw`, `rewards_tick` (2.6 TGas) | `3XaiPGkY2FuE6gjMMjwZwXVyAY7dB2s1BAqWysWHM65y`, `74MezKpeEipaMFPsKgqhvWQ7kLP1AkrWdPPCb2pQChWr`, `U4hCPzBdmx1wRA4LpWFyFxQymKXCpQCZqQDS8j9VCWY` | |
| coin-fast round 18: boss1 guessed SKIP, boss2 YES; the runner proposed SKIP; `guess_settled` 1 right, 1 wrong | `JDq4wVUSzfEtXFKicnCYf1pzEdVDTto29dpxZZZad5sg`, `5FBtZFF7RQHnzF7AaJCqdU222DSY1yrsC6hiGicFJ5je`, `MZwWtVVKEjHCr1Ky8oHL1fegXLVTq6xyy3iGeW9kJVR` | |

## Using an account yourself

The `near` command line finds the key by account name when you add `sign-with-legacy-keychain`.

```
# balance
near account view-account-summary desk-lab-2026.testnet network-config testnet now

# send testnet NEAR
near tokens desk-lab-2026.testnet send-near <to>.testnet '1 NEAR' network-config testnet sign-with-legacy-keychain send

# switch the stub's scene (any account can)
near contract call-function as-transaction stub.hackcheck-2026-1103.testnet set_scene json-args '{"scene":"REFUSED"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as desk-lab-2026.testnet network-config testnet sign-with-legacy-keychain send
```

## Not done here

- No access key has been deleted from any account. Making the real contract keyless is the
  owner's decision at the very end.
- Back up `~/.near-credentials/` yourself if you want these accounts on another machine; losing that
  folder loses control of the accounts (testnet only).
