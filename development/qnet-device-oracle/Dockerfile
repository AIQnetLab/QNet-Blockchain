# QNet device oracle. Build context: the QNet-Project root.
#   docker build -f development/qnet-device-oracle/Dockerfile -t qnet-device-oracle .
FROM ubuntu:22.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    curl \
    pkg-config \
    libclang-dev \
    clang \
    cmake \
    build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.93.0
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /build
COPY core/qnet-device-attest ./core/qnet-device-attest
COPY development/qnet-device-oracle ./development/qnet-device-oracle
ENV RUSTFLAGS="-C target-cpu=x86-64"
ENV CARGO_NET_RETRY=10
RUN cd development/qnet-device-oracle \
    && cargo build --release --locked --bin qnet-device-oracle \
    && cp target/release/qnet-device-oracle /usr/local/bin/

FROM ubuntu:22.04

# The commit this image carries; declared in the runtime stage so the builder layers stay cached.
ARG QNET_BUILD_ID=unstamped
ENV QNET_BUILD_ID=${QNET_BUILD_ID}
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 oracle \
    && useradd -u 10001 -g oracle -s /usr/sbin/nologin -M oracle

COPY --from=builder /usr/local/bin/qnet-device-oracle /usr/local/bin/

# Secrets, configuration and certificates arrive read-only under /etc/qnet-oracle; the database lives
# in /var/lib/qnet-oracle. Nothing secret is baked into the image.
USER 10001:10001
ENV QNET_LOG_LEVEL=3
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/qnet-device-oracle"]
CMD ["run", "--config", "/etc/qnet-oracle/oracle.json"]
