#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Module: block_rewards.py
Implements the logarithmic reward reduction model for QNet.
"""

import math
import logging

def calculate_block_reward(block_height):
    """
    Calculates block reward using logarithmic reduction model.
    
    Args:
        block_height: Current block height
        
    Returns:
        Reward amount for this block
    """
    initial_reward = 16384  # 2^14
    total_blocks = 525600   # 10 years at 52,560 blocks per year
    min_reward = 32         # Minimum reward after 10 years (2^5)
    
    # For blocks after the main emission period
    if block_height > total_blocks:
        return min_reward
    
    # Calculate logarithmic reduction factor (adjusted for 90% emission in 10 years)
    reduction_factor = math.log(block_height + 1) / math.log(total_blocks + 1)
    adjusted_factor = reduction_factor * 1.1  # Adjust for 90% emission
    
    # Ensure factor does not exceed 1
    capped_factor = min(adjusted_factor, 0.999)
    
    # Calculate reward using logarithmic reduction
    reward = initial_reward * (1 - capped_factor)
    
    # Round to integer and ensure minimum reward
    return max(int(reward), min_reward)

def estimate_emission_schedule():
    """
    Estimates and logs the emission schedule.
    Useful for verifying the emission model.
    """
    total_supply = 2**32  # 4,294,967,296
    emission_per_year = {}
    cumulative_emission = 0
    
    # Calculate emission for each year
    for year in range(1, 11):
        start_block = (year - 1) * 52560
        end_block = year * 52560
        
        year_emission = 0
        for block in range(start_block, end_block):
            year_emission += calculate_block_reward(block)
            
        cumulative_emission += year_emission
        percentage = (cumulative_emission / total_supply) * 100
        
        emission_per_year[year] = {
            "emission": year_emission,
            "cumulative": cumulative_emission,
            "percentage": percentage
        }
        
        logging.info(f"Year {year}: {year_emission:,} QNet ({percentage:.2f}% of total)")
    
    # Calculate remaining emission
    remaining = total_supply - cumulative_emission
    logging.info(f"Remaining after 10 years: {remaining:,} QNet ({100 - percentage:.2f}% of total)")
    
    return emission_per_year