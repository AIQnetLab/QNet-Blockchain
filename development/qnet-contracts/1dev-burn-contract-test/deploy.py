#!/usr/bin/env python3
"""
1DEV Burn Contract Deployment Script (Python)
Deploys the burn tracking contract to Solana devnet
"""

import subprocess
import json
import sys
import os
import time
from pathlib import Path

def run_command(command, description, check=True):
    """Run a command and handle errors"""
    print(f"🔄 {description}...")
    try:
        result = subprocess.run(command, shell=True, check=check, capture_output=True, text=True)
        if result.stdout:
            print(result.stdout.strip())
        return result
    except subprocess.CalledProcessError as e:
        print(f"❌ Error: {e}")
        if e.stderr:
            print(f"Error details: {e.stderr}")
        if check:
            sys.exit(1)
        return e

def check_prerequisites():
    """Check if required tools are installed"""
    print("🔧 Checking prerequisites...")
    
    # Check Solana CLI
    result = run_command("solana --version", "Checking Solana CLI", check=False)
    if result.returncode != 0:
        print("❌ Solana CLI is not installed or not in PATH")
        print("   Install from: https://docs.solana.com/cli/install-solana-cli-tools")
        return False
    
    # Check Anchor CLI
    result = run_command("anchor --version", "Checking Anchor CLI", check=False)
    if result.returncode != 0:
        print("❌ Anchor CLI is not installed or not in PATH")
        print("   Install with: cargo install --git https://github.com/coral-xyz/anchor avm --locked")
        return False
    
    print("✅ All prerequisites are installed")
    return True

def setup_solana_config():
    """Configure Solana for devnet deployment"""
    print("🔧 Setting up Solana configuration...")
    
    # Set cluster to devnet
    run_command("solana config set --url https://api.devnet.solana.com", "Setting cluster to devnet")
    
    # Check wallet balance
    result = run_command("solana balance", "Checking wallet balance", check=False)
    if result.returncode == 0:
        balance_line = result.stdout.strip()
        try:
            balance = float(balance_line.split()[0])
            if balance < 1.0:
                print(f"⚠️  Low balance: {balance} SOL")
                print("   Requesting airdrop...")
                run_command("solana airdrop 2", "Requesting SOL airdrop", check=False)
                time.sleep(5)  # Wait for airdrop
        except (ValueError, IndexError):
            print("⚠️  Could not parse balance, continuing anyway...")
    
    return True

def build_contract():
    """Build the Anchor contract"""
    print("🔨 Building contract...")
    
    # Clean build
    run_command("anchor clean", "Cleaning previous build", check=False)
    
    # Build contract
    result = run_command("anchor build", "Building contract")
    
    # Check if .so file was created
    so_file = Path("target/deploy/onedev_burn_contract.so")
    if so_file.exists():
        size = so_file.stat().st_size
        print(f"✅ Contract binary created: {size} bytes")
        return True
    else:
        print("❌ Contract binary (.so file) was not created")
        return False

def deploy_contract():
    """Deploy the contract to Solana"""
    print("🚀 Deploying contract to devnet...")
    
    result = run_command("anchor deploy", "Deploying contract")
    
    if result.returncode == 0:
        print("✅ Contract deployed successfully!")
        
        # Get program ID
        try:
            keys_result = run_command("anchor keys list", "Getting program keys", check=False)
            if keys_result.returncode == 0:
                for line in keys_result.stdout.split('\n'):
                    if 'onedev_burn_contract' in line:
                        program_id = line.split()[-1]
                        print(f"📋 Program ID: {program_id}")
                        return program_id
        except:
            pass
        
        print("⚠️  Could not retrieve program ID automatically")
        return "DEPLOYED_BUT_ID_UNKNOWN"
    
    return None

def show_next_steps(program_id):
    """Show next steps after deployment"""
    print("\n🎉 Deployment completed successfully!")
    print("\n📋 Contract Information:")
    print(f"   Program ID: {program_id}")
    print(f"   Network: Solana Devnet")
    print(f"   RPC URL: https://api.devnet.solana.com")
    
    print("\n🔧 Next Steps:")
    print("1. Update environment variables:")
    print(f"   export BURN_TRACKER_PROGRAM_ID={program_id}")
    print("   export SOLANA_RPC_URL=https://api.devnet.solana.com")
    
    print("\n2. Initialize the contract:")
    print("   anchor run initialize")
    
    print("\n3. Update all config files with the new Program ID")
    
    print("\n4. Test the deployment:")
    print("   anchor test")

def main():
    """Main deployment function"""
    print("🚀 1DEV Burn Contract Deployment Script")
    print("=" * 50)
    
    # Check prerequisites
    if not check_prerequisites():
        sys.exit(1)
    
    # Setup Solana configuration
    if not setup_solana_config():
        sys.exit(1)
    
    # Build contract
    if not build_contract():
        print("❌ Build failed. Please check the code and fix any issues.")
        sys.exit(1)
    
    # Deploy contract
    program_id = deploy_contract()
    if not program_id:
        print("❌ Deployment failed. Please check the logs above.")
        sys.exit(1)
    
    # Show next steps
    show_next_steps(program_id)

if __name__ == "__main__":
    main() 