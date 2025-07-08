//! Macro consensus types

use std::collections::HashMap;

/// Result type for macro consensus
pub struct MacroConsensusResult {
    /// Commits from validators
    pub commits: HashMap<String, Vec<u8>>,
    /// Reveals from validators
    pub reveals: HashMap<String, Vec<u8>>,
    /// Selected leader for next round
    pub next_leader: String,
} 