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

# Copy workspace configuration
COPY Cargo.toml ./
COPY core/ ./core/
COPY development/qnet-integration/ ./development/qnet-integration/

# Create Cargo.lock with pinned base64ct version
RUN cd development/qnet-integration && \
    cargo generate-lockfile && \
    cargo update --package base64ct --precise 1.6.0

# Build the production node from workspace root
RUN cargo build --release --bin qnet-node

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

# Copy the built binary from WORKSPACE ROOT
COPY --from=builder /build/target/release/qnet-node /usr/local/bin/qnet-node

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

# Command to run the application
CMD ["/usr/local/bin/qnet-node"] 