#!/usr/bin/env python3
"""
QNet Quickstart Script
Helps set up and run a QNet node quickly
"""

import os
import sys
import subprocess
import platform
import argparse
import shutil
from pathlib import Path

def print_banner():
    """Print QNet banner"""
    print("""
    ╔═══════════════════════════════════════╗
    ║          QNet Blockchain              ║
    ║     Next-Gen Quantum-Resistant        ║
    ║         Blockchain Platform           ║
    ╚═══════════════════════════════════════╝
    """)

def check_python_version():
    """Check if Python version is 3.8+"""
    if sys.version_info < (3, 8):
        print("❌ Python 3.8+ is required")
        print(f"   Current version: {sys.version}")
        sys.exit(1)
    print(f"✅ Python {sys.version.split()[0]} detected")

def check_rust():
    """Check if Rust is installed"""
    try:
        result = subprocess.run(['rustc', '--version'], capture_output=True, text=True)
        if result.returncode == 0:
            print(f"✅ Rust detected: {result.stdout.strip()}")
            return True
    except FileNotFoundError:
        pass
    
    print("❌ Rust not found. Install from https://rustup.rs/")
    return False

def check_go():
    """Check if Go is installed"""
    try:
        result = subprocess.run(['go', 'version'], capture_output=True, text=True)
        if result.returncode == 0:
            print(f"✅ Go detected: {result.stdout.strip()}")
            return True
    except FileNotFoundError:
        pass
    
    print("⚠️  Go not found. Network layer will use Python fallback")
    return False

def setup_virtual_env():
    """Set up Python virtual environment"""
    venv_path = Path('venv')
    
    if venv_path.exists():
        print("✅ Virtual environment already exists")
        return
    
    print("📦 Creating virtual environment...")
    subprocess.run([sys.executable, '-m', 'venv', 'venv'], check=True)
    print("✅ Virtual environment created")

def install_python_deps():
    """Install Python dependencies"""
    print("📦 Installing Python dependencies...")
    
    # Determine pip command based on OS
    if platform.system() == 'Windows':
        pip_cmd = Path('venv/Scripts/pip')
    else:
        pip_cmd = Path('venv/bin/pip')
    
    # Upgrade pip first
    subprocess.run([str(pip_cmd), 'install', '--upgrade', 'pip'], check=True)
    
    # Install requirements
    if Path('requirements.txt').exists():
        subprocess.run([str(pip_cmd), 'install', '-r', 'requirements.txt'], check=True)
        print("✅ Python dependencies installed")
    else:
        print("⚠️  requirements.txt not found")

def build_rust_modules():
    """Build Rust modules"""
    rust_modules = ['qnet-core-rust', 'qnet-consensus-rust']
    
    for module in rust_modules:
        module_path = Path(module)
        if module_path.exists():
            print(f"🔨 Building {module}...")
            try:
                subprocess.run(['cargo', 'build', '--release'], 
                             cwd=module_path, check=True)
                print(f"✅ {module} built successfully")
            except subprocess.CalledProcessError:
                print(f"❌ Failed to build {module}")
                return False
        else:
            print(f"⚠️  {module} not found")
    
    return True

def build_go_network():
    """Build Go network layer"""
    go_path = Path('qnet-network')
    
    if not go_path.exists():
        print("⚠️  Go network layer not found")
        return False
    
    print("🔨 Building Go network layer...")
    try:
        subprocess.run(['go', 'build'], cwd=go_path, check=True)
        print("✅ Go network layer built")
        return True
    except subprocess.CalledProcessError:
        print("❌ Failed to build Go network layer")
        return False

def setup_config():
    """Set up configuration file"""
    config_path = Path('config/config.ini')
    example_path = Path('config/config.ini.example')
    
    if config_path.exists():
        print("✅ Configuration file exists")
        return
    
    if example_path.exists():
        shutil.copy(example_path, config_path)
        print("✅ Configuration file created from example")
    else:
        print("⚠️  No configuration file found. Using defaults.")

def create_directories():
    """Create necessary directories"""
    dirs = ['data', 'keys', 'logs']
    
    for dir_name in dirs:
        Path(dir_name).mkdir(exist_ok=True)
    
    print("✅ Required directories created")

def run_node(node_type='full'):
    """Run the QNet node"""
    print(f"\n🚀 Starting QNet {node_type} node...")
    
    # Determine Python command based on OS
    if platform.system() == 'Windows':
        python_cmd = Path('venv/Scripts/python')
    else:
        python_cmd = Path('venv/bin/python')
    
    # Set node type in environment
    os.environ['QNET_NODE_TYPE'] = node_type
    
    # Run the node
    try:
        subprocess.run([str(python_cmd), 'qnet-node/src/node/node.py'])
    except KeyboardInterrupt:
        print("\n\n✅ Node stopped by user")
    except Exception as e:
        print(f"\n❌ Error running node: {e}")

def main():
    """Main quickstart function"""
    parser = argparse.ArgumentParser(description='QNet Quickstart')
    parser.add_argument('--node-type', choices=['light', 'full', 'super'], 
                       default='full', help='Type of node to run')
    parser.add_argument('--skip-build', action='store_true', 
                       help='Skip building Rust/Go modules')
    parser.add_argument('--dev', action='store_true',
                       help='Install development dependencies')
    
    args = parser.parse_args()
    
    print_banner()
    
    # Check prerequisites
    print("🔍 Checking prerequisites...")
    check_python_version()
    has_rust = check_rust()
    has_go = check_go()
    
    # Setup environment
    print("\n📋 Setting up environment...")
    setup_virtual_env()
    install_python_deps()
    
    if args.dev and Path('requirements-dev.txt').exists():
        print("📦 Installing development dependencies...")
        if platform.system() == 'Windows':
            pip_cmd = Path('venv/Scripts/pip')
        else:
            pip_cmd = Path('venv/bin/pip')
        subprocess.run([str(pip_cmd), 'install', '-r', 'requirements-dev.txt'])
    
    # Build modules
    if not args.skip_build:
        print("\n🔨 Building modules...")
        if has_rust:
            build_rust_modules()
        if has_go:
            build_go_network()
    
    # Final setup
    print("\n⚙️  Final setup...")
    setup_config()
    create_directories()
    
    print("\n✅ Setup complete!")
    print("=" * 50)
    
    # Ask if user wants to run node
    response = input("\nStart QNet node now? (y/n): ").lower()
    if response == 'y':
        run_node(args.node_type)
    else:
        print("\nTo start the node later, run:")
        if platform.system() == 'Windows':
            print("  venv\\Scripts\\python qnet-node\\src\\node\\node.py")
        else:
            print("  venv/bin/python qnet-node/src/node/node.py")

if __name__ == '__main__':
    main() 