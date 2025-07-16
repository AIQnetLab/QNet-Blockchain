# Multi-stage build for QNet Production Node
FROM rust:1.84 as builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    cmake \
    libssl-dev \
    pkg-config \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /build

# Copy workspace files
COPY Cargo.toml ./
COPY core/ ./core/
COPY development/qnet-integration/ ./development/qnet-integration/

# Build the production node
WORKDIR /build/development/qnet-integration
RUN cargo build --release

# Runtime stage
FROM ubuntu:22.04

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    libssl3 \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create app user
RUN useradd -m -u 1000 qnet

# Create directories
RUN mkdir -p /opt/qnet/node_data && \
    chown -R qnet:qnet /opt/qnet

# Copy the built binary
COPY --from=builder /build/development/qnet-integration/target/release/qnet-node /usr/local/bin/qnet-node

# Make binary executable
RUN chmod +x /usr/local/bin/qnet-node

# Switch to non-root user
USER qnet

# Set working directory
WORKDIR /opt/qnet

# Expose ports
EXPOSE 9876 9877 8001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8001/api/v1/node/health || exit 1

# Default command
CMD ["/usr/local/bin/qnet-node"] 