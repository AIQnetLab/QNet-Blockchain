#!/usr/bin/env python3
"""Build Python bindings for QNet Rust modules."""

import os
import sys
import subprocess
import shutil
from pathlib import Path

def build_module(module_name: str, features: list = None):
    """Build a Rust module with Python bindings."""
    print(f"\n{'='*60}")
    print(f"Building {module_name}...")
    print('='*60)
    
    module_path = Path(module_name)
    if not module_path.exists():
        print(f"Error: Module {module_name} not found!")
        return False
    
    # Change to module directory
    os.chdir(module_path)
    
    # Build command
    cmd = ["maturin", "build", "--release"]
    if features:
        cmd.extend(["--features", ",".join(features)])
    
    try:
        # Run maturin build
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
        print(result.stdout)
        
        # Find the built wheel
        wheel_dir = Path("target/wheels")
        if wheel_dir.exists():
            wheels = list(wheel_dir.glob("*.whl"))
            if wheels:
                print(f"✓ Built wheel: {wheels[0].name}")
                
                # Copy to project root
                dest = Path("..") / "dist" / wheels[0].name
                dest.parent.mkdir(exist_ok=True)
                shutil.copy2(wheels[0], dest)
                print(f"✓ Copied to: {dest}")
                
                return True
        
        print("Error: No wheel file found!")
        return False
        
    except subprocess.CalledProcessError as e:
        print(f"Error building {module_name}:")
        print(e.stderr)
        return False
    finally:
        os.chdir("..")

def install_maturin():
    """Install maturin if not available."""
    try:
        subprocess.run(["maturin", "--version"], check=True, capture_output=True)
        print("✓ Maturin is installed")
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("Installing maturin...")
        subprocess.run([sys.executable, "-m", "pip", "install", "maturin"], check=True)

def main():
    """Main build process."""
    print("QNet Python Bindings Builder")
    print("="*60)
    
    # Ensure we're in the project root
    if not Path("qnet-consensus").exists():
        print("Error: Please run this script from the QNet project root!")
        sys.exit(1)
    
    # Install maturin
    install_maturin()
    
    # Create dist directory
    Path("dist").mkdir(exist_ok=True)
    
    # Build modules
    modules = [
        ("qnet-consensus", ["python"]),
        ("qnet-state", ["python"]),
        ("qnet-mempool", ["python"]),
    ]
    
    success_count = 0
    for module, features in modules:
        if build_module(module, features):
            success_count += 1
    
    print(f"\n{'='*60}")
    print(f"Build Summary: {success_count}/{len(modules)} modules built successfully")
    print('='*60)
    
    if success_count == len(modules):
        print("\n✓ All modules built successfully!")
        print("\nTo install the modules, run:")
        print("  pip install dist/*.whl")
    else:
        print("\n⚠ Some modules failed to build")
        sys.exit(1)

if __name__ == "__main__":
    main() 