#!/bin/bash
# Start the dashboard separately
cd /app
if [ -f "website/app.py" ]; then
    echo "Starting dashboard on port 8080..."
    python website/app.py &
fi

# Run IP fix first
python /app/ip_fix.py

# Start the main node
python node.py
