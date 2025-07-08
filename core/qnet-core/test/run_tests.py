#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: run_tests.py
Runs all test suites for the blockchain system.
"""

import unittest
import os
import sys
import logging

# Configure logging during tests
logging.basicConfig(level=logging.ERROR,
                    format='%(asctime)s [%(levelname)s] %(message)s',
                    handlers=[logging.StreamHandler()])

def run_all_tests():
    """Discover and run all tests in the tests directory"""
    print("=" * 70)
    print("Running blockchain test suites")
    print("=" * 70)
    
    # Add the parent directory to sys.path
    current_dir = os.path.dirname(os.path.abspath(__file__))
    parent_dir = os.path.dirname(current_dir)
    if parent_dir not in sys.path:
        sys.path.insert(0, parent_dir)
    
    # Create test suite from all test files
    test_loader = unittest.TestLoader()
    
    # Try to load tests from a dedicated tests directory if it exists
    tests_dir = os.path.join(current_dir, 'tests')
    if os.path.exists(tests_dir) and os.path.isdir(tests_dir):
        test_suite = test_loader.discover(tests_dir)
    else:
        # Otherwise load tests from the current directory
        test_suite = test_loader.discover(current_dir)
    
    # Run the tests
    test_runner = unittest.TextTestRunner(verbosity=2)
    result = test_runner.run(test_suite)
    
    print("\n" + "=" * 70)
    print(f"Test Results: {result.testsRun} tests run")
    print(f"  Failures: {len(result.failures)}")
    print(f"  Errors: {len(result.errors)}")
    print(f"  Skipped: {len(result.skipped)}")
    print("=" * 70)
    
    return len(result.failures) == 0 and len(result.errors) == 0

if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)