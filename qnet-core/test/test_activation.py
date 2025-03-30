#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: test_activation.py
QNet Activation System Test Suite
Performs automated testing of the activation system components
"""

import unittest
import requests
import time
import json
import os
import subprocess
import threading
import logging
from concurrent.futures import ThreadPoolExecutor

# Configure logging - compact format for minimal data transfer
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler("qnet_tests.log"),
        logging.StreamHandler()
    ]
)

logger = logging.getLogger(__name__)

class QNetAPITests(unittest.TestCase):
    """Test suite for QNet API functionality"""
    
    API_BASE = "http://localhost:8000/api/v1"
    
    def setUp(self):
        """Setup test environment"""
        self.test_wallet = "test_wallet1"
        # Create test activation code if needed
        self._ensure_test_code()
    
    def _ensure_test_code(self):
        """Make sure we have a test activation code"""
        try:
            response = requests.post(
                f"{self.API_BASE}/token/generate_code",
                json={"wallet_address": self.test_wallet}
            )
            if response.status_code == 201:
                self.test_code = response.json()["activation_code"]
                logger.info(f"Generated test activation code: {self.test_code}")
            else:
                self.test_code = "QNET-TEST-TEST-TEST"
                logger.warning(f"Using fallback test code: {self.test_code}")
        except Exception as e:
            logger.error(f"Error generating test code: {e}")
            self.test_code = "QNET-TEST-TEST-TEST"
    
    def test_generate_code(self):
        """Test code generation endpoint"""
        response = requests.post(
            f"{self.API_BASE}/token/generate_code",
            json={"wallet_address": self.test_wallet}
        )
        self.assertEqual(response.status_code, 201)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertTrue("activation_code" in data)
        logger.info(f"Generated activation code: {data['activation_code']}")
    
    def test_verify_code(self):
        """Test code verification endpoint"""
        node_id = "test_node_" + str(int(time.time()))
        response = requests.post(
            f"{self.API_BASE}/token/verify_code",
            json={
                "activation_code": self.test_code,
                "node_id": node_id,
                "node_address": "127.0.0.1:8000"
            }
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        logger.info(f"Verified code successfully: {data['message']}")
    
    def test_get_wallet_codes(self):
        """Test getting codes for a wallet"""
        response = requests.get(
            f"{self.API_BASE}/token/wallet_codes/{self.test_wallet}"
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        logger.info(f"Found {len(data['codes'])} codes for wallet")
        # Print some details of first code if available
        if data['codes']:
            first_code = data['codes'][0]
            logger.info(f"Sample code: {first_code['code']}, Status: {first_code['status']}")
    
    def test_node_transfer_flow(self):
        """Test the complete node transfer flow"""
        # 1. Generate a code to transfer
        node_id_old = "test_old_node_" + str(int(time.time()))
        node_id_new = "test_new_node_" + str(int(time.time()))
        
        # First activate the code on old node
        response = requests.post(
            f"{self.API_BASE}/token/verify_code",
            json={
                "activation_code": self.test_code,
                "node_id": node_id_old,
                "node_address": "127.0.0.1:8001"
            }
        )
        self.assertEqual(response.status_code, 200)
        
        # 2. Initiate transfer
        response = requests.post(
            f"{self.API_BASE}/node/transfer/initiate",
            json={
                "activation_code": self.test_code,
                "wallet_address": self.test_wallet
            }
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue("transfer_code" in data)
        transfer_code = data["transfer_code"]
        logger.info(f"Generated transfer code: {transfer_code}")
        
        # 3. Use the transfer code on new node
        response = requests.post(
            f"{self.API_BASE}/token/verify_code",
            json={
                "activation_code": self.test_code,
                "node_id": node_id_new,
                "node_address": "127.0.0.1:8002",
                "signature": transfer_code
            }
        )
        self.assertEqual(response.status_code, 200)
        logger.info("Transfer verified successfully")

class LoadTestingSuite:
    """Load testing suite for QNet API"""
    
    def __init__(self, base_url="http://localhost:8000/api/v1", concurrency=10, duration=30):
        self.base_url = base_url
        self.concurrency = concurrency
        self.duration = duration
        self.results = {
            "requests": 0,
            "success": 0,
            "failure": 0,
            "response_times": [],
            "errors": []
        }
        self.stop_event = threading.Event()
        
    def run_load_test(self, endpoint, method="GET", data=None):
        """Run load test against a specific endpoint"""
        logger.info(f"Starting load test against {endpoint} with {self.concurrency} concurrent users for {self.duration}s")
        
        # Start worker threads
        with ThreadPoolExecutor(max_workers=self.concurrency) as executor:
            futures = []
            start_time = time.time()
            
            # Schedule first batch of tasks
            for _ in range(self.concurrency):
                futures.append(executor.submit(
                    self._make_request, method, endpoint, data
                ))
            
            # Main loop - keep scheduling tasks until duration is reached
            while time.time() - start_time < self.duration:
                # Check for completed tasks and schedule new ones
                for future in list(futures):
                    if future.done():
                        futures.remove(future)
                        if time.time() - start_time < self.duration:
                            futures.append(executor.submit(
                                self._make_request, method, endpoint, data
                            ))
                time.sleep(0.1)
            
            # Set stop event to signal workers to stop
            self.stop_event.set()
            
            # Wait for all remaining tasks to complete
            for future in futures:
                future.result()
        
        # Calculate statistics
        avg_time = sum(self.results["response_times"]) / max(1, len(self.results["response_times"]))
        rps = self.results["requests"] / self.duration
        
        logger.info(f"Load test completed:")
        logger.info(f"Total requests: {self.results['requests']}")
        logger.info(f"Successful: {self.results['success']} ({self.results['success']/max(1, self.results['requests'])*100:.1f}%)")
        logger.info(f"Failed: {self.results['failure']}")
        logger.info(f"Average response time: {avg_time:.2f}ms")
        logger.info(f"Requests per second: {rps:.2f}")
        
        # Log sample of errors
        if self.results["errors"]:
            logger.info(f"Sample of errors (max 5):")
            for error in self.results["errors"][:5]:
                logger.info(f"  - {error}")
        
        return {
            "requests": self.results["requests"],
            "success_rate": self.results["success"]/max(1, self.results["requests"])*100,
            "avg_response_time": avg_time,
            "rps": rps
        }
    
    def _make_request(self, method, endpoint, data=None):
        """Make a single request and record results"""
        if self.stop_event.is_set():
            return
            
        url = f"{self.base_url}/{endpoint}"
        
        try:
            start_time = time.time()
            
            if method.upper() == "GET":
                response = requests.get(url, timeout=10)
            elif method.upper() == "POST":
                response = requests.post(url, json=data, timeout=10)
            else:
                raise ValueError(f"Unsupported method: {method}")
                
            response_time = (time.time() - start_time) * 1000  # ms
            
            with threading.Lock():
                self.results["requests"] += 1
                self.results["response_times"].append(response_time)
                
                if 200 <= response.status_code < 300:
                    self.results["success"] += 1
                else:
                    self.results["failure"] += 1
                    error = f"{response.status_code}: {response.text[:100]}"
                    self.results["errors"].append(error)
                    
        except Exception as e:
            with threading.Lock():
                self.results["requests"] += 1
                self.results["failure"] += 1
                self.results["errors"].append(str(e))

def run_solana_integration_test():
    """Test integration with Solana for token verification"""
    try:
        # This requires solana Python package to be installed
        from solana.rpc.api import Client
        solana_client = Client("https://api.testnet.solana.com")
        
        # Get recent blockhash to confirm connection
        result = solana_client.get_recent_blockhash()
        logger.info(f"Connected to Solana testnet. Recent blockhash: {result['result']['value']['blockhash']}")
        
        # Try to get balance of test account
        account = "9B5XszUGdMaxCZ7uSQU3kEuZwKDJtPFvGtvPJ8bkDt3P"  # Example account
        balance_result = solana_client.get_balance(account)
        logger.info(f"Account balance: {balance_result['result']['value']} lamports")
        
        # TODO: Add SPL token balance check when integrated
        logger.info("Solana integration test completed")
        return True
    except Exception as e:
        logger.error(f"Error in Solana integration test: {e}")
        return False

if __name__ == "__main__":
    logger.info("Starting QNet test suite")
    
    # Run unit tests
    unittest.main(argv=['first-arg-is-ignored'], exit=False)
    
    # Run load tests
    load_tester = LoadTestingSuite()
    load_tester.run_load_test("token/wallet_codes/test_wallet1", "GET")
    load_tester.run_load_test("token/verify_code", "POST", {
        "activation_code": "QNET-TEST-TEST-TEST",
        "node_id": "load_test_node",
        "node_address": "127.0.0.1:8000"
    })
    
    # Run Solana integration test
    run_solana_integration_test()
    
    logger.info("Test suite completed")