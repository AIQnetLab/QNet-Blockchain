//! Mempool metrics

use prometheus::{
    register_counter_vec, register_gauge_vec, register_histogram_vec,
    CounterVec, GaugeVec, HistogramVec,
};
use lazy_static::lazy_static;

lazy_static! {
    /// Transaction operations counter
    pub static ref TX_OPS: CounterVec = register_counter_vec!(
        "qnet_mempool_tx_operations_total",
        "Total number of transaction operations",
        &["operation", "result"]
    ).unwrap();
    
    /// Current mempool size
    pub static ref MEMPOOL_SIZE: GaugeVec = register_gauge_vec!(
        "qnet_mempool_size",
        "Current mempool size",
        &["type"]
    ).unwrap();
    
    /// Gas price distribution
    pub static ref GAS_PRICE_HISTOGRAM: HistogramVec = register_histogram_vec!(
        "qnet_mempool_gas_price",
        "Gas price distribution in mempool",
        &["type"],
        vec![1.0, 5.0, 10.0, 50.0, 100.0, 500.0, 1000.0]
    ).unwrap();
    
    /// Transaction age
    pub static ref TX_AGE: HistogramVec = register_histogram_vec!(
        "qnet_mempool_tx_age_seconds",
        "Transaction age in mempool",
        &["status"],
        vec![10.0, 60.0, 300.0, 600.0, 1800.0, 3600.0]
    ).unwrap();
    
    /// Eviction counter
    pub static ref EVICTIONS: CounterVec = register_counter_vec!(
        "qnet_mempool_evictions_total",
        "Total number of evictions",
        &["reason"]
    ).unwrap();
}

/// Record transaction operation
pub fn record_tx_operation(operation: &str, success: bool) {
    let result = if success { "success" } else { "failure" };
    TX_OPS.with_label_values(&[operation, result]).inc();
}

/// Update mempool size metrics
pub fn update_mempool_size(total: usize, unique_senders: usize) {
    MEMPOOL_SIZE.with_label_values(&["total"]).set(total as f64);
    MEMPOOL_SIZE.with_label_values(&["unique_senders"]).set(unique_senders as f64);
}

/// Record gas price
pub fn record_gas_price(gas_price: u64) {
    GAS_PRICE_HISTOGRAM
        .with_label_values(&["transaction"])
        .observe(gas_price as f64);
}

/// Record transaction age
pub fn record_tx_age(age_seconds: f64, status: &str) {
    TX_AGE.with_label_values(&[status]).observe(age_seconds);
}

/// Record eviction
pub fn record_eviction(reason: &str) {
    EVICTIONS.with_label_values(&[reason]).inc();
} 