//! Reward Processing Sharding for Scalability
//!
//! Only the shard-count sizing helper remains live; the live reward path is
//! save_epoch_reward_sharded in storage.rs. The former in-RAM ShardedRewardManager
//! (wall-clock reads, two-pass eligibility) had zero callers and was removed.

/// Get optimal shard count based on node count
pub fn calculate_optimal_shards(total_nodes: usize) -> usize {
    // Aim for ~50k-100k nodes per shard
    let optimal = (total_nodes / 75_000).max(1);

    // Round to nearest power of 2 for better distribution
    let mut shard_count = 1;
    while shard_count < optimal {
        shard_count *= 2;
    }

    shard_count.min(256) // Cap at 256 shards
}
