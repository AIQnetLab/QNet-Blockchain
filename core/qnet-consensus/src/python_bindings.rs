//! Python bindings for QNet consensus

use pyo3::prelude::*;
use pyo3::types::PyDict;
use std::sync::Arc;
use std::time::Duration;

use crate::{
    CommitRevealConsensus, NodeReputation, ReputationConsensusManager,
    ConsensusConfig, ReputationConfig, ConsensusPhase, RoundStatus,
};

/// Python wrapper for ConsensusConfig
#[pyclass]
struct PyConsensusConfig {
    inner: ConsensusConfig,
}

#[pymethods]
impl PyConsensusConfig {
    #[new]
    fn new() -> Self {
        Self {
            inner: ConsensusConfig::default(),
        }
    }
    
    #[getter]
    fn commit_window(&self) -> u64 {
        self.inner.commit_window.as_secs()
    }
    
    #[setter]
    fn set_commit_window(&mut self, seconds: u64) {
        self.inner.commit_window = Duration::from_secs(seconds);
    }
    
    #[getter]
    fn reveal_window(&self) -> u64 {
        self.inner.reveal_window.as_secs()
    }
    
    #[setter]
    fn set_reveal_window(&mut self, seconds: u64) {
        self.inner.reveal_window = Duration::from_secs(seconds);
    }
    
    #[getter]
    fn min_reveals_ratio(&self) -> f64 {
        self.inner.min_reveals_ratio
    }
    
    #[setter]
    fn set_min_reveals_ratio(&mut self, ratio: f64) {
        self.inner.min_reveals_ratio = ratio;
    }
}

/// Python wrapper for CommitRevealConsensus
#[pyclass]
struct PyCommitRevealConsensus {
    inner: Arc<CommitRevealConsensus>,
}

#[pymethods]
impl PyCommitRevealConsensus {
    #[new]
    fn new(config: Option<&PyConsensusConfig>) -> Self {
        let config = config
            .map(|c| c.inner.clone())
            .unwrap_or_default();
        
        Self {
            inner: Arc::new(CommitRevealConsensus::new(config)),
        }
    }
    
    fn start_new_round(&self, round_number: u64) -> PyResult<PyObject> {
        let round_state = self.inner.start_new_round(round_number)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(e.to_string()))?;
        
        Python::with_gil(|py| {
            let dict = PyDict::new(py);
            dict.set_item("round_number", round_state.round_number)?;
            dict.set_item("phase", format!("{:?}", round_state.phase))?;
            dict.set_item("status", format!("{:?}", round_state.status))?;
            dict.set_item("difficulty", round_state.difficulty)?;
            Ok(dict.into())
        })
    }
    
    fn submit_commit(&self, node_id: &str, commit_hash: &str, signature: &str) -> PyResult<bool> {
        match self.inner.submit_commit(node_id, commit_hash, signature) {
            Ok(()) => Ok(true),
            Err(e) => {
                // Log error but return false instead of raising exception
                // This matches Python behavior
                Ok(false)
            }
        }
    }
    
    fn submit_reveal(&self, node_id: &str, value: &str, nonce: &str) -> PyResult<bool> {
        match self.inner.submit_reveal(node_id, value, nonce) {
            Ok(()) => Ok(true),
            Err(e) => Ok(false),
        }
    }
    
    fn determine_leader(&self, eligible_nodes: Vec<String>, random_beacon: &str) -> PyResult<Option<String>> {
        self.inner.determine_leader(&eligible_nodes, random_beacon)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(e.to_string()))
    }
    
    fn get_round_state(&self) -> PyResult<PyObject> {
        let round_state = self.inner.get_round_state();
        
        Python::with_gil(|py| {
            let dict = PyDict::new(py);
            dict.set_item("round_number", round_state.round_number)?;
            dict.set_item("phase", format!("{:?}", round_state.phase))?;
            dict.set_item("status", format!("{:?}", round_state.status))?;
            dict.set_item("difficulty", round_state.difficulty)?;
            dict.set_item("round_winner", round_state.round_winner)?;
            dict.set_item("winning_value", round_state.winning_value)?;
            
            // Add commit and reveal counts
            dict.set_item("commit_count", round_state.commits.len())?;
            dict.set_item("reveal_count", round_state.reveals.len())?;
            
            Ok(dict.into())
        })
    }
    
    fn generate_commit(&self, node_id: &str) -> PyResult<(String, String, String)> {
        Ok(self.inner.generate_commit(node_id))
    }
}

/// Python wrapper for NodeReputation
#[pyclass]
struct PyNodeReputation {
    inner: Arc<NodeReputation>,
}

#[pymethods]
impl PyNodeReputation {
    #[new]
    fn new(own_address: String) -> Self {
        let config = ReputationConfig::default();
        Self {
            inner: Arc::new(NodeReputation::new(own_address, config)),
        }
    }
    
    fn add_node(&self, node_address: &str) {
        self.inner.add_node(node_address);
    }
    
    fn record_participation(&self, node_address: &str, participated: bool) {
        self.inner.record_participation(node_address, participated);
    }
    
    fn record_response_time(&self, node_address: &str, response_time: f64) {
        self.inner.record_response_time(node_address, response_time);
    }
    
    fn record_block_quality(&self, node_address: &str, quality_score: f64) {
        self.inner.record_block_quality(node_address, quality_score);
    }
    
    fn get_reputation(&self, node_address: &str) -> f64 {
        self.inner.get_reputation(node_address)
    }
    
    fn get_all_reputations(&self) -> PyResult<PyObject> {
        let reputations = self.inner.get_all_reputations();
        
        Python::with_gil(|py| {
            let dict = PyDict::new(py);
            for (node, score) in reputations {
                dict.set_item(node, score)?;
            }
            Ok(dict.into())
        })
    }
    
    fn apply_penalty(&self, node_address: &str, reason: &str, severity: f64) {
        self.inner.apply_penalty(node_address, reason, severity);
    }
    
    fn apply_reward(&self, node_address: &str, reason: &str, magnitude: f64) {
        self.inner.apply_reward(node_address, reason, magnitude);
    }
}

/// Python module definition
#[pymodule]
fn qnet_consensus_rust(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add_class::<PyConsensusConfig>()?;
    m.add_class::<PyCommitRevealConsensus>()?;
    m.add_class::<PyNodeReputation>()?;
    Ok(())
} 