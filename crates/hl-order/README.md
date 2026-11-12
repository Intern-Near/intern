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

## Tests

```
cargo test -p hl-order
```

The main test rebuilds 16 reference cases computed with Hyperliquid's official Python SDK
(`intern/fixtures/hl/reference/`): the 8 cases the research probe matched, 6 actions that were really signed
through NEAR's signing network and accepted by Hyperliquid testnet, and 2 mainnet cases. For each it compares the
action JSON, the msgpack bytes, the connection id and the digest. Other tests: integer widths in msgpack, the
8-byte nonce, `size_for` never exceeding the notional (200,000 random cases), `check_format` against Hyperliquid's
own examples, and "never panics" on extreme and random input.

## Shared crate

The `Host` trait comes from Engine 1's `intern/crates/shared` (01 §11); this crate has no other dependency. It is a
member of the workspace in `intern/Cargo.toml`, so the commands above run from `intern/`. The contract calls
`check_format` with the market's size decimals before `build` (01 1.2 §11.2).

