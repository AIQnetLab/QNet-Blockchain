//! API handlers

use actix_web::web;

mod account;
mod block;
mod transaction;
mod mempool;
mod consensus;
mod node;

pub use account::*;
pub use block::*;
pub use transaction::*;
pub use mempool::*;
pub use consensus::*;
pub use node::*;

/// Configure all routes
pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg
        // Account endpoints
        .service(
            web::scope("/api/v1/accounts")
                .route("/{address}", web::get().to(get_account))
                .route("/{address}/balance", web::get().to(get_balance))
                .route("/{address}/transactions", web::get().to(get_account_transactions))
        )
        // Block endpoints
        .service(
            web::scope("/api/v1/blocks")
                .route("/latest", web::get().to(get_latest_block))
                .route("/{height}", web::get().to(get_block))
                .route("/hash/{hash}", web::get().to(get_block_by_hash))
        )
        // Transaction endpoints
        .service(
            web::scope("/api/v1/transactions")
                .route("", web::post().to(submit_transaction))
                .route("/{hash}", web::get().to(get_transaction))
                .route("/{hash}/receipt", web::get().to(get_receipt))
        )
        // Mempool endpoints
        .service(
            web::scope("/api/v1/mempool")
                .route("/status", web::get().to(get_mempool_status))
                .route("/transactions", web::get().to(get_mempool_transactions))
                .route("/transactions/{address}", web::get().to(get_sender_transactions))
        )
        // Consensus endpoints
        .service(
            web::scope("/api/v1/consensus")
                .route("/round", web::get().to(get_current_round))
                .route("/commit", web::post().to(submit_commit))
                .route("/reveal", web::post().to(submit_reveal))
        )
        // Node endpoints
        .service(
            web::scope("/api/v1/node")
                .route("/info", web::get().to(get_node_info))
                .route("/peers", web::get().to(get_peers))
                .route("/sync/status", web::get().to(get_sync_status))
        );
} 