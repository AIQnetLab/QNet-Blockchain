/// QNC Yield Pool — user-deployable token staking contract
///
/// # What this is
///
/// A smart contract that any team, DAO, or protocol can deploy on QNet's PQ-EVM.
/// It lets **wallet users** lock QNC tokens and earn proportional yield.
///
/// Has nothing to do with:
/// - Node registration or activation (that happens in core genesis-node logic)
/// - Block production (handled by BFT consensus across all server nodes)
/// - Proof-of-Stake (QNet is not PoS — staking here is purely financial)
///
/// # How yield works
///
/// The pool owner (deployer) periodically deposits QNC into the reward pool —
/// typically by forwarding emission rewards claimed from genesis nodes.
/// On each distribution, every staker receives:
///
///   reward_i = pool_amount × (stake_i / total_staked)
///
/// No tiers, no multipliers. Equal proportional share for everyone.
///
/// # Typical usage flow (wallet perspective)
///
/// 1. User opens wallet, sees "Stake QNC — earn yield"
/// 2. User calls `stake(amount)` via the SDK or mobile app
/// 3. Every epoch (~28 800 blocks), pool receives fresh QNC from the owner
/// 4. Owner calls `distribute(epoch, amount)` — rewards credited proportionally
/// 5. User calls `claim_rewards()` to withdraw earned yield
/// 6. User calls `begin_unstake()` to start cooldown, then `withdraw()` to exit

use std::collections::HashMap;

// ─────────────────────────────────────────────────────────────────────────────
// Constants (all configurable at deployment)
// ─────────────────────────────────────────────────────────────────────────────

/// Minimum stake in smallest QNC unit (10^-9). Zero = no floor.
/// Deployer can set this to anything; here we default to 1 QNC.
pub const DEFAULT_MIN_STAKE: u64 = 1_000_000_000;

/// Default unbonding cooldown in seconds (7 days).
pub const DEFAULT_COOLDOWN_SECS: u64 = 7 * 24 * 3_600;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct StakeRecord {
    pub owner:             [u8; 20],
    /// Locked principal in smallest QNC unit
    pub amount:            u64,
    /// True while actively earning; false once unstake begun
    pub earning:           bool,
    /// Timestamp/block after which withdrawal is allowed (0 = not unbonding)
    pub unlock_at:         u64,
    pub accrued_rewards:   u64,
    pub last_reward_epoch: u64,
}

/// In-memory contract state — mirrors on-chain SSTORE slots in a real deployment.
pub struct QNCYieldPool {
    pub stakes:           HashMap<[u8; 20], StakeRecord>,
    /// Contract owner — funds the reward pool and calls distribute()
    pub owner:            [u8; 20],
    pub min_stake:        u64,
    pub cooldown_secs:    u64,
    /// Sum of all currently earning stakes
    pub total_staked:     u64,
    /// Available reward pool deposited by owner
    pub reward_pool:      u64,
    /// Monotonic clock (seconds or block number — whatever the EVM environment provides)
    pub now:              u64,
}

impl QNCYieldPool {
    pub fn new(owner: [u8; 20], min_stake: u64, cooldown_secs: u64) -> Self {
        Self {
            stakes:        HashMap::new(),
            owner,
            min_stake,
            cooldown_secs,
            total_staked:  0,
            reward_pool:   0,
            now:           0,
        }
    }

    // ── Staking ───────────────────────────────────────────────────────────────

    /// Lock QNC in the pool. Anyone with a wallet can call this.
    pub fn stake(&mut self, caller: [u8; 20], amount: u64) -> Result<(), String> {
        if amount < self.min_stake {
            return Err(format!("Below minimum: {amount} < {}", self.min_stake));
        }
        if self.stakes.contains_key(&caller) {
            return Err("Already staking — top up with add_stake() or exit first".into());
        }
        self.stakes.insert(caller, StakeRecord {
            owner:             caller,
            amount,
            earning:           true,
            unlock_at:         0,
            accrued_rewards:   0,
            last_reward_epoch: 0,
        });
        self.total_staked = self.total_staked.saturating_add(amount);
        Ok(())
    }

    /// Add more QNC to an existing active position.
    pub fn add_stake(&mut self, caller: [u8; 20], extra: u64) -> Result<(), String> {
        if extra == 0 { return Err("Amount must be > 0".into()); }
        let r = self.stakes.get_mut(&caller).ok_or("Not staking")?;
        if !r.earning { return Err("Position is unbonding — cannot top up".into()); }
        r.amount = r.amount.saturating_add(extra);
        self.total_staked = self.total_staked.saturating_add(extra);
        Ok(())
    }

    // ── Rewards ───────────────────────────────────────────────────────────────

    /// Pool owner deposits QNC into the reward pool.
    /// Typically called after claiming epoch emission from genesis nodes.
    pub fn deposit_rewards(&mut self, caller: [u8; 20], amount: u64) -> Result<(), String> {
        if caller != self.owner {
            return Err("Only owner can deposit rewards".into());
        }
        self.reward_pool = self.reward_pool.saturating_add(amount);
        Ok(())
    }

    /// Distribute `amount` from the reward pool to all earning stakers.
    ///
    /// Distribution is **purely proportional** — no tiers, no bonuses.
    /// `reward_i = amount × (stake_i / total_staked)`
    pub fn distribute(&mut self, caller: [u8; 20], epoch: u64, amount: u64) -> Result<(), String> {
        if caller != self.owner {
            return Err("Only owner can distribute".into());
        }
        if amount > self.reward_pool {
            return Err(format!("Pool only has {}, requested {amount}", self.reward_pool));
        }
        if self.total_staked == 0 { return Ok(()); }

        let mut paid: u64 = 0;
        for r in self.stakes.values_mut() {
            if !r.earning { continue; }
            if r.last_reward_epoch >= epoch { continue; }
            let share = amount.saturating_mul(r.amount) / self.total_staked;
            r.accrued_rewards = r.accrued_rewards.saturating_add(share);
            r.last_reward_epoch = epoch;
            paid = paid.saturating_add(share);
        }
        self.reward_pool = self.reward_pool.saturating_sub(paid);
        Ok(())
    }

    /// Withdraw all accrued yield. Principal stays locked.
    pub fn claim_rewards(&mut self, caller: [u8; 20]) -> Result<u64, String> {
        let r = self.stakes.get_mut(&caller).ok_or("Not staking")?;
        if r.accrued_rewards == 0 { return Err("Nothing to claim".into()); }
        let amount = r.accrued_rewards;
        r.accrued_rewards = 0;
        // In a real deployment: transfer `amount` QNC to caller here
        Ok(amount)
    }

    // ── Exit ──────────────────────────────────────────────────────────────────

    /// Start the unbonding cooldown.
    /// The position immediately stops earning rewards.
    pub fn begin_unstake(&mut self, caller: [u8; 20]) -> Result<u64, String> {
        let r = self.stakes.get_mut(&caller).ok_or("Not staking")?;
        if !r.earning {
            return Err("Already unbonding".into());
        }
        self.total_staked = self.total_staked.saturating_sub(r.amount);
        r.earning   = false;
        r.unlock_at = self.now + self.cooldown_secs;
        Ok(r.unlock_at)
    }

    /// Withdraw principal after cooldown has elapsed.
    /// Any unclaimed rewards are returned alongside the principal.
    pub fn withdraw(&mut self, caller: [u8; 20]) -> Result<WithdrawResult, String> {
        let r = self.stakes.get(&caller).ok_or("Not staking")?;
        if r.earning {
            return Err("Call begin_unstake() first".into());
        }
        if self.now < r.unlock_at {
            return Err(format!("Cooldown active until {}, now={}", r.unlock_at, self.now));
        }
        let result = WithdrawResult {
            principal:       r.amount,
            pending_rewards: r.accrued_rewards,
        };
        self.stakes.remove(&caller);
        // In a real deployment: transfer (principal + pending_rewards) QNC to caller
        Ok(result)
    }
}

#[derive(Debug, PartialEq)]
pub struct WithdrawResult {
    pub principal:       u64,
    pub pending_rewards: u64,
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(b: u8) -> [u8; 20] { [b; 20] }
    fn pool() -> QNCYieldPool {
        QNCYieldPool::new(addr(0x01), DEFAULT_MIN_STAKE, DEFAULT_COOLDOWN_SECS)
    }

    #[test]
    fn test_proportional_equal_stakes() {
        let mut p = pool();
        let owner = addr(0x01);

        p.stake(addr(0xA1), 1_000_000_000).unwrap();
        p.stake(addr(0xA2), 1_000_000_000).unwrap();

        p.deposit_rewards(owner, 2_000_000_000).unwrap();
        p.distribute(owner, 1, 2_000_000_000).unwrap();

        let r1 = p.claim_rewards(addr(0xA1)).unwrap();
        let r2 = p.claim_rewards(addr(0xA2)).unwrap();

        assert_eq!(r1, r2, "Equal stakes → equal rewards");
        assert_eq!(r1, 1_000_000_000);
    }

    #[test]
    fn test_proportional_unequal_stakes() {
        let mut p = pool();
        let owner = addr(0x01);

        p.stake(addr(0xA1), 3_000_000_000).unwrap(); // 3×
        p.stake(addr(0xA2), 1_000_000_000).unwrap(); // 1×

        p.deposit_rewards(owner, 4_000_000_000).unwrap();
        p.distribute(owner, 1, 4_000_000_000).unwrap();

        let r1 = p.claim_rewards(addr(0xA1)).unwrap();
        let r2 = p.claim_rewards(addr(0xA2)).unwrap();

        assert_eq!(r1, 3 * r2, "3× stake must yield 3× rewards");
    }

    #[test]
    fn test_unstaking_stops_earning() {
        let mut p = pool();
        let owner = addr(0x01);

        p.stake(addr(0xA1), 1_000_000_000).unwrap();
        p.stake(addr(0xA2), 1_000_000_000).unwrap();

        // A1 begins unbonding — stops earning immediately
        p.begin_unstake(addr(0xA1)).unwrap();

        p.deposit_rewards(owner, 1_000_000_000).unwrap();
        p.distribute(owner, 1, 1_000_000_000).unwrap();

        // A1 gets nothing; A2 gets everything
        assert!(p.claim_rewards(addr(0xA1)).is_err(), "Unbonding position earns nothing");
        assert_eq!(p.claim_rewards(addr(0xA2)).unwrap(), 1_000_000_000);
    }

    #[test]
    fn test_cooldown_enforced() {
        let mut p = QNCYieldPool::new(addr(0x01), DEFAULT_MIN_STAKE, 604_800);
        p.stake(addr(0xA1), 5_000_000_000).unwrap();
        p.begin_unstake(addr(0xA1)).unwrap();

        // Cannot withdraw immediately
        assert!(p.withdraw(addr(0xA1)).is_err());

        // Fast-forward past cooldown
        p.now += 604_800 + 1;
        let res = p.withdraw(addr(0xA1)).unwrap();
        assert_eq!(res, WithdrawResult { principal: 5_000_000_000, pending_rewards: 0 });
    }

    #[test]
    fn test_pending_rewards_returned_on_withdraw() {
        let mut p = pool();
        let owner = addr(0x01);

        p.stake(addr(0xA1), 2_000_000_000).unwrap();
        p.deposit_rewards(owner, 500_000_000).unwrap();
        p.distribute(owner, 1, 500_000_000).unwrap();

        // Do NOT claim, just unstake
        p.begin_unstake(addr(0xA1)).unwrap();
        p.now += DEFAULT_COOLDOWN_SECS + 1;

        let res = p.withdraw(addr(0xA1)).unwrap();
        assert_eq!(res.principal, 2_000_000_000);
        assert_eq!(res.pending_rewards, 500_000_000, "Unclaimed rewards returned on exit");
    }

    #[test]
    fn test_add_stake_increases_share() {
        let mut p = pool();
        let owner = addr(0x01);

        p.stake(addr(0xA1), 1_000_000_000).unwrap();
        p.stake(addr(0xA2), 1_000_000_000).unwrap();

        // A1 doubles their stake — should now get 2× what A2 gets
        p.add_stake(addr(0xA1), 1_000_000_000).unwrap();

        p.deposit_rewards(owner, 3_000_000_000).unwrap();
        p.distribute(owner, 1, 3_000_000_000).unwrap();

        let r1 = p.claim_rewards(addr(0xA1)).unwrap();
        let r2 = p.claim_rewards(addr(0xA2)).unwrap();
        assert_eq!(r1, 2 * r2);
    }
}
