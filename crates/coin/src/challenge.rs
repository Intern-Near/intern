//! Interface 1.7, owner's decision (Engine 2's list, item 12): a reported result can be challenged.
//!
//! The runner reports each bet's result (known limit 2). Since 1.6 every order carries a client order id, so anyone
//! can compare a reported result with Hyperliquid's own fills. For `CHALLENGE_ROUNDS` (3) rounds after a bet's round,
//! anyone registered may challenge its result: `ft_transfer_call(coin, bond, '{"challenge":{"position_id":N,
//! "returned":"<the dollars back they say is right>","reason":"<at most 140 characters>"}}')` with at least
//! `CHALLENGE_BOND` ($5). That opens a `CORRECT` vote at once (it passes like a promotion).
//! - Passed: anyone calls `apply_correction(vote_id)`: the pool takes the difference (on testnet the contract mints
//!   or burns test dollars, as `settle` does), the bet's `returned` becomes the challenged figure with
//!   `result_source` `CORRECTED`, and the bond comes back to the challenger as a prize.
//! - Failed: the bond goes to the BRAVE pool as outside income.
//!
//! A reason is shown, never given to the AI. Bonds waiting are USDC held apart from both pools: the books add
//! `get_challenges().bonds_held`. State lives under its own storage keys (prefix `c7`): no migration.

use crate::*;
use near_sdk::borsh;

pub const CHALLENGE_BOND: u128 = 5_000_000;
pub const CHALLENGE_ROUNDS: u64 = 3;
/// `result_source` code of a corrected bet.
pub const CORRECTED: u8 = 3;
const MAX_REASON: usize = 140;
const GAS_BOOKS: Gas = Gas::from_tgas(15);
const GAS_ON_CORRECTION: Gas = Gas::from_tgas(20);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChallengeRec {
    pub vote_id: u64,
    pub position_id: u64,
    pub challenger: AccountId,
    pub bond: U128,
    pub reported: U128,
    pub claimed: U128,
    pub reason: String,
    /// "OPEN", "PASSED" (waiting for `apply_correction`), "APPLIED", "FAILED".
    pub state: String,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChallengeState {
    pub bonds_held: u128,
    pub count: u64,
}

#[near(serializers = [json])]
pub struct ChallengesView {
    pub bonds_held: U128,
    pub bond: U128,
    pub window_rounds: u64,
    pub challenges: Vec<ChallengeRec>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub(crate) struct ChallengeMsg {
    pub challenge: ChallengeBody,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub(crate) struct ChallengeBody {
    pub position_id: u64,
    pub returned: U128,
    pub reason: String,
}

fn state() -> ChallengeState {
    env::storage_read(b"c7s").map_or_else(ChallengeState::default, |b| {
        borsh::from_slice(&b).unwrap_or_else(|_| env::panic_str("challenge state"))
    })
}
fn put_state(s: &ChallengeState) {
    env::storage_write(b"c7s", &borsh::to_vec(s).unwrap_or_else(|_| env::panic_str("challenge state")));
}
fn rec_key(vote_id: u64) -> Vec<u8> {
    [b"c7v".as_slice(), &vote_id.to_le_bytes()].concat()
}
fn pos_key(position_id: u64) -> Vec<u8> {
    [b"c7p".as_slice(), &position_id.to_le_bytes()].concat()
}
fn read_rec(vote_id: u64) -> Option<ChallengeRec> {
    env::storage_read(&rec_key(vote_id)).map(|b| borsh::from_slice(&b).unwrap_or_else(|_| env::panic_str("challenge")))
}
fn put_rec(r: &ChallengeRec) {
    env::storage_write(&rec_key(r.vote_id), &borsh::to_vec(r).unwrap_or_else(|_| env::panic_str("challenge")));
}

impl Coin {
    /// ft_on_transfer with `{"challenge":{..}}`. Returns what to refund.
    pub(crate) fn take_challenge(&mut self, who: &AccountId, c: ChallengeBody, amount: u128) -> u128 {
        let refuse = |why: &str| {
            env::log_str(&format!("{why}: refunded"));
            amount
        };
        if amount < CHALLENGE_BOND {
            return refuse("a challenge's bond is at least 5 USDC");
        }
        if c.reason.chars().count() > MAX_REASON || c.reason.chars().any(|ch| ch.is_control() && ch != '\n') {
            return refuse("a reason is at most 140 characters, with no control characters");
        }
        if !self.registered(who) {
            return refuse("register first (storage_deposit)");
        }
        self.tick();
        let Some(p) = self.positions.get(&c.position_id).copied() else { return refuse("no such bet") };
        let (Some(reported), Some(crate::round::REPORTED_CODE)) = (p.returned, p.result_source) else {
            return refuse("only a bet with a reported result can be challenged");
        };
        let now_round = self.current.expect("round").id;
        if now_round > p.round_id + CHALLENGE_ROUNDS {
            return refuse("the challenge window for this bet is over (3 rounds after its round)");
        }
        if env::storage_has_key(&pos_key(c.position_id)) {
            return refuse("this bet's result has already been challenged");
        }
        if c.returned.0 == reported {
            return refuse("the challenged figure equals the reported one");
        }
        let Some(vote_id) = self.open_internal_vote(rules::vote::VoteKind::Correct, who) else {
            return refuse("a CORRECT vote is already open, or no locked coin can vote yet");
        };
        env::storage_write(&pos_key(c.position_id), &vote_id.to_le_bytes());
        let rec = ChallengeRec {
            vote_id,
            position_id: c.position_id,
            challenger: who.clone(),
            bond: U128(amount),
            reported: U128(reported),
            claimed: c.returned,
            reason: c.reason,
            state: "OPEN".to_string(),
        };
        put_rec(&rec);
        let mut s = state();
        s.bonds_held += amount;
        s.count += 1;
        put_state(&s);
        self.feed.push(
            EventName::ResultChallenged,
            json!({"vote_id": vote_id, "position_id": c.position_id, "challenger": who,
                   "reported": U128(reported), "claimed": rec.claimed, "bond": U128(amount)}),
        );
        0
    }

    /// vote.rs, when a CORRECT vote finishes.
    pub(crate) fn challenge_finished(&mut self, vote_id: u64, passed: bool) {
        let Some(mut r) = read_rec(vote_id) else { return };
        if passed {
            r.state = "PASSED".to_string();
        } else {
            r.state = "FAILED".to_string();
            let mut s = state();
            s.bonds_held -= r.bond.0;
            put_state(&s);
            self.take_income("challenge", r.bond.0);
        }
        put_rec(&r);
    }
}

#[near]
impl Coin {
    /// 1.7. Applies a passed CORRECT vote: the pool takes the difference (test dollars minted or burned on testnet),
    /// the bet is marked CORRECTED, the bond comes back to the challenger as a prize. Anyone; at least 60 TGas.
    pub fn apply_correction(&mut self, vote_id: u64) -> PromiseOrValue<bool> {
        require!(env::prepaid_gas() >= Gas::from_tgas(60), "attach at least 60 TGas");
        let r = read_rec(vote_id).unwrap_or_else(|| env::panic_str("no such challenge"));
        require!(r.state == "PASSED", "only a passed challenge can be applied, once");
        let delta = r.claimed.0 as i128 - r.reported.0 as i128;
        let mut r2 = r.clone();
        r2.state = "APPLYING".to_string();
        put_rec(&r2);
        let usdc = crate::round::ext_mock_usdc::ext(self.cfg.usdc_token.clone()).with_static_gas(GAS_BOOKS);
        let books =
            if delta > 0 { usdc.mint(Self::me(), U128(delta as u128)) } else { usdc.burn(U128(delta.unsigned_abs())) };
        PromiseOrValue::Promise(
            books.then(Self::ext(Self::me()).with_static_gas(GAS_ON_CORRECTION).on_correction(vote_id)),
        )
    }

    #[private]
    pub fn on_correction(&mut self, vote_id: u64) -> bool {
        let mut r = read_rec(vote_id).unwrap_or_else(|| env::panic_str("no such challenge"));
        if matches!(env::promise_result_checked(0, 64), Err(PromiseError::Failed)) {
            r.state = "PASSED".to_string();
            put_rec(&r);
            env::log_str("the test-dollar mint or burn failed; call apply_correction again");
            return false;
        }
        let delta = r.claimed.0 as i128 - r.reported.0 as i128;
        self.books.brave_total = (self.books.brave_total as i128 + delta).max(0) as u128;
        if let Some(mut p) = self.positions.get(&r.position_id).copied() {
            p.returned = Some(r.claimed.0);
            p.result_source = Some(CORRECTED);
            self.positions.insert(r.position_id, p);
            if let Some(mut rr) = self.rounds.get(&p.round_id).copied() {
                rr.result += delta;
                self.rounds.insert(p.round_id, rr);
            }
        }
        let mut s = state();
        s.bonds_held -= r.bond.0;
        put_state(&s);
        self.rw_credit_prize(&r.challenger, r.bond.0);
        r.state = "APPLIED".to_string();
        put_rec(&r);
        self.feed.push(
            EventName::ResultCorrected,
            json!({"vote_id": vote_id, "position_id": r.position_id, "from": r.reported, "to": r.claimed,
                   "delta": wire::I128(delta), "brave_after": U128(self.books.brave_total)}),
        );
        true
    }

    /// 1.7. Challenges, newest first (at most 20), and the bonds held.
    pub fn get_challenges(&self) -> ChallengesView {
        let s = state();
        let mut challenges = Vec::new();
        let mut id = self.next_vote_id;
        while id > 1 && challenges.len() < 20 {
            id -= 1;
            if let Some(r) = read_rec(id) {
                challenges.push(r);
            }
        }
        ChallengesView {
            bonds_held: U128(s.bonds_held),
            bond: U128(CHALLENGE_BOND),
            window_rounds: CHALLENGE_ROUNDS,
            challenges,
        }
    }
}
