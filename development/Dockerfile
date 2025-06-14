# Multi-stage build for QNet Node
FROM rust:1.74 as rust-builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    cmake \
    libssl-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Build Rust modules
WORKDIR /build

# Copy Rust projects
COPY qnet-core-rust/ ./qnet-core-rust/
COPY qnet-consensus-rust/ ./qnet-consensus-rust/

# Build Rust modules
RUN cd qnet-core-rust && cargo build --release
RUN cd qnet-consensus-rust && cargo build --release

# Go builder stage
FROM golang:1.21 as go-builder

WORKDIR /build

# Copy Go project
COPY qnet-network/ ./qnet-network/

# Build Go network layer
RUN cd qnet-network && go mod download && go build -o qnet-network

# Final stage
FROM python:3.11-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    libssl3 \
    libgomp1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create app user
RUN useradd -m -u 1000 qnet

# Set working directory
WORKDIR /app

# Copy Python requirements
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy Rust artifacts
COPY --from=rust-builder /build/qnet-core-rust/target/release/*.so /usr/local/lib/
COPY --from=rust-builder /build/qnet-consensus-rust/target/release/*.so /usr/local/lib/

# Copy Go binary
COPY --from=go-builder /build/qnet-network/qnet-network /usr/local/bin/

# Copy application code
COPY qnet-core/ ./qnet-core/
COPY qnet-node/ ./qnet-node/
COPY qnet-sdk/ ./qnet-sdk/
COPY qnet-vm/ ./qnet-vm/
COPY config/ ./config/

# Create necessary directories
RUN mkdir -p data keys logs && \
    chown -R qnet:qnet /app

# Update library path
ENV LD_LIBRARY_PATH=/usr/local/lib:$LD_LIBRARY_PATH

# Switch to non-root user
USER qnet

# Expose ports
EXPOSE 9876 5000 9090

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:5000/health || exit 1

# Default command
CMD ["python", "qnet-node/src/node/node.py"] 