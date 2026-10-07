//! What the proof views' snapshots pin, estimated from the writes themselves. A RocksDB snapshot
//! keeps the version of every row it saw once that row is overwritten or deleted, and compaction
//! stores those versions in the same files as the live rows, so no RocksDB property tells them
//! apart. Each derived DB's writer therefore feeds every row key it writes into HyperLogLog
//! sketches: one per family for the live set, and one per stripe, the rows written between one
//! capture and the next. A snapshot taken at seq s pins one version of each distinct row changed
//! after s up to the next held snapshot, so the union of the stripes in between, times the rows'
//! average size, bounds what it holds.

use std::collections::BTreeMap;

const HLL_BITS: u32 = 12;
const HLL_REGS: usize = 1 << HLL_BITS;
/// Stripes kept per DB: enough for every held capture plus the dropped ones between them.
const STRIPES_MAX: usize = 64;
/// The value size a delete is charged with: the version it leaves pinned, not its tombstone.
pub(crate) const PINNED_VALUE_BYTES: usize = 32;

/// A HyperLogLog cardinality sketch over 2^12 registers: about 1.6% standard error, 4 KB.
#[derive(Clone)]
struct Hll {
    regs: Box<[u8]>,
}

impl Default for Hll {
    fn default() -> Self {
        Self { regs: vec![0u8; HLL_REGS].into_boxed_slice() }
    }
}

/// 64-bit mix of a row key. Tree node keys share long zero runs, so the bytes are folded and
/// finalized rather than used as they are.
fn mix(key: &[u8]) -> u64 {
    let mut h: u64 = 0x9E37_79B9_7F4A_7C15 ^ key.len() as u64;
    for chunk in key.chunks(8) {
        let mut b = [0u8; 8];
        b[..chunk.len()].copy_from_slice(chunk);
        h = (h ^ u64::from_le_bytes(b)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        h ^= h >> 31;
    }
    h ^= h >> 30;
    h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 27;
    h = h.wrapping_mul(0x94D0_49BB_1331_11EB);
    h ^ (h >> 31)
}

impl Hll {
    #[cfg(test)]
    fn add(&mut self, key: &[u8]) {
        self.add_hash(mix(key));
    }

    fn add_hash(&mut self, h: u64) {
        let idx = (h >> (64 - HLL_BITS)) as usize;
        let rank = ((h << HLL_BITS) | (1u64 << (HLL_BITS - 1))).leading_zeros() as u8 + 1;
        if self.regs[idx] < rank {
            self.regs[idx] = rank;
        }
    }

    fn merge(&mut self, other: &Hll) {
        for (a, b) in self.regs.iter_mut().zip(other.regs.iter()) {
            if *b > *a { *a = *b; }
        }
    }

    fn count(&self) -> f64 {
        let m = HLL_REGS as f64;
        let mut sum = 0.0f64;
        let mut zeros = 0usize;
        for r in self.regs.iter() {
            sum += 2f64.powi(-(*r as i32));
            if *r == 0 { zeros += 1; }
        }
        let estimate = 0.7213 / (1.0 + 1.079 / m) * m * m / sum;
        if estimate <= 2.5 * m && zeros > 0 {
            m * (m / zeros as f64).ln()
        } else {
            estimate
        }
    }
}

/// Distinct rows with the bytes written for them.
#[derive(Clone, Default)]
struct Tally {
    hll: Hll,
    rows: u64,
    bytes: u64,
}

impl Tally {
    fn add(&mut self, hash: u64, bytes: usize) {
        self.hll.add_hash(hash);
        self.rows += 1;
        self.bytes += bytes as u64;
    }

    /// Distinct rows times the average bytes written per row.
    fn bytes_estimate(&self) -> u64 {
        if self.rows == 0 { return 0; }
        (self.hll.count() * (self.bytes as f64 / self.rows as f64)) as u64
    }
}

#[derive(Default)]
struct Inner {
    /// Per family, every row put since its last wipe: the live set.
    live: Vec<Tally>,
    /// From each capture's seq: the rows changed after it, until the next capture.
    stripes: BTreeMap<u64, Tally>,
}

/// One derived DB's sketch, fed by its single writer thread and read by the views worker.
pub(crate) struct RowSketch {
    inner: parking_lot::Mutex<Inner>,
}

/// A batch of rows as its writer reports them: puts carry their full size, deletes pin the
/// version they replace.
pub(crate) struct RowBatch<'a> {
    guard: parking_lot::MutexGuard<'a, Inner>,
}

impl RowBatch<'_> {
    pub(crate) fn put(&mut self, family: usize, key: &[u8], value_len: usize) {
        let (h, bytes) = (mix(key), key.len() + value_len);
        let g = &mut *self.guard;
        g.live[family].add(h, bytes);
        if let Some((_, s)) = g.stripes.iter_mut().next_back() {
            s.add(h, bytes);
        }
    }

    pub(crate) fn delete(&mut self, key: &[u8]) {
        if let Some((_, s)) = self.guard.stripes.iter_mut().next_back() {
            s.add(mix(key), key.len() + PINNED_VALUE_BYTES);
        }
    }

    /// Every row of `family` was deleted: its live set starts over.
    pub(crate) fn wipe_family(&mut self, family: usize) {
        self.guard.live[family] = Tally::default();
    }
}

impl RowSketch {
    pub(crate) fn new(families: usize) -> Self {
        Self { inner: parking_lot::Mutex::new(Inner { live: vec![Tally::default(); families], stripes: BTreeMap::new() }) }
    }

    /// The writer's batch: rows noted through it land in the live set and the open stripe.
    pub(crate) fn batch(&self) -> RowBatch<'_> {
        RowBatch { guard: self.inner.lock() }
    }

    /// A capture at `seq` was taken on the writer thread: rows written from now on are changes
    /// after it.
    pub(crate) fn start_stripe(&self, seq: u64) {
        let mut g = self.inner.lock();
        g.stripes.entry(seq).or_default();
        while g.stripes.len() > STRIPES_MAX {
            g.stripes.pop_first();
        }
    }

    /// (live bytes, bytes the snapshots taken at `held` seqs pin). Stripes older than the oldest
    /// held seq are dropped: no held snapshot can pin what they describe.
    pub(crate) fn estimate(&self, held: &[u64]) -> (u64, u64) {
        let mut held: Vec<u64> = held.to_vec();
        held.sort_unstable();
        held.dedup();
        let mut g = self.inner.lock();
        if let Some(&oldest) = held.first() {
            let keep = g.stripes.split_off(&oldest);
            g.stripes = keep;
        }
        let live: u64 = g.live.iter().map(Tally::bytes_estimate).sum();
        let mut pinned = 0u64;
        for (i, &h) in held.iter().enumerate() {
            let next = held.get(i + 1).copied().unwrap_or(u64::MAX);
            let mut union = Tally::default();
            for (_, s) in g.stripes.range(h..next) {
                union.hll.merge(&s.hll);
                union.rows += s.rows;
                union.bytes += s.bytes;
            }
            pinned += union.bytes_estimate();
        }
        (live, pinned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(i: u64) -> [u8; 36] {
        let mut k = [0u8; 36];
        k[..4].copy_from_slice(&((i % 7) as u32).to_be_bytes());
        k[28..].copy_from_slice(&(i / 7).to_be_bytes());
        k
    }

    #[test]
    fn hll_counts_distinct_rows_within_its_error() {
        for n in [100u64, 10_000, 1_000_000] {
            let mut h = Hll::default();
            for i in 0..n {
                h.add(&key(i));
                h.add(&key(i)); // repeats do not count
            }
            let err = (h.count() - n as f64).abs() / n as f64;
            assert!(err < 0.05, "n={} counted {:.0}", n, h.count());
        }
    }

    // A snapshot pins one version of each row changed after it up to the next held snapshot: rows
    // rewritten many times count once, stripes of captures no longer held merge into the held one
    // before them, and a wipe starts the live set over.
    #[test]
    fn stripes_attribute_changed_rows_to_the_snapshot_before_them() {
        let s = RowSketch::new(2);
        {
            let mut b = s.batch();
            for i in 0..10_000 { b.put(0, &key(i), 32); }
        }
        s.start_stripe(10);
        for _ in 0..5 {
            let mut b = s.batch();
            for i in 0..2_000 { b.put(0, &key(i), 32); }
        }
        s.start_stripe(20);
        {
            let mut b = s.batch();
            for i in 5_000..6_000 { b.put(0, &key(i), 32); }
            for i in 9_000..9_500 { b.delete(&key(i)); }
        }
        let row = 36.0 + 32.0;
        let near = |got: u64, want: f64| (got as f64 - want).abs() / want < 0.06;
        let (live, pinned) = s.estimate(&[10, 20]);
        assert!(near(live, 10_000.0 * row), "live {}", live);
        assert!(near(pinned, 2_000.0 * row + 1_500.0 * row), "pinned {}", pinned);
        // The capture at 20 was dropped: its stripe belongs to the snapshot at 10.
        let (_, pinned) = s.estimate(&[10]);
        assert!(near(pinned, 3_500.0 * row), "merged {}", pinned);
        assert_eq!(s.estimate(&[]).1, 0, "no snapshot pins nothing");
        s.batch().wipe_family(0);
        assert_eq!(s.estimate(&[]).0, 0, "a wiped family has no live rows");
    }
}
