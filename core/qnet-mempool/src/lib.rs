#![allow(unused_imports)]
#![allow(unused_variables)]
#![allow(dead_code)]
#![allow(missing_docs)]

//! High-performance transaction mempool for QNet blockchain

pub mod config;
pub mod errors;
pub mod eviction;
pub mod mempool;
pub mod priority;
pub mod validation;
pub mod metrics;
pub mod simple_mempool;


#[cfg(feature = "python")]
pub mod python;

pub use config::MempoolConfig;
pub use errors::{MempoolError, MempoolResult};
pub use mempool::Mempool;
pub use priority::TxPriority;
pub use validation::SimpleValidator;
pub use simple_mempool::{SimpleMempool, SimpleMempoolConfig};

/// Prelude for common imports
pub mod prelude {
    pub use crate::{
        Mempool,
        MempoolConfig,
        MempoolError,
        MempoolResult,
        TxPriority,
        mempool::*,

        simple_mempool::*,
        priority::*,
        validation::*,
        eviction::*,
        config::*,
        errors::*,
    };
} 