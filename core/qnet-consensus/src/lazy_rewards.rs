//! Pool-1 emission schedule.
//!
//! All that survives of the phase-aware reward manager: the halving curve, which is the
//! consensus emission amount. Everything else was a second reward accounting that ran beside
//! the certified one and disagreed with it.

/// Seconds of chain time per microblock slot. Block timestamps are slot-anchored
/// (block_ts = genesis_ts + height*SLOT), so height alone is the chain's clock.
pub const EMISSION_SLOT_SECS: u64 = 1;
/// Seconds per emission year (365d), the halving schedule's unit.
pub const EMISSION_SECS_PER_YEAR: u64 = 365 * 24 * 60 * 60;

/// Pool-1 base emission for a halving cycle. Pure integer arithmetic, no clock, no state —
/// the single schedule shared by the wall-clock display path and the consensus height path.
pub fn pool1_base_emission_for_cycles(halving_cycles: u64) -> u64 {
    // Base emission in nanoQNC: 251,432.34 QNC × 10^9
    const BASE_EMISSION_NANO: u128 = 251_432_340_000_000;

    // FIX R20-L1: Correct branch ordering — >= 50 check BEFORE > 5
    // to ensure zero-emission safety net is reachable after ~200 years
    let emission_nano: u128 = if halving_cycles >= 50 {
        // Emission effectively zero after ~200+ years (integer division
        // already yields 0 well before this, but explicit guard is cleaner)
        0
    } else if halving_cycles == 5 {
        // 5th halving (year 20-24): Sharp drop — ÷16 (4 halvings) then ÷10
        // Divisor = 2^4 × 10 = 160
        BASE_EMISSION_NANO / 160
    } else if halving_cycles > 5 {
        // After sharp drop: Resume normal halving from low base
        // Divisor = 160 × 2^(cycles-5)
        let normal_halvings = (halving_cycles - 5).min(63);
        let divisor = 160u128.saturating_mul(1u128 << normal_halvings);
        BASE_EMISSION_NANO / divisor.max(1)
    } else {
        // Normal halving for first 5 cycles (0-20 years)
        // Divisor = 2^halving_cycles
        let divisor = 1u128 << halving_cycles.min(63);
        BASE_EMISSION_NANO / divisor
    };

    // Safe downcast: max value 251T nanoQNC << u64::MAX (18.4E)
    emission_nano as u64
}

/// CONSENSUS emission schedule: Pool-1 base emission at a block height.
///
/// The halving cycle is derived from HEIGHT, not from the wall clock. Block timestamps are
/// slot-anchored, so height is an exact, node-independent measure of elapsed chain time; reading
/// SystemTime::now() here would make the amount depend on each node's clock and split the network
/// for the whole cycle in which their clocks straddle a halving boundary. Producer and validator
/// both call this, so the emission TX's amount is verifiable rather than asserted.
pub fn pool1_base_emission_at_height(height: u64) -> u64 {
    let years = height.saturating_mul(EMISSION_SLOT_SECS) / EMISSION_SECS_PER_YEAR;
    pool1_base_emission_for_cycles(years / 4)
}

#[cfg(test)]
mod tests_emission_schedule {
    use super::*;

    /// The consensus emission schedule must be a pure function of height. It is recomputed by every
    /// validator and compared byte-for-byte against the producer's amount, so any dependence on the
    /// local clock would split the network for the whole cycle in which node clocks straddle a
    /// halving boundary.
    #[test]
    fn emission_at_height_is_deterministic_and_clock_free() {
        for h in [0u64, 1, 14_400, 31_536_000, 63_072_000, 126_144_000] {
            let a = pool1_base_emission_at_height(h);
            let b = pool1_base_emission_at_height(h);
            assert_eq!(a, b, "same height must yield the same amount, h={}", h);
        }
    }

    /// Halving boundaries land on the expected heights: cycle = (height_secs / year) / 4.
    #[test]
    fn halving_boundaries_follow_height() {
        let year = EMISSION_SECS_PER_YEAR / EMISSION_SLOT_SECS;
        let full = pool1_base_emission_for_cycles(0);
        assert_eq!(pool1_base_emission_at_height(0), full);
        assert_eq!(pool1_base_emission_at_height(4 * year - 1), full, "still cycle 0");
        assert_eq!(pool1_base_emission_at_height(4 * year), full / 2, "first halving");
        assert_eq!(pool1_base_emission_at_height(8 * year), full / 4, "second halving");
        // 5th cycle is the sharp drop: ÷16 then ÷10.
        assert_eq!(pool1_base_emission_at_height(20 * year), full / 160);
    }

    /// The schedule is monotonically non-increasing and terminates at zero.
    #[test]
    fn emission_never_increases_and_reaches_zero() {
        let mut prev = u64::MAX;
        for cycles in 0..=60u64 {
            let e = pool1_base_emission_for_cycles(cycles);
            assert!(e <= prev, "emission increased at cycle {}", cycles);
            prev = e;
        }
        assert_eq!(pool1_base_emission_for_cycles(50), 0, "zero-emission safety net");
    }
}
