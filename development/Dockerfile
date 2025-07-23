# Multi-stage build for QNet Production Node
FROM rust:1.82-bookworm as builder

# Install build dependencies including libclang for bindgen
RUN apt-get update && apt-get install -y \
    cmake \
    libssl-dev \
    pkg-config \
    protobuf-compiler \
    build-essential \
    curl \
    libclang-dev \
    llvm-dev \
    clang \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables for libclang
ENV LIBCLANG_PATH=/usr/lib/x86_64-linux-gnu
ENV BINDGEN_EXTRA_CLANG_ARGS="-I/usr/include"

# Set working directory  
WORKDIR /build

# Copy core dependencies to correct path
COPY core/ ./core/

# Copy qnet-integration project
COPY development/qnet-integration/ ./qnet-integration/

# Change to qnet-integration directory
WORKDIR /build/qnet-integration

# Create Cargo.lock with pinned base64ct version
RUN cargo generate-lockfile && \
    cargo update --package base64ct --precise 1.6.0

# Build the production node from qnet-integration directory
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

# Copy the built binary from qnet-integration directory
COPY --from=builder /build/qnet-integration/target/release/qnet-node /usr/local/bin/qnet-node

# Make binary executable
RUN chmod +x /usr/local/bin/qnet-node

# Switch to non-root user
USER qnet

# Set working directory
WORKDIR /opt/qnet

# Expose ports
EXPOSE 8001 8002 8003 7001 7002 7003

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8001/health || exit 1

# Production mode - fully automatic configuration, interactive activation only
CMD ["/usr/local/bin/qnet-node"] 