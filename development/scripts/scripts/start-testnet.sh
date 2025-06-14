#!/bin/bash

# Start QNet testnet with multiple nodes

echo "Starting QNet testnet..."

# Build the node
echo "Building QNet node..."
cargo build --release

# Create data directories
mkdir -p testnet/node1 testnet/node2 testnet/node3

# Start bootstrap node
echo "Starting bootstrap node (node1)..."
./target/release/qnet_node \
    --data-dir testnet/node1 \
    --listen /ip4/127.0.0.1/tcp/9001 \
    --api-addr 127.0.0.1:8081 \
    --producer \
    > testnet/node1.log 2>&1 &

NODE1_PID=$!
echo "Node1 PID: $NODE1_PID"

# Wait for bootstrap node to start
sleep 5

# Get bootstrap node peer ID (simplified - in real scenario would parse from logs)
BOOTSTRAP_PEER="12D3KooWExample@/ip4/127.0.0.1/tcp/9001"

# Start node 2
echo "Starting node2..."
./target/release/qnet_node \
    --data-dir testnet/node2 \
    --listen /ip4/127.0.0.1/tcp/9002 \
    --api-addr 127.0.0.1:8082 \
    --bootstrap "$BOOTSTRAP_PEER" \
    > testnet/node2.log 2>&1 &

NODE2_PID=$!
echo "Node2 PID: $NODE2_PID"

# Start node 3
echo "Starting node3..."
./target/release/qnet_node \
    --data-dir testnet/node3 \
    --listen /ip4/127.0.0.1/tcp/9003 \
    --api-addr 127.0.0.1:8083 \
    --bootstrap "$BOOTSTRAP_PEER" \
    --producer \
    > testnet/node3.log 2>&1 &

NODE3_PID=$!
echo "Node3 PID: $NODE3_PID"

echo "Testnet started!"
echo "Logs: testnet/node*.log"
echo "APIs: http://localhost:8081, :8082, :8083"
echo ""
echo "To stop: kill $NODE1_PID $NODE2_PID $NODE3_PID"
echo "Or run: ./scripts/stop-testnet.sh"

# Save PIDs for stop script
echo "$NODE1_PID $NODE2_PID $NODE3_PID" > testnet/pids.txt 