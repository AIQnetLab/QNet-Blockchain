#!/usr/bin/env python3
"""
Real-time performance dashboard for QNet
Monitors TPS, latency, and shard distribution
"""

import asyncio
import time
from datetime import datetime
import matplotlib.pyplot as plt
import matplotlib.animation as animation
from collections import deque

class PerformanceDashboard:
    def __init__(self):
        self.tps_history = deque(maxlen=100)
        self.latency_history = deque(maxlen=100)
        self.time_history = deque(maxlen=100)
        
        # Setup plot
        self.fig, (self.ax1, self.ax2) = plt.subplots(2, 1, figsize=(10, 8))
        self.fig.suptitle('QNet Performance Monitor - Target: 1M TPS')
        
    def update_metrics(self, frame):
        # Simulate metrics (replace with actual data)
        current_time = time.time()
        current_tps = 5000 + frame * 100  # Simulating growth
        current_latency = 50 - frame * 0.1  # Simulating improvement
        
        self.time_history.append(current_time)
        self.tps_history.append(current_tps)
        self.latency_history.append(current_latency)
        
        # Update TPS plot
        self.ax1.clear()
        self.ax1.plot(list(self.time_history), list(self.tps_history), 'g-')
        self.ax1.axhline(y=1_000_000, color='r', linestyle='--', label='Target: 1M TPS')
        self.ax1.set_ylabel('Transactions Per Second')
        self.ax1.set_title(f'Current TPS: {current_tps:,.0f}')
        self.ax1.legend()
        self.ax1.grid(True)
        
        # Update latency plot
        self.ax2.clear()
        self.ax2.plot(list(self.time_history), list(self.latency_history), 'b-')
        self.ax2.axhline(y=10, color='r', linestyle='--', label='Target: <10ms')
        self.ax2.set_ylabel('Latency (ms)')
        self.ax2.set_xlabel('Time')
        self.ax2.set_title(f'Current Latency: {current_latency:.1f}ms')
        self.ax2.legend()
        self.ax2.grid(True)
        
    def start(self):
        ani = animation.FuncAnimation(self.fig, self.update_metrics, interval=1000)
        plt.show()

if __name__ == "__main__":
    dashboard = PerformanceDashboard()
    dashboard.start()
