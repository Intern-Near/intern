//! Tests for ai-check, with a test `Host` built on ordinary Rust crates (sha2, sha3, k256, ed25519-dalek), and the
//! real signed answers recorded in step 1 (intern/fixtures/ai/).
extern crate std;

use super::*;
use crate::json::Value;
use ed25519_dalek::{Signature as EdSignature, Verifier, VerifyingKey as EdKey};
use k256::ecdsa::{RecoveryId, Signature as K256Signature, VerifyingKey as K256Key};
use sha2::{Digest, Sha256};
use sha3::Keccak256;
use std::format;
use std::string::{String, ToString};
use std::vec;
use std::vec::Vec;

struct TestHost;

impl Host for TestHost {
    fn sha256(&self, data: &[u8]) -> [u8; 32] {
        Sha256::digest(data).into()
    }
    fn keccak256(&self, data: &[u8]) -> [u8; 32] {
        Keccak256::digest(data).into()
    }
    fn ed25519_verify(&self, signature: &[u8; 64], message: &[u8], public_key: &[u8; 32]) -> bool {
        let Ok(key) = EdKey::from_bytes(public_key) else {
            return false;
        };
        key.verify(message, &EdSignature::from_bytes(signature))
            .is_ok()
    }
    fn ecrecover(&self, hash: &[u8; 32], signature: &[u8; 64], v: u8) -> Option<[u8; 64]> {
        // ai-check promises to pass only a recovery id of 0 or 1. A NEAR host function may abort on anything else,
        // which would erase the refusal, so the test host holds it to that.
        assert!(
            v < 2,
            "ai-check passed recovery id {v}; only 0 or 1 is allowed"
        );
        let sig = K256Signature::from_slice(signature).ok()?;
        let key = K256Key::recover_from_prehash(hash, &sig, RecoveryId::from_byte(v)?).ok()?;
        let point = key.to_sec1_point(false); // 0x04 ‖ X ‖ Y
        point.as_bytes().get(1..65)?.try_into().ok()
    }
}

fn unhex(s: &str) -> Vec<u8> {
    let s = s.trim_start_matches("0x");
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap())
        .collect()
}

/// A random number generator with a fixed seed (xorshift64*), so every run tests the same inputs.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

// ---------------------------------------------------------------- the step 1 recordings

struct Recording {
    name: String,
    model: String,
    rulebook: String,
    round_id: u64,
    nonce: String,
    request: Vec<u8>,
    response: Vec<u8>,
    ecdsa_signer: Vec<u8>,
    ecdsa_signature: Vec<u8>,
    ed25519_signer: Vec<u8>,
    ed25519_signature: Vec<u8>,
}

impl Recording {
    fn pinned(&self, algo: Algo) -> Pinned<'_> {
        let signer = if algo == Algo::Ecdsa {
            &self.ecdsa_signer
        } else {
            &self.ed25519_signer
        };
        Pinned {
            model: &self.model,
            algo,
            signer,
        }
    }
    fn expected(&self) -> Expected<'_> {
        Expected {
            rulebook: &self.rulebook,
            round_id: self.round_id,
            nonce: &self.nonce,
        }
    }
    fn signature(&self, algo: Algo) -> &[u8] {
        if algo == Algo::Ecdsa {
            &self.ecdsa_signature
        } else {
            &self.ed25519_signature
        }
    }
    fn verify_with(
        &self,
        algo: Algo,
        request: &[u8],
        response: &[u8],
        signature: &[u8],
    ) -> Result<Decision, Refusal> {
        verify(
            &TestHost,
            &self.pinned(algo),
            &self.expected(),
            request,
            response,
            signature,
        )
    }
    fn verify(&self, algo: Algo) -> Result<Decision, Refusal> {
        self.verify_with(algo, &self.request, &self.response, self.signature(algo))
    }
}

fn recordings() -> Vec<Recording> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/ai");
    let mut out = Vec::new();
    for model in std::fs::read_dir(&root).unwrap() {
        let model = model.unwrap().path();
        if !model.is_dir() || model.ends_with("catalog") {
            continue;
        }
        for case in std::fs::read_dir(&model).unwrap() {
            let dir = case.unwrap().path();
            let Ok(meta) = std::fs::read_to_string(dir.join("meta.json")) else {
                continue;
            };
            let meta: serde_json::Value = serde_json::from_str(&meta).unwrap();
            let sig = |algo: &str| -> Vec<u8> {
                let reply: serde_json::Value = serde_json::from_str(
                    &std::fs::read_to_string(dir.join(format!("signature-{algo}.json"))).unwrap(),
                )
                .unwrap();
                unhex(reply["signature"].as_str().unwrap())
            };
            out.push(Recording {
                name: format!(
                    "{}/{}",
                    model.file_name().unwrap().to_str().unwrap(),
                    dir.file_name().unwrap().to_str().unwrap()
                ),
                model: meta["model"].as_str().unwrap().to_string(),
                rulebook: meta["expected"]["rulebook"].as_str().unwrap().to_string(),
                round_id: meta["expected"]["round_id"].as_u64().unwrap(),
                nonce: meta["expected"]["nonce"].as_str().unwrap().to_string(),
                request: std::fs::read(dir.join("request.bin")).unwrap(),
                response: std::fs::read(dir.join("response.bin")).unwrap(),
                ecdsa_signer: unhex(
                    meta["preflight"]["ecdsa"]["signing_address"]
                        .as_str()
                        .unwrap(),
                ),
                ecdsa_signature: sig("ecdsa"),
                ed25519_signer: unhex(
                    meta["preflight"]["ed25519"]["signing_address"]
                        .as_str()
                        .unwrap(),
                ),
                ed25519_signature: sig("ed25519"),
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn bet(market: Market, side: Side, margin_e6: u128, leverage: u32) -> Result<Decision, Refusal> {
    Ok(Decision::Bet {
        market,
        side,
        margin_e6,
        leverage,
    })
}

/// What each recorded answer says, read by eye (intern/fixtures/ai/README.md), and whether it has blank lines
/// around the line. A padded answer is MALFORMED_DECISION (01 1.2 §6.2, D12).
fn by_eye(name: &str) -> (Result<Decision, Refusal>, bool) {
    use Market::*;
    use Side::*;
    match name {
        "qwen--qwen3.8-27b/normal" => (bet(Pengu, Long, 1_000_000, 1), true),
        "qwen--qwen3.8-27b/nothink" => (bet(Pengu, Long, 20_000_000, 1), false),
        "qwen--qwen3.8-27b/push" => (Ok(Decision::Skip), true),
        "qwen--qwen3.8-27b/chatty" => (bet(Pengu, Long, 1_000_000, 1), true),
        "qwen--qwen3.8-27b/trick" => (bet(Wif, Short, 500_000_000, 5), true),
        "z-ai--glm-5.3-flash/normal" => (bet(Pengu, Long, 20_000_000, 1), false),
        "z-ai--glm-5.3-flash/push" => (bet(Doge, Long, 20_000_000, 1), false),
        "z-ai--glm-5.3-flash/chatty" => (Err(Refusal::MalformedDecision), false), // two sentences before the line
        "z-ai--glm-5.3-flash/trick" => (bet(Pengu, Long, 20_000_000, 1), false),
        "qwen--qwen3.6-35b-a3b-fp8/normal" => (bet(Pepe, Long, 1_000_000, 1), true),
        "qwen--qwen3.6-35b-a3b-fp8/nothink" => (bet(Pengu, Long, 2_000_000, 1), false),
        "qwen--qwen3.6-35b-a3b-fp8/push" => (bet(Doge, Long, 1_000_000, 1), true),
        "qwen--qwen3.6-35b-a3b-fp8/chatty" => (bet(Pengu, Long, 1_000_000, 1), true),
        "qwen--qwen3.6-35b-a3b-fp8/trick" => (bet(Doge, Long, 20_000_000, 1), true),
        "deepseek-ai--deepseek-v4.1-flash-1017/normal" => (bet(Pengu, Long, 1_000_000, 1), false),
        "deepseek-ai--deepseek-v4.1-flash-1017/pretty" => (bet(Pengu, Long, 1_000_000, 1), false),
        "deepseek-ai--deepseek-v4.1-flash-1017/push" => (bet(Doge, Long, 20_000_000, 1), false),
        "deepseek-ai--deepseek-v4.1-flash-1017/chatty" => (bet(Pengu, Long, 1_000_000, 1), false),
        "deepseek-ai--deepseek-v4.1-flash-1017/trick" => (Ok(Decision::Skip), false),
        other => panic!("no reading by eye for {other}"),
    }
}

#[test]
fn every_recording_verifies_and_reads_as_by_eye_with_either_scheme() {
    let recs = recordings();
    assert_eq!(recs.len(), 19, "the 19 step 1 recordings");
    for r in &recs {
        let (decision, padded) = by_eye(&r.name);
        let want = if padded {
            Err(Refusal::MalformedDecision)
        } else {
            decision
        };
        for algo in [Algo::Ecdsa, Algo::Ed25519] {
            assert_eq!(r.verify(algo), want, "{} with {algo:?}", r.name);
        }
    }
}

#[test]
fn one_changed_byte_in_the_request_the_response_or_the_signature_is_bad_model_signature() {
    let recs = recordings();
    let mut rng = Rng(1);
    for r in &recs {
        for algo in [Algo::Ecdsa, Algo::Ed25519] {
            let flip = |bytes: &[u8], at: usize| -> Vec<u8> {
                let mut b = bytes.to_vec();
                b[at] ^= 0x01;
                b
            };
            let sig = r.signature(algo);
            let (req, resp) = (rng.below(r.request.len()), rng.below(r.response.len()));
            let bad = Err(Refusal::BadModelSignature);
            assert_eq!(
                r.verify_with(algo, &flip(&r.request, req), &r.response, sig),
                bad,
                "{}",
                r.name
            );
            assert_eq!(
                r.verify_with(algo, &r.request, &flip(&r.response, resp), sig),
                bad,
                "{}",
                r.name
            );
            assert_eq!(
                r.verify_with(algo, &r.request, &r.response, &flip(sig, rng.below(64))),
                bad,
                "{}",
                r.name
            );
        }
    }
}

#[test]
fn a_signature_that_does_not_fit_the_pinned_signer_is_bad_model_signature() {
    let recs = recordings();
    let r = &recs[0];
    let bad = Err(Refusal::BadModelSignature);
    let check = |pinned: Pinned, signature: &[u8]| {
        verify(
            &TestHost,
            &pinned,
            &r.expected(),
            &r.request,
            &r.response,
            signature,
        )
    };
    // Another signer, another model, the other scheme's signature, a cut or overlong signature, a bad v.
    assert_eq!(
        check(
            Pinned {
                signer: &[7u8; 20],
                ..r.pinned(Algo::Ecdsa)
            },
            &r.ecdsa_signature
        ),
        bad
    );
    assert_eq!(
        check(
            Pinned {
                signer: &[7u8; 32],
                ..r.pinned(Algo::Ed25519)
            },
            &r.ed25519_signature
        ),
        bad
    );
    assert_eq!(
        check(
            Pinned {
                model: "z-ai/glm-5.3-flash",
                ..r.pinned(Algo::Ecdsa)
            },
            &r.ecdsa_signature
        ),
        bad
    );
    assert_eq!(check(r.pinned(Algo::Ecdsa), &r.ed25519_signature), bad);
    assert_eq!(check(r.pinned(Algo::Ed25519), &r.ecdsa_signature), bad);
    assert_eq!(check(r.pinned(Algo::Ecdsa), &r.ecdsa_signature[..64]), bad);
    assert_eq!(
        check(
            r.pinned(Algo::Ecdsa),
            &[r.ecdsa_signature.as_slice(), &[0]].concat()
        ),
        bad
    );
    assert_eq!(check(r.pinned(Algo::Ecdsa), &[]), bad);
    assert_eq!(
        check(
            Pinned {
                signer: &r.ecdsa_signer[..19],
                ..r.pinned(Algo::Ecdsa)
            },
            &r.ecdsa_signature
        ),
        bad
    );
    let mut v29 = r.ecdsa_signature.clone();
    v29[64] = 29;
    assert_eq!(check(r.pinned(Algo::Ecdsa), &v29), bad);
    // v written as 0/1 instead of 27/28 is the same signature.
    let mut v01 = r.ecdsa_signature.clone();
    v01[64] -= 27;
    assert!(check(r.pinned(Algo::Ecdsa), &v01).is_ok());
}

#[test]
fn a_genuine_signature_over_another_rulebook_is_wrong_rulebook() {
    for r in &recordings() {
        let other_nonce = if r.nonce == "0000000000000000" {
            "1111111111111111"
        } else {
            "0000000000000000"
        };
        let rulebook = r.rulebook.replace(&r.nonce, other_nonce);
        let expected = Expected {
            rulebook: &rulebook,
            round_id: r.round_id,
            nonce: other_nonce,
        };
        for algo in [Algo::Ecdsa, Algo::Ed25519] {
            let got = verify(
                &TestHost,
                &r.pinned(algo),
                &expected,
                &r.request,
                &r.response,
                r.signature(algo),
            );
            assert_eq!(got, Err(Refusal::WrongRulebook), "{}", r.name);
        }
    }
}

// ---------------------------------------------------------------- check 4: the request's shape (item B)

#[test]
fn the_request_must_be_exactly_the_pinned_model_sent_the_rulebook() {
    let pinned = Pinned {
        model: "M/m-1",
        algo: Algo::Ecdsa,
        signer: &[0; 20],
    };
    let expected = Expected {
        rulebook: "Rules\nline two \"quoted\"",
        round_id: 1,
        nonce: "0000000000000000",
    };
    let ok = |body: &str| request_ok(&pinned, &expected, body.as_bytes());
    let sys = r#"{"role":"system","content":"Rules\nline two \"quoted\""}"#;
    let user = r#"{"role":"user","content":"prices"}"#;
    let base = format!(r#"{{"model":"M/m-1","messages":[{sys},{user}],"stream":false}}"#);
    assert!(ok(&base));
    assert!(ok(&format!(" \n{{ \"stream\" : false ,\n \"messages\" : [ {sys} , {user} ] , \"model\" : \"M/m-1\" }}\n")));
    assert!(ok(&base.replace("Rules", r"\u0052ules"))); // escapes decode to the same text
    assert!(ok(&base.replace(
        r#""stream":false"#,
        r#""stream":false,"chat_template_kwargs":{"enable_thinking":false}"#
    )));

    for (why, body) in [
        ("another model", base.replace("M/m-1", "M/m-2")),
        ("another rulebook", base.replace("line two", "line 2")),
        (
            "an extra key",
            base.replace(r#""stream":false"#, r#""stream":false,"temperature":0"#),
        ),
        (
            "n",
            base.replace(r#""stream":false"#, r#""stream":false,"n":2"#),
        ),
        (
            "streaming",
            base.replace(r#""stream":false"#, r#""stream":true"#),
        ),
        ("no stream key", base.replace(r#","stream":false"#, "")),
        ("no model", base.replace(r#""model":"M/m-1","#, "")),
        (
            "a duplicate key",
            base.replace(r#""stream":false"#, r#""stream":false,"model":"M/m-1""#),
        ),
        (
            "thinking switched on",
            base.replace(
                r#""stream":false"#,
                r#""stream":false,"chat_template_kwargs":{"enable_thinking":true}"#,
            ),
        ),
        (
            "more in chat_template_kwargs",
            base.replace(
                r#""stream":false"#,
                r#""stream":false,"chat_template_kwargs":{"enable_thinking":false,"x":1}"#,
            ),
        ),
        (
            "three messages",
            base.replace(user, &format!("{user},{user}")),
        ),
        ("one message", base.replace(&format!(",{user}"), "")),
        (
            "system second",
            format!(r#"{{"model":"M/m-1","messages":[{user},{sys}],"stream":false}}"#),
        ),
        ("two system messages", base.replace(user, sys)),
        (
            "an extra key in a message",
            base.replace(r#"{"role":"user","#, r#"{"role":"user","name":"x","#),
        ),
        (
            "content as parts",
            base.replace(
                r#""content":"prices""#,
                r#""content":[{"type":"text","text":"prices"}]"#,
            ),
        ),
        ("not an object", "[]".to_string()),
        ("not JSON", "model=M".to_string()),
        ("text after the object", format!("{base} x")),
        ("a byte-order mark", format!("\u{feff}{base}")),
    ] {
        assert!(!ok(&body), "accepted {why}");
    }
}

// ---------------------------------------------------------------- check 5: the decision line

const D1: &str = r#"{"v":1,"round":42,"nonce":"9f2c41d07ab35e16","action":"skip"}"#;
const D2: &str = r#"{"v":1,"round":42,"nonce":"9f2c41d07ab35e16","action":"bet","market":"DOGE","side":"long","margin_e6":"20000000","leverage":1}"#;

/// Check 5 alone: the answer placed in a response the way NEAR AI returns it, read for round 42 and its nonce.
fn read(answer: &str) -> Option<Decision> {
    read_at(answer, 42, "9f2c41d07ab35e16")
}

fn read_at(answer: &str, round_id: u64, nonce: &str) -> Option<Decision> {
    let body = format!(
        r#"{{"id":"x","choices":[{{"index":0,"message":{{"role":"assistant","content":{}}}}}]}}"#,
        serde_json::to_string(answer).unwrap()
    );
    read_decision(
        &Expected {
            rulebook: "",
            round_id,
            nonce,
        },
        body.as_bytes(),
    )
}

fn interface_file(name: &str) -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../interface")
        .join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap()
}

/// Test cases D1 to D13 of 01 §12, read from Engine 1's intern/interface/vectors/checks.json.
#[test]
fn decision_line_cases_d1_to_d13_from_checks_json() {
    let file = interface_file("vectors/checks.json");
    // 01 1.3 changed no decision-line case: D1 to D13 are the same as in 1.2.
    assert_eq!(file["interface_version"], "1.3");
    let d = &file["decision_line_cases"];
    let (round_id, nonce) = (
        d["round_id"].as_u64().unwrap(),
        d["nonce"].as_str().unwrap(),
    );
    let cases = d["cases"].as_array().unwrap();
    let ids: Vec<&str> = cases.iter().map(|c| c["id"].as_str().unwrap()).collect();
    let want_ids: Vec<String> = (1..=13).map(|i| format!("D{i}")).collect();
    assert_eq!(ids, want_ids);
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let text = case["text"].as_str().unwrap();
        let expected = &case["expected"];
        let want: Result<Decision, Refusal> = if let Some(ok) = expected.get("ok") {
            Ok(match ok["action"].as_str().unwrap() {
                "SKIP" => Decision::Skip,
                "BET" => Decision::Bet {
                    market: ok["market"].as_str().unwrap().parse().unwrap(),
                    side: ok["side"].as_str().unwrap().parse().unwrap(),
                    margin_e6: ok["margin"].as_str().unwrap().parse().unwrap(),
                    leverage: ok["leverage"].as_u64().unwrap().try_into().unwrap(),
                },
                other => panic!("{id}: unknown action {other}"),
            })
        } else {
            Err(expected["refusal"].as_str().unwrap().parse().unwrap())
        };
        let got = read_at(text, round_id, nonce).ok_or(Refusal::MalformedDecision);
        assert_eq!(got, want, "{id}: {text:?}");
        // The contract writes every well-formed line back byte for byte.
        if let Ok(decision) = want {
            assert_eq!(decision_line(round_id, nonce, &decision), text, "{id}");
        }
    }
}

/// More variants of the D cases than checks.json holds (for example a space after each colon, not only the first).
#[test]
fn decision_line_variants_around_the_d_cases() {
    use Market::*;
    use Side::*;
    assert_eq!(read(D1), Some(Decision::Skip)); // D1
    assert_eq!(
        read(D2),
        Some(Decision::Bet {
            market: Doge,
            side: Long,
            margin_e6: 20_000_000,
            leverage: 1
        })
    ); // D2
    for (i, _) in D2.match_indices(':') {
        assert_eq!(read(&format!("{} {}", &D2[..=i], &D2[i + 1..])), None); // D3: a space after any colon
    }
    assert_eq!(read(&format!("```json\n{D2}\n```")), None); // D4
    assert_eq!(read(&D2.replace(r#""20000000""#, "20000000")), None); // D5
    assert_eq!(read(&D2.replace(r#""round":42"#, r#""round":41"#)), None); // D6
    assert_eq!(
        read(&D2.replace("9f2c41d07ab35e16", "9f2c41d07ab35e17")),
        None
    ); // D7
    assert_eq!(read(&D2.replace("DOGE", "doge")), None); // D8
    assert_eq!(read(&D2.replace(r#""20000000""#, r#""020000000""#)), None); // D9
    assert_eq!(
        read(&D2.replace("DOGE", "WIF")),
        Some(Decision::Bet {
            market: Wif,
            side: Long,
            margin_e6: 20_000_000,
            leverage: 1
        })
    ); // D10
    assert_eq!(read(&format!("I think DOGE looks good. {D2}")), None); // D11
    assert_eq!(read(&format!("{D1}\n")), None); // D12, a trailing newline
    assert_eq!(read(&format!("{D2}\r\n")), None);
    assert_eq!(read(&format!("\n{D2}")), None);
}

/// 01 1.2 §6.2: blank lines, spaces or tabs before or after the line are MALFORMED_DECISION, as is anything else.
#[test]
fn nothing_may_stand_before_or_after_the_line() {
    for pad in [
        "\n", "\n\n", "\r\n", " ", "\t", "\u{a0}", "\u{200b}", "\u{feff}", ".", "`",
    ] {
        assert_eq!(read(&format!("{pad}{D2}")), None, "before: {pad:?}");
        assert_eq!(read(&format!("{D2}{pad}")), None, "after: {pad:?}");
        assert_eq!(read(&format!("{pad}{D1}{pad}")), None, "around: {pad:?}");
    }
    assert_eq!(read(&format!("\n\n{D2}\r\n\t ")), None);
}

/// The model, scheme and signer pinned in 01 1.2 §6.3 (and in the real contract's get_constants().model), checked
/// against the recordings of that model. Every other model's answers are refused at check 3.
#[test]
fn the_pinned_model_of_01_v1_2_verifies_its_own_recordings_only() {
    let pinned = Pinned {
        model: "z-ai/glm-5.3-flash",
        algo: Algo::Ed25519,
        signer: &unhex("5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff"),
    };
    let mut glm = 0;
    for r in &recordings() {
        let got = verify(
            &TestHost,
            &pinned,
            &r.expected(),
            &r.request,
            &r.response,
            &r.ed25519_signature,
        );
        if r.model == pinned.model {
            glm += 1;
            assert_eq!(r.ed25519_signer, pinned.signer, "{}", r.name);
            assert_eq!(got, by_eye(&r.name).0, "{}", r.name);
        } else {
            assert_eq!(got, Err(Refusal::BadModelSignature), "{}", r.name);
        }
    }
    assert_eq!(glm, 4, "the four GLM recordings");
    let normal = recordings()
        .into_iter()
        .find(|r| r.name == "z-ai--glm-5.3-flash/normal")
        .unwrap();
    assert_eq!(
        verify(
            &TestHost,
            &pinned,
            &normal.expected(),
            &normal.request,
            &normal.response,
            &normal.ed25519_signature
        ),
        bet(Market::Pengu, Side::Long, 20_000_000, 1)
    );
}

#[test]
fn decision_line_edge_cases_follow_01_section_6_2() {
    use Market::*;
    use Side::*;
    assert_eq!(
        read(&D2.replace(r#""20000000""#, r#""0""#)),
        Some(Decision::Bet {
            market: Doge,
            side: Long,
            margin_e6: 0,
            leverage: 1
        })
    );
    let max = u128::MAX.to_string();
    assert_eq!(
        read(&D2.replace("20000000", &max)),
        Some(Decision::Bet {
            market: Doge,
            side: Long,
            margin_e6: u128::MAX,
            leverage: 1
        })
    );
    assert_eq!(
        read(&D2.replace(r#""leverage":1"#, r#""leverage":4294967295"#)),
        Some(Decision::Bet {
            market: Doge,
            side: Long,
            margin_e6: 20_000_000,
            leverage: u32::MAX
        })
    );
    for bad in [
        D2.replace(r#""leverage":1"#, r#""leverage":0"#),
        D2.replace(r#""leverage":1"#, r#""leverage":4294967296"#),
        D2.replace(r#""leverage":1"#, r#""leverage":01"#),
        D2.replace(r#""leverage":1"#, r#""leverage":1.0"#),
        D2.replace(r#""leverage":1"#, r#""leverage":"1""#),
        D2.replace("20000000", "340282366920938463463374607431768211456"), // u128::MAX + 1
        D2.replace("20000000", "+20000000"),
        D2.replace("20000000", "-20000000"),
        D2.replace("20000000", ""),
        D2.replace("DOGE", "BTC"),
        D2.replace("DOGE", "DOGEX"),
        D2.replace("long", "LONG"),
        D2.replace(r#""bet""#, r#""BET""#),
        D1.replace(r#""v":1"#, r#""v":2"#),
        D1.replace("skip", "sk\\u0069p"),
        D2.replace(r#""leverage":1}"#, r#""leverage":1,"x":1}"#),
        format!("{D2}}}"),
        D2[..D2.len() - 1].to_string(),
    ] {
        assert_eq!(read(&bad), None, "{bad}");
    }
}

#[test]
fn the_line_reader_on_its_own_refuses_every_non_canonical_number() {
    // The line reader is the first guard; the comparison with `decision_line` is the second. Each must hold alone.
    let ok = |l: &str| line::parse(l, 42, "9f2c41d07ab35e16");
    assert!(ok(D2).is_some());
    for (from, to) in [
        ("\"20000000\"", "\"+20000000\""),
        ("\"20000000\"", "\"020000000\""),
        ("\"20000000\"", "\"00\""),
        ("\"20000000\"", "\"2e7\""),
        ("\"20000000\"", "\" 20000000\""),
        ("\"leverage\":1", "\"leverage\":+1"),
        ("\"leverage\":1", "\"leverage\":01"),
        ("\"leverage\":1", "\"leverage\":0"),
        ("\"leverage\":1", "\"leverage\":1 "),
        ("\"round\":42", "\"round\":042"),
        ("\"round\":42", "\"round\":+42"),
    ] {
        let bad = D2.replace(from, to);
        assert_eq!(ok(&bad), None, "{bad}");
    }
}

#[test]
fn the_answer_comes_only_from_a_response_with_exactly_one_choice() {
    let exp = Expected {
        rulebook: "",
        round_id: 42,
        nonce: "9f2c41d07ab35e16",
    };
    let line = serde_json::to_string(D1).unwrap();
    let one = format!(r#"{{"choices":[{{"message":{{"content":{line}}}}}]}}"#);
    assert_eq!(read_decision(&exp, one.as_bytes()), Some(Decision::Skip));
    for bad in [
        format!(
            r#"{{"choices":[{{"message":{{"content":{line}}}}},{{"message":{{"content":{line}}}}}]}}"#
        ),
        r#"{"choices":[]}"#.to_string(),
        r#"{"choices":[{"message":{"content":null}}]}"#.to_string(),
        format!(r#"{{"choices":[{{"message":{{"content":{line},"content":{line}}}}}]}}"#),
        format!(r#"[{{"message":{{"content":{line}}}}}]"#),
    ] {
        assert_eq!(read_decision(&exp, bad.as_bytes()), None, "{bad}");
    }
}

#[test]
fn every_decision_line_reads_back_as_the_decision_it_was_written_from() {
    use Market::*;
    use Side::*;
    let mut decisions = vec![Decision::Skip];
    for market in [Doge, Shib, Pepe, Pengu, Wif, Trump] {
        for side in [Long, Short] {
            for margin_e6 in [0, 1, 9, 10, 20_000_000, u128::MAX] {
                for leverage in [1, 2, 10, u32::MAX] {
                    decisions.push(Decision::Bet {
                        market,
                        side,
                        margin_e6,
                        leverage,
                    });
                }
            }
        }
    }
    for d in decisions {
        for (round, nonce) in [
            (42u64, "9f2c41d07ab35e16"),
            (0, "0000000000000000"),
            (u64::MAX, "ffffffffffffffff"),
        ] {
            let text = decision_line(round, nonce, &d);
            assert_eq!(line::parse(&text, round, nonce), Some(d), "{text}");
        }
    }
    assert_eq!(decision_line(42, "9f2c41d07ab35e16", &Decision::Skip), D1);
}

// ---------------------------------------------------------------- the JSON reader

#[test]
fn the_json_reader_decodes_escapes_and_refuses_anything_doubtful() {
    let s = |text: &str| json::parse(text.as_bytes());
    assert_eq!(
        s(r#"{"a":"x\"\\\/\b\f\n\r\t\u00e9\ud83d\ude00"}"#)
            .unwrap()
            .get("a")
            .unwrap()
            .as_str(),
        Some("x\"\\/\u{8}\u{c}\n\r\t\u{e9}\u{1f600}")
    );
    assert_eq!(
        s("\"caf\u{e9} \u{1f600}\"").unwrap().as_str(),
        Some("caf\u{e9} \u{1f600}")
    ); // raw UTF-8
    for good in [
        "0",
        "-0",
        "-12.5e-3",
        "1E+2",
        "true",
        "null",
        "[]",
        "{}",
        " [ 1 , [ ] , { \"a\" : null } ] ",
    ] {
        assert!(s(good).is_some(), "refused {good}");
    }
    for bad in [
        r#"{"a":1,"a":2}"#,
        r#"[{"a":1,"b":2,"a":3}]"#,
        r#""\ud800""#,
        r#""\udc00""#,
        r#""\ud800\u0041""#,
        "\"tab\there\"",
        "\"line\nbreak\"",
        r#""\x41""#,
        r#""\u00g1""#,
        r#""unterminated"#,
        "01",
        "1.",
        ".5",
        "+1",
        "1e",
        "-",
        "NaN",
        "[1,]",
        "{\"a\":1,}",
        "{a:1}",
        "{'a':1}",
        "[1] [2]",
        "// c\n1",
        "\u{feff}1",
        "",
        " ",
    ] {
        assert!(s(bad).is_none(), "accepted {bad:?}");
    }
    assert!(json::parse(&[b'"', 0xff, b'"']).is_none()); // not UTF-8
    assert!(json::parse(&[b'"', 0xc3, b'"']).is_none()); // a cut UTF-8 sequence
}

#[test]
fn the_json_reader_limits_nesting_and_keys() {
    let nested = |n: usize| format!("{}{}", "[".repeat(n), "]".repeat(n));
    assert!(json::parse(nested(json::MAX_DEPTH + 1).as_bytes()).is_some());
    assert!(json::parse(nested(json::MAX_DEPTH + 2).as_bytes()).is_none());
    assert!(json::parse("[".repeat(1_000_000).as_bytes()).is_none()); // no stack overflow
    assert!(json::parse(r#"{"a":"#.repeat(100_000).as_bytes()).is_none());
    let keys = |n: usize| {
        format!(
            "{{{}}}",
            (0..n)
                .map(|i| format!(r#""k{i}":0"#))
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    assert!(json::parse(keys(json::MAX_KEYS).as_bytes()).is_some());
    assert!(json::parse(keys(json::MAX_KEYS + 1).as_bytes()).is_none());
}

// ---------------------------------------------------------------- never panics

#[test]
fn never_panics_on_random_or_damaged_input() {
    let recs = recordings();
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let random =
        |rng: &mut Rng, n: usize| -> Vec<u8> { (0..n).map(|_| rng.next() as u8).collect() };
    let pinned = Pinned {
        model: "M",
        algo: Algo::Ecdsa,
        signer: &[1; 20],
    };
    let expected = Expected {
        rulebook: "R",
        round_id: 1,
        nonce: "0000000000000000",
    };
    for _ in 0..20_000 {
        let (a, b, c) = (rng.below(300), rng.below(300), rng.below(80));
        let (req, resp, sig) = (
            random(&mut rng, a),
            random(&mut rng, b),
            random(&mut rng, c),
        );
        let _ = verify(&TestHost, &pinned, &expected, &req, &resp, &sig);
        let _ = verify(
            &TestHost,
            &Pinned {
                algo: Algo::Ed25519,
                signer: &[1; 32],
                ..pinned
            },
            &expected,
            &req,
            &resp,
            &sig,
        );
        let _ = json::parse(&resp);
        let _ = request_ok(&pinned, &expected, &req);
        let _ = read_decision(&expected, &resp);
    }
    // Damaged real bodies: cut short, or with bytes changed or inserted. The JSON and line readers must hold.
    for _ in 0..5_000 {
        let r = &recs[rng.below(recs.len())];
        let mut resp = r.response.clone();
        match rng.below(3) {
            0 => resp.truncate(rng.below(resp.len() + 1)),
            1 => {
                for _ in 0..1 + rng.below(4) {
                    let at = rng.below(resp.len());
                    resp[at] = rng.next() as u8;
                }
            }
            _ => {
                const AWKWARD: &[u8] = b"\"{}[]\\:,0e-\x00\xff";
                let at = rng.below(resp.len() + 1);
                resp.insert(at, AWKWARD[rng.below(AWKWARD.len())]);
            }
        }
        let _ = read_decision(&r.expected(), &resp);
        let _ = request_ok(&r.pinned(Algo::Ecdsa), &r.expected(), &resp);
    }
    // The empty proposal.
    assert_eq!(
        verify(&TestHost, &pinned, &expected, &[], &[], &[]),
        Err(Refusal::BadModelSignature)
    );
}

#[test]
fn refusal_codes_are_spelled_as_in_01() {
    assert_eq!(Refusal::BadModelSignature.as_str(), "BAD_MODEL_SIGNATURE");
    assert_eq!(Refusal::WrongRulebook.as_str(), "WRONG_RULEBOOK");
    assert_eq!(Refusal::MalformedDecision.as_str(), "MALFORMED_DECISION");
    assert_eq!(Value::Null, Value::Null);
}
