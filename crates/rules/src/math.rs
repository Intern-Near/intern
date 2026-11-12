//! Whole-number helpers. Exact for every `u128` input, never panic.

/// `a × b / c`, rounded down. Exact for every `u128` input: the product is kept in 256 bits.
/// `None` if `c` is 0 or the result does not fit in a `u128`.
pub fn mul_div_floor(a: u128, b: u128, c: u128) -> Option<u128> {
    if c == 0 {
        return None;
    }
    if let Some(p) = a.checked_mul(b) {
        return Some(p / c);
    }
    let (hi, lo) = mul_wide(a, b);
    div_wide(hi, lo, c)
}

/// The full 256-bit product of two `u128`s, as `(high 128 bits, low 128 bits)`.
pub fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    const M: u128 = u64::MAX as u128;
    let (a1, a0) = (a >> 64, a & M);
    let (b1, b0) = (b >> 64, b & M);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let (mid, c1) = p01.overflowing_add(p10);
    let (mid, c2) = mid.overflowing_add(p00 >> 64);
    let lo = (mid << 64) | (p00 & M);
    let hi = p11 + (mid >> 64) + ((c1 as u128 + c2 as u128) << 64);
    (hi, lo)
}

/// `(hi × 2^128 + lo) / c`, rounded down; `None` if `c` is 0 or the quotient needs more than 128 bits.
fn div_wide(hi: u128, lo: u128, c: u128) -> Option<u128> {
    if c == 0 || hi >= c {
        return None;
    }
    let mut rem = hi; // always below c
    let mut q: u128 = 0;
    for i in (0..128).rev() {
        let top = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        q <<= 1;
        if top == 1 || rem >= c {
            rem = rem.wrapping_sub(c);
            q |= 1;
        }
    }
    Some(q)
}

/// Basis points in one whole.
pub const BPS: u128 = 10_000;

/// `amount × bps / 10,000`, rounded down. With `bps` ≤ 10,000 the result never exceeds `amount`.
pub fn bps_of(amount: u128, bps: u32) -> u128 {
    // a / 10000 × bps + (a % 10000) × bps / 10000 is exact and cannot overflow for bps ≤ 10,000.
    let bps = bps as u128;
    (amount / BPS)
        .saturating_mul(bps)
        .saturating_add((amount % BPS) * bps / BPS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// (hi, lo) − (hi2, lo2) in 256 bits; None if negative.
    fn sub_wide((h1, l1): (u128, u128), (h2, l2): (u128, u128)) -> Option<(u128, u128)> {
        let (lo, borrow) = l1.overflowing_sub(l2);
        let hi = h1.checked_sub(h2)?.checked_sub(borrow as u128)?;
        Some((hi, lo))
    }

    #[test]
    fn known_values() {
        assert_eq!(mul_wide(u128::MAX, u128::MAX), (u128::MAX - 1, 1));
        assert_eq!(mul_wide(1 << 64, 1 << 64), (1, 0));
        assert_eq!(
            mul_div_floor(u128::MAX, u128::MAX, u128::MAX),
            Some(u128::MAX)
        );
        assert_eq!(mul_div_floor(u128::MAX, 2, 2), Some(u128::MAX));
        assert_eq!(mul_div_floor(u128::MAX, 2, 1), None, "does not fit");
        assert_eq!(mul_div_floor(7, 3, 0), None);
        assert_eq!(mul_div_floor(7, 3, 2), Some(10));
        assert_eq!(bps_of(1_000_000_000, 200), 20_000_000);
        assert_eq!(bps_of(u128::MAX, 10_000), u128::MAX);
        assert_eq!(bps_of(9_999, 1), 0);
    }

    proptest! {
        /// q = floor(a·b/c) exactly: q·c ≤ a·b < (q+1)·c, checked in 256 bits.
        #[test]
        fn mul_div_is_exact(a in any::<u128>(), b in any::<u128>(), c in 1..=u128::MAX) {
            let ab = mul_wide(a, b);
            match mul_div_floor(a, b, c) {
                Some(q) => {
                    let qc = mul_wide(q, c);
                    let r = sub_wide(ab, qc).expect("q·c ≤ a·b");
                    prop_assert!(r.0 == 0 && r.1 < c, "remainder below c");
                }
                None => prop_assert!(ab.0 >= c, "None only when the quotient needs > 128 bits"),
            }
        }

        #[test]
        fn mul_div_matches_plain_arithmetic_when_it_fits(a in any::<u64>(), b in any::<u64>(), c in 1..=u128::MAX) {
            prop_assert_eq!(mul_div_floor(a as u128, b as u128, c), Some(a as u128 * b as u128 / c));
        }

        #[test]
        fn bps_of_is_floor_and_never_above_the_amount(a in any::<u128>(), bps in 0u32..=10_000) {
            let x = bps_of(a, bps);
            prop_assert!(x <= a);
            prop_assert_eq!(Some(x), mul_div_floor(a, bps as u128, BPS));
        }
    }
}
