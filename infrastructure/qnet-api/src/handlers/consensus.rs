//! Consensus-related API handlers

use actix_web::{web, HttpResponse};
use serde::{Deserialize, Serialize};
use crate::{error::ApiResult, state::AppState};
use qnet_consensus::commit_reveal::{Commit, Reveal};

/// Commit request
#[derive(Debug, Deserialize)]
pub struct CommitRequest {
    pub node_address: String,
    pub commit_hash: String,
    pub signature: String,
}

/// Reveal request
#[derive(Debug, Deserialize)]
pub struct RevealRequest {
    pub node_address: String,
    pub reveal_value: String,
}

/// Round info response
#[derive(Debug, Serialize)]
pub struct RoundInfo {
    pub round: u64,
    pub phase: String,
    pub start_time: u64,
    pub commit_end_time: u64,
    pub reveal_end_time: u64,
    pub commits_count: usize,
    pub reveals_count: usize,
    pub leader: Option<String>,
}

/// Get current consensus round
pub async fn get_current_round(
    state: web::Data<AppState>,
) -> ApiResult<HttpResponse> {
    match state.consensus.get_round_state() {
        Some(round_state) => {
            let info = RoundInfo {
                round: round_state.round_number,
                phase: format!("{:?}", round_state.phase),
                start_time: round_state.phase_start.elapsed().as_secs(),
                commit_end_time: round_state.phase_start.elapsed().as_secs() + round_state.phase_duration.as_secs(),
                reveal_end_time: round_state.phase_start.elapsed().as_secs() + (round_state.phase_duration.as_secs() * 2),
                commits_count: round_state.commits.len(),
                reveals_count: round_state.reveals.len(),
                leader: "TBD".to_string(), // Leader determined after reveal phase
            };
            Ok(HttpResponse::Ok().json(info))
        }
        None => Ok(HttpResponse::Ok().json(serde_json::json!({
            "error": "No active round",
            "message": "Consensus is not currently running"
        }))),
    }
}

/// Submit commit
pub async fn submit_commit(
    state: web::Data<AppState>,
    req: web::Json<CommitRequest>,
) -> ApiResult<HttpResponse> {
    // Add commit to consensus
    match state.consensus.add_commit(
        &req.node_address,
        &req.commit_hash,
        &req.signature,
    ) {
        Ok(_) => Ok(HttpResponse::Ok().json(serde_json::json!({
            "status": "success",
            "message": "Commit accepted"
        }))),
        Err(e) => Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "error": "Commit rejected",
            "reason": e.to_string()
        }))),
    }
}

/// Submit reveal
pub async fn submit_reveal(
    state: web::Data<AppState>,
    req: web::Json<RevealRequest>,
) -> ApiResult<HttpResponse> {
    // Add reveal to consensus
    match state.consensus.add_reveal(
        &req.node_address,
        &req.reveal_value,
    ) {
        Ok(_) => Ok(HttpResponse::Ok().json(serde_json::json!({
            "status": "success",
            "message": "Reveal accepted"
        }))),
        Err(e) => Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "error": "Reveal rejected",
            "reason": e.to_string()
        }))),
    }
} 