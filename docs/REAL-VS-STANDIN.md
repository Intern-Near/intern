# What is real, and what is a stand-in (Engine 1: the program)

For the README. Every line is true as of 2026-11-12 on NEAR testnet; addresses are in
`intern/interface/deployments.json`. "Real" means the mechanism itself runs on chain as described; on testnet
all money is test money.

| Part | On testnet | Real or stand-in | What that means |
|---|---|---|---|
| The coin ($INTERN: NEP-141/145/148), the BRAVE and SAFE pools, money waiting as `pending`, cash-out, the dial, rounds on the clock, the feed | `coin.desk-lab-2026.testnet` | **Real** | Whole numbers only; every rounding favours the pool; 1,000 units locked at the first conversion |
| The dollar | `usdc.desk-lab-2026.testnet` | **Stand-in** | A plain NEP-141 token with 6 decimals and an open `mint`: worth nothing. Mainnet would pin native USDC |
| The rank checks (checks 1, 2 and 6–12 of the sixteen NOPE reasons) | the coin | **Real** | Run on chain, in order, against the pool now and at round open; a NOPE is recorded, never an abort |
| "Really the AI" (checks 3–5) | the coin | **Real** | Engine 2's `ai-check` verifies NEAR AI's ed25519 signature for the pinned model `z-ai/glm-5.3-flash`, the rulebook byte for byte, and the one-line decision. (The test copy `coin-fast` uses a stand-in check, labelled in its `get_constants().model.id`) |
| The funding quote (checks 13–16) | — | **Not built** | `funding.mode` is `RECORDED`; an attached quote is refused as `BAD_QUOTE_SIGNATURE`. Mainnet would verify a signed 1Click quote |
| Signing Hyperliquid orders | NEAR's signing network `v1.signer-prod.testnet` | **Real** | The contract builds each order (Engine 2's `hl-order`), has it signed for its own derived address `0x46f8eb2a044a826c70e9682fe3bfd65970340132`, and checks the signature recovers to that address before publishing it |
| A filled bet on Hyperliquid | Hyperliquid testnet | **Real, once** | Round 7 on 2026-11-12: 268 DOGE bought and sold; the account's −$0.037117 equals the program's booked result |
| Moving margin to Hyperliquid | — | **Stand-in** | The address was funded once by hand with 100 test USDC; no money moves from the contract to Hyperliquid (known limit 3) |
| A bet's result | `report_result` | **Stand-in** | Reported by the runner, worked out from the fills (`result_source` `REPORTED`); the contract cannot read Hyperliquid (known limits 1 and 2). It then mints or burns test dollars so its books match what it holds (limit 12) |
| Votes: lock, promote, demote, fire, rehire, playbooks | the coin | **Real** | Weight grows over 7 rounds; demote/fire at 34% of all locked weight; promotions wait two rounds |
| Lending | `lender.desk-lab-2026.testnet` | **Stand-in** | A fixed 5% a year test rate, interest minted from the test dollar's tap, never short of money. Rhea Lend works from a contract on mainnet, but its testnet market does not take our test dollar. The pool keeps the Intern's slice idle either way |
| Outside income (tips, launchpad fees) | the coin | **Real** | Credited at the next round's opening, before new money converts; only while the Intern is employed |
| Playbooks and the 10% coach cut | the coin | **Real** | Paid in (test) dollars to the authors of the playbook that was active in a winning round |
| Stickers: boss badges, the sixteen originals, goal stickers (NEP-171) | `stickers.desk-lab-2026.testnet` | **Real** | Badges cannot be transferred. Only the coin contract mints, after checking the claim |
| Who gets an original | `propose(.., credited_to)` | **Trusted** | The runner names the visitor; the program cannot check it (as with the user message, section 6.3) |
| Goal bars: boss goal, tip jar, hype train | the coin | **Real** | Targets are constants; filling one never changes what the Intern may trade |
| The launchpad | `launch.desk-lab-2026.testnet` | **Real** | Constant-product curve in (test) USDC, 1% fee to the BRAVE pool. Launched coins are entries in the launchpad's ledger, not separate NEP-141 contracts |
| The stub | `stub.hackcheck-2026-1103.testnet` | **Stand-in** | Made-up data in the interface's shapes, for building the site |
| The round clock | the coin | **Demo** | 30-minute rounds on testnet; the product's round is 24 hours |
| The contracts cannot be changed | — | **Not yet** | All contract accounts still hold a full-access key, so they can be upgraded; that is how steps 3–9 were deployed. Removing the keys is the owner's decision: see `ACCESS-KEYS.md` |
