FROM python:3.9-slim-bullseye as build

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    git \
    libsnappy-dev \
    librocksdb-dev \
    libssl-dev \
    pkg-config \
    libffi-dev \
    libbz2-dev \
    liblz4-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Set up working directory
WORKDIR /build

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -U pip && \
    pip install --no-cache-dir wheel setuptools cffi && \
    pip install --no-cache-dir -r requirements.txt

# Copy source code and build Rust components
COPY src /build/src
COPY scripts /build/scripts
COPY patches /build/patches

# Build the Rust components if patches exist
RUN if [ -d "/build/patches" ] && [ -f "/build/patches/crypto.rs" ] && [ -f "/build/patches/merkle.rs" ]; then \
    mkdir -p /build/src/crypto/rust/src && \
    cp /build/patches/crypto.rs /build/src/crypto/rust/src/crypto.rs && \
    cp /build/patches/merkle.rs /build/src/crypto/rust/src/merkle.rs && \
    cd /build/src/crypto/rust && \
    if [ -f "build.sh" ]; then \
        chmod +x build.sh && \
        ./build.sh || cd src && rustc --crate-type=dylib crypto.rs && rustc --crate-type=dylib merkle.rs && rustc --crate-type=dylib -L . lib.rs && mv *.so ..; \
    else \
        cd src && rustc --crate-type=dylib crypto.rs && rustc --crate-type=dylib merkle.rs && rustc --crate-type=dylib -L . lib.rs && mv *.so ..; \
    fi; \
fi

# Final image
FROM python:3.9-slim-bullseye

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    libsnappy1v5 \
    librocksdb6.11 \
    libssl1.1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set up working directory
WORKDIR /app

# Create necessary directories
RUN mkdir -p /app/data /app/blockchain_data /app/keys /app/logs /app/snapshots /app/config /app/src

# Copy from build stage
COPY --from=build /usr/local/lib/python3.9/site-packages /usr/local/lib/python3.9/site-packages
COPY --from=build /build/src /app/src

# Create a non-privileged user
RUN groupadd -r qnet && useradd -r -g qnet -m -d /home/qnet qnet

# Copy additional files
COPY scripts /app/scripts
COPY requirements.txt /app/

# Set appropriate permissions
RUN chown -R qnet:qnet /app && \
    chmod -R 755 /app && \
    chmod -R 700 /app/keys && \
    chmod -R 777 /app/data /app/logs /app/snapshots /app/blockchain_data /app/config

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    QNET_NETWORK=testnet \
    QNET_DATA_DIR=/app/data \
    QNET_STORAGE_TYPE=rocksdb \
    QNET_MONITORING_ENABLED=true \
    QNET_SYBIL_RESISTANCE=true \
    QNET_TLS_REQUIRED=true \
    QNET_PORT=8000 \
    PYTHONPATH=/app

# Switch to non-privileged user
USER qnet

# Expose ports
EXPOSE 8000 8080 9090

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

# Command to run
CMD ["python", "src/node/node.py"]