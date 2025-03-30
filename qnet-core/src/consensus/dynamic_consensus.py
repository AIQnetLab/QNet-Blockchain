#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: dynamic_consensus.py
Implements adaptive timing for consensus phases based on network conditions
with improved performance and metrics collection.
"""

import time
import logging
import threading
import math
import random
import statistics
import requests
import json
from typing import Dict, List, Tuple, Optional, Any, Union
from collections import deque

class NetworkMetrics:
    """
    Collects and analyzes network metrics to optimize consensus timing
    """
    def __init__(self, window_size: int = 20):
        """
        Initialize the network metrics tracker
        
        Args:
            window_size: Number of data points to keep for metrics calculation
        """
        self.window_size = window_size
        self.latencies: Dict[str, List[float]] = {}  # peer -> list of latencies
        self.response_rates: Dict[str, List[float]] = {}  # peer -> list of response rates (0-1)
        self.broadcast_times: List[Tuple[int, float]] = []  # (message size, time)
        
        # Use RLock for thread safety
        self.lock = threading.RLock()
        
        # Performance metrics
        self.average_latency = 1.0  # Default to 1 second until we have real data
        self.latency_std_dev = 0.2
        self.network_reliability = 1.0
        self.p90_latency = 2.0
        
        # Store percentiles for better analysis
        self.p50_latency = 1.0
        self.p95_latency = 3.0
        self.p99_latency = 5.0
        
        # Track recent network events for anomaly detection
        self.recent_network_events = deque(maxlen=100)
        
        # Last update time
        self.last_update = time.time()
        
        # Network status indicators
        self.network_status = "healthy"  # Can be "healthy", "degraded", "unstable"
        self.network_congestion = 0.0  # 0.0 (none) to 1.0 (severe)
        
        logging.info("Network metrics tracker initialized")
    
    def record_peer_latency(self, peer: str, latency: float) -> None:
        """
        Record latency for a specific peer
        
        Args:
            peer: Peer address
            latency: Measured latency in seconds
        """
        if not isinstance(latency, (int, float)) or latency < 0:
            logging.warning(f"Invalid latency value for {peer}: {latency}")
            return
            
        with self.lock:
            if peer not in self.latencies:
                self.latencies[peer] = []
            
            self.latencies[peer].append(latency)
            
            # Keep only the last window_size values
            if len(self.latencies[peer]) > self.window_size:
                self.latencies[peer] = self.latencies[peer][-self.window_size:]
                
            # Record as network event for anomaly detection
            event_time = time.time()
            self.recent_network_events.append({
                "type": "latency",
                "peer": peer,
                "value": latency,
                "timestamp": event_time
            })
    
    def record_peer_response(self, peer: str, success: bool) -> None:
        """
        Record successful or failed communication with a peer
        
        Args:
            peer: Peer address
            success: Whether the communication was successful
        """
        with self.lock:
            if peer not in self.response_rates:
                self.response_rates[peer] = []
            
            self.response_rates[peer].append(1.0 if success else 0.0)
            
            # Keep only the last window_size values
            if len(self.response_rates[peer]) > self.window_size:
                self.response_rates[peer] = self.response_rates[peer][-self.window_size:]
                
            # Record as network event for anomaly detection
            event_time = time.time()
            self.recent_network_events.append({
                "type": "response",
                "peer": peer,
                "value": 1.0 if success else 0.0,
                "timestamp": event_time
            })
    
    def record_broadcast_time(self, message_size: int, broadcast_time: float) -> None:
        """
        Record time taken to broadcast a message of specific size
        
        Args:
            message_size: Size of the broadcast message in bytes
            broadcast_time: Time taken to broadcast to all peers
        """
        if not isinstance(broadcast_time, (int, float)) or broadcast_time < 0:
            logging.warning(f"Invalid broadcast time: {broadcast_time}")
            return
            
        with self.lock:
            self.broadcast_times.append((message_size, broadcast_time))
            
            # Keep only the last window_size values
            if len(self.broadcast_times) > self.window_size:
                self.broadcast_times = self.broadcast_times[-self.window_size:]
                
            # Record as network event
            event_time = time.time()
            self.recent_network_events.append({
                "type": "broadcast",
                "message_size": message_size,
                "value": broadcast_time,
                "timestamp": event_time
            })
    
    def update_metrics(self) -> None:
        """
        Update calculated metrics based on collected data
        """
        with self.lock:
            # Don't update too frequently
            if time.time() - self.last_update < 60:  # 60 seconds
                return
            
            self.last_update = time.time()
            
            # Calculate average latency across all peers
            all_latencies = []
            for peer_latencies in self.latencies.values():
                all_latencies.extend(peer_latencies)
            
            if all_latencies:
                try:
                    self.average_latency = statistics.mean(all_latencies)
                    
                    # Calculate standard deviation
                    if len(all_latencies) > 1:
                        self.latency_std_dev = statistics.stdev(all_latencies)
                    
                    # Calculate percentile latencies
                    sorted_latencies = sorted(all_latencies)
                    n = len(sorted_latencies)
                    
                    self.p50_latency = sorted_latencies[int(n * 0.5)] if n > 0 else 1.0
                    self.p90_latency = sorted_latencies[int(n * 0.9)] if n > 0 else 2.0
                    self.p95_latency = sorted_latencies[int(n * 0.95)] if n > 0 else 3.0
                    self.p99_latency = sorted_latencies[int(n * 0.99)] if n > 0 else 5.0
                except (ValueError, TypeError, IndexError) as e:
                    logging.error(f"Error calculating latency metrics: {e}")
            
            # Calculate network reliability
            all_responses = []
            for peer_responses in self.response_rates.values():
                all_responses.extend(peer_responses)
            
            if all_responses:
                try:
                    self.network_reliability = statistics.mean(all_responses)
                except (ValueError, TypeError) as e:
                    logging.error(f"Error calculating network reliability: {e}")
            
            # Analyze broadcast times
            if self.broadcast_times:
                try:
                    # Check if broadcast times are increasing over time
                    recent_broadcasts = self.broadcast_times[-min(10, len(self.broadcast_times)):]
                    if len(recent_broadcasts) >= 5:
                        times = [t for _, t in recent_broadcasts]
                        if all(times[i] > times[i-1] for i in range(1, len(times))):
                            self.network_congestion = min(1.0, self.network_congestion + 0.1)
                        else:
                            self.network_congestion = max(0.0, self.network_congestion - 0.05)
                except Exception as e:
                    logging.error(f"Error analyzing broadcast times: {e}")
            
            # Determine network status
                try:
                    # Analyze recent events for network status
                    if self.network_reliability < 0.7:
                        self.network_status = "unstable"
                    elif self.network_reliability < 0.9 or self.network_congestion > 0.5:
                        self.network_status = "degraded"
                    else:
                        self.network_status = "healthy"
                except Exception as e:
                    logging.error(f"Error determining network status: {e}")
            
            logging.info(f"Network metrics updated: Avg latency = {self.average_latency:.3f}s, "
                        f"P90 latency = {self.p90_latency:.3f}s, "
                        f"Reliability = {self.network_reliability:.2f}, "
                        f"Status = {self.network_status}")
    
    def analyze_anomalies(self) -> Dict[str, Any]:
        """
        Analyze recent network events for anomalies
        
        Returns:
            Dictionary with anomaly information
        """
        with self.lock:
            anomalies = []
            
            # Check for sudden latency spikes
            latency_events = [e for e in self.recent_network_events if e["type"] == "latency"]
            if len(latency_events) >= 10:
                recent_latencies = [e["value"] for e in latency_events[-10:]]
                older_latencies = [e["value"] for e in latency_events[-20:-10]] if len(latency_events) >= 20 else []
                
                if older_latencies:
                    recent_avg = statistics.mean(recent_latencies)
                    older_avg = statistics.mean(older_latencies)
                    
                    # If recent latencies are much higher than older ones
                    if recent_avg > older_avg * 2:
                        anomalies.append({
                            "type": "latency_spike",
                            "severity": "high" if recent_avg > older_avg * 5 else "medium",
                            "details": f"Latency increased from {older_avg:.2f}s to {recent_avg:.2f}s"
                        })
            
            # Check for connection failures
            response_events = [e for e in self.recent_network_events if e["type"] == "response"]
            if len(response_events) >= 10:
                recent_responses = [e["value"] for e in response_events[-10:]]
                if sum(recent_responses) < len(recent_responses) * 0.7:
                    failure_rate = 1.0 - (sum(recent_responses) / len(recent_responses))
                    anomalies.append({
                        "type": "connection_failures",
                        "severity": "high" if failure_rate > 0.5 else "medium",
                        "details": f"Connection failure rate is {failure_rate:.2%}"
                    })
            
            return {
                "anomalies": anomalies,
                "count": len(anomalies),
                "network_status": self.network_status,
                "timestamp": time.time()
            }
    
    def ping_peers(self, peers: List[str], timeout: float = 1.0) -> None:
        """
        Ping peers to measure latency and reliability
        
        Args:
            peers: List of peer addresses to ping
            timeout: Maximum time to wait for response (seconds)
        """
        if not peers:
            logging.warning("No peers to ping")
            return
            
        for peer in peers:
            try:
                start_time = time.time()
                response = requests.head(f"http://{peer}/", timeout=timeout)
                end_time = time.time()
                
                latency = end_time - start_time
                success = response.status_code >= 200 and response.status_code < 300
                
                self.record_peer_latency(peer, latency)
                self.record_peer_response(peer, success)
            except requests.RequestException as e:
                logging.debug(f"Request exception when pinging {peer}: {e}")
                self.record_peer_response(peer, False)
            except Exception as e:
                logging.error(f"Unexpected error when pinging {peer}: {e}")
                self.record_peer_response(peer, False)
        
        # Update metrics after pinging all peers
        self.update_metrics()
    
    def get_metrics_report(self) -> Dict[str, Any]:
        """
        Get a comprehensive report of network metrics
        
        Returns:
            Dictionary with network metrics
        """
        with self.lock:
            # Get peer-specific metrics
            peer_metrics = {}
            for peer, latencies in self.latencies.items():
                if latencies:
                    avg_latency = statistics.mean(latencies) if latencies else 0
                    
                    responses = self.response_rates.get(peer, [])
                    reliability = statistics.mean(responses) if responses else 0
                    
                    peer_metrics[peer] = {
                        "avg_latency": avg_latency,
                        "reliability": reliability,
                        "data_points": len(latencies)
                    }
            
            return {
                "average_latency": self.average_latency,
                "p50_latency": self.p50_latency,
                "p90_latency": self.p90_latency,
                "p95_latency": self.p95_latency,
                "p99_latency": self.p99_latency,
                "network_reliability": self.network_reliability,
                "network_status": self.network_status,
                "network_congestion": self.network_congestion,
                "peers": peer_metrics,
                "anomalies": self.analyze_anomalies()["anomalies"],
                "timestamp": time.time()
            }

class AdaptiveConsensusTimer:
    """
    Implements adaptive timing for consensus phases based on network conditions
    """
    def __init__(self, network_metrics: NetworkMetrics, config: Any):
        """
        Initialize the adaptive consensus timer
        
        Args:
            network_metrics: Network metrics tracker
            config: Configuration object
        """
        self.network_metrics = network_metrics
        self.config = config
        
        # Default timing parameters (seconds)
        self.min_commit_time = 15
        self.max_commit_time = 45
        self.min_reveal_time = 15
        self.max_reveal_time = 45
        
        # Safety factor to account for network variability
        self.safety_factor = 1.5
        
        # Track consensus phases with timing
        self.phase_stats: Dict[str, List[Tuple[float, int, int]]] = {
            "commit": [],  # (duration, success_count, total_count)
            "reveal": []   # (duration, success_count, total_count)
        }
        
        # Current recommended timings
        self.current_commit_time = 30  # seconds
        self.current_reveal_time = 30  # seconds
        
        # Track round performance
        self.round_performance: Dict[int, Dict[str, Any]] = {}  # round -> performance stats
        
        # Use lock for thread safety
        self.lock = threading.RLock()
        logging.info("Adaptive consensus timer initialized")
    
    def record_phase_result(self, phase: str, duration: float, success_count: int, total_count: int) -> None:
        """
        Record the result of a consensus phase
        
        Args:
            phase: Consensus phase (commit or reveal)
            duration: Time the phase took in seconds
            success_count: Number of successful participants
            total_count: Total number of eligible participants
        """
        if phase not in ["commit", "reveal"]:
            logging.warning(f"Unknown phase: {phase}")
            return
            
        if not isinstance(duration, (int, float)) or duration <= 0:
            logging.warning(f"Invalid duration for phase {phase}: {duration}")
            return
            
        if not isinstance(success_count, int) or success_count < 0:
            logging.warning(f"Invalid success count for phase {phase}: {success_count}")
            return
            
        if not isinstance(total_count, int) or total_count <= 0:
            logging.warning(f"Invalid total count for phase {phase}: {total_count}")
            return
            
        if success_count > total_count:
            logging.warning(f"Success count {success_count} greater than total count {total_count}")
            success_count = total_count
        
        with self.lock:
            if phase not in self.phase_stats:
                self.phase_stats[phase] = []
            
            self.phase_stats[phase].append((duration, success_count, total_count))
            
            # Keep only the last 20 phases
            if len(self.phase_stats[phase]) > 20:
                self.phase_stats[phase] = self.phase_stats[phase][-20:]
            
            # Recalculate timing
            self._recalculate_timings()
    
    def record_round_performance(self, round_num: int, phases: Dict[str, Dict[str, Any]]) -> None:
        """
        Record performance statistics for a complete consensus round
        
        Args:
            round_num: Consensus round number
            phases: Dictionary with performance data for each phase
        """
        with self.lock:
            self.round_performance[round_num] = {
                "phases": phases,
                "timestamp": time.time()
            }
            
            # Keep only the last 50 rounds
            if len(self.round_performance) > 50:
                oldest_round = min(self.round_performance.keys())
                del self.round_performance[oldest_round]
    
    def _recalculate_timings(self) -> None:
        """
        Recalculate optimal timings based on collected data
        """
        # Update from network metrics
        self.network_metrics.update_metrics()
        
        # Calculate new commit time
        commit_data = self.phase_stats.get("commit", [])
        if commit_data:
            try:
                # Calculate success rate
                success_rates = [success / total for _, success, total in commit_data if total > 0]
                avg_success_rate = statistics.mean(success_rates) if success_rates else 0.5
                
                # Calculate optimal time based on network metrics and past performance
                base_time = self.network_metrics.p90_latency * 2  # Round trip time for messages
                reliability_factor = 1 / max(0.5, self.network_metrics.network_reliability)
                success_factor = 1 / max(0.5, avg_success_rate)
                
                # Apply additional factor based on network status
                status_factor = 1.0
                if self.network_metrics.network_status == "degraded":
                    status_factor = 1.2
                elif self.network_metrics.network_status == "unstable":
                    status_factor = 1.5
                
                new_commit_time = base_time * self.safety_factor * reliability_factor * success_factor * status_factor
                
                # Clamp to reasonable values
                self.current_commit_time = max(self.min_commit_time, 
                                             min(self.max_commit_time, new_commit_time))
            except (ValueError, TypeError, ZeroDivisionError) as e:
                logging.error(f"Error recalculating commit time: {e}")
        
        # Calculate new reveal time (similar approach)
        reveal_data = self.phase_stats.get("reveal", [])
        if reveal_data:
            try:
                # Calculate success rate
                success_rates = [success / total for _, success, total in reveal_data if total > 0]
                avg_success_rate = statistics.mean(success_rates) if success_rates else 0.5
                
                # Calculate optimal time based on network metrics and past performance
                base_time = self.network_metrics.p90_latency * 2  # Round trip time for messages
                reliability_factor = 1 / max(0.5, self.network_metrics.network_reliability)
                success_factor = 1 / max(0.5, avg_success_rate)
                
                # Apply additional factor based on network status
                status_factor = 1.0
                if self.network_metrics.network_status == "degraded":
                    status_factor = 1.2
                elif self.network_metrics.network_status == "unstable":
                    status_factor = 1.5
                
                new_reveal_time = base_time * self.safety_factor * reliability_factor * success_factor * status_factor
                
                # Clamp to reasonable values
                self.current_reveal_time = max(self.min_reveal_time, 
                                             min(self.max_reveal_time, new_reveal_time))
            except (ValueError, TypeError, ZeroDivisionError) as e:
                logging.error(f"Error recalculating reveal time: {e}")
        
        logging.info(f"Recalculated consensus timings: Commit = {self.current_commit_time:.1f}s, "
                    f"Reveal = {self.current_reveal_time:.1f}s")
    
    def get_commit_wait_time(self) -> Tuple[float, float]:
        """
        Get recommended commit phase timing with randomization
        
        Returns:
            Tuple of (base_time, random_offset)
        """
        with self.lock:
            base_time = self.current_commit_time
            # Add randomness to prevent synchronization issues (±10%)
            max_offset = base_time * 0.1
            return base_time, max_offset
    
    def get_reveal_wait_time(self) -> Tuple[float, float]:
        """
        Get recommended reveal phase timing with randomization
        
        Returns:
            Tuple of (base_time, random_offset)
        """
        with self.lock:
            base_time = self.current_reveal_time
            # Add randomness to prevent synchronization issues (±10%)
            max_offset = base_time * 0.1
            return base_time, max_offset
    
    def get_timing_report(self) -> Dict[str, Any]:
        """
        Get a report of current consensus timing parameters
        
        Returns:
            Dictionary with timing information
        """
        with self.lock:
            commit_data = self.phase_stats.get("commit", [])
            reveal_data = self.phase_stats.get("reveal", [])
            
            # Calculate statistics for commit phase
            commit_stats = {}
            if commit_data:
                durations = [duration for duration, _, _ in commit_data]
                success_rates = [success / total for _, success, total in commit_data if total > 0]
                
                commit_stats = {
                    "average_duration": statistics.mean(durations) if durations else 0,
                    "average_success_rate": statistics.mean(success_rates) if success_rates else 0,
                    "data_points": len(commit_data)
                }
            
            # Calculate statistics for reveal phase
            reveal_stats = {}
            if reveal_data:
                durations = [duration for duration, _, _ in reveal_data]
                success_rates = [success / total for _, success, total in reveal_data if total > 0]
                
                reveal_stats = {
                    "average_duration": statistics.mean(durations) if durations else 0,
                    "average_success_rate": statistics.mean(success_rates) if success_rates else 0,
                    "data_points": len(reveal_data)
                }
            
            return {
                "current_commit_time": self.current_commit_time,
                "current_reveal_time": self.current_reveal_time,
                "safety_factor": self.safety_factor,
                "min_commit_time": self.min_commit_time,
                "max_commit_time": self.max_commit_time,
                "min_reveal_time": self.min_reveal_time,
                "max_reveal_time": self.max_reveal_time,
                "commit_stats": commit_stats,
                "reveal_stats": reveal_stats,
                "network_status": self.network_metrics.network_status,
                "network_reliability": self.network_metrics.network_reliability,
                "timestamp": time.time()
            }
    
    def start_monitoring(self, peers: List[str], interval: int = 60) -> threading.Thread:
        """
        Start a background thread to monitor network conditions
        
        Args:
            peers: List of peer addresses to monitor
            interval: Interval between checks in seconds
            
        Returns:
            The monitoring thread
        """
        if not peers:
            logging.warning("No peers provided for monitoring")
            peers = []
            
        def _monitor_loop():
            while True:
                try:
                    if peers:
                        self.network_metrics.ping_peers(peers)
                    time.sleep(max(1, interval))
                except Exception as e:
                    logging.error(f"Error in network monitoring: {e}")
                    time.sleep(10)  # Wait a bit before trying again
        
        monitor_thread = threading.Thread(target=_monitor_loop, daemon=True)
        monitor_thread.start()
        return monitor_thread

# Example usage:
if __name__ == "__main__":
    # Configure logging
    logging.basicConfig(level=logging.INFO,
                       format='%(asctime)s [%(levelname)s] %(message)s')
    
    # Initialize network metrics tracker
    network_metrics = NetworkMetrics()
    
    # Initialize adaptive timer with a mock config
    config = {}
    timer = AdaptiveConsensusTimer(network_metrics, config)
    
    # Start network monitoring with some sample peers
    peers = ["localhost:8000", "localhost:8001"]
    timer.start_monitoring(peers)
    
    # Simulate some phase results
    timer.record_phase_result("commit", 25.0, 3, 5)
    timer.record_phase_result("reveal", 25.0, 4, 5)
    
    # Get timing recommendations
    commit_time, commit_offset = timer.get_commit_wait_time()
    reveal_time, reveal_offset = timer.get_reveal_wait_time()
    
    print(f"Recommended commit time: {commit_time}s ± {commit_offset}s")
    print(f"Recommended reveal time: {reveal_time}s ± {reveal_offset}s")
    
    # Get timing report
    timing_report = timer.get_timing_report()
    print(json.dumps(timing_report, indent=2))