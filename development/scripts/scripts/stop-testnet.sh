#!/bin/bash

# Stop QNet testnet

echo "Stopping QNet testnet..."

if [ -f testnet/pids.txt ]; then
    PIDS=$(cat testnet/pids.txt)
    echo "Killing processes: $PIDS"
    kill $PIDS
    rm testnet/pids.txt
    echo "Testnet stopped."
else
    echo "No PID file found. Testnet may not be running."
fi 