#!/bin/bash
# Start QNet test network with microblock architecture

echo "=== QNet Microblock Test Network ==="
echo "Starting 2-node network to test micro/macro blocks..."

# Clean up old data
echo "Cleaning up old data..."
rm -rf node1_data node2_data

# Build the project
echo "Building QNet..."
cargo build --release

# Start Node 1 (Super node, will be initial leader)
echo "Starting Node 1 (Super node)..."
cargo run --release --bin qnet-node -- \
    --data-dir node1_data \
    --port 9876 \
    --rpc-port 8545 \
    --node-type super \
    --region na \
    > node1.log 2>&1 &

NODE1_PID=$!
echo "Node 1 PID: $NODE1_PID"

# Wait for Node 1 to start
echo "Waiting for Node 1 to start..."
sleep 5

# Start Node 2 (Full node)
echo "Starting Node 2 (Full node)..."
cargo run --release --bin qnet-node -- \
    --data-dir node2_data \
    --port 9877 \
    --rpc-port 8546 \
    --node-type full \
    --region na \
    --bootstrap localhost:9876 \
    > node2.log 2>&1 &

NODE2_PID=$!
echo "Node 2 PID: $NODE2_PID"

# Wait for nodes to connect
echo "Waiting for nodes to connect..."
sleep 5

# Show status
echo ""
echo "=== Network Status ==="
echo "Node 1 (Super): http://localhost:8545"
echo "Node 2 (Full): http://localhost:8546"
echo ""
echo "Logs:"
echo "  tail -f node1.log"
echo "  tail -f node2.log"
echo ""
echo "To stop: kill $NODE1_PID $NODE2_PID"
echo ""
echo "Run test: python test_microblocks.py"

# Keep script running
wait 