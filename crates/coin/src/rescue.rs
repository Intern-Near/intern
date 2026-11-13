//! Interface 1.7, owner's decision (Engine 2's list, item 16): holders can rescue a fired Intern.
//!
//! While the Intern is FIRED, anyone may pay into a rescue (`ft_transfer_call(coin, amount, '{"rescue":{}}')`, at
//! least $1). The money is held apart until the fund reaches `RESCUE_TARGET` ($50): then it goes to the BRAVE pool
//! as outside income, and the Intern is rehired at INTERN from the next round (a new 30-day term). For the
//! `RESCUE_ROUNDS` (14) rounds after that, every winning round pays `RESCUE_CUT_BPS` (10%) of its result to the
//! rescuers, split by what each put in, as prizes (`claim_prizes`). If holders rehire it by vote first, every
//! contribution waiting in the fund is given back, as a prize.
//!
//! The waiting fund is USDC held apart from both pools: the books add `get_rescue().fund`. State lives under its own
//! storage key (`r7s`): no migration.

use crate::*;
use near_sdk::borsh;

pub const RESCUE_TARGET: u128 = 50_000_000;
pub const RESCUE_ROUNDS: u64 = 14;
pub const RESCUE_CUT_BPS: u128 = 1_000;
const MAX_RESCUERS: usize = 50;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RescueState {
    /// Waiting: contributions to a rescue not yet complete.
    pub fund: u128,
    pub contributors: Vec<(AccountId, u128)>,
    /// The last completed rescue: its rescuers' shares, and the rounds that pay them.
    pub shares: Vec<(AccountId, u128)>,
    pub from_round: u64,
    pub until_round: u64,
    pub paid_total: u128,
    pub rescues: u32,
}

#[near(serializers = [json])]
pub struct RescueView {
    pub fund: U128,
    pub target: U128,
    pub contributors: u32,
    pub rescuers: Vec<(AccountId, U128)>,
    pub from_round: u64,
    pub until_round: u64,
    pub cut_bps: u32,
    pub paid_total: U128,
    pub rescues: u32,
}

/// `{"rescue":{}}`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub(crate) struct RescueMsg {
    #[allow(dead_code)]
    pub rescue: crate::TipBody,
}

fn read() -> RescueState {
    env::storage_read(b"r7s").map_or_else(RescueState::default, |b| {
        borsh::from_slice(&b).unwrap_or_else(|_| env::panic_str("rescue state"))
    })
}
fn write(s: &RescueState) {
    env::storage_write(b"r7s", &borsh::to_vec(s).unwrap_or_else(|_| env::panic_str("rescue state")));
}

impl Coin {
    /// ft_on_transfer with `{"rescue":{}}`. Returns what to refund.
    pub(crate) fn take_rescue(&mut self, who: &AccountId, amount: u128) -> u128 {
        if amount < goals::MIN_TIP {
            env::log_str("a rescue contribution is at least 1 USDC: refunded");
            return amount;
        }
        self.tick();
        let (_, status) = self.rank_now();
        if status != Status::Fired || self.rank.pending.is_some() {
            env::log_str("a rescue is only for a fired Intern with no rehire on its way: refunded");
            return amount;
        }
        let mut s = read();
        match s.contributors.iter().position(|(a, _)| a == who) {
            Some(i) => s.contributors[i].1 += amount,
            None if s.contributors.len() >= MAX_RESCUERS => {
                env::log_str("this rescue has all the rescuers it can take: refunded");
                return amount;
            }
            None => s.contributors.push((who.clone(), amount)),
        }
        s.fund += amount;
        self.feed.push(
            EventName::RescueGrew,
            json!({"amount": U128(amount), "by": who, "fund": U128(s.fund), "target": U128(RESCUE_TARGET)}),
        );
        if s.fund >= RESCUE_TARGET {
            let round_id = self.current.expect("round").id;
            let eff = round_id + 1;
            let fund = s.fund;
            self.take_income("rescue", fund);
            self.rank.pending = Some((0, 0, eff)); // INTERN, EMPLOYED, from the next round (a new term then)
            s.shares = std::mem::take(&mut s.contributors);
            s.fund = 0;
            s.from_round = eff;
            s.until_round = eff + RESCUE_ROUNDS;
            s.rescues += 1;
            let rescuers: Vec<&AccountId> = s.shares.iter().map(|(a, _)| a).collect();
            self.feed.push(
                EventName::Rescued,
                json!({"round_id": round_id, "effective_round": eff, "fund": U128(fund), "rescuers": rescuers}),
            );
        }
        write(&s);
        0
    }

    /// finish_settle, for a winning round: the rescuers' cut, if the round is in their window. Returns it.
    pub(crate) fn pay_rescuers(&mut self, round_id: u64, result: u128) -> u128 {
        let mut s = read();
        if s.shares.is_empty() || round_id < s.from_round || round_id >= s.until_round {
            return 0;
        }
        let cut = result * RESCUE_CUT_BPS / 10_000;
        let total: u128 = s.shares.iter().map(|(_, v)| *v).sum();
        if cut == 0 || total == 0 {
            return 0;
        }
        let mut paid = 0;
        let shares = s.shares.clone();
        for (who, v) in &shares {
            let each = cut * v / total;
            if each > 0 {
                self.rw_credit_prize(who, each);
                paid += each;
            }
        }
        s.paid_total += paid;
        write(&s);
        self.feed.push(EventName::RescuePaid, json!({"round_id": round_id, "amount": U128(paid)}));
        paid
    }

    /// apply_due_rank, when the Intern is rehired by vote: a rescue still collecting gives every contribution back.
    pub(crate) fn rescue_refund_waiting(&mut self) {
        let mut s = read();
        if s.fund == 0 {
            return;
        }
        for (who, v) in std::mem::take(&mut s.contributors) {
            self.rw_credit_prize(&who, v);
        }
        s.fund = 0;
        write(&s);
    }
}

#[near]
impl Coin {
    /// 1.7. The rescue fund and the last rescue's rescuers.
    pub fn get_rescue(&self) -> RescueView {
        let s = read();
        RescueView {
            fund: U128(s.fund),
            target: U128(RESCUE_TARGET),
            contributors: s.contributors.len() as u32,
            rescuers: s.shares.iter().map(|(a, v)| (a.clone(), U128(*v))).collect(),
            from_round: s.from_round,
            until_round: s.until_round,
            cut_bps: RESCUE_CUT_BPS as u32,
            paid_total: U128(s.paid_total),
            rescues: s.rescues,
        }
    }
}
