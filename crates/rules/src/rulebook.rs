//! Section 6.1: the rulebook text the program writes for the AI. Byte-exact: Engine 2's `ai-check`
//! compares the request's system message against it.

use crate::limits::{bets_left, limits, max_next_margin};
use shared::Rank;

/// Section 6.1: playbook text is limited to 2,000 bytes.
pub const PLAYBOOK_MAX_BYTES: usize = 2_000;

/// The section 6.1 template for a given state.
///
/// - Uses `brave_at_open`, never the pool now (section 3, 1.1), so the text does not change under
///   the runner when someone cashes out.
/// - `rank` is the current rank (after a demotion, the lower one).
/// - `bets_left` and `max_margin_e6` stop at 0.
/// - `playbook` must already be clean (see [`clean_playbook`]); `None` prints "none".
pub fn rulebook(
    round_id: u64,
    nonce: &str,
    rank: Rank,
    brave_at_open: u128,
    bets_used: u32,
    at_risk: u128,
    playbook: Option<&str>,
) -> String {
    let l = limits(rank);
    let markets: Vec<&str> = l.markets.iter().map(|m| m.as_str()).collect();
    let sides: Vec<&str> = l.sides.iter().map(|s| s.as_decision_str()).collect();
    let lines = [
        "You are the Intern, an AI trader. A program checks your answer against the rules below. An answer that breaks a rule is refused.".to_string(),
        format!("round: {round_id}"),
        format!("nonce: {nonce}"),
        format!("rank: {}", rank.as_str()),
        format!("markets: {}", markets.join(", ")),
        format!("sides: {}", sides.join(", ")),
        format!("max_leverage: {}", l.max_leverage),
        format!("max_margin_e6: {}", max_next_margin(rank, brave_at_open, at_risk)),
        format!("min_notional_e6: {}", crate::limits::MIN_NOTIONAL),
        format!("bets_left: {}", bets_left(rank, bets_used)),
        format!("playbook: {}", playbook.unwrap_or("none")),
        // 1.2 (Engine 2's item A): the unit and the minimum, said once.
        "Amounts are US dollars times 1,000,000, so 10000000 is $10. A bet's notional is margin_e6 times leverage and must be at least min_notional_e6.".to_string(),
        "Answer with exactly one line of JSON and nothing else, in one of these two forms:".to_string(),
        format!(r#"{{"v":1,"round":{round_id},"nonce":"{nonce}","action":"skip"}}"#),
        format!(
            r#"{{"v":1,"round":{round_id},"nonce":"{nonce}","action":"bet","market":"DOGE","side":"long","margin_e6":"11000000","leverage":1}}"#
        ),
    ];
    lines.join("\n")
}

/// Section 6.1: the nonce is 16 lower-case hex characters.
pub fn is_valid_nonce(n: &str) -> bool {
    n.len() == 16
        && n.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybookError {
    TooLong,
    Empty,
}

/// Section 6.1: a playbook may not contain a newline; the program replaces newlines with spaces
/// when it is submitted. Also limited to 2,000 bytes. "\r\n" becomes one space.
pub fn clean_playbook(text: &str) -> Result<String, PlaybookError> {
    let clean = text.replace("\r\n", " ").replace(['\n', '\r'], " ");
    if clean.trim().is_empty() {
        return Err(PlaybookError::Empty);
    }
    if clean.len() > PLAYBOOK_MAX_BYTES {
        return Err(PlaybookError::TooLong);
    }
    Ok(clean)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_intern_rulebook_written_out_by_hand() {
        let want = "You are the Intern, an AI trader. A program checks your answer against the rules below. An answer that breaks a rule is refused.\n\
round: 42\n\
nonce: 9f2c41d07ab35e16\n\
rank: INTERN\n\
markets: DOGE, SHIB, PEPE, PENGU\n\
sides: long\n\
max_leverage: 1\n\
max_margin_e6: 20000000\n\
min_notional_e6: 11000000\n\
bets_left: 1\n\
playbook: none\n\
Amounts are US dollars times 1,000,000, so 10000000 is $10. A bet's notional is margin_e6 times leverage and must be at least min_notional_e6.\n\
Answer with exactly one line of JSON and nothing else, in one of these two forms:\n\
{\"v\":1,\"round\":42,\"nonce\":\"9f2c41d07ab35e16\",\"action\":\"skip\"}\n\
{\"v\":1,\"round\":42,\"nonce\":\"9f2c41d07ab35e16\",\"action\":\"bet\",\"market\":\"DOGE\",\"side\":\"long\",\"margin_e6\":\"11000000\",\"leverage\":1}";
        assert_eq!(
            rulebook(
                42,
                "9f2c41d07ab35e16",
                Rank::Intern,
                1_000_000_000,
                0,
                0,
                None
            ),
            want
        );
    }

    #[test]
    fn fifteen_lines_and_no_trailing_newline() {
        for rank in Rank::ALL {
            let t = rulebook(
                7,
                "0123456789abcdef",
                rank,
                5_000_000_000,
                1,
                10_000_000,
                Some("be careful"),
            );
            assert_eq!(t.split('\n').count(), 15);
            assert!(!t.ends_with('\n'));
        }
    }

    #[test]
    fn nonces() {
        assert!(is_valid_nonce("9f2c41d07ab35e16"));
        assert!(!is_valid_nonce("9F2C41D07AB35E16"));
        assert!(!is_valid_nonce("9f2c41d07ab35e1"));
        assert!(!is_valid_nonce("9f2c41d07ab35e1g"));
    }

    #[test]
    fn playbooks_lose_their_newlines() {
        assert_eq!(clean_playbook("a\nb\r\nc\rd").unwrap(), "a b c d");
        assert_eq!(clean_playbook(&"x".repeat(2_000)).unwrap().len(), 2_000);
        assert_eq!(
            clean_playbook(&"x".repeat(2_001)),
            Err(PlaybookError::TooLong)
        );
        assert_eq!(clean_playbook(" \n "), Err(PlaybookError::Empty));
    }
}
