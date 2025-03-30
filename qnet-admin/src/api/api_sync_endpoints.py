#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: api_sync_endpoints.py
API endpoints for fast synchronization.
"""

import os
import json
import time
import logging
import sqlite3
import threading
from flask import send_file, jsonify, request, abort
from werkzeug.utils import secure_filename

def register_sync_endpoints(app, sync_manager):
   """Register synchronization API endpoints to a Flask app"""
   
   @app.route('/api/v1/snapshot/latest', methods=['GET'])
   def get_latest_snapshot():
       """Get information about the latest snapshot"""
       try:
           # Get latest snapshot from database
           conn = sqlite3.connect(sync_manager.db_path)
           cursor = conn.cursor()
           
           cursor.execute("""
               SELECT height, hash, timestamp, path FROM snapshots 
               ORDER BY height DESC LIMIT 1
           """)
           
           result = cursor.fetchone()
           conn.close()
           
           if not result:
               return jsonify({"error": "No snapshots available"}), 404
               
           height, hash_value, timestamp, path = result
           
           snapshot_info = {
               "id": hash_value,
               "height": height,
               "hash": hash_value,
               "timestamp": timestamp,
               "size": os.path.getsize(path) if os.path.exists(path) else 0
           }
           
           return jsonify(snapshot_info), 200
       except Exception as e:
           logging.error(f"Error getting latest snapshot: {e}")
           return jsonify({"error": str(e)}), 500
   
   @app.route('/api/v1/snapshot/list', methods=['GET'])
   def list_snapshots():
       """List available snapshots"""
       try:
           # Get snapshots from database
           conn = sqlite3.connect(sync_manager.db_path)
           cursor = conn.cursor()
           
           cursor.execute("""
               SELECT height, hash, timestamp, path FROM snapshots 
               ORDER BY height DESC
           """)
           
           snapshots = []
           for height, hash_value, timestamp, path in cursor.fetchall():
               snapshots.append({
                   "id": hash_value,
                   "height": height,
                   "hash": hash_value,
                   "timestamp": timestamp,
                   "size": os.path.getsize(path) if os.path.exists(path) else 0
               })
           
           conn.close()
           
           return jsonify({"snapshots": snapshots}), 200
       except Exception as e:
           logging.error(f"Error listing snapshots: {e}")
           return jsonify({"error": str(e)}), 500
   
   @app.route('/api/v1/snapshot/download/<snapshot_id>', methods=['GET'])
   def download_snapshot(snapshot_id):
       """Download a specific snapshot by its ID (hash)"""
       try:
           # Find snapshot in database
           conn = sqlite3.connect(sync_manager.db_path)
           cursor = conn.cursor()
           
           cursor.execute("""
               SELECT path FROM snapshots 
               WHERE hash = ?
           """, (snapshot_id,))
           
           result = cursor.fetchone()
           conn.close()
           
           if not result:
               return jsonify({"error": "Snapshot not found"}), 404
               
           path = result[0]
           
           if not os.path.exists(path):
               return jsonify({"error": "Snapshot file not found"}), 404
               
           return send_file(path, as_attachment=True)
       except Exception as e:
           logging.error(f"Error downloading snapshot: {e}")
           return jsonify({"error": str(e)}), 500
   
   @app.route('/api/v1/snapshot/create', methods=['POST'])
   def create_snapshot_endpoint():
       """Create a new snapshot"""
       try:
           # Create snapshot
           snapshot_path = sync_manager.create_snapshot()
           
           if not snapshot_path:
               return jsonify({"error": "Failed to create snapshot"}), 500
               
           # Get snapshot info
           conn = sqlite3.connect(sync_manager.db_path)
           cursor = conn.cursor()
           
           cursor.execute("""
               SELECT height, hash, timestamp FROM snapshots 
               WHERE path = ?
           """, (snapshot_path,))
           
           result = cursor.fetchone()
           conn.close()
           
           if not result:
               return jsonify({"error": "Snapshot created but not found in database"}), 500
               
           height, hash_value, timestamp = result
           
           snapshot_info = {
               "id": hash_value,
               "height": height,
               "hash": hash_value,
               "timestamp": timestamp,
               "path": snapshot_path,
               "size": os.path.getsize(snapshot_path)
           }
           
           return jsonify(snapshot_info), 200
       except Exception as e:
           logging.error(f"Error creating snapshot: {e}")
           return jsonify({"error": str(e)}), 500
   
   @app.route('/api/v1/sync/stats', methods=['GET'])
   def get_sync_stats():
       """Get synchronization statistics"""
       try:
           stats = sync_manager.get_sync_stats()
           return jsonify(stats), 200
       except Exception as e:
           logging.error(f"Error getting sync stats: {e}")
           return jsonify({"error": str(e)}), 500
   
   @app.route('/api/v1/sync/fast', methods=['POST'])
   def trigger_fast_sync():
       """Trigger a fast sync operation"""
       try:
           if sync_manager.is_syncing:
               return jsonify({"error": "Sync already in progress"}), 400
               
           # Get target peer from request if provided
           target_peer = None
           data = request.get_json()
           if data and "peer" in data:
               target_peer = data["peer"]
               
           # Start sync in a background thread to not block the API
           def do_sync():
               sync_manager.fast_sync(target_peer)
           
           threading.Thread(target=do_sync).start()
           
           return jsonify({"message": "Fast sync started"}), 200
       except Exception as e:
           logging.error(f"Error triggering fast sync: {e}")
           return jsonify({"error": str(e)}), 500
   
   @app.route('/api/v1/sync/headers', methods=['POST'])
   def trigger_header_sync():
       """Trigger a header-only sync operation"""
       try:
           if sync_manager.is_syncing:
               return jsonify({"error": "Sync already in progress"}), 400
               
           # Get target peer from request if provided
           target_peer = None
           data = request.get_json()
           if data and "peer" in data:
               target_peer = data["peer"]
               
           # Start sync in a background thread to not block the API
           def do_sync():
               sync_manager.sync_headers(target_peer)
           
           threading.Thread(target=do_sync).start()
           
           return jsonify({"message": "Header sync started"}), 200
       except Exception as e:
           logging.error(f"Error triggering header sync: {e}")
           return jsonify({"error": str(e)}), 500