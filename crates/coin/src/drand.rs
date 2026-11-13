//! Interface 1.7, owner's decision (Engine 2's list, item 22): fair randomness anyone can check, from drand.
//!
//! The payday draw picks its winners with the randomness of one drand round fixed in advance: the first round of
//! drand's "quicknet" at or after the draw period's end. Anyone (the runner does) submits that round's beacon with
//! `submit_drand(round, signature)`; the contract verifies drand's BLS signature itself with NEAR's BLS12-381 host
//! functions (NEP-488) and keeps `sha256(signature)` as the round's randomness. A draw that is due waits for its
//! beacon for up to `DRAND_WAIT_ROUNDS` of our rounds, then falls back to NEAR's block seed and says so in its event.
//!
//! quicknet: scheme `bls-unchained-g1-rfc9380` (signatures on G1, the public key on G2), a round every 3 seconds from
//! 2023-08-23T15:09:27Z; message = sha256(round, 8 bytes big-endian), hashed to G1 with RFC 9380's
//! `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_`. Golden stickers keep NEAR's block seed: a public beacon would let a
//! guesser predict them.

use crate::*;

/// drand quicknet's chain hash: its beacons are at https://api.drand.sh/<CHAIN_HASH>/public/<round>.
pub const CHAIN_HASH: &str = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
pub const DRAND_GENESIS_MS: u64 = 1_692_803_367_000;
pub const DRAND_PERIOD_MS: u64 = 3_000;
/// Our rounds a due draw waits for its beacon before falling back to the block seed.
pub const DRAND_WAIT_ROUNDS: u64 = 2;
const PUBLIC_KEY: &str = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
/// The BLS12-381 G2 generator, compressed (ZCash format).
const G2_GENERATOR: &str = "93e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8";
const DST: &[u8] = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
/// The BLS12-381 base field modulus, big-endian.
const P: [u8; 48] = [
    0x1a, 0x01, 0x11, 0xea, 0x39, 0x7f, 0xe6, 0x9a, 0x4b, 0x1b, 0xa7, 0xb6, 0x43, 0x4b, 0xac, 0xd7, 0x64, 0x77, 0x4b,
    0x84, 0xf3, 0x85, 0x12, 0xbf, 0x67, 0x30, 0xd2, 0xa0, 0xf6, 0xb0, 0xf6, 0x24, 0x1e, 0xab, 0xff, 0xfe, 0xb1, 0x53,
    0xff, 0xff, 0xb9, 0xfe, 0xff, 0xff, 0xff, 0xff, 0xaa, 0xab,
];

/// The first drand round at or after `ms`.
pub fn drand_round_at(ms: u64) -> u64 {
    if ms <= DRAND_GENESIS_MS {
        return 1;
    }
    (ms - DRAND_GENESIS_MS).div_ceil(DRAND_PERIOD_MS) + 1
}

fn unhex(s: &str) -> Vec<u8> {
    crate::sign::unhex(s).unwrap_or_else(|| env::panic_str("hex"))
}

/// `a >= b` for 49-byte big-endian numbers.
fn ge(a: &[u8; 49], b: &[u8; 49]) -> bool {
    a.iter().zip(b.iter()).find(|(x, y)| x != y).is_none_or(|(x, y)| x > y)
}

fn sub(a: &mut [u8; 49], b: &[u8; 49]) {
    let mut borrow = 0i16;
    for i in (0..49).rev() {
        let mut d = a[i] as i16 - b[i] as i16 - borrow;
        borrow = 0;
        if d < 0 {
            d += 256;
            borrow = 1;
        }
        a[i] = d as u8;
    }
}

/// A 64-byte big-endian number reduced modulo P (RFC 9380's hash_to_field, L = 64), by binary long division.
fn mod_p(x: &[u8]) -> [u8; 48] {
    let mut p = [0u8; 49];
    p[1..].copy_from_slice(&P);
    let mut r = [0u8; 49];
    for byte in x {
        for bit in (0..8).rev() {
            // r = 2r + bit
            let mut carry = (byte >> bit) & 1;
            for i in (0..49).rev() {
                let v = ((r[i] as u16) << 1) | carry as u16;
                r[i] = v as u8;
                carry = (v >> 8) as u8;
            }
            if ge(&r, &p) {
                sub(&mut r, &p);
            }
        }
    }
    let mut out = [0u8; 48];
    out.copy_from_slice(&r[1..]);
    out
}

/// RFC 9380 expand_message_xmd with SHA-256, 128 bytes out.
fn expand_xmd(msg: &[u8]) -> Vec<u8> {
    let mut dst_prime = DST.to_vec();
    dst_prime.push(DST.len() as u8);
    let mut m = vec![0u8; 64];
    m.extend_from_slice(msg);
    m.extend_from_slice(&[0x00, 0x80, 0x00]); // len_in_bytes = 128, then I2OSP(0, 1)
    m.extend_from_slice(&dst_prime);
    let b0 = env::sha256_array(&m);
    let mut out = Vec::with_capacity(128);
    let mut prev = [0u8; 32];
    for i in 1u8..=4 {
        let mut t = Vec::with_capacity(32 + 1 + dst_prime.len());
        if i == 1 {
            t.extend_from_slice(&b0);
        } else {
            t.extend(b0.iter().zip(prev.iter()).map(|(a, b)| a ^ b));
        }
        t.push(i);
        t.extend_from_slice(&dst_prime);
        prev = env::sha256_array(&t);
        out.extend_from_slice(&prev);
    }
    out
}

/// Whether `signature` (48 bytes, compressed G1) is drand quicknet's signature of `round`.
pub fn verify_drand(round: u64, signature: &[u8]) -> bool {
    if signature.len() != 48 {
        return false;
    }
    let msg = env::sha256_array(round.to_be_bytes());
    let uniform = expand_xmd(&msg);
    let mut fps = mod_p(&uniform[..64]).to_vec();
    fps.extend_from_slice(&mod_p(&uniform[64..]));
    let Some(qs) = env::bls12381_map_fp_to_g1(&fps) else {
        return false;
    };
    let mut sum = vec![0u8];
    sum.extend_from_slice(&qs[..96]);
    sum.push(0);
    sum.extend_from_slice(&qs[96..]);
    let Some(h) = env::bls12381_p1_sum(&sum) else {
        return false;
    };
    let Some(s) = env::bls12381_p1_decompress(signature) else {
        return false;
    };
    let mut neg = vec![1u8];
    neg.extend_from_slice(&s);
    let Some(neg_s) = env::bls12381_p1_sum(&neg) else {
        return false;
    };
    let (Some(g2), Some(pk)) =
        (env::bls12381_p2_decompress(unhex(G2_GENERATOR)), env::bls12381_p2_decompress(unhex(PUBLIC_KEY)))
    else {
        return false;
    };
    // e(-sig, g2) · e(H(m), pk) == 1  ⇔  e(sig, g2) == e(H(m), pk). The check also rejects points outside the groups.
    let mut pairs = neg_s;
    pairs.extend_from_slice(&g2);
    pairs.extend_from_slice(&h);
    pairs.extend_from_slice(&pk);
    env::bls12381_pairing_check(&pairs) == Some(true)
}

fn beacon_key(round: u64) -> Vec<u8> {
    [b"d7r".as_slice(), &round.to_le_bytes()].concat()
}

/// The randomness of a verified drand round, if submitted.
pub(crate) fn drand_randomness(round: u64) -> Option<[u8; 32]> {
    env::storage_read(&beacon_key(round)).and_then(|b| b.try_into().ok())
}

#[near]
impl Coin {
    /// 1.7. Anyone: a drand quicknet beacon (`signature`: 96 hex characters). Verified, then kept as
    /// `sha256(signature)` for the draw that needs it. Returns the randomness (hex).
    pub fn submit_drand(&mut self, round: u64, signature: String) -> String {
        let sig = crate::sign::unhex(&signature).unwrap_or_else(|| env::panic_str("signature must be hex"));
        require!(verify_drand(round, &sig), "this is not drand quicknet's signature of that round");
        let r = env::sha256_array(&sig);
        env::storage_write(&beacon_key(round), &r);
        self.feed.push(EventName::DrandSubmitted, json!({"round": round, "randomness": crate::sign::hex(&r)}));
        crate::sign::hex(&r)
    }

    /// 1.7. Where a draw period's luck comes from: `state` is "OPEN" (the period is not over), "WAITING" (tickets
    /// fixed, waiting for `drand_round`'s beacon), or "HELD" with `source` "drand", "block" (no beacon in time) or
    /// "none" (nothing to luck: nobody, one entrant or no prize). `tickets`: the frozen `[account, tickets]` in the
    /// order they are drawn from (while waiting, and kept for the last 4 periods after), or null.
    pub fn get_drand(&self, period: Option<u64>) -> near_sdk::serde_json::Value {
        let p = period.unwrap_or(self.rw.draw_period);
        let (state, round, source) = if let Some(d) = crate::rewards::read_pending(p) {
            ("WAITING", Some(d.drand_round), None)
        } else if let Some((r, s)) = draw_source(p) {
            ("HELD", (r > 0).then_some(r), Some(s))
        } else {
            ("OPEN", None, None)
        };
        let tickets = crate::rewards::draw_tickets(p)
            .map(|w| w.into_iter().map(|(a, t)| json!([a, U128(t)])).collect::<Vec<_>>());
        json!({"period": p, "state": state, "drand_round": round, "source": source,
               "randomness": round.and_then(drand_randomness).map(|r| crate::sign::hex(&r)), "tickets": tickets,
               "chain": "quicknet", "chain_hash": CHAIN_HASH, "wait_rounds": DRAND_WAIT_ROUNDS})
    }
}

fn source_key(p: u64) -> Vec<u8> {
    [b"d7h".as_slice(), &p.to_le_bytes()].concat()
}

/// Kept when a draw is held: (drand round or 0, where its luck came from).
pub(crate) fn note_draw_source(p: u64, drand_round: u64, source: &str) {
    let mut v = drand_round.to_le_bytes().to_vec();
    v.extend_from_slice(source.as_bytes());
    env::storage_write(&source_key(p), &v);
}

fn draw_source(p: u64) -> Option<(u64, String)> {
    let v = env::storage_read(&source_key(p))?;
    let r = u64::from_le_bytes(v.get(..8)?.try_into().ok()?);
    Some((r, String::from_utf8(v[8..].to_vec()).ok()?))
}

/// Tests: as if `round`'s beacon had been submitted.
#[cfg(test)]
pub(crate) fn put_randomness(round: u64, r: [u8; 32]) {
    env::storage_write(&beacon_key(round), &r);
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    /// A real quicknet beacon (https://api.drand.sh/52db…e971/public/1000).
    const SIG_1000: &str =
        "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39";
    const RANDOMNESS_1000: &str = "fe290beca10872ef2fb164d2aa4442de4566183ec51c56ff3cd603d930e54fdd";

    #[test]
    fn a_real_quicknet_beacon_verifies_and_nothing_else_does() {
        testing_env!(VMContextBuilder::new().build());
        let sig = unhex(SIG_1000);
        assert!(verify_drand(1000, &sig), "round 1000's own signature");
        assert!(!verify_drand(1001, &sig), "another round");
        let mut bad = sig.clone();
        bad[47] ^= 1;
        assert!(!verify_drand(1000, &bad), "a changed signature");
        // drand's own randomness is sha256(signature): the same as what the contract keeps.
        assert_eq!(crate::sign::hex(&env::sha256_array(&sig)), RANDOMNESS_1000);
    }

    #[test]
    fn drand_rounds_follow_the_clock() {
        assert_eq!(drand_round_at(DRAND_GENESIS_MS), 1);
        assert_eq!(drand_round_at(DRAND_GENESIS_MS + 2_999), 2);
        assert_eq!(drand_round_at(DRAND_GENESIS_MS + 3_000), 2);
        assert_eq!(drand_round_at(DRAND_GENESIS_MS + 3_001), 3);
    }
}
