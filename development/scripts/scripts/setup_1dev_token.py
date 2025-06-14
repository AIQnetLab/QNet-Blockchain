#!/usr/bin/env python3
"""
1DEV Token Creation and Management Script
Creates 1DEV token on Solana devnet for QNet testing
"""

import subprocess
import json
import os
import sys
from pathlib import Path

class SolanaTokenManager:
    def __init__(self):
        self.devnet_url = "https://api.devnet.solana.com"
        self.token_name = "1DEV"
        self.token_symbol = "1DEV"
        self.decimals = 6
        self.total_supply = 1_000_000_000  # 1 billion tokens
        
    def check_solana_cli(self):
        """Check if Solana CLI is installed"""
        try:
            result = subprocess.run(['solana', '--version'], 
                                  capture_output=True, text=True)
            if result.returncode == 0:
                print(f"✅ Solana CLI found: {result.stdout.strip()}")
                return True
            else:
                print("❌ Solana CLI not found")
                return False
        except FileNotFoundError:
            print("❌ Solana CLI not installed")
            return False
    
    def install_solana_cli(self):
        """Install Solana CLI"""
        print("📦 Installing Solana CLI...")
        
        if os.name == 'nt':  # Windows
            install_cmd = [
                'powershell', '-Command',
                'Invoke-WebRequest -Uri "https://release.solana.com/v1.18.4/solana-install-init-x86_64-pc-windows-msvc.exe" -OutFile "solana-installer.exe"; Start-Process -Wait -FilePath "./solana-installer.exe" -ArgumentList "/S"; Remove-Item "solana-installer.exe"'
            ]
        else:  # Linux/Mac
            install_cmd = [
                'sh', '-c',
                'curl -sSfL https://release.solana.com/v1.18.4/install | sh'
            ]
        
        try:
            subprocess.run(install_cmd, check=True)
            print("✅ Solana CLI installed successfully")
            
            # Add to PATH for Windows
            if os.name == 'nt':
                solana_path = os.path.expanduser("~/.local/share/solana/install/active_release/bin")
                current_path = os.environ.get('PATH', '')
                if solana_path not in current_path:
                    os.environ['PATH'] = f"{solana_path};{current_path}"
                    print(f"✅ Added {solana_path} to PATH")
            
            return True
        except subprocess.CalledProcessError as e:
            print(f"❌ Failed to install Solana CLI: {e}")
            return False
    
    def setup_devnet_config(self):
        """Configure Solana CLI for devnet"""
        print("🔧 Configuring Solana CLI for devnet...")
        
        try:
            # Set devnet cluster
            subprocess.run(['solana', 'config', 'set', '--url', self.devnet_url], 
                         check=True, capture_output=True)
            
            # Generate new keypair if doesn't exist
            keypair_path = os.path.expanduser("~/.config/solana/id.json")
            if not os.path.exists(keypair_path):
                subprocess.run(['solana-keygen', 'new', '--no-bip39-passphrase'], 
                             check=True)
            
            # Get wallet address
            result = subprocess.run(['solana', 'address'], 
                                  capture_output=True, text=True, check=True)
            wallet_address = result.stdout.strip()
            
            print(f"✅ Devnet configured")
            print(f"📍 Wallet address: {wallet_address}")
            
            return wallet_address
            
        except subprocess.CalledProcessError as e:
            print(f"❌ Failed to configure devnet: {e}")
            return None
    
    def request_airdrop(self, wallet_address, amount=2):
        """Request SOL airdrop for transaction fees"""
        print(f"💰 Requesting {amount} SOL airdrop...")
        
        try:
            subprocess.run(['solana', 'airdrop', str(amount), wallet_address], 
                         check=True, capture_output=True)
            
            # Check balance
            result = subprocess.run(['solana', 'balance'], 
                                  capture_output=True, text=True, check=True)
            balance = result.stdout.strip()
            print(f"✅ Airdrop successful. Balance: {balance}")
            return True
            
        except subprocess.CalledProcessError as e:
            print(f"❌ Airdrop failed: {e}")
            return False
    
    def create_token(self):
        """Create 1DEV token on Solana devnet"""
        print(f"🪙 Creating {self.token_name} token...")
        
        try:
            # Create token
            result = subprocess.run(['spl-token', 'create-token', '--decimals', str(self.decimals)], 
                                  capture_output=True, text=True, check=True)
            
            # Extract token address from output
            lines = result.stdout.strip().split('\n')
            token_address = None
            for line in lines:
                if 'Creating token' in line:
                    token_address = line.split()[-1]
                    break
            
            if not token_address:
                print("❌ Failed to extract token address")
                return None
            
            print(f"✅ Token created: {token_address}")
            
            # Create token account
            subprocess.run(['spl-token', 'create-account', token_address], 
                         check=True, capture_output=True)
            
            # Mint tokens
            mint_amount = self.total_supply * (10 ** self.decimals)
            subprocess.run(['spl-token', 'mint', token_address, str(mint_amount)], 
                         check=True, capture_output=True)
            
            print(f"✅ Minted {self.total_supply:,} {self.token_name} tokens")
            
            return token_address
            
        except subprocess.CalledProcessError as e:
            print(f"❌ Token creation failed: {e}")
            return None
    
    def update_config(self, token_address):
        """Update QNet config with new token address"""
        config_path = Path("config/config.ini")
        
        if not config_path.exists():
            print("❌ config/config.ini not found")
            return False
        
        try:
            # Read current config
            with open(config_path, 'r') as f:
                content = f.read()
            
            # Replace placeholder with real token address
            updated_content = content.replace(
                'PLACEHOLDER_TO_BE_CREATED', 
                token_address
            )
            
            # Write updated config
            with open(config_path, 'w') as f:
                f.write(updated_content)
            
            print(f"✅ Updated config.ini with token address: {token_address}")
            return True
            
        except Exception as e:
            print(f"❌ Failed to update config: {e}")
            return False
    
    def test_burn_transaction(self, token_address, amount=1500):
        """Test burning tokens (send to null address)"""
        print(f"🔥 Testing burn of {amount} {self.token_name} tokens...")
        
        # Solana burn address (11111111111111111111111111111112)
        burn_address = "11111111111111111111111111111112"
        
        try:
            # Transfer tokens to burn address
            result = subprocess.run([
                'spl-token', 'transfer', token_address, 
                str(amount), burn_address
            ], capture_output=True, text=True, check=True)
            
            # Extract transaction signature
            lines = result.stdout.strip().split('\n')
            tx_signature = None
            for line in lines:
                if 'Signature:' in line:
                    tx_signature = line.split('Signature:')[1].strip()
                    break
            
            print(f"✅ Burn transaction successful")
            print(f"📝 Transaction signature: {tx_signature}")
            
            return tx_signature
            
        except subprocess.CalledProcessError as e:
            print(f"❌ Burn transaction failed: {e}")
            return None
    
    def get_token_info(self, token_address):
        """Get token information"""
        try:
            result = subprocess.run(['spl-token', 'supply', token_address], 
                                  capture_output=True, text=True, check=True)
            supply = result.stdout.strip()
            
            result = subprocess.run(['spl-token', 'balance', token_address], 
                                  capture_output=True, text=True, check=True)
            balance = result.stdout.strip()
            
            print(f"📊 Token Info:")
            print(f"   Address: {token_address}")
            print(f"   Total Supply: {supply}")
            print(f"   Your Balance: {balance}")
            
            return {
                'address': token_address,
                'supply': supply,
                'balance': balance
            }
            
        except subprocess.CalledProcessError as e:
            print(f"❌ Failed to get token info: {e}")
            return None

def main():
    """Main setup function"""
    print("🚀 QNet 1DEV Token Setup")
    print("=" * 50)
    
    manager = SolanaTokenManager()
    
    # Step 1: Check/Install Solana CLI
    if not manager.check_solana_cli():
        if not manager.install_solana_cli():
            print("❌ Setup failed: Could not install Solana CLI")
            return False
    
    # Step 2: Configure devnet
    wallet_address = manager.setup_devnet_config()
    if not wallet_address:
        print("❌ Setup failed: Could not configure devnet")
        return False
    
    # Step 3: Request airdrop
    if not manager.request_airdrop(wallet_address):
        print("❌ Setup failed: Could not get SOL airdrop")
        return False
    
    # Step 4: Create token
    token_address = manager.create_token()
    if not token_address:
        print("❌ Setup failed: Could not create token")
        return False
    
    # Step 5: Update config
    if not manager.update_config(token_address):
        print("⚠️ Warning: Could not update config.ini")
    
    # Step 6: Test burn
    burn_tx = manager.test_burn_transaction(token_address)
    if burn_tx:
        print(f"✅ Burn test successful: {burn_tx}")
    
    # Step 7: Show final info
    manager.get_token_info(token_address)
    
    print("\n🎉 1DEV Token Setup Complete!")
    print(f"📍 Token Address: {token_address}")
    print(f"🌐 Network: Solana Devnet")
    print(f"💰 Supply: {manager.total_supply:,} tokens")
    print("\n🔗 Next steps:")
    print("1. Add token to web interface faucet")
    print("2. Test node activation with burn")
    print("3. Test economic model transitions")
    
    return True

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1) 