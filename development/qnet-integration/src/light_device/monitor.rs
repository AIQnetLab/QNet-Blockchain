//! The cross-owner monitor of the light eligibility bitmaps (A16, plan RF-7): every bit that exactly one of
//! a shard's three owners set is logged, and an alert is raised when there are more than a few. Each owner
//! sees every reply of the shard (the replies are gossiped between them), so a node one owner credited and no
//! other owner saw is a lagging owner or one that credits nodes nobody else heard from.
//!
//! Local and read-only: it reads the committed rows (`light_bm_`) and this genesis's own attestations, and
//! writes nothing. Phase B (on-chain device commitments) is what would let validators refuse such bits.

/// One owner's view of a shard's epoch: its committed row, or - for this genesis when it committed none (it
/// stood down while the primary was healthy) - the set its own attestations make.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerView {
    /// The owner's genesis index (0..5).
    pub owner: usize,
    pub bits: Vec<u8>,
    /// A committed row (the chain's), not this genesis's own view.
    pub committed: bool,
}

/// What one owner set alone in one shard's epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SingleOwner {
    pub owner: usize,
    pub committed: bool,
    pub count: u64,
    /// The first roster indices, for the log.
    pub sample: Vec<u32>,
}

const SAMPLE: usize = 8;

/// Per owner, the bits set in its view and in no other view. Fewer than two views compare nothing.
pub fn single_owner_bits(views: &[OwnerView]) -> Vec<SingleOwner> {
    if views.len() < 2 { return Vec::new(); }
    let mut out = Vec::new();
    for (i, v) in views.iter().enumerate() {
        let mut found = SingleOwner { owner: v.owner, committed: v.committed, count: 0, sample: Vec::new() };
        for (byte, b) in v.bits.iter().enumerate() {
            let others = views.iter().enumerate().filter(|(j, _)| *j != i)
                .fold(0u8, |acc, (_, o)| acc | o.bits.get(byte).copied().unwrap_or(0));
            let alone = b & !others;
            if alone == 0 { continue; }
            found.count += alone.count_ones() as u64;
            for bit in 0..8u32 {
                if alone & (1 << bit) != 0 && found.sample.len() < SAMPLE { found.sample.push(byte as u32 * 8 + bit); }
            }
        }
        if found.count > 0 { out.push(found); }
    }
    out
}

/// The bits any view set.
pub fn union_count(views: &[OwnerView]) -> u64 {
    let len = views.iter().map(|v| v.bits.len()).max().unwrap_or(0);
    (0..len).map(|i| views.iter().fold(0u8, |acc, v| acc | v.bits.get(i).copied().unwrap_or(0)).count_ones() as u64).sum()
}

/// More bits set by one owner alone than this raise an alert: gossip at the epoch's edge leaves a few.
pub fn alert_threshold(union: u64) -> u64 {
    (union / 100).max(16)
}

/// What one shard's epoch showed: the owners' alone-set bits and how many bits any of them set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShardFinding {
    pub shard: usize,
    pub union: u64,
    pub single: Vec<SingleOwner>,
}

/// Compare, for each shard the genesis `own` owns, the rows its owners committed for `epoch` - and, where
/// `own` committed none, the set its own attestations make (`eligible`, the node ids it credited; read
/// only when needed, and left out when empty, since a restart may have lost it). Reads only.
pub fn check_epoch(storage: &crate::storage::Storage, own: usize, epoch: u64, eligible: impl FnOnce() -> Vec<String>)
    -> Vec<ShardFinding>
{
    let owned: Vec<usize> = (0..5usize).filter(|sh| crate::node::light_owner_rank(*sh, own).is_some()).collect();
    let rows: Vec<(usize, Vec<(usize, Vec<u8>)>)> =
        owned.iter().map(|sh| (*sh, storage.load_light_bitmaps_by_owner(epoch, *sh))).collect();
    if rows.iter().all(|(_, r)| r.is_empty()) { return Vec::new(); }
    let need_own: Vec<usize> = rows.iter().filter(|(_, r)| !r.is_empty() && !r.iter().any(|(o, _)| *o == own))
        .map(|(sh, _)| *sh).collect();
    let mut own_view: std::collections::HashMap<usize, Vec<u32>> = std::collections::HashMap::new();
    if !need_own.is_empty() {
        let credited: std::collections::HashSet<String> = eligible().into_iter().collect();
        if !credited.is_empty() {
            let _ = storage.light_roster_for_each(crate::node::light_roster_cutoff(epoch), |id, _, idx| {
                let sh = crate::node::light_shard_of(id);
                if need_own.contains(&sh) && credited.contains(id) { own_view.entry(sh).or_default().push(idx); }
            });
        }
    }
    let mut out = Vec::new();
    for (shard, committed) in rows {
        let mut views: Vec<OwnerView> = committed.into_iter().map(|(owner, bits)| OwnerView { owner, bits, committed: true }).collect();
        if !views.iter().any(|v| v.owner == own) {
            if let Some(ix) = own_view.remove(&shard) { views.push(OwnerView { owner: own, bits: bits_of(ix), committed: false }); }
        }
        if views.len() < 2 { continue; }
        out.push(ShardFinding { shard, union: union_count(&views), single: single_owner_bits(&views) });
    }
    out
}

/// A bitmap with the bits of `indices` set.
pub fn bits_of(indices: impl IntoIterator<Item = u32>) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    for i in indices {
        let byte = i as usize / 8;
        if out.len() <= byte { out.resize(byte + 1, 0); }
        out[byte] |= 1 << (i % 8);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bit_one_owner_set_alone_is_named_with_its_owner() {
        let primary = OwnerView { owner: 1, bits: bits_of([0, 3, 9, 40]), committed: true };
        let backup = OwnerView { owner: 2, bits: bits_of([0, 3, 9]), committed: false };
        let found = single_owner_bits(&[primary.clone(), backup.clone()]);
        assert_eq!(found, vec![SingleOwner { owner: 1, committed: true, count: 1, sample: vec![40] }]);
        // The other way round: this genesis saw a reply the committed row left out (a lagging committer).
        let seen = OwnerView { owner: 2, bits: bits_of([0, 3, 9, 12]), committed: false };
        let found = single_owner_bits(&[OwnerView { bits: bits_of([0, 3, 9]), ..primary.clone() }, seen]);
        assert_eq!(found, vec![SingleOwner { owner: 2, committed: false, count: 1, sample: vec![12] }]);
        // Three owners: a bit two of them set is no divergence.
        let third = OwnerView { owner: 3, bits: bits_of([40]), committed: true };
        assert!(single_owner_bits(&[primary.clone(), backup.clone(), third]).is_empty());
        // One view compares nothing; agreeing views give nothing.
        assert!(single_owner_bits(&[primary.clone()]).is_empty());
        assert!(single_owner_bits(&[backup.clone(), OwnerView { owner: 1, ..backup.clone() }]).is_empty());
        assert_eq!(union_count(&[primary, backup]), 4);
        assert_eq!((alert_threshold(0), alert_threshold(10_000)), (16, 100));
        let many = OwnerView { owner: 0, bits: bits_of(0..100), committed: true };
        let s = single_owner_bits(&[many, OwnerView { owner: 1, bits: vec![], committed: true }]);
        assert_eq!((s[0].count, s[0].sample.len()), (100, 8), "counted in full, sampled for the log");
    }

    #[test]
    fn a_backup_owner_compares_the_committed_row_with_its_own_attestations() {
        let dir = tempfile::TempDir::new().unwrap();
        let s = crate::storage::Storage::new(dir.path().to_str().unwrap()).unwrap();
        for (i, n) in ["light_mobile_aa", "light_mobile_bb", "light_mobile_cc"].iter().enumerate() {
            s.save_node_registration_at_height_burn(n, "light", &format!("w{}", i), 70.0, 10 + i as u64, "burn").unwrap();
        }
        let mut idx = 0u32;
        s.light_roster_for_each(u64::MAX, |id, _, i| if id == "light_mobile_aa" { idx = i }).unwrap();
        let shard = crate::node::light_shard_of("light_mobile_aa");
        let [primary, backup, _] = crate::node::light_shard_owners(shard);
        // Nothing committed for the epoch: nothing to compare, and the own view is never read.
        assert!(check_epoch(&s, backup, 3, || panic!("not needed")).is_empty());
        // The primary committed the node plus a bit nobody else saw; the backup credited the node only.
        s.save_light_bitmap_from(3, shard, primary, 3 * 14_400 + 14_300, &bits_of([idx, 60])).unwrap();
        let found = check_epoch(&s, backup, 3, || vec!["light_mobile_aa".to_string()]);
        let f = found.iter().find(|f| f.shard == shard).expect("the shard");
        assert_eq!(f.single, vec![SingleOwner { owner: primary, committed: true, count: 1, sample: vec![60] }]);
        assert_eq!(f.union, 2);
        // An empty own view (a restart lost it) compares nothing rather than flag every committed bit.
        assert!(check_epoch(&s, backup, 3, Vec::new).iter().all(|f| f.shard != shard));
        // Two committed rows that agree: nothing alone.
        s.save_light_bitmap_from(3, shard, backup, 3 * 14_400 + 14_350, &bits_of([idx, 60])).unwrap();
        let found = check_epoch(&s, backup, 3, || panic!("the backup committed its own row"));
        assert!(found.iter().filter(|f| f.shard == shard).all(|f| f.single.is_empty()));
    }
}
