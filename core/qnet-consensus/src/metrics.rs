//! Metrics collection for consensus

use prometheus::{
    register_counter_vec, register_gauge_vec, register_histogram_vec,
    CounterVec, GaugeVec, HistogramVec,
};
use lazy_static::lazy_static;
use std::sync::{Arc, RwLock};

lazy_static! {
    /// Counter for consensus rounds
    pub static ref CONSENSUS_ROUNDS: CounterVec = register_counter_vec!(
        "qnet_consensus_rounds_total",
        "Total number of consensus rounds",
        &["status"]
    ).unwrap();
    
    /// Counter for commits
    pub static ref CONSENSUS_COMMITS: CounterVec = register_counter_vec!(
        "qnet_consensus_commits_total",
        "Total number of commits received",
        &["result"]
    ).unwrap();
    
    /// Counter for reveals
    pub static ref CONSENSUS_REVEALS: CounterVec = register_counter_vec!(
        "qnet_consensus_reveals_total",
        "Total number of reveals received",
        &["result"]
    ).unwrap();
    
    /// Gauge for current difficulty
    pub static ref CONSENSUS_DIFFICULTY: GaugeVec = register_gauge_vec!(
        "qnet_consensus_difficulty",
        "Current consensus difficulty",
        &["type"]
    ).unwrap();
    
    /// Gauge for active participants
    pub static ref CONSENSUS_PARTICIPANTS: GaugeVec = register_gauge_vec!(
        "qnet_consensus_participants",
        "Number of active participants",
        &["phase"]
    ).unwrap();
    
    /// Histogram for round duration
    pub static ref CONSENSUS_ROUND_DURATION: HistogramVec = register_histogram_vec!(
        "qnet_consensus_round_duration_seconds",
        "Duration of consensus rounds",
        &["phase"],
        vec![10.0, 20.0, 30.0, 45.0, 60.0, 90.0, 120.0, 180.0]
    ).unwrap();
    
    /// Histogram for reputation scores
    pub static ref NODE_REPUTATION_SCORE: HistogramVec = register_histogram_vec!(
        "qnet_node_reputation_score",
        "Distribution of node reputation scores",
        &["category"],
        vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
    ).unwrap();
    
    /// Counter for reputation updates
    pub static ref REPUTATION_UPDATES: CounterVec = register_counter_vec!(
        "qnet_reputation_updates_total",
        "Total number of reputation updates",
        &["type"]
    ).unwrap();
}

/// Metrics data
#[derive(Default)]
pub struct Metrics {
    /// Total rounds
    pub total_rounds: u64,
    /// Successful rounds
    pub successful_rounds: u64,
}

/// Record a successful consensus round
pub fn record_successful_round(duration_secs: f64) {
    CONSENSUS_ROUNDS.with_label_values(&["success"]).inc();
    CONSENSUS_ROUND_DURATION
        .with_label_values(&["complete"])
        .observe(duration_secs);
}

/// Record a failed consensus round
pub fn record_failed_round(duration_secs: f64) {
    CONSENSUS_ROUNDS.with_label_values(&["failed"]).inc();
    CONSENSUS_ROUND_DURATION
        .with_label_values(&["failed"])
        .observe(duration_secs);
}

/// Record a commit
pub fn record_commit(accepted: bool) {
    let label = if accepted { "accepted" } else { "rejected" };
    CONSENSUS_COMMITS.with_label_values(&[label]).inc();
}

/// Record a reveal
pub fn record_reveal(accepted: bool) {
    let label = if accepted { "accepted" } else { "rejected" };
    CONSENSUS_REVEALS.with_label_values(&[label]).inc();
}

/// Update difficulty metric
pub fn update_difficulty(difficulty: f64) {
    CONSENSUS_DIFFICULTY
        .with_label_values(&["current"])
        .set(difficulty);
}

/// Update participant count
pub fn update_participants(phase: &str, count: usize) {
    CONSENSUS_PARTICIPANTS
        .with_label_values(&[phase])
        .set(count as f64);
}

/// Record reputation score
pub fn record_reputation_score(score: f64) {
    NODE_REPUTATION_SCORE
        .with_label_values(&["node"])
        .observe(score);
}

/// Record reputation update
pub fn record_reputation_update(update_type: &str) {
    REPUTATION_UPDATES.with_label_values(&[update_type]).inc();
}

/// Consensus metrics wrapper
pub struct ConsensusMetrics {
    inner: Arc<RwLock<Metrics>>,
}

impl ConsensusMetrics {
    /// Create new metrics
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(Metrics::default())),
        }
    }
} 