#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: async_operations.py
Implements asynchronous API operations for QNet
"""

import uuid
import time
import threading
import logging
import json
from concurrent.futures import ThreadPoolExecutor
from functools import wraps
from flask import request, jsonify, Blueprint

# Initialize logger
logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

class AsyncRequestHandler:
    """Handler for asynchronous API requests"""
    
    def __init__(self, max_workers=10, task_ttl=3600):
        """
        Initialize async request handler
        
        Args:
            max_workers: Maximum number of concurrent worker threads
            task_ttl: Time to live for completed tasks (seconds)
        """
        self.executor = ThreadPoolExecutor(max_workers=max_workers)
        self.pending_tasks = {}  # {task_id: task_info}
        self.lock = threading.RLock()
        self.task_ttl = task_ttl
        
        # Start cleanup thread
        self.stop_event = threading.Event()
        self.cleanup_thread = threading.Thread(target=self._cleanup_loop, daemon=True)
        self.cleanup_thread.start()
    
    def submit_task(self, task_id, func, *args, **kwargs):
        """
        Submit async task and return task ID
        
        Args:
            task_id: Unique task identifier (generate one if None)
            func: Function to execute
            *args, **kwargs: Arguments to pass to the function
            
        Returns:
            str: Task ID
        """
        with self.lock:
            # Generate task ID if not provided
            if task_id is None:
                task_id = str(uuid.uuid4())
            
            # Submit task to executor
            future = self.executor.submit(func, *args, **kwargs)
            
            # Store task info
            self.pending_tasks[task_id] = {
                "future": future,
                "submitted_at": time.time(),
                "args": args,
                "kwargs": kwargs,
                "status": "running",
                "result": None,
                "error": None,
                "complete": False
            }
            
            # Add completion callback
            future.add_done_callback(lambda f: self._handle_completion(task_id, f))
            
            return task_id
    
    def _handle_completion(self, task_id, future):
        """
        Handle task completion
        
        Args:
            task_id: Task ID
            future: Future object
        """
        with self.lock:
            if task_id not in self.pending_tasks:
                return
            
            task = self.pending_tasks[task_id]
            task["complete"] = True
            
            try:
                result = future.result()
                task["status"] = "completed"
                task["result"] = result
            except Exception as e:
                task["status"] = "failed"
                task["error"] = str(e)
                logger.error(f"Async task {task_id} failed: {e}")
    
    def get_task_result(self, task_id, wait=False, timeout=None):
        """
        Get result of async task
        
        Args:
            task_id: Task ID
            wait: Whether to wait for completion if not done
            timeout: Timeout in seconds (if wait is True)
            
        Returns:
            tuple: (task_info, error_message)
        """
        with self.lock:
            if task_id not in self.pending_tasks:
                return None, "Task not found"
                
            task = self.pending_tasks[task_id]
            future = task["future"]
            
            if not future.done() and not wait:
                return {
                    "task_id": task_id,
                    "status": task["status"],
                    "submitted_at": task["submitted_at"]
                }, None
                
            try:
                if wait and not future.done():
                    result = future.result(timeout=timeout)
                else:
                    # Get result if done, don't wait
                    if future.done():
                        if task["error"]:
                            return {
                                "task_id": task_id,
                                "status": task["status"],
                                "error": task["error"],
                                "submitted_at": task["submitted_at"],
                                "completed_at": task.get("completed_at")
                            }, None
                        else:
                            return {
                                "task_id": task_id,
                                "status": task["status"],
                                "result": task["result"],
                                "submitted_at": task["submitted_at"],
                                "completed_at": task.get("completed_at")
                            }, None
                    else:
                        return {
                            "task_id": task_id,
                            "status": "running",
                            "submitted_at": task["submitted_at"]
                        }, None
                
            except TimeoutError:
                return {
                    "task_id": task_id,
                    "status": "running",
                    "submitted_at": task["submitted_at"]
                }, "Task timed out"
                
            except Exception as e:
                # Record error
                task["status"] = "failed"
                task["error"] = str(e)
                task["completed_at"] = time.time()
                
                return {
                    "task_id": task_id,
                    "status": "failed",
                    "error": str(e),
                    "submitted_at": task["submitted_at"],
                    "completed_at": task["completed_at"]
                }, None
    
    def cancel_task(self, task_id):
        """
        Cancel pending task
        
        Args:
            task_id: Task ID
            
        Returns:
            bool: True if cancelled, False otherwise
        """
        with self.lock:
            if task_id not in self.pending_tasks:
                return False
                
            task = self.pending_tasks[task_id]
            future = task["future"]
            
            # Try to cancel
            cancelled = future.cancel()
            
            if cancelled:
                task["status"] = "cancelled"
                task["completed_at"] = time.time()
                
            return cancelled
    
    def _cleanup_loop(self):
        """Background thread for cleaning up old tasks"""
        while not self.stop_event.is_set():
            try:
                time.sleep(300)  # Check every 5 minutes
                now = time.time()
                
                with self.lock:
                    # Find tasks to clean up
                    tasks_to_remove = []
                    
                    for task_id, task in self.pending_tasks.items():
                        # Remove completed tasks after TTL
                        if task.get("complete", False):
                            completed_at = task.get("completed_at", task["submitted_at"])
                            if now - completed_at > self.task_ttl:
                                tasks_to_remove.append(task_id)
                        # Remove very old running tasks (24 hours)
                        elif now - task["submitted_at"] > 86400:
                            # Try to cancel first
                            future = task["future"]
                            future.cancel()
                            tasks_to_remove.append(task_id)
                    
                    # Remove tasks
                    for task_id in tasks_to_remove:
                        del self.pending_tasks[task_id]
                        
                    if tasks_to_remove:
                        logger.info(f"Cleaned up {len(tasks_to_remove)} old async tasks")
                        
            except Exception as e:
                logger.error(f"Error in async task cleanup: {e}")
    
    def get_pending_tasks(self):
        """
        Get list of pending tasks
        
        Returns:
            list: List of task info dictionaries
        """
        with self.lock:
            return [
                {
                    "task_id": task_id,
                    "status": task_info["status"],
                    "submitted_at": task_info["submitted_at"],
                    "completed_at": task_info.get("completed_at")
                }
                for task_id, task_info in self.pending_tasks.items()
            ]
    
    def shutdown(self):
        """Shutdown the async handler"""
        self.stop_event.set()
        self.executor.shutdown(wait=False)
        
        if self.cleanup_thread.is_alive():
            self.cleanup_thread.join(timeout=5)

# Create global async handler instance
async_handler = AsyncRequestHandler()

# Create Blueprint for async API endpoints
async_api_bp = Blueprint('async_api', __name__, url_prefix='/api/v1/async')

@async_api_bp.route('/tasks', methods=['GET'])
def list_tasks():
    """List all pending tasks"""
    tasks = async_handler.get_pending_tasks()
    return jsonify({
        "count": len(tasks),
        "tasks": tasks
    })

@async_api_bp.route('/task/<task_id>', methods=['GET'])
def get_task(task_id):
    """Get task status and result"""
    wait = request.args.get('wait', 'false').lower() == 'true'
    timeout = float(request.args.get('timeout', 5)) if wait else None
    
    task_info, error = async_handler.get_task_result(task_id, wait, timeout)
    
    if task_info is None:
        return jsonify({
            "error": error
        }), 404
    
    if error:
        return jsonify({
            "task_id": task_id,
            "status": "timeout",
            "error": error
        }), 408
    
    return jsonify(task_info)

@async_api_bp.route('/task/<task_id>', methods=['DELETE'])
def cancel_task(task_id):
    """Cancel a task"""
    success = async_handler.cancel_task(task_id)
    
    if not success:
        return jsonify({
            "error": "Failed to cancel task"
        }), 400
    
    return jsonify({
        "task_id": task_id,
        "status": "cancelled"
    })

# Decorator for making endpoints asynchronous
def async_endpoint(func):
    """
    Decorator to make a Flask endpoint function asynchronous
    
    The decorated function runs in a background thread and returns immediately
    with a task ID. The result can be retrieved later with the task ID.
    """
    @wraps(func)
    def wrapper(*args, **kwargs):
        # Get data from request for task
        task_data = {}
        
        if request.method == 'POST' and request.is_json:
            task_data = request.get_json()
        elif request.method == 'GET':
            task_data = request.args.to_dict()
        
        # Generate task ID
        task_id = str(uuid.uuid4())
        
        # Submit function to async handler
        async_handler.submit_task(task_id, func, task_data, *args, **kwargs)
        
        # Return task ID immediately
        return jsonify({
            "task_id": task_id,
            "status": "submitted",
            "result_url": f"/api/v1/async/task/{task_id}"
        })
    
    return wrapper

# Register the blueprint with a Flask app
def register_async_endpoints(app):
    """Register async endpoints with Flask app"""
    app.register_blueprint(async_api_bp)
    logger.info("Async API endpoints registered")