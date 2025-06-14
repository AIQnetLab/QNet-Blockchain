//! Integration tests for QNet API

use actix_web::{test, web, App};
use qnet_api::{handlers, state::AppState, config::Config};
use serde_json::json;
use std::sync::Arc;
use tempfile::TempDir;

async fn setup_test_app() -> (test::TestServer, TempDir) {
    let temp_dir = TempDir::new().unwrap();
    let mut config = Config::default();
    config.state_db_path = temp_dir.path().to_str().unwrap().to_string();
    
    let app_state = Arc::new(AppState::new(&config).await.unwrap());
    
    let server = test::start(move || {
        App::new()
            .app_data(web::Data::new(app_state.clone()))
            .configure(handlers::configure)
    });
    
    (server, temp_dir)
}

#[actix_rt::test]
async fn test_mempool_status() {
    let (server, _temp_dir) = setup_test_app().await;
    
    let resp = server
        .get("/api/v1/mempool/status")
        .send()
        .await
        .unwrap();
    
    assert!(resp.status().is_success());
    
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["size"], 0);
    assert_eq!(body["unique_senders"], 0);
}

#[actix_rt::test]
async fn test_submit_transaction() {
    let (server, _temp_dir) = setup_test_app().await;
    
    let tx_request = json!({
        "from": "sender123",
        "tx_type": {
            "type": "transfer",
            "to": "recipient456",
            "amount": 1000
        },
        "nonce": 0,
        "gas_price": 10,
        "gas_limit": 21000,
        "signature": "dummy_signature"
    });
    
    let resp = server
        .post("/api/v1/transactions")
        .send_json(&tx_request)
        .await
        .unwrap();
    
    assert!(resp.status().is_success());
    
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body["hash"].is_string());
    assert_eq!(body["status"], "pending");
}

#[actix_rt::test]
async fn test_get_transaction() {
    let (server, _temp_dir) = setup_test_app().await;
    
    // First submit a transaction
    let tx_request = json!({
        "from": "sender123",
        "tx_type": {
            "type": "transfer",
            "to": "recipient456",
            "amount": 1000
        },
        "nonce": 0,
        "gas_price": 10,
        "gas_limit": 21000,
        "signature": "dummy_signature"
    });
    
    let submit_resp = server
        .post("/api/v1/transactions")
        .send_json(&tx_request)
        .await
        .unwrap();
    
    let submit_body: serde_json::Value = submit_resp.json().await.unwrap();
    let tx_hash = submit_body["hash"].as_str().unwrap();
    
    // Now get the transaction
    let get_resp = server
        .get(&format!("/api/v1/transactions/{}", tx_hash))
        .send()
        .await
        .unwrap();
    
    assert!(get_resp.status().is_success());
    
    let body: serde_json::Value = get_resp.json().await.unwrap();
    assert_eq!(body["hash"], tx_hash);
    assert_eq!(body["from"], "sender123");
}

#[actix_rt::test]
async fn test_mempool_transactions() {
    let (server, _temp_dir) = setup_test_app().await;
    
    // Submit multiple transactions
    for i in 0..5 {
        let tx_request = json!({
            "from": format!("sender{}", i),
            "tx_type": {
                "type": "transfer",
                "to": "recipient",
                "amount": 1000
            },
            "nonce": 0,
            "gas_price": 10 + i,
            "gas_limit": 21000,
            "signature": "dummy_signature"
        });
        
        server
            .post("/api/v1/transactions")
            .send_json(&tx_request)
            .await
            .unwrap();
    }
    
    // Get mempool transactions
    let resp = server
        .get("/api/v1/mempool/transactions?limit=10")
        .send()
        .await
        .unwrap();
    
    assert!(resp.status().is_success());
    
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["total"], 5);
    assert_eq!(body["transactions"].as_array().unwrap().len(), 5);
}

#[actix_rt::test]
async fn test_validation_error() {
    let (server, _temp_dir) = setup_test_app().await;
    
    // Invalid transaction (gas price too low)
    let tx_request = json!({
        "from": "sender123",
        "tx_type": {
            "type": "transfer",
            "to": "recipient456",
            "amount": 1000
        },
        "nonce": 0,
        "gas_price": 0,  // Invalid
        "gas_limit": 21000,
        "signature": "dummy_signature"
    });
    
    let resp = server
        .post("/api/v1/transactions")
        .send_json(&tx_request)
        .await
        .unwrap();
    
    assert_eq!(resp.status(), 422);  // Unprocessable Entity
    
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["error"], "validation_error");
} 