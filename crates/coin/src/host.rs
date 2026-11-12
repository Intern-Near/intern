//! `shared::Host` on NEAR's host functions.

use near_sdk::env;
use shared::Host;

/// The contract's `Host`: every call goes to a NEAR host function.
#[derive(Debug, Clone, Copy, Default)]
pub struct NearHost;

impl Host for NearHost {
    fn sha256(&self, data: &[u8]) -> [u8; 32] {
        env::sha256_array(data)
    }

    fn keccak256(&self, data: &[u8]) -> [u8; 32] {
        env::keccak256_array(data)
    }

    fn ed25519_verify(&self, signature: &[u8; 64], message: &[u8], public_key: &[u8; 32]) -> bool {
        env::ed25519_verify(signature, message, public_key)
    }

    /// `v` must be the recovery id 0 or 1 (section 11). Anything else returns `None` here instead
    /// of reaching the host function, because the host function treats some out-of-range `v`
    /// values as an error that aborts the call, and a proposal must never abort (section 7).
    /// High-s signatures are accepted: `malleability_flag` is false.
    fn ecrecover(&self, hash: &[u8; 32], signature: &[u8; 64], v: u8) -> Option<[u8; 64]> {
        if v > 1 {
            return None;
        }
        env::ecrecover(hash, signature, v, false)
    }
}

#[cfg(test)]
mod tests {
    //! Run with `cargo test -p coin`. The host functions here are nearcore's own code
    //! (near-sdk's `unit-testing` feature runs them through near-vm-runner).
    //!
    //! The two Ethereum "personal sign" signatures below were made on 2026-11-11 with Python's
    //! eth_account 0.13.4 (`Account.sign_message(encode_defunct(text=...))`), each with a fresh
    //! random key that was thrown away and never written down. The signed text has NEAR AI's shape,
    //! `{model}:{sha256 of request}:{sha256 of response}` (01-SHARED-INTERFACE.md section 6.3).

    use super::*;

    const TEXT: &str = "test-model:a3670d673b068fecef04788fbe229fbe200153c657e6a0ed56e5421e1c3a5af6:d4a534e3d5ab43de5b09ee16dedc6eec035cf179b072195f128d15ac87be79f0";
    const DIGEST: &str = "5de52ae75bc988d05f2fbba9cd291d71445ed95752016d0f5644926ed4f4b4a1";

    struct EthSig {
        r: &'static str,
        s: &'static str,
        v: u8,
        address: &'static str,
    }

    const SIG_V27: EthSig = EthSig {
        r: "697e5c0780d1e964eaee607644fae922a86a24f7993c6afe0387422b63c095fe",
        s: "28f2a4492ac07f9fd0f1a79466401ad37735ccdc6d3a5598bfcc364552031cc6",
        v: 27,
        address: "90d014859df44ea500d3050c61fa99d018caf49b",
    };
    const SIG_V28: EthSig = EthSig {
        r: "3e85b77d9a895bbbacee18e06cf2daed0f7679f675a987886f44dde61be2554e",
        s: "3855a135bb8ae3a3e0cf7f8f18dfd793403cca9ac3113631c4c2bd17987e408d",
        v: 28,
        address: "5c7abc740acbbd4a6aaffbb3260144cf5d5ec54d",
    };

    /// secp256k1 group order n.
    const N: &str = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";

    fn unhex<const L: usize>(h: &str) -> [u8; L] {
        assert_eq!(h.len(), 2 * L, "hex length");
        let mut out = [0u8; L];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap();
        }
        out
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn rs(sig: &EthSig) -> [u8; 64] {
        let mut out = [0u8; 64];
        out[..32].copy_from_slice(&unhex::<32>(sig.r));
        out[32..].copy_from_slice(&unhex::<32>(sig.s));
        out
    }

    /// The Ethereum address of a 64-byte uncompressed public key: the last 20 bytes of its keccak.
    fn address(h: &NearHost, pubkey: &[u8; 64]) -> String {
        hex(&h.keccak256(pubkey)[12..])
    }

    /// EIP-191 "personal sign" digest: keccak256("\x19Ethereum Signed Message:\n" + len + text).
    fn personal_digest(h: &NearHost, text: &str) -> [u8; 32] {
        let mut m = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
        m.extend_from_slice(text.as_bytes());
        h.keccak256(&m)
    }

    /// n - s, big-endian, 32 bytes.
    fn negate_mod_n(s: &[u8; 32]) -> [u8; 32] {
        let n = unhex::<32>(N);
        let mut out = [0u8; 32];
        let mut borrow = 0i16;
        for i in (0..32).rev() {
            let mut d = n[i] as i16 - s[i] as i16 - borrow;
            borrow = if d < 0 { 1 } else { 0 };
            if d < 0 {
                d += 256;
            }
            out[i] = d as u8;
        }
        out
    }

    #[test]
    fn hashes_match_published_values() {
        let h = NearHost;
        assert_eq!(
            hex(&h.sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex(&h.keccak256(b"")),
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
        // Our digest of the signed text equals eth_account's.
        assert_eq!(hex(&personal_digest(&h, TEXT)), DIGEST);
    }

    #[test]
    fn ethereum_signatures_recover_once_27_is_taken_off_v() {
        let h = NearHost;
        let digest = unhex::<32>(DIGEST);
        for sig in [SIG_V27, SIG_V28] {
            let pk = h
                .ecrecover(&digest, &rs(&sig), sig.v - 27)
                .expect("recovers");
            assert_eq!(address(&h, &pk), sig.address, "v = {}", sig.v);
        }
    }

    #[test]
    fn raw_27_or_28_is_refused_without_aborting() {
        let h = NearHost;
        let digest = unhex::<32>(DIGEST);
        for sig in [SIG_V27, SIG_V28] {
            assert_eq!(h.ecrecover(&digest, &rs(&sig), sig.v), None);
        }
        for v in [2u8, 3, 4, 255] {
            assert_eq!(h.ecrecover(&digest, &rs(&SIG_V27), v), None, "v = {v}");
        }
    }

    #[test]
    fn why_v_is_guarded_the_raw_host_function_aborts_on_large_v() {
        // Calls env::ecrecover directly, not through NearHost: v 0..=3 return normally, v >= 4 is
        // a host error (an abort on chain). NearHost returns None for anything above 1 instead.
        let digest = unhex::<32>(DIGEST);
        let sig = rs(&SIG_V27);
        for v in [0u8, 1, 2, 3] {
            assert!(
                std::panic::catch_unwind(|| env::ecrecover(&digest, &sig, v, false)).is_ok(),
                "v = {v}"
            );
        }
        for v in [4u8, 27, 28] {
            assert!(
                std::panic::catch_unwind(|| env::ecrecover(&digest, &sig, v, false)).is_err(),
                "v = {v}"
            );
        }
    }

    #[test]
    fn the_wrong_recovery_id_gives_a_different_signer() {
        let h = NearHost;
        let digest = unhex::<32>(DIGEST);
        let wrong = 1 - (SIG_V27.v - 27);
        if let Some(pk) = h.ecrecover(&digest, &rs(&SIG_V27), wrong) {
            assert_ne!(address(&h, &pk), SIG_V27.address);
        }
    }

    #[test]
    fn high_s_signatures_are_accepted() {
        // eth_account always produces low s. Flip each signature to its high-s twin (s -> n - s,
        // recovery id flipped): it must still recover the same signer.
        let h = NearHost;
        let digest = unhex::<32>(DIGEST);
        for sig in [SIG_V27, SIG_V28] {
            let mut flipped = rs(&sig);
            let s: [u8; 32] = flipped[32..].try_into().unwrap();
            flipped[32..].copy_from_slice(&negate_mod_n(&s));
            assert!(flipped[32] >= 0x80, "the twin really is high-s");
            let pk = h
                .ecrecover(&digest, &flipped, 1 - (sig.v - 27))
                .expect("high-s recovers");
            assert_eq!(address(&h, &pk), sig.address);
        }
    }

    #[test]
    fn a_changed_message_or_junk_signature_does_not_recover_the_signer() {
        let h = NearHost;
        let other = personal_digest(&h, "test-model:changed");
        let pk = h.ecrecover(&other, &rs(&SIG_V27), SIG_V27.v - 27);
        assert!(pk.map(|k| address(&h, &k)) != Some(SIG_V27.address.to_string()));
        // All-zero and all-0xff signatures: None, no abort.
        let digest = unhex::<32>(DIGEST);
        assert_eq!(h.ecrecover(&digest, &[0u8; 64], 0), None);
        assert_eq!(h.ecrecover(&digest, &[0xffu8; 64], 1), None);
    }

    #[test]
    fn ed25519_verify_matches_the_sdk_example() {
        // The example vector printed in near-sdk 5.30.1's own documentation of env::ed25519_verify.
        let h = NearHost;
        let sig = unhex::<64>(
            "41c44494dab13009be73d2ccbd3a49677ddc1f26ad2823ce72833ce4b9603f77ca70a9e179272d92d28e8b2ae7006747c87ab1890362a50347eff553f5ec4008",
        );
        let pk = unhex::<32>("9c16937bf04cce709fed52344c43634f1e7a05fc29dd41f48844c3588c7fe663");
        assert!(h.ed25519_verify(&sig, b"Hello world!", &pk));
        assert!(!h.ed25519_verify(&sig, b"Modified message!", &pk));
        assert!(!h.ed25519_verify(&[1u8; 64], b"Hello world!", &pk));
    }
}
