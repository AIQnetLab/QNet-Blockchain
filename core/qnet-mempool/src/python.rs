//! Python bindings for QNet mempool

use pyo3::prelude::*;
use pyo3::exceptions::PyValueError;
use std::sync::Arc;

use crate::simple_mempool::{SimpleMempool, SimpleMempoolConfig};

/// Python wrapper for MempoolConfig
#[pyclass(name = "MempoolConfig")]
#[derive(Clone)]
pub struct PyMempoolConfig {
    inner: SimpleMempoolConfig,
}

#[pymethods]
impl PyMempoolConfig {
    #[new]
    #[pyo3(signature = (max_size=500000, min_gas_price=1))]
    fn new(
        max_size: usize,
        min_gas_price: u64,
    ) -> Self {
        Self {
            inner: SimpleMempoolConfig {
                max_size,
                min_gas_price,
            },
        }
    }
    
    #[staticmethod]
    fn default() -> Self {
        Self {
            inner: SimpleMempoolConfig::default(),
        }
    }
}

/// Python wrapper for Mempool
#[pyclass(name = "Mempool")]
pub struct PyMempool {
    inner: Arc<SimpleMempool>,
}

#[pymethods]
impl PyMempool {
    #[new]
    fn new(config: &PyMempoolConfig, _state_db_path: &str) -> PyResult<Self> {
        let mempool = SimpleMempool::new(config.inner.clone());
        
        Ok(Self {
            inner: Arc::new(mempool),
        })
    }
    
    fn add_transaction(&self, tx_json: &str) -> PyResult<String> {
        // Simple validation - just check if it's valid JSON
        let _: serde_json::Value = serde_json::from_str(tx_json)
            .map_err(|e| PyValueError::new_err(format!("Invalid transaction JSON: {}", e)))?;
        
        // Generate a simple hash
        use sha2::{Sha256, Digest};
        let mut hasher = Sha256::new();
        hasher.update(tx_json.as_bytes());
        let hash = hex::encode(hasher.finalize());
        
        // Store in mempool
        if self.inner.add_raw_transaction(tx_json.to_string(), hash.clone()) {
            Ok(hash)
        } else {
            Err(PyValueError::new_err("Failed to add transaction to mempool"))
        }
    }
    
    fn get_transaction(&self, hash: &str) -> Option<String> {
        self.inner.get_raw_transaction(hash)
    }
    
    fn get_pending_transactions(&self, limit: usize) -> Vec<String> {
        self.inner.get_pending_transactions(limit)
    }
    
    fn remove_transaction(&self, hash: &str) -> bool {
        self.inner.remove_transaction(hash)
    }
    
    fn size(&self) -> usize {
        self.inner.size()
    }
    
    fn clear(&self) {
        self.inner.clear()
    }
    
    fn validate(&self, tx_json: &str) -> PyResult<bool> {
        // Simple validation
        match serde_json::from_str::<serde_json::Value>(tx_json) {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    }
}

/// Python module
#[pymodule]
fn qnet_mempool(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add_class::<PyMempoolConfig>()?;
    m.add_class::<PyMempool>()?;
    Ok(())
} 