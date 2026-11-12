//! Checks 3–5 of 01-SHARED-INTERFACE.md section 7 ("really the AI").
//!
//! - The real check (step 7, every build without `fake-ai-check`): Engine 2's `ai-check` with NEAR's
//!   host functions and the pinned model (`sign::real_check`).
//! - `Fake` (feature `fake-ai-check`, and unit tests): STAND-IN. The signature must be the four
//!   bytes `FAKE`; the response body must be exactly a decision line (section 6.2) for the current
//!   round and nonce. The request is not looked at, so WRONG_RULEBOOK cannot happen with it.
//!   `get_constants().model.id` names it, so nobody mistakes it for the real check.

use near_sdk::serde::Deserialize;
use shared::{Decision, Market, Refusal, Side};

/// What the proposal must match (the interface's `ai_check::Expected`).
pub struct Expected<'a> {
    pub rulebook: &'a str,
    pub round_id: u64,
    pub nonce: &'a str,
}

pub trait AiCheck {
    /// Returns the decision, or exactly one of BAD_MODEL_SIGNATURE, WRONG_RULEBOOK,
    /// MALFORMED_DECISION. Never panics.
    fn verify(
        &self,
        expected: &Expected,
        request: &[u8],
        response: &[u8],
        signature: &[u8],
    ) -> Result<Decision, Refusal>;
    /// For `get_constants().model.id`, so nobody mistakes a stand-in for the real check.
    fn name(&self) -> &'static str;
}

impl crate::Coin {
    /// Checks 3–5 for `propose`: the real check, or the stand-in in a `fake-ai-check` build.
    pub(crate) fn check_ai(
        &self,
        e: &Expected,
        req: &[u8],
        resp: &[u8],
        sig: &[u8],
    ) -> Result<Decision, Refusal> {
        // TEST ONLY (sandbox build): replay a recorded answer against the rulebook it was made for.
        #[cfg(feature = "test-hooks")]
        if let Some(b) = near_sdk::env::storage_read(b"TEST_EXPECT") {
            let (rulebook, round_id, nonce): (String, u64, String) =
                near_sdk::serde_json::from_slice(&b).expect("test hook");
            let e = Expected {
                rulebook: &rulebook,
                round_id,
                nonce: &nonce,
            };
            return self.check_ai_inner(&e, req, resp, sig);
        }
        self.check_ai_inner(e, req, resp, sig)
    }

    fn check_ai_inner(
        &self,
        e: &Expected,
        req: &[u8],
        resp: &[u8],
        sig: &[u8],
    ) -> Result<Decision, Refusal> {
        #[cfg(any(test, feature = "fake-ai-check"))]
        {
            Fake.verify(e, req, resp, sig)
        }
        #[cfg(not(any(test, feature = "fake-ai-check")))]
        {
            crate::sign::real_check(&self.pins, e, req, resp, sig)
        }
    }

    /// `get_constants().model`: the pins, or the stand-in's name in a `fake-ai-check` build.
    pub(crate) fn model_view(&self) -> wire::ModelPin {
        let pinned = self.pins.model_view();
        #[cfg(any(test, feature = "fake-ai-check"))]
        {
            wire::ModelPin {
                id: Fake.name().to_string(),
                ..pinned
            }
        }
        #[cfg(not(any(test, feature = "fake-ai-check")))]
        {
            pinned
        }
    }
}

#[cfg(any(test, feature = "fake-ai-check"))]
pub struct Fake;

#[cfg(any(test, feature = "fake-ai-check"))]
impl AiCheck for Fake {
    fn verify(
        &self,
        expected: &Expected,
        _request: &[u8],
        response: &[u8],
        signature: &[u8],
    ) -> Result<Decision, Refusal> {
        if signature != b"FAKE" {
            return Err(Refusal::BadModelSignature);
        }
        let text = core::str::from_utf8(response).map_err(|_| Refusal::MalformedDecision)?;
        read_decision_line(text, expected.round_id, expected.nonce)
            .ok_or(Refusal::MalformedDecision)
    }
    fn name(&self) -> &'static str {
        "FAKE-AI-CHECK: stand-in, signature 'FAKE' accepted (a test build; the real check is Engine 2's ai-check)"
    }
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct Line {
    v: u64,
    round: u64,
    nonce: String,
    action: String,
    market: Option<String>,
    side: Option<String>,
    margin_e6: Option<String>,
    leverage: Option<u64>,
}

/// The one correct writing of a decision line (section 6.2).
pub fn decision_line(round_id: u64, nonce: &str, d: &Decision) -> String {
    match d {
        Decision::Skip => {
            format!(r#"{{"v":1,"round":{round_id},"nonce":"{nonce}","action":"skip"}}"#)
        }
        Decision::Bet {
            market,
            side,
            margin_e6,
            leverage,
        } => format!(
            r#"{{"v":1,"round":{round_id},"nonce":"{nonce}","action":"bet","market":"{}","side":"{}","margin_e6":"{}","leverage":{}}}"#,
            market.as_str(),
            side.as_decision_str(),
            margin_e6,
            leverage
        ),
    }
}

/// Section 6.2, no tolerant reading: parse, write it out again in the one correct form, and require
/// the two to be byte-equal; then `v`, `round` and `nonce` must be right.
pub fn read_decision_line(text: &str, round_id: u64, nonce: &str) -> Option<Decision> {
    let l: Line = near_sdk::serde_json::from_str(text).ok()?;
    let d = match l.action.as_str() {
        "skip" => Decision::Skip,
        "bet" => Decision::Bet {
            market: l.market?.parse::<Market>().ok()?,
            side: Side::from_decision_str(&l.side?)?,
            margin_e6: {
                let m = l.margin_e6?;
                if m.is_empty() || !m.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                m.parse().ok()?
            },
            leverage: u32::try_from(l.leverage?).ok().filter(|x| *x >= 1)?,
        },
        _ => return None,
    };
    if l.v != 1 || l.round != round_id || l.nonce != nonce {
        return None;
    }
    (decision_line(round_id, nonce, &d) == text).then_some(d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::{self, Value};
    use std::path::PathBuf;

    #[test]
    fn every_decision_line_case_d1_to_d13() {
        let p =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../interface/vectors/checks.json");
        let file: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        let block = &file["decision_line_cases"];
        let (round, nonce) = (
            block["round_id"].as_u64().unwrap(),
            block["nonce"].as_str().unwrap(),
        );
        let cases = block["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 13);
        for c in cases {
            let got = read_decision_line(c["text"].as_str().unwrap(), round, nonce);
            match c["expected"].get("ok") {
                Some(ok) => {
                    let d = got.unwrap_or_else(|| panic!("{} should read", c["id"]));
                    let want = match ok["action"].as_str().unwrap() {
                        "SKIP" => Decision::Skip,
                        _ => Decision::Bet {
                            market: ok["market"].as_str().unwrap().parse().unwrap(),
                            side: ok["side"].as_str().unwrap().parse().unwrap(),
                            margin_e6: ok["margin"].as_str().unwrap().parse().unwrap(),
                            leverage: ok["leverage"].as_u64().unwrap() as u32,
                        },
                    };
                    assert_eq!(d, want, "{}", c["id"]);
                }
                None => assert_eq!(got, None, "{} must be MALFORMED_DECISION", c["id"]),
            }
        }
    }

    #[test]
    fn the_fake_wants_fake_and_never_panics() {
        let e = Expected {
            rulebook: "",
            round_id: 1,
            nonce: "0123456789abcdef",
        };
        let line = br#"{"v":1,"round":1,"nonce":"0123456789abcdef","action":"skip"}"#;
        assert_eq!(Fake.verify(&e, b"", line, b"FAKE"), Ok(Decision::Skip));
        assert_eq!(
            Fake.verify(&e, b"", line, b"fake"),
            Err(Refusal::BadModelSignature)
        );
        assert_eq!(
            Fake.verify(&e, b"", &[0xff, 0xfe], b"FAKE"),
            Err(Refusal::MalformedDecision)
        );
        assert_eq!(
            Fake.verify(&e, b"", b"", b"FAKE"),
            Err(Refusal::MalformedDecision)
        );
        let huge = br#"{"v":1,"round":1,"nonce":"0123456789abcdef","action":"bet","market":"DOGE","side":"long","margin_e6":"999999999999999999999999999999999999999999","leverage":1}"#;
        assert_eq!(
            Fake.verify(&e, b"", huge, b"FAKE"),
            Err(Refusal::MalformedDecision),
            "beyond u128"
        );
        let lev0 = br#"{"v":1,"round":1,"nonce":"0123456789abcdef","action":"bet","market":"DOGE","side":"long","margin_e6":"1","leverage":0}"#;
        assert_eq!(
            Fake.verify(&e, b"", lev0, b"FAKE"),
            Err(Refusal::MalformedDecision),
            "leverage 1 or more"
        );
    }
}
