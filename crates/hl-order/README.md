# hl-order

Builds the exact bytes and hash Hyperliquid expects for an order or a leverage change. Engine 2 writes it; the
contract (Engine 1) calls it. The interface is fixed in 01-SHARED-INTERFACE.md section 11.2.

A port of the research probe (`research-scripts/hl-guard/src/lib.rs`) with the NEAR-specific parts taken out.
Pure (no NEAR SDK, no network, no clock, no storage), `no_std` with `alloc`, no `unsafe`. Its only dependency is
Engine 1's `shared` crate (the `Host` trait).

## How the contract uses it

1. `check_format(px_e8, sz_e8, sz_decimals)` with the market's size decimals from 01 §4. `build` cannot do this
   part, because an `Action` does not carry the size decimals.
2. For an opening order: `size_for(notional_e6, px_e8, sz_decimals)` gives the size, and `notional_e6(px_e8, sz_e8)`
   (rounded up) is what to compare with the recorded notional.
3. `build(host, &action, nonce_ms, expires_after_ms, testnet)` gives `action_json` (what is posted to Hyperliquid
   as `"action"`) and `digest` (what NEAR's signing network signs).

## Client order id (cloid)

An order may carry a client order id ("cloid"): 16 bytes the signer picks. Hyperliquid keeps it with the order and
returns it with each of the order's fills. The contract's orders carry none today: its fills have no `cloid` key
(`intern/fixtures/hl/info/2026-11-12T115243Z/userFills-testnet-contract.json`). **The contract does not use this
yet**; nothing that is deployed changes.

**Setting it.** `build` is unchanged. `build_with_cloid` takes one more argument:

```rust
let cloid = hl_order::Cloid(bytes); // [u8; 16]
let built = hl_order::build_with_cloid(host, &action, Some(cloid), nonce_ms, expires_after_ms, testnet)?;
```

- `None` gives exactly what `build` gives, byte for byte (checked on all 16 reference cases below).
- `Some` adds `"c":"0x…"` (32 lower-case hex digits) as the order's last key, after `"t"`, which is where the
  official SDK puts it. The cloid is inside the signed hash, so nobody can change or remove it without breaking
  the signature.
- Only orders carry one. A cloid on a leverage change is refused (`HlError::CloidOnLeverage`): Hyperliquid's
  `updateLeverage` has no such field.

**What it gives.** Every fill in Hyperliquid's public `userFills` / `userFillsByTime` carries its order's `cloid`
(seen in a recorded mainnet reply, `intern/fixtures/hl/info/2026-11-11T173427Z/userFillsByTime-mainnet-sample.json`),
and `orderStatus` accepts a cloid in place of an order id (Hyperliquid's info-endpoint docs). With the encoding
below, anyone can sort the contract's fills by verdict exactly, partial fills included (round 7's opening order
filled in two parts, 17 and 251 DOGE), with no time windows and no guessing. A fills-against-results check becomes
exact.

**What it needs from the owner.**
1. 01 §11.2 gains `Cloid`, `build_with_cloid` and `HlError::CloidOnLeverage`, and 01 writes down the encoding, so
   that the site, the runner and anyone else can read it. A signed order's `action` (`SignedAction`) then has a
   `"c"` key.
2. The contract builds its opening and closing orders with `build_with_cloid` in `ask_signature` (the leverage
   action stays as it is), and its tests follow. The runner needs no change: it posts the action exactly as the
   contract signed it.

**Proposed encoding.** 16 bytes, each field big-endian:

| Bytes | Field |
|---|---|
| 0–3 | the round id (its low 32 bits) |
| 4–7 | the position id (its low 32 bits): the id a YES verdict returns |
| 8–15 | the order's own Hyperliquid nonce, the one it is signed with |

```rust
let mut id = [0u8; 16];
id[..4].copy_from_slice(&(round_id as u32).to_be_bytes());
id[4..8].copy_from_slice(&(position_id as u32).to_be_bytes());
id[8..].copy_from_slice(&nonce.to_be_bytes());
```

For example, round 7's opening order (position 3, nonce 1794483574065) would carry
`0x0000000700000003000001a1cf8e5531`.

It is unique because of the nonce. The contract's nonce grows with every action it signs (`next_hl_nonce`:
the last one plus one, or the block time if later), and Hyperliquid refuses a nonce the signer has already used
("never have been used before", its nonces-and-api-wallets page). So no two orders the contract signs share their
last 8 bytes, whatever their round and position. This matters for closes: `close` may be signed again at a new
price (01 §9.3), and each new close gets its own cloid. A cloid made only of the round and an index would repeat
for a re-signed close unless the contract stored a counter, and Hyperliquid's docs do not say whether it refuses a
repeated cloid (UNVERIFIED), so this encoding avoids the question. The first 8 bytes name the verdict: the round id
is there because positions are listed per round (`get_positions({ round_id })`). 32 bits each last thousands of
years, even with 5-minute rounds of four bets; uniqueness never depends on them.

**Not checked.** No order with a cloid from this crate has been sent to Hyperliquid (we do not send to
`/exchange`). Its bytes and digests match the official SDK byte for byte (10 cases), but that Hyperliquid accepts
them is UNVERIFIED until the owner allows a check like `intern/fixtures/hl/exchange-selftest/` (a throwaway key
that Hyperliquid refuses for having no account, but whose recovered address it names). Also UNVERIFIED: whether
Hyperliquid would accept an upper-case cloid; this crate never writes one.

## Tests

```
cargo test -p hl-order
```

The main test rebuilds 16 reference cases computed with Hyperliquid's official Python SDK
(`intern/fixtures/hl/reference/`): the 8 cases the research probe matched, 6 actions that were really signed
through NEAR's signing network and accepted by Hyperliquid testnet, and 2 mainnet cases. For each it compares the
action JSON, the msgpack bytes, the connection id and the digest, and checks that `build_with_cloid` with no cloid
gives the same. A second test does the same for 10 cases with and without a cloid, on both networks
(`cloid_digests.json`, same SDK): round 7's real opening and closing orders, those orders with the proposed cloid,
and cloids of all zeros, all ones, the docs' example and the SDK's own test value. Other tests: integer widths in
msgpack, the 8-byte nonce, where `"c"` goes in the JSON and the msgpack, a cloid on a leverage change refused,
`size_for` never exceeding the notional (200,000 random cases), `check_format` against Hyperliquid's own examples,
and "never panics" on extreme and random input.

## Shared crate

The `Host` trait comes from Engine 1's `intern/crates/shared` (01 §11); this crate has no other dependency. It is a
member of the workspace in `intern/Cargo.toml`, so the commands above run from `intern/`. The contract calls
`check_format` with the market's size decimals before `build` (01 1.2 §11.2).

