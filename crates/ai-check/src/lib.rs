//! ai-check: checks 3, 4 and 5 of 01-SHARED-INTERFACE.md section 7, in that order.
//!
//! 3. `BAD_MODEL_SIGNATURE`: the signature over `model:sha256(request):sha256(response)` is not the pinned signer's.
//! 4. `WRONG_RULEBOOK`: the request is not the pinned model being sent the current rulebook as its system message.
//! 5. `MALFORMED_DECISION`: the answer is not exactly a decision line for this round and nonce.
//!
//! Pure: no NEAR SDK, no network, no clock, no storage; `no_std` with `alloc`; no `unsafe`. All hashing and
//! signature maths go through [`Host`]. It never panics: every bad input is one of the three refusals.
//! The interface is fixed in 01 §11.1; the shared types come from Engine 1's `shared` crate (01 §11).
//!
//! Follows 01 version 1.2:
//! - the request's allowed shape (§6.3): see [`request_ok`];
//! - the decision line (§6.2): see `line.rs`. A margin of "0" is well-formed (D13);
//! - nothing before or after the line, not even a blank line, a space or a tab (§6.2, D12);
//! - both signing schemes work; the contract pins one (`Pinned::algo`). 01 1.2 pins `z-ai/glm-5.3-flash`, ed25519.
#![no_std]
#![forbid(unsafe_code)]

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;

pub mod json;
mod line;

pub use shared::{Decision, Host, Market, Refusal, Side};

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Algo {
    Ecdsa,
    Ed25519,
}

pub struct Pinned<'a> {
    /// The full model name, e.g. "z-ai/glm-5.3-flash".
    pub model: &'a str,
    pub algo: Algo,
    /// 20-byte address for Ecdsa, 32-byte key for Ed25519.
    pub signer: &'a [u8],
}

pub struct Expected<'a> {
    /// The exact text of 01 §6.1, built by the contract.
    pub rulebook: &'a str,
    pub round_id: u64,
    pub nonce: &'a str,
}

/// Runs checks 3, 4 and 5 of section 7, in that order.
/// Returns the decision, or exactly one of:
/// Refusal::BadModelSignature, Refusal::WrongRulebook, Refusal::MalformedDecision.
pub fn verify<H: Host>(
    host: &H,
    pinned: &Pinned,
    expected: &Expected,
    request: &[u8],
    response: &[u8],
    signature: &[u8],
) -> Result<Decision, Refusal> {
    if !signature_ok(host, pinned, request, response, signature) {
        return Err(Refusal::BadModelSignature);
    }
    if !request_ok(pinned, expected, request) {
        return Err(Refusal::WrongRulebook);
    }
    read_decision(expected, response).ok_or(Refusal::MalformedDecision)
}

/// The contract's own writing of a decision line (section 6.2). Used for the byte-equality check
/// and by the runner's tests.
pub fn decision_line(round_id: u64, nonce: &str, decision: &Decision) -> String {
    match decision {
        Decision::Skip => {
            alloc::format!(r#"{{"v":1,"round":{round_id},"nonce":"{nonce}","action":"skip"}}"#)
        }
        Decision::Bet {
            market,
            side,
            margin_e6,
            leverage,
        } => alloc::format!(
            r#"{{"v":1,"round":{round_id},"nonce":"{nonce}","action":"bet","market":"{}","side":"{}","margin_e6":"{margin_e6}","leverage":{leverage}}}"#,
            market.as_str(),
            side.as_decision_str(),
        ),
    }
}

// ---------------------------------------------------------------- check 3: the signature

fn push_hex(out: &mut Vec<u8>, bytes: &[u8]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for b in bytes {
        out.push(HEX[usize::from(b >> 4)]);
        out.push(HEX[usize::from(b & 0x0f)]);
    }
}

/// `model:sha256(request):sha256(response)`, lower-case hex: the text NEAR AI's model hardware signs.
fn signed_text<H: Host>(host: &H, model: &str, request: &[u8], response: &[u8]) -> Vec<u8> {
    let mut text = Vec::with_capacity(model.len() + 130);
    text.extend_from_slice(model.as_bytes());
    text.push(b':');
    push_hex(&mut text, &host.sha256(request));
    text.push(b':');
    push_hex(&mut text, &host.sha256(response));
    text
}

fn signature_ok<H: Host>(
    host: &H,
    pinned: &Pinned,
    request: &[u8],
    response: &[u8],
    signature: &[u8],
) -> bool {
    let text = signed_text(host, pinned.model, request, response);
    match pinned.algo {
        Algo::Ed25519 => {
            let (Ok(sig), Ok(key)) = (
                <&[u8; 64]>::try_from(signature),
                <&[u8; 32]>::try_from(pinned.signer),
            ) else {
                return false;
            };
            host.ed25519_verify(sig, &text, key)
        }
        Algo::Ecdsa => {
            // Ethereum "personal sign": keccak256("\x19Ethereum Signed Message:\n" + length + text), then recover the
            // signer's public key; its address is the last 20 bytes of the key's keccak256.
            if signature.len() != 65 || pinned.signer.len() != 20 {
                return false;
            }
            let (Some(Ok(rs)), Some(&v)) = (
                signature.get(..64).map(<&[u8; 64]>::try_from),
                signature.get(64),
            ) else {
                return false;
            };
            // NEAR AI writes v as 27 or 28; the recovery id is 0 or 1 (01 item E).
            let recovery = match v {
                0 | 1 => v,
                27 | 28 => v - 27,
                _ => return false,
            };
            let mut message = Vec::with_capacity(text.len() + 32);
            message.extend_from_slice(b"\x19Ethereum Signed Message:\n");
            message.extend_from_slice(alloc::format!("{}", text.len()).as_bytes());
            message.extend_from_slice(&text);
            let Some(public_key) = host.ecrecover(&host.keccak256(&message), rs, recovery) else {
                return false;
            };
            host.keccak256(&public_key).get(12..) == Some(pinned.signer)
        }
    }
}

// ---------------------------------------------------------------- check 4: the rulebook

/// The request must be exactly the pinned model being sent the current rulebook (01 §6.3, version 1.2):
/// - a JSON object whose only keys are `model`, `messages`, `stream` and, optionally, `chat_template_kwargs`;
/// - `model` is the pinned model, `stream` is `false`;
/// - `messages` is exactly two messages, each with exactly the keys `role` and `content` (a string): first the
///   system message, whose text is the rulebook byte for byte (after JSON escapes are decoded), then the user's;
/// - `chat_template_kwargs`, if present, is exactly `{"enable_thinking": false}` (it can only switch thinking off).
///
/// Any other shape, or a key written twice anywhere, is WRONG_RULEBOOK.
pub fn request_ok(pinned: &Pinned, expected: &Expected, request: &[u8]) -> bool {
    let Some(body) = json::parse(request) else {
        return false;
    };
    let Some(fields) = body.as_object() else {
        return false;
    };
    let (mut model, mut messages, mut stream) = (false, false, false);
    for (key, value) in fields {
        match key.as_str() {
            "model" => model = value.as_str() == Some(pinned.model),
            "stream" => stream = *value == json::Value::Bool(false),
            "messages" => messages = messages_ok(value, expected.rulebook),
            "chat_template_kwargs" => {
                let thinking_off = matches!(value.as_object(), Some([(k, json::Value::Bool(false))]) if k == "enable_thinking");
                if !thinking_off {
                    return false;
                }
            }
            _ => return false,
        }
    }
    model && messages && stream
}

fn message<'v>(m: &'v json::Value, role: &str) -> Option<&'v str> {
    if m.as_object()?.len() != 2 || m.get("role")?.as_str()? != role {
        return None;
    }
    m.get("content")?.as_str()
}

fn messages_ok(value: &json::Value, rulebook: &str) -> bool {
    let Some([system, user]) = value.as_array() else {
        return false;
    };
    message(system, "system") == Some(rulebook) && message(user, "user").is_some()
}

// ---------------------------------------------------------------- check 5: the decision line

/// The answer text: `choices[0].message.content` of a response with exactly one choice.
fn answer_text(body: &json::Value) -> Option<&str> {
    let [choice] = body.get("choices")?.as_array()? else {
        return None;
    };
    choice.get("message")?.get("content")?.as_str()
}

/// The answer must be the decision line and nothing else: no blank line, space or tab before or after it (01 §6.2,
/// test case D12). The line is then read by its fixed shape and compared with the contract's own writing of it.
fn read_decision(expected: &Expected, response: &[u8]) -> Option<Decision> {
    let body = json::parse(response)?;
    let line = answer_text(&body)?;
    let decision = line::parse(line, expected.round_id, expected.nonce)?;
    if decision_line(expected.round_id, expected.nonce, &decision) != line {
        return None;
    }
    Some(decision)
}
