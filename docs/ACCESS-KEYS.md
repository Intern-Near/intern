# Removing the contracts' access keys (the owner's decision)

Every contract account below holds one **full-access key**, kept by the NEAR CLI on the owner's machine
(`~/.near-credentials/testnet/`). With it, anyone holding the key can deploy new code over the contract. That is
how steps 3 to 9 were deployed and migrated without losing a balance. Removing the key makes the code permanent.

## Which accounts

| Account | What it is | Recommendation |
|---|---|---|
| `coin.desk-lab-2026.testnet` | the program | the one that matters: "nobody can change the rules" is only true once its key is gone |
| `stickers.desk-lab-2026.testnet` | the sticker NFTs | with the coin |
| `launch.desk-lab-2026.testnet` | the launchpad | with the coin |
| `lender.desk-lab-2026.testnet` | the STAND-IN lender | keep (a stand-in) |
| `usdc.desk-lab-2026.testnet` | the STAND-IN dollar | keep (a stand-in) |
| `stub.hackcheck-2026-1103.testnet` | the stub | keep (a stand-in) |
| `coin-fast.desk-lab-2026.testnet` | a test copy with 5-minute rounds | keep, or delete the account |

## The exact steps (per account; run by the owner)

1. Run `./verify.sh` and check section 5 says `SAME` for the account: the code on chain is exactly this source.
2. Check the account holds enough NEAR for its storage plus room to grow (every new boss, vote, refusal and feed
   item is paid from it, except what registrations and claims pay):
   `near account view-account-summary <account> network-config testnet now`. Top it up first; it can never be
   topped up for an upgrade later, but anyone can still send it NEAR.
3. List its keys: `near account list-keys <account> network-config testnet now`.
4. Delete the full-access key:
   `near account delete-keys <account> public-keys <ed25519:…> network-config testnet sign-with-legacy-keychain send`.
5. Check: `near account list-keys <account> network-config testnet now` shows no keys.

## What follows, for good

- **No fix, ever.** A bug found later stays. No `migrate`, no new feature, no new runner account.
- **The pinned model and signer cannot change.** If NEAR AI changes the signing key of `z-ai/glm-5.3-flash`,
  every proposal is refused from then on (known limit 10). Cash-out still works.
- **The runner account cannot change.** If Engine 2 loses the runner's key, nobody can propose again. Cash-out,
  votes and SAFE keep working.
- **The account's NEAR stays where it is.** Nobody can withdraw it, and nobody can delete the account.
- **What stays possible:** everything the code allows: pay-in, cash-out, votes, claims, rounds, signing orders.

## What I suggest

Keep the keys while the hackathon is being judged on testnet (a bug can still be fixed), say so plainly in the
README ("the contracts are still upgradeable; the keys are removed after judging"), and remove the coin's,
stickers' and launchpad's keys once the code is final. The choice and the action are the owner's.
