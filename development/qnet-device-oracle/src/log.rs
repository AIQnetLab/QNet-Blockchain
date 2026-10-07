//! Two-tier logs: `[LEVEL][SUBSYSTEM] event key=value`. Level from QNET_LOG_LEVEL (0 off .. 5 trace,
//! default 3). Request bodies, vendor tokens and IP addresses are never logged at any level.

use std::sync::atomic::{AtomicU64, Ordering};

pub static LOG_LEVEL: AtomicU64 = AtomicU64::new(3);

pub fn init() {
    let level = std::env::var("QNET_LOG_LEVEL")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(3);
    LOG_LEVEL.store(level.min(5), Ordering::Relaxed);
}

#[inline(always)]
pub fn lvl() -> u64 {
    LOG_LEVEL.load(Ordering::Relaxed)
}
#[inline(always)]
pub fn is_err() -> bool {
    lvl() >= 1
}
#[inline(always)]
pub fn is_warn() -> bool {
    lvl() >= 2
}
#[inline(always)]
pub fn is_info() -> bool {
    lvl() >= 3
}
#[inline(always)]
pub fn is_debug() -> bool {
    lvl() >= 4
}
