#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: node_dashboard.py
A simple web dashboard for node monitoring and management.
Provides UI for checking node status, peers, and chain info.
"""

from flask import Flask, render_template, request, redirect, url_for, jsonify
import threading
import os
import sys
import time
import json
import logging
import psutil
import platform
from datetime import datetime

# Add parent directory to path to import modules
parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

# Import blockchain modules
try:
    import config
    from blockchain import Block, Blockchain
    from block_rewards import calculate_block_reward
except ImportError as e:
    print(f"Import error: {e}")
    sys.exit(1)

app = Flask(__name__)

# Initialize system stats cache
system_stats = {
    "cpu_percent": 0,
    "memory_percent": 0,
    "disk_usage": 0,
    "uptime": 0,
    "timestamp": 0
}

# Path to store dashboard data
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard_data")
if not os.path.exists(DATA_DIR):
    os.makedirs(DATA_DIR)

# Log file for dashboard
log_file = os.path.join(DATA_DIR, "dashboard.log")
logging.basicConfig(level=logging.INFO,
                   format='%(asctime)s [%(levelname)s] %(message)s',
                   handlers=[logging.FileHandler(log_file)])

# Create directory for templates
TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")
if not os.path.exists(TEMPLATE_DIR):
    os.makedirs(TEMPLATE_DIR)

# Create basic HTML templates
def create_templates():
    """Create basic HTML templates for the dashboard if they don't exist"""
    if not os.path.exists(TEMPLATE_DIR):
        os.makedirs(TEMPLATE_DIR)
    
    # Base template with navigation
    base_html = """<!DOCTYPE html>
<html>
<head>
    <title>{% block title %}Blockchain Node Dashboard{% endblock %}</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        .sidebar {
            position: fixed;
            top: 0;
            bottom: 0;
            left: 0;
            z-index: 100;
            padding: 48px 0 0;
            box-shadow: inset -1px 0 0 rgba(0, 0, 0, .1);
        }
        .sidebar-sticky {
            position: relative;
            top: 0;
            height: calc(100vh - 48px);
            padding-top: .5rem;
            overflow-x: hidden;
            overflow-y: auto;
        }
        .node-status {
            padding: 10px;
            border-radius: 5px;
            margin-bottom: 20px;
        }
        .status-online {
            background-color: #d4edda;
        }
        .status-syncing {
            background-color: #fff3cd;
        }
        .status-offline {
            background-color: #f8d7da;
        }
    </style>
</head>
<body>
    <nav class="navbar navbar-dark fixed-top bg-dark p-0 shadow">
        <a class="navbar-brand col-sm-3 col-md-2 mr-0 px-3" href="#">Blockchain Node</a>
    </nav>

    <div class="container-fluid">
        <div class="row">
            <nav class="col-md-2 d-none d-md-block bg-light sidebar">
                <div class="sidebar-sticky">
                    <ul class="nav flex-column">
                        <li class="nav-item">
                            <a class="nav-link {% if active_page == 'dashboard' %}active{% endif %}" href="{{ url_for('dashboard') }}">
                                Dashboard
                            </a>
                        </li>
                        <li class="nav-item">
                            <a class="nav-link {% if active_page == 'peers' %}active{% endif %}" href="{{ url_for('peers') }}">
                                Peers
                            </a>
                        </li>
                        <li class="nav-item">
                            <a class="nav-link {% if active_page == 'blockchain' %}active{% endif %}" href="{{ url_for('blockchain') }}">
                                Blockchain
                            </a>
                        </li>
                        <li class="nav-item">
                            <a class="nav-link {% if active_page == 'transactions' %}active{% endif %}" href="{{ url_for('transactions') }}">
                                Transactions
                            </a>
                        </li>
                        <li class="nav-item">
                            <a class="nav-link {% if active_page == 'settings' %}active{% endif %}" href="{{ url_for('settings') }}">
                                Settings
                            </a>
                        </li>
                    </ul>
                </div>
            </nav>

            <main role="main" class="col-md-9 ml-sm-auto col-lg-10 px-4">
                <div class="d-flex justify-content-between flex-wrap flex-md-nowrap align-items-center pt-3 pb-2 mb-3 border-bottom">
                    <h1 class="h2">{% block header %}Dashboard{% endblock %}</h1>
                </div>
                {% block content %}{% endblock %}
            </main>
        </div>
    </div>
    
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/js/bootstrap.bundle.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    {% block scripts %}{% endblock %}
</body>
</html>
"""

    # Dashboard template (main page)
    dashboard_html = """{% extends "base.html" %}
{% block title %}Dashboard - Blockchain Node{% endblock %}
{% block header %}Dashboard{% endblock %}

{% block content %}
    <div class="node-status {% if system_info.is_synced %}status-online{% elif system_info.is_syncing %}status-syncing{% else %}status-offline{% endif %}">
        <h4>Node Status: {{ system_info.status }}</h4>
        <p>Node ID: {{ system_info.node_id }}</p>
        <p>Address: {{ system_info.address }}</p>
        <p>Version: {{ system_info.version }}</p>
    </div>

    <div class="row">
        <div class="col-md-6">
            <div class="card mb-4">
                <div class="card-header">
                    System Information
                </div>
                <div class="card-body">
                    <p><strong>CPU Usage:</strong> {{ system_stats.cpu_percent }}%</p>
                    <p><strong>Memory Usage:</strong> {{ system_stats.memory_percent }}%</p>
                    <p><strong>Disk Usage:</strong> {{ system_stats.disk_usage }}%</p>
                    <p><strong>Uptime:</strong> {{ system_stats.uptime }}</p>
                    <p><strong>Last Updated:</strong> {{ system_stats.timestamp }}</p>
                </div>
            </div>
        </div>
        <div class="col-md-6">
            <div class="card mb-4">
                <div class="card-header">
                    Blockchain Information
                </div>
                <div class="card-body">
                    <p><strong>Chain Height:</strong> {{ blockchain_info.height }}</p>
                    <p><strong>Last Block:</strong> {{ blockchain_info.last_block_time }}</p>
                    <p><strong>Peers:</strong> {{ blockchain_info.peer_count }}</p>
                    <p><strong>Pending Transactions:</strong> {{ blockchain_info.pending_tx_count }}</p>
                    <p><strong>Balance:</strong> {{ blockchain_info.balance }}</p>
                </div>
            </div>
        </div>
    </div>

    <div class="row mt-4">
        <div class="col-12">
            <div class="card">
                <div class="card-header">
                    Network Activity
                </div>
                <div class="card-body">
                    <canvas id="networkChart" width="400" height="200"></canvas>
                </div>
            </div>
        </div>
    </div>
{% endblock %}

{% block scripts %}
<script>
    // Network activity chart
    var ctx = document.getElementById('networkChart').getContext('2d');
    var networkChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: {{ chart_data.labels|safe }},
            datasets: [{
                label: 'Transactions',
                data: {{ chart_data.transaction_counts|safe }},
                borderColor: 'rgba(54, 162, 235, 1)',
                backgroundColor: 'rgba(54, 162, 235, 0.2)',
                borderWidth: 1
            },
            {
                label: 'Blocks',
                data: {{ chart_data.block_counts|safe }},
                borderColor: 'rgba(255, 99, 132, 1)',
                backgroundColor: 'rgba(255, 99, 132, 0.2)',
                borderWidth: 1
            }]
        },
        options: {
            scales: {
                y: {
                    beginAtZero: true
                }
            }
        }
    });
    
    // Refresh the page every 30 seconds
    setTimeout(function() {
        location.reload();
    }, 30000);
</script>
{% endblock %}
"""

    # Write templates to files if they don't exist yet
    templates = {
        "base.html": base_html,
        "dashboard.html": dashboard_html,
    }
    
    for filename, content in templates.items():
        filepath = os.path.join(TEMPLATE_DIR, filename)
        if not os.path.exists(filepath):
            with open(filepath, 'w') as f:
                f.write(content)
            logging.info(f"Created template: {filename}")

# Create missing templates on startup
create_templates()

# Background worker to update system stats
def update_system_stats():
    """Update system statistics periodically"""
    global system_stats
    
    while True:
        try:
            # Get CPU and memory usage
            cpu_percent = psutil.cpu_percent(interval=1)
            memory = psutil.virtual_memory()
            
            # Get disk usage for the current directory
            disk = psutil.disk_usage(os.path.dirname(os.path.abspath(__file__)))
            
            # Get system uptime
            if platform.system() == "Windows":
                uptime_seconds = time.time() - psutil.boot_time()
            else:
                uptime_seconds = time.time() - psutil.boot_time()
            
            # Format uptime as days, hours, minutes
            days, remainder = divmod(int(uptime_seconds), 86400)
            hours, remainder = divmod(remainder, 3600)
            minutes, seconds = divmod(remainder, 60)
            uptime_str = f"{days}d {hours}h {minutes}m"
            
            # Update stats
            system_stats = {
                "cpu_percent": cpu_percent,
                "memory_percent": memory.percent,
                "disk_usage": disk.percent,
                "uptime": uptime_str,
                "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            }
            
            # Save to file for persistence
            stats_file = os.path.join(DATA_DIR, "system_stats.json")
            with open(stats_file, 'w') as f:
                json.dump(system_stats, f)
                
        except Exception as e:
            logging.error(f"Error updating system stats: {e}")
            
        time.sleep(60)  # Update every minute

# Start the background worker
stats_thread = threading.Thread(target=update_system_stats, daemon=True)
stats_thread.start()

# Flask routes
@app.route('/')
def dashboard():
    """Main dashboard page"""
    try:
        # Get system information
        uptime_seconds = time.time() - psutil.boot_time()
        days, remainder = divmod(int(uptime_seconds), 86400)
        hours, remainder = divmod(remainder, 3600)
        minutes, _ = divmod(remainder, 60)
        
        # Determine node status
        is_syncing = False
        is_synced = True
        status = "Online"
        
        if len(config.peers) < 3:
            status = "Limited Connectivity"
            is_synced = False
        
        # Try to get last network activity
        last_sync_ago = time.time() - config.consensus_manager.last_activity if hasattr(config.consensus_manager, 'last_activity') else 999999
        if last_sync_ago > 600:  # No activity in 10 minutes
            status = "Inactive"
            is_synced = False
        
        system_info = {
            "status": status,
            "node_id": config.node_id,
            "address": config.own_address,
            "version": "1.0.0",
            "is_syncing": is_syncing,
            "is_synced": is_synced
        }
        
        # Get blockchain information
        try:
            chain_height = len(config.blockchain.chain)
            last_block_time = datetime.fromtimestamp(config.blockchain.last_block.timestamp).strftime("%Y-%m-%d %H:%M:%S") if config.blockchain.last_block else "N/A"
            
            blockchain_info = {
                "height": chain_height,
                "last_block_time": last_block_time,
                "peer_count": len(config.peers),
                "pending_tx_count": len(config.blockchain.transaction_pool),
                "balance": config.balances.get(config.own_address, 0)
            }
        except Exception as e:
            logging.error(f"Error getting blockchain info: {e}")
            blockchain_info = {
                "height": 0,
                "last_block_time": "N/A",
                "peer_count": 0,
                "pending_tx_count": 0,
                "balance": 0
            }
        
        # Get chart data (dummy data for now)
        chart_data = {
            "labels": ["00:00", "01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00", "08:00", "09:00", "10:00", "11:00"],
            "transaction_counts": [12, 19, 3, 5, 2, 3, 20, 33, 23, 12, 5, 6],
            "block_counts": [1, 2, 1, 1, 0, 1, 2, 3, 2, 1, 0, 1]
        }
        
        return render_template('dashboard.html', 
                               active_page='dashboard',
                               system_info=system_info,
                               system_stats=system_stats,
                               blockchain_info=blockchain_info,
                               chart_data=chart_data)
    
    except Exception as e:
        logging.error(f"Error rendering dashboard: {e}")
        return f"Error loading dashboard: {str(e)}", 500

# More routes would be added here for peers, blockchain, etc.

# Run the dashboard app
if __name__ == "__main__":
    # Default port for dashboard is 8080
    dashboard_port = int(os.environ.get("DASHBOARD_PORT", "8080"))
    logging.info(f"Starting dashboard on port {dashboard_port}")
    app.run(host="0.0.0.0", port=dashboard_port)