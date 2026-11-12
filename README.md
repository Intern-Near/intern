# $INTERN

A memecoin whose AI "Intern" proposes Hyperliquid perp bets, and a program on NEAR that checks every bet against
the Intern's rank limits before anything is signed, recording a YES or a NOPE. Holders vote to promote, demote or
fire the Intern. Built for the NEAR hackathon; everything runs on **NEAR testnet with test dollars**.

> A fuller README is on its way. Until then, this page only points to what is here.

## What is in this repository

| Folder | What it is |
|---|---|
| `crates/` | The NEAR contracts (Rust): `coin` (the program), `rules` (the rank checks), `shared`, `ai-check` and `hl-order` (verify the AI's signed answer; build Hyperliquid orders), `mock-usdc`, `lender`, `stickers`, `launchpad`, `coin/stub` |
| `runner/` | The off-chain Intern (TypeScript): asks the model, proposes on NEAR, places the signed orders on Hyperliquid testnet, reports results |
| `web/` | The website (Vite + React) |
| `interface/` | Contract addresses (`deployments.json`), refusal codes, ranks, markets, test vectors |
| `fixtures/` | Recorded AI answers, Hyperliquid replies, and every testnet account and transaction |
| `docs/` | What is real and what is a stand-in, gas and storage measurements, the attack suite, how to rebuild and compare |
| `01-SHARED-INTERFACE.md` | The interface all three parts follow (version 1.3), with its known limits in section 14 |

## Check it yourself

```
./verify.sh          # builds every contract, runs every test (incl. a local NEAR node), compares with testnet
./verify.sh --quick  # the same without the local node
```

It sends no transaction and uses no key. Start with `docs/README.md` and `docs/REAL-VS-STANDIN.md`.
