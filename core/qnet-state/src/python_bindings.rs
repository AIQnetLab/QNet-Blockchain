//! Python bindings for QNet state management

use pyo3::prelude::*;
use pyo3::exceptions::{PyValueError, PyRuntimeError};
use std::sync::Arc;
use tokio::runtime::Runtime;

use crate::{
    StateDB, Account, Transaction, TransactionType, Block,
    ConsensusProof
};

/// Python wrapper for StateDB
#[pyclass]
pub struct PyStateDB {
    inner: Arc<StateDB>,
    runtime: Arc<Runtime>,
}

#[pymethods]
impl PyStateDB {
    /// Create new StateDB instance
    #[new]
    #[pyo3(signature = (path, cache_size=None))]
    fn new(path: String, cache_size: Option<usize>) -> PyResult<Self> {
        let runtime = Runtime::new()
            .map_err(|e| PyRuntimeError::new_err(format!("Failed to create runtime: {}", e)))?;
        
        let db = runtime.block_on(async {
            StateDB::new(&path, cache_size)
                .await
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to create StateDB: {}", e)))
        })?;
        
        Ok(Self {
            inner: Arc::new(db),
            runtime: Arc::new(runtime),
        })
    }
    
    /// Get account by address
    fn get_account(&self, address: &str) -> PyResult<Option<PyAccount>> {
        let db = self.inner.clone();
        let address = address.to_string();
        
        self.runtime.block_on(async move {
            match db.get_account(&address).await {
                Ok(Some(account)) => Ok(Some(PyAccount { inner: account })),
                Ok(None) => Ok(None),
                Err(e) => Err(PyRuntimeError::new_err(format!("Failed to get account: {}", e))),
            }
        })
    }
    
    /// Get account balance
    fn get_balance(&self, address: &str) -> PyResult<u64> {
        let db = self.inner.clone();
        let address = address.to_string();
        
        self.runtime.block_on(async move {
            db.get_balance(&address)
                .await
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to get balance: {}", e)))
        })
    }
    
    /// Get block by height
    fn get_block(&self, height: u64) -> PyResult<Option<PyBlock>> {
        let db = self.inner.clone();
        
        self.runtime.block_on(async move {
            match db.get_block(height).await {
                Ok(Some(block)) => Ok(Some(PyBlock { inner: block })),
                Ok(None) => Ok(None),
                Err(e) => Err(PyRuntimeError::new_err(format!("Failed to get block: {}", e))),
            }
        })
    }
    
    /// Get latest block
    fn get_latest_block(&self) -> PyResult<Option<PyBlock>> {
        let db = self.inner.clone();
        
        self.runtime.block_on(async move {
            match db.get_latest_block().await {
                Ok(Some(block)) => Ok(Some(PyBlock { inner: block })),
                Ok(None) => Ok(None),
                Err(e) => Err(PyRuntimeError::new_err(format!("Failed to get latest block: {}", e))),
            }
        })
    }
    
    /// Execute transaction
    fn execute_transaction(&self, py_tx: &PyTransaction) -> PyResult<String> {
        let db = self.inner.clone();
        let tx = py_tx.inner.clone();
        
        self.runtime.block_on(async move {
            db.execute_transaction(tx)
                .await
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to execute transaction: {}", e)))
        })
    }
    
    /// Process block
    fn process_block(&self, py_block: &PyBlock) -> PyResult<()> {
        let db = self.inner.clone();
        let block = py_block.inner.clone();
        
        self.runtime.block_on(async move {
            db.process_block(block)
                .await
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to process block: {}", e)))
        })
    }
    
    /// Get state root
    fn get_state_root(&self) -> PyResult<String> {
        let db = self.inner.clone();
        
        self.runtime.block_on(async move {
            db.get_state_root()
                .await
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to get state root: {}", e)))
        })
    }
}

/// Python wrapper for Account
#[pyclass]
#[derive(Clone)]
pub struct PyAccount {
    inner: Account,
}

#[pymethods]
impl PyAccount {
    #[getter]
    fn address(&self) -> String {
        self.inner.address.clone()
    }
    
    #[getter]
    fn balance(&self) -> u64 {
        self.inner.balance
    }
    
    #[getter]
    fn nonce(&self) -> u64 {
        self.inner.nonce
    }
    
    #[getter]
    fn is_node(&self) -> bool {
        self.inner.is_node
    }
    
    #[getter]
    fn node_type(&self) -> Option<String> {
        self.inner.node_type.clone()
    }
    
    #[getter]
    fn stake(&self) -> u64 {
        self.inner.stake
    }
    
    #[getter]
    fn reputation(&self) -> f64 {
        self.inner.reputation
    }
    
    fn __repr__(&self) -> String {
        format!(
            "Account(address='{}', balance={}, nonce={}, is_node={})",
            self.inner.address, self.inner.balance, self.inner.nonce, self.inner.is_node
        )
    }
}

/// Python wrapper for Transaction
#[pyclass]
#[derive(Clone)]
pub struct PyTransaction {
    inner: Transaction,
}

#[pymethods]
impl PyTransaction {
    /// Create new transfer transaction
    #[staticmethod]
    fn transfer(from: String, to: String, amount: u64, nonce: u64, gas_price: u64, gas_limit: u64) -> Self {
        let mut tx = Transaction {
            hash: String::new(),
            from,
            to: Some(to),
            amount,
            nonce,
            gas_price,
            gas_limit,
            timestamp: chrono::Utc::now().timestamp_millis() as u64,
            signature: None,
            tx_type: TransactionType::Transfer,
            data: None,
        };
        tx.hash = tx.calculate_hash();
        Self { inner: tx }
    }
    
    /// Create node activation transaction
    #[staticmethod]
    fn node_activation(from: String, node_type: String, amount: u64, nonce: u64, gas_price: u64, gas_limit: u64) -> Self {
        let mut tx = Transaction {
            hash: String::new(),
            from,
            to: None,
            amount,
            nonce,
            gas_price,
            gas_limit,
            timestamp: chrono::Utc::now().timestamp_millis() as u64,
            signature: None,
            tx_type: TransactionType::NodeActivation,
            data: Some(serde_json::json!({ "node_type": node_type }).to_string()),
        };
        tx.hash = tx.calculate_hash();
        Self { inner: tx }
    }
    
    #[getter]
    fn from_address(&self) -> String {
        self.inner.from.clone()
    }
    
    #[getter]
    fn to_address(&self) -> Option<String> {
        self.inner.to.clone()
    }
    
    #[getter]
    fn amount(&self) -> u64 {
        self.inner.amount
    }
    
    #[getter]
    fn nonce(&self) -> u64 {
        self.inner.nonce
    }
    
    #[getter]
    fn gas_price(&self) -> u64 {
        self.inner.gas_price
    }
    
    #[getter]
    fn gas_limit(&self) -> u64 {
        self.inner.gas_limit
    }
    
    #[getter]
    fn timestamp(&self) -> u64 {
        self.inner.timestamp
    }
    
    #[getter]
    fn tx_type(&self) -> String {
        match self.inner.tx_type {
            TransactionType::Transfer => "transfer".to_string(),
            TransactionType::NodeActivation => "node_activation".to_string(),
            TransactionType::ContractDeploy => "contract_deploy".to_string(),
            TransactionType::ContractCall => "contract_call".to_string(),
            TransactionType::RewardDistribution => "reward_distribution".to_string(),
        }
    }
    
    #[setter]
    fn set_signature(&mut self, signature: String) {
        self.inner.signature = Some(signature);
    }
    
    fn hash(&self) -> PyResult<String> {
        Ok(self.inner.hash.clone())
    }
}

/// Python wrapper for Block
#[pyclass]
#[derive(Clone)]
pub struct PyBlock {
    inner: Block,
}

#[pymethods]
impl PyBlock {
    /// Create new block
    #[new]
    fn new(
        height: u64,
        previous_hash: String,
        transactions: Vec<PyTransaction>,
        validator: String,
    ) -> Self {
        let txs = transactions.into_iter().map(|tx| tx.inner).collect();
        
        Self {
            inner: Block {
                height,
                timestamp: chrono::Utc::now().timestamp_millis() as u64,
                previous_hash,
                transactions: txs,
                state_root: String::new(),
                validator,
                consensus_proof: ConsensusProof {
                    round: 0,
                    commits: vec![],
                    reveals: vec![],
                },
            }
        }
    }
    
    #[getter]
    fn height(&self) -> u64 {
        self.inner.height
    }
    
    #[getter]
    fn timestamp(&self) -> u64 {
        self.inner.timestamp
    }
    
    #[getter]
    fn previous_hash(&self) -> String {
        self.inner.previous_hash.clone()
    }
    
    #[getter]
    fn state_root(&self) -> String {
        self.inner.state_root.clone()
    }
    
    #[getter]
    fn validator(&self) -> String {
        self.inner.validator.clone()
    }
    
    #[getter]
    fn transactions(&self) -> Vec<PyTransaction> {
        self.inner.transactions.iter()
            .map(|tx| PyTransaction { inner: tx.clone() })
            .collect()
    }
    
    fn hash(&self) -> PyResult<String> {
        match self.inner.hash() {
            Ok(hash_bytes) => Ok(hex::encode(hash_bytes)),
            Err(e) => Err(PyValueError::new_err(format!("Failed to compute hash: {}", e)))
        }
    }
}

/// Python module
#[pymodule]
fn qnet_state(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add_class::<PyStateDB>()?;
    m.add_class::<PyAccount>()?;
    m.add_class::<PyTransaction>()?;
    m.add_class::<PyBlock>()?;
    Ok(())
} 