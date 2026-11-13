# Tail or Fade (spec 12b, first version, testnet)

When the Intern's bet opens, a visitor has **10 minutes** to put a **$10 or $25** chip on the same market at **2x
isolated**: **TAIL** (the same way as the Intern) or **FADE** (the other way). The bet is a real Hyperliquid testnet
position in the visitor's **own** Hyperliquid account, derived from their NEAR account by NEAR's signing network.
Nothing of ours holds their money. There is no platform fee on testnet (owner's decision, 2026-11-12); the 5 bps
builder fee is a mainnet feature.

Code: `tailfade/` (TypeScript, browser and Node, depends only on `@noble/curves` and `@noble/hashes`). Every digest
and signature is checked against Hyperliquid's official Python SDK (`tailfade/reference/sdk_vectors.py`,
`tailfade/test/vectors.json`); 29 tests.

## The visitor's steps

| Step | What happens | Library | Wallet popup |
|---|---|---|---|
| 1. Connect | The visitor's NEAR account | the site's wallet connector | (sign-in) |
| 2. Their address | `hlAddressOf(accountId)`: the derived Hyperliquid address (path `tailfade-1`) | `mpc.ts` | no |
| 3. Test dollars | `POST {faucet}/faucet {"account_id"}`: $30 of test USDC to that address, once | faucet service | no |
| 4. Trading key | `newAgent()` in the browser; keep `agentToHex(agent)` in localStorage. It can trade, never withdraw | `tailfade.ts` | no |
| 5. Approve it | `approveAgent(agent.address)` → `signTransaction(digest)` → the wallet sends it (a call to `v1.signer-prod.testnet` `sign`, 1 yocto, about 10 s) → `sigFromOutcome(outcome)` → `submitApproval(action, sig)`; check with `isApproved(address, agent)` | `tailfade.ts`, `mpc.ts` | **yes, once** |
| 6. Tail or Fade | During `openWindow(feed, now)`: `placeChip({ agent, market, choice, internSide, chipUsd })` | `tailfade.ts` | no (3 ms) |
| 7. Close | `closePosition({ agent, user: address, market })` (reduce-only IOC) | `tailfade.ts` | no |
| 8. Watch | `account(address)`: value, positions, unrealized PnL | `hl.ts` | no |

- `openWindow(feed, now)` reads the coin's feed (`get_feed`): the window opens when the Intern's **opening order**
  is signed (`order_signed` with kind `OPEN`) and lasts 10 minutes, for the market and side of its `approved` bet.
  Market names are the interface's (`SHIB`, `PEPE`); the library maps them to Hyperliquid's (`kSHIB`, `kPEPE`).
- `signTransaction(digest)` is shaped for `@hot-labs/near-connect`'s `signAndSendTransaction`. The signing network
  needs a 1 yocto deposit, so a function-call key cannot do it: one popup is unavoidable (research §2b).
- Orders are IOC 1% through the mid (fill now or not at all), sized to the chip × 2 and never under Hyperliquid's
  $10 minimum. A chip that does not fill says so in its reply; show it.

## Verified on testnet (2026-11-13)

`node scripts/e2e-testnet.ts boss2.desk-lab-2026.testnet` in `tailfade/`, with a test account standing in for a
visitor's wallet. Evidence: `fixtures/hl/tailfade-e2e/20261113T060414-boss2.desk-lab-2026.testnet/`.

| Step | Result |
|---|---|
| Address | `boss2.desk-lab-2026.testnet` → `0xd859cdeb4eaa5fcb6b9e3f8c226c8c173b0bb047` (path `tailfade-1`) |
| Faucet | $30 sent by `usdSend` from the faucet wallet; the address then held $29 (Hyperliquid's $1 fee for a new account) |
| Approve the trading key | NEAR tx `61jVZXTrZv34SZwyxvVPGx1LpHnGzge8khRnCh4Xjref` (the signing network, about 10 s); Hyperliquid `ok`; `extraAgents` lists the key |
| TAIL $10 on DOGE, 2x isolated | leverage `ok`; IOC buy **filled 314 DOGE at 0.063806**, margin $10.02 |
| Close | reduce-only IOC sell **filled 314 DOGE at 0.063784** |
| After | $28.975065, no position (−$0.025: the price move and fees) |

## The faucet

Base URL: see `testnet.tailfade_faucet` in `interface/deployments.json`.

| Call | Answer |
|---|---|
| `GET /faucet` | `{ configured, address, amount_usd, granted, max, balance_usd }` |
| `POST /faucet {"account_id":"visitor.testnet"}` | `200 { ok, account_id, hl_address, amount, reply }`; `400` bad name; `404` no such NEAR account; `409` already funded (this account, or the address already holds funds); `429` two accounts a day from one address; `503` no key yet, cap reached, or empty; `502` Hyperliquid refused |
| `GET /address/<account>` | `{ account_id, hl_address }` |

It derives the address itself from the account name (a caller cannot redirect the money), sends from the owner's
Hyperliquid testnet account (`FAUCET_HL_PRIVATE_KEY`, set only in Railway's private variables), once per NEAR
account, at most `FAUCET_MAX` (30) accounts in all, and never stores the caller's IP address (a salted hash only).

## What the page must say (spec 12b)

- **Not an edge.** Fading the Intern is a bet with real stakes on testnet, not a strategy. Leverage can wipe out the
  chip quickly.
- **Not enforced by a contract.** The browser key trades; nothing of ours checks a visitor's size. The app sets it.
- **Testnet.** Test dollars from the faucet; nothing here is worth money.
