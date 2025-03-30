#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: validation_decorators.py
Provides decorators for input validation, error handling, and other common patterns
to reduce code duplication and improve reliability.
"""

import functools
import inspect
import logging
import time
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple, Type, Union

def validate_parameters(func):
    """
    Validates function parameters based on type hints and docstring
    
    Example:
    @validate_parameters
    def example_func(name: str, count: int = 0) -> bool:
        '''
        Example function
        
        Args:
            name: Name must not be empty
            count: Must be non-negative
        '''
        # Function implementation
        return True
    """
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        # Get function signature
        sig = inspect.signature(func)
        bound_args = sig.bind(*args, **kwargs)
        bound_args.apply_defaults()
        
        # Get parameter names and values
        params = bound_args.arguments
        
        # Get type hints
        type_hints = func.__annotations__
        
        # Check each parameter
        for name, value in params.items():
            # Skip 'self' parameter for methods
            if name == 'self':
                continue
                
            # Check type if type hint is available
            if name in type_hints:
                expected_type = type_hints[name]
                # Handle Union types
                if hasattr(expected_type, '__origin__') and expected_type.__origin__ is Union:
                    valid_types = expected_type.__args__
                    if not any(isinstance(value, t) for t in valid_types if t is not type(None)):
                        raise TypeError(f"Parameter '{name}' must be one of types {valid_types}, got {type(value)}")
                # Handle Lists
                elif hasattr(expected_type, '__origin__') and expected_type.__origin__ is list:
                    if not isinstance(value, list):
                        raise TypeError(f"Parameter '{name}' must be a list, got {type(value)}")
                    # Check element types if specified
                    if hasattr(expected_type, '__args__') and expected_type.__args__:
                        item_type = expected_type.__args__[0]
                        for i, item in enumerate(value):
                            if not isinstance(item, item_type):
                                raise TypeError(f"Item {i} in parameter '{name}' must be of type {item_type}, got {type(item)}")
                # Handle Dicts
                elif hasattr(expected_type, '__origin__') and expected_type.__origin__ is dict:
                    if not isinstance(value, dict):
                        raise TypeError(f"Parameter '{name}' must be a dict, got {type(value)}")
                # Simple type check
                elif not isinstance(value, expected_type) and value is not None:
                    raise TypeError(f"Parameter '{name}' must be of type {expected_type}, got {type(value)}")
            
            # Additional validation for common parameter types
            if isinstance(value, str) and name != 'self':
                if len(value) == 0:
                    raise ValueError(f"Parameter '{name}' cannot be an empty string")
            elif isinstance(value, (int, float)) and value < 0 and 'timeout' not in name.lower():
                # Allow negative values only for specific parameter names
                raise ValueError(f"Parameter '{name}' cannot be negative")
            elif isinstance(value, list) and len(value) == 0 and not name.endswith('_optional'):
                # Allow empty lists only for parameters explicitly marked as optional
                logging.warning(f"Empty list provided for parameter '{name}'")
        
        # Call the original function
        return func(*args, **kwargs)
    
    return wrapper

def verify_node_address(func):
    """
    Verifies that a node address parameter is valid
    """
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        # Get function signature
        sig = inspect.signature(func)
        bound_args = sig.bind(*args, **kwargs)
        
        # Check if 'node_address' is in parameters
        if 'node_address' in bound_args.arguments:
            node_address = bound_args.arguments['node_address']
            
            # Basic validation
            if not node_address or not isinstance(node_address, str):
                raise ValueError(f"Invalid node address: {node_address}")
                
            # Format validation (IP:port or hostname:port)
            import re
            if not re.match(r'^[a-zA-Z0-9\.\-]+:[0-9]{1,5}$', node_address):
                raise ValueError(f"Invalid node address format: {node_address}")
        
        # Call the original function
        return func(*args, **kwargs)
    
    return wrapper

def handle_exceptions(log_level=logging.ERROR, return_value=None):
    """
    Decorator to handle exceptions with proper logging and optional return value
    
    Args:
        log_level: Logging level for exceptions
        return_value: Value to return in case of exception
    """
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            try:
                return func(*args, **kwargs)
            except Exception as e:
                # Get function name for better error messages
                func_name = func.__name__
                
                # Get the caller's file name if possible
                frame = inspect.currentframe().f_back
                caller = frame.f_code.co_filename if frame else "unknown"
                
                # Log the exception
                logging.log(log_level, f"Exception in {func_name} called from {caller}: {e}")
                
                # Return the specified value
                return return_value
        
        return wrapper
    
    return decorator

def retry(max_attempts=3, retry_delay=1.0, backoff_factor=2.0, exceptions=(Exception,)):
    """
    Decorator for retrying a function when specific exceptions occur
    
    Args:
        max_attempts: Maximum number of attempts
        retry_delay: Initial delay between retries (in seconds)
        backoff_factor: Factor by which to increase delay after each failure
        exceptions: Tuple of exceptions that trigger a retry
    """
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            attempt = 0
            current_delay = retry_delay
            
            while attempt < max_attempts:
                try:
                    return func(*args, **kwargs)
                except exceptions as e:
                    attempt += 1
                    if attempt >= max_attempts:
                        # Log the final failure
                        logging.warning(f"Function {func.__name__} failed after {max_attempts} attempts: {e}")
                        raise  # Re-raise the last exception
                    
                    # Log the retry
                    logging.info(f"Retry {attempt}/{max_attempts} for {func.__name__} after error: {e}. Waiting {current_delay:.2f}s")
                    
                    # Wait before retrying
                    time.sleep(current_delay)
                    
                    # Increase delay for next attempt
                    current_delay *= backoff_factor
        
        return wrapper
    
    return decorator

def rate_limit(calls_per_second=10, window_size=1.0):
    """
    Rate limiting decorator for functions
    
    Args:
        calls_per_second: Maximum number of calls per second
        window_size: Time window in seconds for rate limiting
    """
    def decorator(func):
        # Create a lock and a deque to track call times
        lock = threading.RLock()
        from collections import deque
        call_times = deque(maxlen=int(calls_per_second * window_size * 2))
        
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            with lock:
                current_time = time.time()
                
                # Remove old timestamps
                while call_times and call_times[0] < current_time - window_size:
                    call_times.popleft()
                
                # Check if we're exceeding the rate limit
                if len(call_times) >= calls_per_second * window_size:
                    # Calculate wait time
                    time_to_wait = call_times[0] + window_size - current_time
                    if time_to_wait > 0:
                        logging.debug(f"Rate limit reached for {func.__name__}, waiting {time_to_wait:.4f}s")
                        time.sleep(time_to_wait)
                        current_time = time.time()
                
                # Add current time to the deque
                call_times.append(current_time)
            
            # Call the original function
            return func(*args, **kwargs)
        
        return wrapper
    
    return decorator

def memoize(max_size=128, ttl=None):
    """
    Memoization decorator with optional time-to-live for cached results
    
    Args:
        max_size: Maximum cache size
        ttl: Time-to-live for cached entries in seconds (None for no expiration)
    """
    def decorator(func):
        cache = {}
        call_times = {}
        lock = threading.RLock()
        
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            # Create a hashable key from the function arguments
            key = str(args) + str(sorted(kwargs.items()))
            
            with lock:
                current_time = time.time()
                
                # Check if result is in cache and not expired
                if key in cache:
                    if ttl is None or current_time - call_times[key] < ttl:
                        return cache[key]
                    else:
                        # Remove expired entry
                        del cache[key]
                        del call_times[key]
                
                # Call the original function
                result = func(*args, **kwargs)
                
                # Add result to cache
                cache[key] = result
                call_times[key] = current_time
                
                # Limit cache size
                if len(cache) > max_size:
                    # Remove oldest entry
                    oldest_key = min(call_times, key=call_times.get)
                    del cache[oldest_key]
                    del call_times[oldest_key]
                
                return result
        
        # Add cache statistics and management functions
        wrapper.cache_info = lambda: {
            "size": len(cache),
            "max_size": max_size,
            "ttl": ttl,
            "hits": sum(1 for k in cache if k in call_times)
        }
        wrapper.cache_clear = lambda: cache.clear() or call_times.clear()
        
        return wrapper
    
    return decorator

def measure_performance(log_threshold=1.0):
    """
    Decorator to measure and log function execution time
    
    Args:
        log_threshold: Minimum execution time (in seconds) to log
    """
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            start_time = time.time()
            result = func(*args, **kwargs)
            execution_time = time.time() - start_time
            
            if execution_time >= log_threshold:
                logging.info(f"Function {func.__name__} took {execution_time:.4f}s to execute")
            
            return result
        return wrapper
    return decorator

# Example usage
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    
    # Example function with parameter validation
    @validate_parameters
    def add_numbers(a: int, b: int) -> int:
        """Add two numbers"""
        return a + b
    
    # Example function with exception handling
    @handle_exceptions(return_value=0)
    def divide(a: int, b: int) -> float:
        """Divide a by b"""
        return a / b
    
    # Example function with retry logic
    @retry(max_attempts=3, exceptions=(ConnectionError,))
    def fetch_data(url: str) -> dict:
        """Fetch data from URL"""
        # Simulate connection error
        if random.random() < 0.7:
            raise ConnectionError("Simulated connection error")
        return {"status": "success"}
    
    # Example function with rate limiting
    @rate_limit(calls_per_second=2)
    def api_call() -> str:
        """Make API call"""
        return "API response"
    
    # Example function with memoization
    @memoize(ttl=60)
    def expensive_computation(n: int) -> int:
        """Compute factorial"""
        if n <= 1:
            return 1
        return n * expensive_computation(n-1)
    
    # Example function with performance measurement
    @measure_performance(log_threshold=0.01)
    def slow_function() -> None:
        """A slow function"""
        time.sleep(0.1)
    
    # Test the functions
    import random
    
    print(f"1 + 2 = {add_numbers(1, 2)}")
    print(f"10 / 2 = {divide(10, 2)}")
    print(f"10 / 0 = {divide(10, 0)}  # Returns 0 due to exception handler")
    
    try:
        data = fetch_data("https://example.com")
        print(f"Fetch data result: {data}")
    except ConnectionError:
        print("Failed to fetch data after retries")
    
    for _ in range(5):
        print(f"API call: {api_call()}")
    
    print(f"Factorial of 5: {expensive_computation(5)}")
    print(f"Factorial of 5 (cached): {expensive_computation(5)}")
    
    slow_function()