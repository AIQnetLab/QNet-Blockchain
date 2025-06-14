#!/usr/bin/env python3
"""
Production 1DEV Token Creation Script
Creates real 1DEV token on Solana TESTNET for QNet (NO MAINNET YET)
"""

import os
import sys
import json
import time
import requests
import hashlib
from pathlib import Path
from typing import Dict, Optional, Tuple

class ProductionTokenCreator:
    def __init__(self, network: str = "mainnet"):
        self.network = network
        self.token_name = "1DEV"
        self.token_symbol = "1DEV"
        self.decimals = 6
        self.total_supply = 1_000_000_000  # 1 billion tokens
        
        # Network configurations (NO MAINNET YET)
        self.networks = {
            "devnet": {
                "rpc_url": "https://api.devnet.solana.com",
                "explorer": "https://explorer.solana.com/?cluster=devnet"
            },
            "testnet": {
                "rpc_url": "https://api.testnet.solana.com",
                "explorer": "https://explorer.solana.com/?cluster=testnet"
            }
        }
        
        if network not in self.networks:
            raise ValueError(f"Unsupported network: {network}")
    
    def check_solana_installation(self) -> Tuple[bool, str]:
        """Check if Solana CLI is installed and configured"""
        try:
            import subprocess
            result = subprocess.run(['solana', '--version'], 
                                  capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                return True, result.stdout.strip()
            else:
                return False, "Solana CLI not found or not working"
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False, "Solana CLI not installed"
    
    def install_solana_windows(self) -> bool:
        """Install Solana CLI on Windows"""
        print("📦 Installing Solana CLI for Windows...")
        
        installer_url = "https://release.solana.com/v1.18.4/solana-install-init-x86_64-pc-windows-msvc.exe"
        installer_path = "solana-installer.exe"
        
        try:
            # Download installer
            print("   Downloading installer...")
            response = requests.get(installer_url, stream=True)
            response.raise_for_status()
            
            with open(installer_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
            
            # Run installer silently
            print("   Running installer...")
            import subprocess
            result = subprocess.run([installer_path, '/S'], 
                                  capture_output=True, timeout=300)
            
            # Cleanup
            os.remove(installer_path)
            
            if result.returncode == 0:
                # Add to PATH
                solana_path = os.path.expanduser("~/.local/share/solana/install/active_release/bin")
                current_path = os.environ.get('PATH', '')
                if solana_path not in current_path:
                    os.environ['PATH'] = f"{solana_path};{current_path}"
                
                print("✅ Solana CLI installed successfully")
                return True
            else:
                print(f"❌ Installation failed: {result.stderr}")
                return False
                
        except Exception as e:
            print(f"❌ Installation error: {e}")
            return False
    
    def configure_network(self) -> bool:
        """Configure Solana CLI for the specified network"""
        try:
            import subprocess
            
            rpc_url = self.networks[self.network]["rpc_url"]
            
            # Set cluster
            result = subprocess.run(['solana', 'config', 'set', '--url', rpc_url],
                                  capture_output=True, text=True)
            
            if result.returncode != 0:
                print(f"❌ Failed to set cluster: {result.stderr}")
                return False
            
            # Check if keypair exists
            keypair_path = os.path.expanduser("~/.config/solana/id.json")
            if not os.path.exists(keypair_path):
                print("🔑 Generating new keypair...")
                result = subprocess.run(['solana-keygen', 'new', '--no-bip39-passphrase'],
                                      capture_output=True, text=True)
                if result.returncode != 0:
                    print(f"❌ Failed to generate keypair: {result.stderr}")
                    return False
            
            # Get wallet address
            result = subprocess.run(['solana', 'address'],
                                  capture_output=True, text=True)
            if result.returncode == 0:
                wallet_address = result.stdout.strip()
                print(f"✅ Network configured: {self.network}")
                print(f"📍 Wallet address: {wallet_address}")
                return True
            else:
                print(f"❌ Failed to get wallet address: {result.stderr}")
                return False
                
        except Exception as e:
            print(f"❌ Configuration error: {e}")
            return False
    
    def check_sol_balance(self) -> float:
        """Check SOL balance for transaction fees"""
        try:
            import subprocess
            result = subprocess.run(['solana', 'balance'],
                                  capture_output=True, text=True)
            if result.returncode == 0:
                balance_str = result.stdout.strip().split()[0]
                return float(balance_str)
            else:
                return 0.0
        except:
            return 0.0
    
    def request_airdrop(self, amount: float = 2.0) -> bool:
        """Request SOL airdrop (devnet only)"""
        if self.network != "devnet":
            print("❌ Airdrop only available on devnet")
            return False
        
        try:
            import subprocess
            result = subprocess.run(['solana', 'airdrop', str(amount)],
                                  capture_output=True, text=True)
            
            if result.returncode == 0:
                print(f"✅ Airdrop successful: {amount} SOL")
                return True
            else:
                print(f"❌ Airdrop failed: {result.stderr}")
                return False
        except Exception as e:
            print(f"❌ Airdrop error: {e}")
            return False
    
    def create_token(self) -> Optional[str]:
        """Create the 1DEV token"""
        try:
            import subprocess
            
            print(f"🪙 Creating {self.token_name} token on {self.network}...")
            
            # Create token
            result = subprocess.run(['spl-token', 'create-token', '--decimals', str(self.decimals)],
                                  capture_output=True, text=True)
            
            if result.returncode != 0:
                print(f"❌ Token creation failed: {result.stderr}")
                return None
            
            # Extract token address
            lines = result.stdout.strip().split('\n')
            token_address = None
            for line in lines:
                if 'Creating token' in line:
                    parts = line.split()
                    if len(parts) > 2:
                        token_address = parts[-1]
                        break
            
            if not token_address:
                print("❌ Failed to extract token address")
                return None
            
            print(f"✅ Token created: {token_address}")
            
            # Create token account
            print("🏦 Creating token account...")
            result = subprocess.run(['spl-token', 'create-account', token_address],
                                  capture_output=True, text=True)
            
            if result.returncode != 0:
                print(f"❌ Token account creation failed: {result.stderr}")
                return None
            
            # Mint tokens
            print(f"⚡ Minting {self.total_supply:,} tokens...")
            mint_amount = self.total_supply * (10 ** self.decimals)
            result = subprocess.run(['spl-token', 'mint', token_address, str(mint_amount)],
                                  capture_output=True, text=True)
            
            if result.returncode != 0:
                print(f"❌ Token minting failed: {result.stderr}")
                return None
            
            print(f"✅ Successfully minted {self.total_supply:,} {self.token_name} tokens")
            
            return token_address
            
        except Exception as e:
            print(f"❌ Token creation error: {e}")
            return None
    
    def verify_token(self, token_address: str) -> Dict:
        """Verify token creation and get info"""
        try:
            import subprocess
            
            # Get token supply
            result = subprocess.run(['spl-token', 'supply', token_address],
                                  capture_output=True, text=True)
            supply = result.stdout.strip() if result.returncode == 0 else "Unknown"
            
            # Get token balance
            result = subprocess.run(['spl-token', 'balance', token_address],
                                  capture_output=True, text=True)
            balance = result.stdout.strip() if result.returncode == 0 else "Unknown"
            
            token_info = {
                "address": token_address,
                "name": self.token_name,
                "symbol": self.token_symbol,
                "decimals": self.decimals,
                "total_supply": supply,
                "balance": balance,
                "network": self.network,
                "explorer_url": f"{self.networks[self.network]['explorer']}/address/{token_address}"
            }
            
            return token_info
            
        except Exception as e:
            print(f"❌ Token verification error: {e}")
            return {}
    
    def update_config_files(self, token_address: str) -> bool:
        """Update QNet config files with new token address"""
        try:
            config_files = [
                "config/config.ini",
                "qnet-explorer/frontend/src/app/api/faucet/claim/route.ts"
            ]
            
            updated_files = []
            
            for config_file in config_files:
                if not os.path.exists(config_file):
                    print(f"⚠️ Config file not found: {config_file}")
                    continue
                
                # Read file
                with open(config_file, 'r', encoding='utf-8') as f:
                    content = f.read()
                
                # Replace placeholder
                old_placeholders = [
                    'PLACEHOLDER_TO_BE_CREATED',
                    'DEV1111111111111111111111111111111111111111'
                ]
                
                updated = False
                for placeholder in old_placeholders:
                    if placeholder in content:
                        content = content.replace(placeholder, token_address)
                        updated = True
                
                if updated:
                    # Write updated content
                    with open(config_file, 'w', encoding='utf-8') as f:
                        f.write(content)
                    updated_files.append(config_file)
                    print(f"✅ Updated {config_file}")
            
            if updated_files:
                print(f"✅ Updated {len(updated_files)} config files")
                return True
            else:
                print("⚠️ No config files needed updating")
                return True
                
        except Exception as e:
            print(f"❌ Config update error: {e}")
            return False
    
    def save_token_info(self, token_info: Dict) -> bool:
        """Save token information to file"""
        try:
            output_file = f"1dev_token_{self.network}_info.json"
            
            # Add creation timestamp
            token_info["created_at"] = time.time()
            token_info["created_date"] = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
            
            with open(output_file, 'w') as f:
                json.dump(token_info, f, indent=2)
            
            print(f"✅ Token info saved to {output_file}")
            return True
            
        except Exception as e:
            print(f"❌ Failed to save token info: {e}")
            return False

def main():
    """Main function to create production 1DEV token"""
    print("🚀 QNet Production 1DEV Token Creator")
    print("=" * 50)
    
    # Ask for network selection
    print("Select network:")
    print("1. Devnet (for testing)")
    print("2. Testnet (for testnet deployment)")
    print("⚠️  MAINNET NOT AVAILABLE YET - ONLY LOCAL/TESTNET!")
    
    try:
        choice = input("Enter choice (1 or 2): ").strip()
        if choice == "1":
            network = "devnet"
        elif choice == "2":
            network = "testnet"
        else:
            print("❌ Invalid choice")
            return False
    except KeyboardInterrupt:
        print("\n❌ Cancelled by user")
        return False
    
    creator = ProductionTokenCreator(network)
    
    # Step 1: Check Solana installation
    print(f"\n📋 Step 1: Checking Solana CLI installation...")
    installed, version = creator.check_solana_installation()
    
    if not installed:
        print(f"❌ {version}")
        if os.name == 'nt':  # Windows
            if input("Install Solana CLI? (y/n): ").lower() == 'y':
                if not creator.install_solana_windows():
                    return False
            else:
                print("❌ Solana CLI required for token creation")
                return False
        else:
            print("Please install Solana CLI: curl -sSfL https://release.solana.com/v1.18.4/install | sh")
            return False
    else:
        print(f"✅ Solana CLI found: {version}")
    
    # Step 2: Configure network
    print(f"\n📋 Step 2: Configuring {network} network...")
    if not creator.configure_network():
        return False
    
    # Step 3: Check SOL balance
    print(f"\n📋 Step 3: Checking SOL balance...")
    sol_balance = creator.check_sol_balance()
    print(f"💰 Current balance: {sol_balance} SOL")
    
    if sol_balance < 0.1:  # Need SOL for transaction fees
        if network == "devnet":
            print("🚰 Requesting SOL airdrop...")
            creator.request_airdrop(2.0)
        else:
            print("❌ Insufficient SOL balance for transaction fees")
            print("Please fund your wallet with SOL and try again")
            return False
    
    # Step 4: Create token
    print(f"\n📋 Step 4: Creating 1DEV token...")
    token_address = creator.create_token()
    
    if not token_address:
        return False
    
    # Step 5: Verify token
    print(f"\n📋 Step 5: Verifying token...")
    token_info = creator.verify_token(token_address)
    
    if not token_info:
        return False
    
    # Step 6: Update config files
    print(f"\n📋 Step 6: Updating config files...")
    creator.update_config_files(token_address)
    
    # Step 7: Save token info
    print(f"\n📋 Step 7: Saving token information...")
    creator.save_token_info(token_info)
    
    # Final summary
    print(f"\n🎉 SUCCESS: 1DEV Token Created!")
    print("=" * 50)
    print(f"📍 Token Address: {token_address}")
    print(f"🌐 Network: {network.upper()}")
    print(f"💰 Total Supply: {token_info.get('total_supply', 'Unknown')}")
    print(f"🔗 Explorer: {token_info.get('explorer_url', 'N/A')}")
    
    if network == "mainnet":
        print(f"\n🚨 IMPORTANT:")
        print(f"   - Save the token address securely")
        print(f"   - Backup your wallet keypair")
        print(f"   - This is the production token!")
    
    return True

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1) 