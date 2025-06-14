//! WebSocket support for real-time updates

use actix::{Actor, StreamHandler, AsyncContext, ActorContext};
use actix_web_actors::ws;
use actix_web::{web, HttpRequest, HttpResponse};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use crate::{error::ApiResult, state::AppState};

/// WebSocket heartbeat interval
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);

/// Client timeout
const CLIENT_TIMEOUT: Duration = Duration::from_secs(10);

/// WebSocket message types
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsMessage {
    /// Subscribe to events
    Subscribe { channels: Vec<String> },
    /// Unsubscribe from events
    Unsubscribe { channels: Vec<String> },
    /// Ping message
    Ping,
    /// Pong response
    Pong,
    /// New block event
    NewBlock { height: u64, hash: String },
    /// New transaction event
    NewTransaction { hash: String },
    /// Consensus update
    ConsensusUpdate { round: u64, phase: String },
}

/// WebSocket connection actor
pub struct WsConnection {
    /// Client heartbeat
    heartbeat: Instant,
    /// Subscribed channels
    subscriptions: Vec<String>,
    /// App state
    state: web::Data<AppState>,
}

impl WsConnection {
    pub fn new(state: web::Data<AppState>) -> Self {
        Self {
            heartbeat: Instant::now(),
            subscriptions: Vec::new(),
            state,
        }
    }
    
    /// Start heartbeat
    fn heartbeat(&self, ctx: &mut <Self as Actor>::Context) {
        ctx.run_interval(HEARTBEAT_INTERVAL, |act, ctx| {
            if Instant::now().duration_since(act.heartbeat) > CLIENT_TIMEOUT {
                ctx.stop();
                return;
            }
            ctx.ping(b"");
        });
    }
}

impl Actor for WsConnection {
    type Context = ws::WebsocketContext<Self>;
    
    fn started(&mut self, ctx: &mut Self::Context) {
        self.heartbeat(ctx);
    }
}

/// Handle WebSocket messages
impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for WsConnection {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        match msg {
            Ok(ws::Message::Ping(msg)) => {
                self.heartbeat = Instant::now();
                ctx.pong(&msg);
            }
            Ok(ws::Message::Pong(_)) => {
                self.heartbeat = Instant::now();
            }
            Ok(ws::Message::Text(text)) => {
                // Parse message
                match serde_json::from_str::<WsMessage>(&text) {
                    Ok(msg) => match msg {
                        WsMessage::Subscribe { channels } => {
                            for channel in channels {
                                if !self.subscriptions.contains(&channel) {
                                    self.subscriptions.push(channel);
                                }
                            }
                        }
                        WsMessage::Unsubscribe { channels } => {
                            self.subscriptions.retain(|c| !channels.contains(c));
                        }
                        WsMessage::Ping => {
                            let response = serde_json::to_string(&WsMessage::Pong).unwrap();
                            ctx.text(response);
                        }
                        _ => {}
                    },
                    Err(_) => {
                        ctx.text(r#"{"error":"Invalid message format"}"#);
                    }
                }
            }
            Ok(ws::Message::Binary(_)) => {}
            Ok(ws::Message::Close(reason)) => {
                ctx.close(reason);
                ctx.stop();
            }
            _ => ctx.stop(),
        }
    }
}

/// WebSocket endpoint handler
pub async fn websocket_handler(
    req: HttpRequest,
    stream: web::Payload,
    state: web::Data<AppState>,
) -> ApiResult<HttpResponse> {
    ws::start(WsConnection::new(state), &req, stream)
        .map_err(|e| crate::error::ApiError::Internal(e.to_string()))
} 