//! Kademlia routing table: bucket maintenance, closest-peer selection, refresh.

use super::*;

impl KademliaRoutingTable {
    pub fn new(local_node_id: &str) -> Self {
        let mut hasher = Sha3_256::new();
        hasher.update(local_node_id.as_bytes());
        let hash = hasher.finalize();
        let mut local_id_hash = [0u8; 32];
        local_id_hash.copy_from_slice(&hash);
        Self {
            local_id_hash,
            buckets: Arc::new(DashMap::new()),
            bucket_last_refresh: Arc::new(DashMap::new()),
        }
    }

    pub(super) fn bucket_index_for(&self, peer_hash: &[u8; 32]) -> usize {
        for (i, (a, b)) in self.local_id_hash.iter().zip(peer_hash.iter()).enumerate() {
            if a != b {
                let xor = a ^ b;
                for bit_pos in (0..8).rev() {
                    if (xor >> bit_pos) & 1 == 1 {
                        return i * 8 + (7 - bit_pos);
                    }
                }
            }
        }
        KADEMLIA_BITS - 1
    }

    pub(super) fn hash_node_id(node_id: &str) -> [u8; 32] {
        let mut hasher = Sha3_256::new();
        hasher.update(node_id.as_bytes());
        let h = hasher.finalize();
        let mut out = [0u8; 32];
        out.copy_from_slice(&h);
        out
    }

    /// Insert or update a peer in the appropriate k-bucket.
    /// Returns true if the peer was added/updated.
    pub fn upsert(&self, node_id: &str, addr: &str, reputation: f64, now: u64) -> bool {
        let id_hash = Self::hash_node_id(node_id);
        let bucket_idx = self.bucket_index_for(&id_hash);

        let mut bucket = self.buckets.entry(bucket_idx).or_insert_with(Vec::new);

        if let Some(pos) = bucket.iter().position(|p| p.node_id == node_id) {
            bucket[pos].last_seen = now;
            bucket[pos].reputation = reputation;
            bucket[pos].addr = addr.to_string();
            return true;
        }

        if bucket.len() < KADEMLIA_K {
            bucket.push(KademliaPeer {
                node_id: node_id.to_string(),
                addr: addr.to_string(),
                id_hash,
                last_seen: now,
                reputation,
            });
            return true;
        }

        // Bucket full — evict lowest-reputation peer if new one is better
        if let Some((worst_idx, worst_rep)) = bucket.iter().enumerate()
            .min_by(|a, b| a.1.reputation.partial_cmp(&b.1.reputation).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(i, p)| (i, p.reputation))
        {
            if reputation > worst_rep {
                bucket[worst_idx] = KademliaPeer {
                    node_id: node_id.to_string(),
                    addr: addr.to_string(),
                    id_hash,
                    last_seen: now,
                    reputation,
                };
                return true;
            }
        }
        false
    }

    /// Find the K closest peers to a target hash (XOR metric).
    pub fn find_closest(&self, target_hash: &[u8; 32], k: usize) -> Vec<KademliaPeer> {
        let mut all_peers: Vec<(Vec<u8>, KademliaPeer)> = Vec::new();
        for entry in self.buckets.iter() {
            for peer in entry.value().iter() {
                let dist: Vec<u8> = peer.id_hash.iter().zip(target_hash.iter())
                    .map(|(a, b)| a ^ b).collect();
                all_peers.push((dist, peer.clone()));
            }
        }
        all_peers.sort_by(|a, b| a.0.cmp(&b.0));
        all_peers.into_iter().take(k).map(|(_, p)| p).collect()
    }

    /// Get bucket indices that haven't been refreshed recently.
    pub fn stale_buckets(&self, now: u64) -> Vec<usize> {
        let mut stale = Vec::new();
        for entry in self.buckets.iter() {
            let idx = *entry.key();
            let last = self.bucket_last_refresh.get(&idx).map(|v| *v).unwrap_or(0);
            if now.saturating_sub(last) > KADEMLIA_REFRESH_INTERVAL_SECS {
                stale.push(idx);
            }
        }
        stale
    }

    pub fn mark_refreshed(&self, bucket_idx: usize, now: u64) {
        self.bucket_last_refresh.insert(bucket_idx, now);
    }

    pub fn total_peers(&self) -> usize {
        self.buckets.iter().map(|e| e.value().len()).sum()
    }

    pub fn remove(&self, node_id: &str) {
        let id_hash = Self::hash_node_id(node_id);
        let bucket_idx = self.bucket_index_for(&id_hash);
        if let Some(mut bucket) = self.buckets.get_mut(&bucket_idx) {
            bucket.retain(|p| p.node_id != node_id);
        }
    }
}
