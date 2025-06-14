//! Error handling for API

use actix_web::{error::ResponseError, http::StatusCode, HttpResponse};
use serde::Serialize;
use thiserror::Error;

/// API error types
#[derive(Error, Debug)]
pub enum ApiError {
    /// Bad request
    #[error("Bad request: {0}")]
    BadRequest(String),
    
    /// Not found
    #[error("Not found: {0}")]
    NotFound(String),
    
    /// Internal error
    #[error("Internal error: {0}")]
    Internal(String),
    
    /// Validation error
    #[error("Validation error: {0}")]
    Validation(String),
    
    /// Unauthorized
    #[error("Unauthorized")]
    Unauthorized,
    
    /// Rate limited
    #[error("Rate limited")]
    RateLimited,
    
    /// State error
    #[error("State error: {0}")]
    State(#[from] qnet_state::errors::StateError),
    
    /// Mempool error
    #[error("Mempool error: {0}")]
    Mempool(#[from] qnet_mempool::errors::MempoolError),
    
    /// Consensus error
    #[error("Consensus error: {0}")]
    Consensus(#[from] qnet_consensus::errors::ConsensusError),
}

/// Error response
#[derive(Serialize)]
struct ErrorResponse {
    error: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<serde_json::Value>,
}

impl ResponseError for ApiError {
    fn status_code(&self) -> StatusCode {
        match self {
            ApiError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ApiError::NotFound(_) => StatusCode::NOT_FOUND,
            ApiError::Validation(_) => StatusCode::UNPROCESSABLE_ENTITY,
            ApiError::Unauthorized => StatusCode::UNAUTHORIZED,
            ApiError::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            ApiError::Internal(_) | ApiError::State(_) | ApiError::Mempool(_) | ApiError::Consensus(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        }
    }
    
    fn error_response(&self) -> HttpResponse {
        let error_response = ErrorResponse {
            error: match self {
                ApiError::BadRequest(_) => "bad_request",
                ApiError::NotFound(_) => "not_found",
                ApiError::Validation(_) => "validation_error",
                ApiError::Unauthorized => "unauthorized",
                ApiError::RateLimited => "rate_limited",
                ApiError::Internal(_) => "internal_error",
                ApiError::State(_) => "state_error",
                ApiError::Mempool(_) => "mempool_error",
                ApiError::Consensus(_) => "consensus_error",
            }.to_string(),
            message: self.to_string(),
            details: None,
        };
        
        HttpResponse::build(self.status_code()).json(error_response)
    }
}

/// Result type for API operations
pub type ApiResult<T> = Result<T, ApiError>; 