# Build stage
FROM rust:1.75-bookworm AS builder

WORKDIR /app

# Copy Cargo files first for dependency caching
COPY Cargo.toml ./

# Create dummy src for dependency compilation
RUN mkdir src && echo "fn main() {}" > src/main.rs

# Build dependencies only
RUN cargo build --release || true

# Copy actual source
COPY src ./src

# Touch main.rs to force rebuild
RUN touch src/main.rs

# Build release binary
RUN cargo build --release

# Runtime stage
FROM debian:bookworm-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/target/release/qnet-indexer /app/qnet-indexer

# Create non-root user
RUN useradd -m -u 1000 qnet && chown -R qnet:qnet /app
USER qnet

# Expose API port
EXPOSE 9000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:9000/health || exit 1

# Run indexer
CMD ["./qnet-indexer"]

