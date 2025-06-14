use actix_web::{web, App, HttpServer, middleware};
use actix_cors::Cors;
use actix_web_prom::PrometheusMetricsBuilder;
use tracing::{info, error};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use std::sync::Arc;

mod config;
mod error;
mod handlers;
mod state;
mod websocket;

use config::Config;
use state::AppState;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Initialize tracing
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "qnet_api=debug,actix_web=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    info!("Starting QNet API server...");

    // Load configuration
    let config = Config::from_env();
    let bind_address = format!("{}:{}", config.host, config.port);

    // Initialize state
    let app_state = match AppState::new(&config).await {
        Ok(state) => Arc::new(state),
        Err(e) => {
            error!("Failed to initialize app state: {}", e);
            return Err(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()));
        }
    };

    // Setup Prometheus metrics
    let prometheus = PrometheusMetricsBuilder::new("qnet_api")
        .endpoint("/metrics")
        .build()
        .unwrap();

    info!("Starting HTTP server on {}", bind_address);

    // Start HTTP server
    HttpServer::new(move || {
        let cors = Cors::default()
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header()
            .max_age(3600);

        App::new()
            .app_data(web::Data::new(app_state.clone()))
            .wrap(cors)
            .wrap(middleware::Logger::default())
            .wrap(middleware::Compress::default())
            .wrap(prometheus.clone())
            .wrap(tracing_actix_web::TracingLogger::default())
            .configure(handlers::configure)
            .route("/ws", web::get().to(websocket::websocket_handler))
    })
    .bind(&bind_address)?
    .run()
    .await
} 