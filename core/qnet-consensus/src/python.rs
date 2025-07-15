//! Python bindings for QNet consensus

use pyo3::prelude::*;
use pyo3::exceptions::PyRuntimeError;
use std::sync::Arc;
use tokio::runtime::Runtime;
use std::collections::HashMap;

use crate::{
    ConsensusConfig, CommitRevealConsensus, ConsensusMessage,
    NodeReputation, LeaderSelector, DynamicTiming
};

/// Python wrapper for ConsensusConfig
#[pyclass]
#[derive(Clone)]
pub struct PyConsensusConfig {
    inner: ConsensusConfig,
}

#[pymethods]
impl PyConsensusConfig {
    #[new]
    #[pyo3(signature = (commit_duration_ms=60000, reveal_duration_ms=30000, reputation_threshold=0.7))]
    fn new(
        commit_duration_ms: u64,
        reveal_duration_ms: u64,
        reputation_threshold: f64,
    ) -> Self {
        Self {
            inner: ConsensusConfig {
                commit_duration_ms,
                reveal_duration_ms,
                reputation_threshold,
                participation_weight: 0.4,
                response_time_weight: 0.3,
                block_quality_weight: 0.3,
            },
        }
    }
    
    #[getter]
    fn commit_duration_ms(&self) -> u64 {
        self.inner.commit_duration_ms
    }
    
    #[getter]
    fn reveal_duration_ms(&self) -> u64 {
        self.inner.reveal_duration_ms
    }
    
    #[getter]
    fn reputation_threshold(&self) -> f64 {
        self.inner.reputation_threshold
    }
}

/// Python wrapper for CommitRevealConsensus
#[pyclass]
pub struct PyConsensus {
    inner: Arc<CommitRevealConsensus>,
    runtime: Arc<Runtime>,
}

#[pymethods]
impl PyConsensus {
    #[new]
    fn new(config: PyConsensusConfig) -> PyResult<Self> {
        let runtime = Runtime::new()
            .map_err(|e| PyRuntimeError::new_err(format!("Failed to create runtime: {}", e)))?;
        
        let consensus = CommitRevealConsensus::new(config.inner);
        
        Ok(Self {
            inner: Arc::new(consensus),
            runtime: Arc::new(runtime),
        })
    }
    
    /// Start a new consensus round
    fn start_round(&self, round_number: u64, node_id: String) -> PyResult<()> {
        let consensus = self.inner.clone();
        
        self.runtime.block_on(async move {
            consensus.start_round(round_number, &node_id)
                .await
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to start round: {}", e)))
        })
    }
    
    /// Submit commit
    fn submit_commit(&self, round_number: u64, node_id: String, commit_hash: String) -> PyResult<()> {
        let consensus = self.inner.clone();
        
        self.runtime.block_on(async move {
            consensus.submit_commit(round_number, &node_id, commit_hash)
                .await
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to submit commit: {}", e)))
        })
    }
    
    /// Submit reveal
    fn submit_reveal(&self, round_number: u64, node_id: String, value: String, nonce: String) -> PyResult<()> {
        let consensus = self.inner.clone();
        
        self.runtime.block_on(async move {
            consensus.submit_reveal(round_number, &node_id, value, nonce)
                .await
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to submit reveal: {}", e)))
        })
    }
    
    /// Get consensus result
    fn get_result(&self, round_number: u64) -> PyResult<Option<String>> {
        let consensus = self.inner.clone();
        
        self.runtime.block_on(async move {
            consensus.get_result(round_number)
                .await
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to get result: {}", e)))
        })
    }
    
    /// Check if node can participate
    fn can_participate(&self, node_id: String) -> PyResult<bool> {
        let consensus = self.inner.clone();
        
        self.runtime.block_on(async move {
            Ok(consensus.can_participate(&node_id).await)
        })
    }
    
    /// Get current phase
    fn get_current_phase(&self, round_number: u64) -> PyResult<String> {
        let consensus = self.inner.clone();
        
        self.runtime.block_on(async move {
            let phase = consensus.get_current_phase(round_number).await;
            Ok(format!("{:?}", phase))
        })
    }
}

/// Python wrapper for NodeReputation
#[pyclass]
#[derive(Clone)]
pub struct PyNodeReputation {
    node_id: String,
    score: f64,
    participation_rate: f64,
    success_rate: f64,
    average_response_time: f64,
}

#[pymethods]
impl PyNodeReputation {
    #[new]
    fn new(node_id: String) -> Self {
        Self {
            node_id,
            score: 100.0,  // FIXED: 0-100 scale
            participation_rate: 100.0,  // FIXED: 0-100 scale
            success_rate: 100.0,  // FIXED: 0-100 scale
            average_response_time: 0.0,
        }
    }
    
    #[getter]
    fn node_id(&self) -> String {
        self.node_id.clone()
    }
    
    #[getter]
    fn score(&self) -> f64 {
        self.score
    }
    
    #[getter]
    fn participation_rate(&self) -> f64 {
        self.participation_rate
    }
    
    #[getter]
    fn success_rate(&self) -> f64 {
        self.success_rate
    }
    
    fn update_participation(&mut self, participated: bool) {
        // Simple update logic (0-100 scale)
        if participated {
            self.participation_rate = (self.participation_rate * 0.9) + 10.0;
            self.participation_rate = self.participation_rate.min(100.0);
        } else {
            self.participation_rate *= 0.9;
            self.participation_rate = self.participation_rate.max(0.0);
        }
        self.update_score();
    }
    
    fn update_success(&mut self, successful: bool) {
        // Simple update logic (0-100 scale)
        if successful {
            self.success_rate = (self.success_rate * 0.9) + 10.0;
            self.success_rate = self.success_rate.min(100.0);
        } else {
            self.success_rate *= 0.9;
            self.success_rate = self.success_rate.max(0.0);
        }
        self.update_score();
    }
    
    fn update_score(&mut self) {
        // Combined score calculation (0-100 scale)
        self.score = (self.participation_rate * 0.4) + (self.success_rate * 0.6);
        self.score = self.score.max(0.0).min(100.0);
    }
}

/// Python wrapper for LeaderSelector
#[pyclass]
pub struct PyLeaderSelector {
    runtime: Arc<Runtime>,
}

#[pymethods]
impl PyLeaderSelector {
    #[new]
    fn new() -> PyResult<Self> {
        let runtime = Runtime::new()
            .map_err(|e| PyRuntimeError::new_err(format!("Failed to create runtime: {}", e)))?;
        
        Ok(Self {
            runtime: Arc::new(runtime),
        })
    }
    
    /// Select leader for round
    fn select_leader(&self, round_number: u64, nodes: Vec<PyNodeReputation>) -> PyResult<String> {
        // Convert Python nodes to internal format
        let mut reputations = HashMap::new();
        for node in nodes {
            let rep = NodeReputation {
                score: node.score,
                participation_rate: node.participation_rate,
                success_rate: node.success_rate,
                average_response_time: node.average_response_time,
                last_update: std::time::SystemTime::now(),
            };
            reputations.insert(node.node_id.clone(), rep);
        }
        
        let selector = LeaderSelector::new();
        
        self.runtime.block_on(async move {
            selector.select_leader(round_number, &reputations)
                .await
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to select leader: {}", e)))
        })
    }
}

/// Python wrapper for DynamicTiming
#[pyclass]
pub struct PyDynamicTiming {
    base_commit_duration: u64,
    base_reveal_duration: u64,
}

#[pymethods]
impl PyDynamicTiming {
    #[new]
    fn new(base_commit_duration_ms: u64, base_reveal_duration_ms: u64) -> Self {
        Self {
            base_commit_duration: base_commit_duration_ms,
            base_reveal_duration: base_reveal_duration_ms,
        }
    }
    
    /// Calculate adjusted timing based on network conditions
    fn calculate_timing(&self, network_latency_ms: f64, node_count: usize) -> (u64, u64) {
        let timing = DynamicTiming::new(self.base_commit_duration, self.base_reveal_duration);
        timing.calculate_timing(network_latency_ms, node_count)
    }
}

/// Python module
#[pymodule]
fn qnet_consensus(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add_class::<PyConsensusConfig>()?;
    m.add_class::<PyConsensus>()?;
    m.add_class::<PyNodeReputation>()?;
    m.add_class::<PyLeaderSelector>()?;
    m.add_class::<PyDynamicTiming>()?;
    Ok(())
} 