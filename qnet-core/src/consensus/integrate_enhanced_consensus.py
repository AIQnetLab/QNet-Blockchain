#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Script: integrate_enhanced_consensus.py
Integrates enhanced consensus modules into the QNet blockchain
"""

import os
import sys
import logging
import shutil
import time
import argparse
import re

def setup_logging():
    """Configure logging for the integration script"""
    log_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "integration.log")
    logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s [%(levelname)s] %(message)s',
                    handlers=[logging.StreamHandler(),
                              logging.FileHandler(log_file, encoding="utf-8")])

def create_directories():
    """Create necessary directories for modules"""
    dirs = ["consensus_modules", "backup"]
    for d in dirs:
        os.makedirs(d, exist_ok=True)
    
    logging.info(f"Created directories: {', '.join(dirs)}")

def backup_files():
    """Backup original files before modification"""
    backup_dir = os.path.join(os.getcwd(), "backup")
    files_to_backup = ["node.py", "api.py", "consensus.py"]
    
    for file in files_to_backup:
        if os.path.exists(file):
            dest = os.path.join(backup_dir, f"{file}.bak.{int(time.time())}")
            try:
                shutil.copy2(file, dest)
                logging.info(f"Backed up {file} to {dest}")
            except Exception as e:
                logging.error(f"Failed to backup {file}: {e}")
        else:
            logging.warning(f"File {file} not found, skipping backup")

def create_consensus_modules():
    """Create enhanced consensus modules"""
    module_files = {
        "dynamic_consensus.py": "consensus_modules/dynamic_consensus.py",
        "network_partition_manager.py": "consensus_modules/network_partition_manager.py",
        "reputation_consensus.py": "consensus_modules/reputation_consensus.py",
        "consensus_scaling.py": "consensus_modules/consensus_scaling.py"
    }
    
    # Create __init__.py for the package
    init_content = """
# Consensus modules package
try:
    from .dynamic_consensus import NetworkMetrics, AdaptiveConsensusTimer
    from .network_partition_manager import NetworkPartitionManager
    from .reputation_consensus import NodeReputation, ReputationConsensusManager
    from .consensus_scaling import ConsensusScalingManager

    __all__ = [
        'NetworkMetrics', 'AdaptiveConsensusTimer',
        'NetworkPartitionManager',
        'NodeReputation', 'ReputationConsensusManager',
        'ConsensusScalingManager'
    ]
except ImportError as e:
    print(f"Error importing consensus modules: {e}")
"""
    
    # Create __init__.py file
    init_path = "consensus_modules/__init__.py"
    try:
        with open(init_path, "w") as f:
            f.write(init_content)
        logging.info(f"Created module {init_path}")
    except Exception as e:
        logging.error(f"Failed to create {init_path}: {e}")
    
    # Create module files
    for source, dest in module_files.items():
        try:
            if os.path.exists(source):
                with open(source, "r") as f:
                    content = f.read()
                
                with open(dest, "w") as f:
                    f.write(content)
                
                logging.info(f"Created module {dest} from {source}")
            else:
                logging.error(f"Source file {source} not found")
        except Exception as e:
            logging.error(f"Error creating module {dest}: {e}")

def find_insert_position(content, search_patterns):
    """Find position to insert code using multiple search patterns"""
    position = -1
    
    for pattern in search_patterns:
        position = content.find(pattern)
        if position != -1:
            return position + len(pattern)
    
    return -1

def modify_node_py():
    """Modify node.py to integrate enhanced consensus"""
    if not os.path.exists("node.py"):
        logging.error("node.py not found. Cannot modify.")
        return False
        
    try:
        with open("node.py", "r") as f:
            content = f.read()
    except Exception as e:
        logging.error(f"Failed to read node.py: {e}")
        return False
    
    # Add import for consensus scaling
    import_code = """
# Import enhanced consensus modules
try:
    from consensus_modules import ConsensusScalingManager
    CONSENSUS_SCALING_AVAILABLE = True
except ImportError:
    logging.warning("Consensus scaling modules not available")
    CONSENSUS_SCALING_AVAILABLE = False
"""
    
    # Find import section using multiple patterns
    import_patterns = [
        "# Setup logging",
        "import config",
        "from token_verification_api"
    ]
    import_section_end = find_insert_position(content, import_patterns)
    
    if import_section_end == -1:
        logging.error("Could not find import section in node.py")
        return False
        
    modified_content = content[:import_section_end] + import_code + content[import_section_end:]
    
    # Add consensus scaling initialization before starting auto processes
    init_code = """
    # Initialize consensus scaling manager if available
    consensus_scaling = None
    enhanced_auto_mine = auto_mine
    
    if 'CONSENSUS_SCALING_AVAILABLE' in globals() and CONSENSUS_SCALING_AVAILABLE:
        try:
            consensus_scaling = ConsensusScalingManager(
                config.own_address, 
                config.blockchain,
                config,
                app
            )
            
            # Enhance auto_mine function
            enhanced_auto_mine = consensus_scaling.integrate_with_mining(auto_mine)
            
            # Integrate with API
            consensus_scaling.integrate_with_api()
            
            logging.info("Enhanced consensus activated")
        except Exception as e:
            logging.error(f"Failed to initialize consensus scaling: {e}")
            enhanced_auto_mine = auto_mine
    
    """
    
    # Find start_auto_processes function using multiple patterns
    start_patterns = [
        "def start_auto_processes():",
        "\"\"\"Start all automatic background processes\"\"\""
    ]
    
    for pattern in start_patterns:
        start_auto_pos = modified_content.find(pattern)
        if start_auto_pos != -1:
            break
    
    if start_auto_pos == -1:
        logging.error("Could not find start_auto_processes function in node.py")
        return False
        
    # Find the position to insert initialization code (after the docstring)
    function_body_start = modified_content.find(":", start_auto_pos)
    if function_body_start == -1:
        logging.error("Could not find function body start in node.py")
        return False
        
    function_body_start += 1  # Move past the colon
    
    # Find the first non-whitespace/non-comment line
    lines = modified_content[function_body_start:].split('\n')
    line_index = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped and not stripped.startswith('#'):
            line_index = i
            break
    
    # Calculate the insert position
    insert_position = function_body_start + sum(len(lines[i]) + 1 for i in range(line_index))
    
    # Insert initialization code
    modified_content = (modified_content[:insert_position] + 
                      init_code + modified_content[insert_position:])
    
    # Replace auto_mine with enhanced_auto_mine in thread creation
    old_thread_patterns = [
        'threads.append(threading.Thread(target=auto_mine, daemon=True))',
        'threading.Thread(target=auto_mine,'
    ]
    
    for pattern in old_thread_patterns:
        if pattern in modified_content:
            new_pattern = pattern.replace('auto_mine', 'enhanced_auto_mine')
            modified_content = modified_content.replace(pattern, new_pattern)
            logging.info(f"Replaced {pattern} with {new_pattern}")
    
    # Write the modified file
    try:
        with open("node.py", "w") as f:
            f.write(modified_content)
        
        logging.info("Modified node.py to integrate enhanced consensus")
        return True
    except Exception as e:
        logging.error(f"Failed to write modified node.py: {e}")
        return False

def modify_api_py():
    """Modify api.py to add new endpoints"""
    if not os.path.exists("api.py"):
        logging.error("api.py not found. Cannot modify.")
        return False
        
    try:
        with open("api.py", "r") as f:
            content = f.read()
    except Exception as e:
        logging.error(f"Failed to read api.py: {e}")
        return False
    
    # Add new import at the top
    import_code = """
# Import enhanced consensus modules
try:
    from consensus_modules import NetworkMetrics, NetworkPartitionManager, NodeReputation, ReputationConsensusManager
    CONSENSUS_MODULES_AVAILABLE = True
except ImportError:
    logging.warning("Consensus modules not available")
    CONSENSUS_MODULES_AVAILABLE = False
"""
    
    # Find import section using multiple patterns
    import_patterns = [
        "# Create Flask app",
        "app = Flask",
        "import config"
    ]
    import_section_end = find_insert_position(content, import_patterns)
    
    if import_section_end == -1:
        logging.error("Could not find import section in api.py")
        return False
        
    modified_content = content[:import_section_end] + import_code + content[import_section_end:]
    
    # Check if the content already has our endpoints to avoid duplication
    if 'consensus_stats_endpoint' in modified_content:
        logging.info("API endpoints already added to api.py, skipping")
        return True
    
    # Add new endpoints at the end of the file
    endpoints_code = """
# Enhanced consensus metrics endpoints
@app.route('/api/v1/consensus/stats')
def consensus_stats_endpoint():
    """Get comprehensive statistics on consensus performance"""
    try:
        # This endpoint is handled by the ConsensusScalingManager
        # The implementation is automatically injected at runtime
        return jsonify({"error": "ConsensusScalingManager not initialized"}), 500
    except Exception as e:
        logging.error(f"Error in /api/v1/consensus/stats endpoint: {e}")
        return jsonify({"error": "Internal server error"}), 500

@app.route('/api/v1/network/health')
def network_health_endpoint():
    """Get network health information including partition detection"""
    try:
        # This endpoint is handled by the ConsensusScalingManager
        # The implementation is automatically injected at runtime
        return jsonify({"error": "ConsensusScalingManager not initialized"}), 500
    except Exception as e:
        logging.error(f"Error in /api/v1/network/health endpoint: {e}")
        return jsonify({"error": "Internal server error"}), 500

@app.route('/api/v1/consensus/reputation')
def reputation_endpoint():
    """Get node reputation information"""
    try:
        # This endpoint is handled by the ConsensusScalingManager
        # The implementation is automatically injected at runtime
        return jsonify({"error": "ConsensusScalingManager not initialized"}), 500
    except Exception as e:
        logging.error(f"Error in /api/v1/consensus/reputation endpoint: {e}")
        return jsonify({"error": "Internal server error"}), 500

@app.route('/api/v1/consensus/config', methods=['POST'])
def consensus_config_endpoint():
    """Update consensus configuration parameters"""
    try:
        # This endpoint is handled by the ConsensusScalingManager
        # The implementation is automatically injected at runtime
        return jsonify({"error": "ConsensusScalingManager not initialized"}), 500
    except Exception as e:
        logging.error(f"Error in /api/v1/consensus/config endpoint: {e}")
        return jsonify({"error": "Internal server error"}), 500
"""
    
    # Add new endpoints at the end of the file
    modified_content += endpoints_code
    
    # Write the modified file
    try:
        with open("api.py", "w") as f:
            f.write(modified_content)
        
        logging.info("Modified api.py to add enhanced consensus endpoints")
        return True
    except Exception as e:
        logging.error(f"Failed to write modified api.py: {e}")
        return False

def modify_consensus_py():
    """Modify consensus.py to enhance leader selection with reputation"""
    if not os.path.exists("consensus.py"):
        logging.error("consensus.py not found. Cannot modify.")
        return False
        
    try:
        with open("consensus.py", "r") as f:
            content = f.read()
    except Exception as e:
        logging.error(f"Failed to read consensus.py: {e}")
        return False
    
    # Add new import at the top
    import_code = """
# Import reputation manager interface
try:
    from consensus_modules import NodeReputation
    REPUTATION_AVAILABLE = True
except ImportError:
    REPUTATION_AVAILABLE = False
"""
    
    # Find import section using multiple patterns
    import_patterns = [
        "class ConsensusManager:",
        "import hashlib"
    ]
    import_section_end = find_insert_position(content, import_patterns)
    
    if import_section_end == -1:
        logging.error("Could not find ConsensusManager class in consensus.py")
        return False
        
    modified_content = content[:import_section_end] + import_code + content[import_section_end:]
    
    # Check if the content already has our modifications to avoid duplication
    if '_select_leader_with_reputation' in modified_content:
        logging.info("ConsensusManager already enhanced in consensus.py, skipping")
        return True
    
    # Find the determine_leader method using regex
    determine_leader_pattern = re.compile(r'def\s+determine_leader\s*\(\s*self\s*,\s*round_num\s*,\s*eligible_nodes\s*,\s*random_beacon\s*\)')
    match = determine_leader_pattern.search(modified_content)
    
    if not match:
        logging.error("Could not find determine_leader method in consensus.py")
        return False
    
    method_start = match.start()
    
    # Find the end of the method
    # Look for the next method definition or the end of the class
    next_method_pattern = re.compile(r'def\s+\w+\s*\(')
    next_match = next_method_pattern.search(modified_content, match.end())
    
    if next_match:
        method_end = next_match.start()
    else:
        # If no next method, assume it ends at the end of the file
        method_end = len(modified_content)
    
    original_method = modified_content[method_start:method_end]
    
    # Create the enhanced method
    enhanced_method = """    def determine_leader(self, round_num, eligible_nodes, random_beacon):
        """Determine the leader for this round with optional reputation weighting"""
        with self.lock:
            # Check if we have enough reveals
            if round_num not in self.reveals:
                logging.warning(f"No reveals for round {round_num}")
                return None
                
            valid_reveals = []
            
            for node, proposal in self.reveals[round_num].items():
                # Check if node is eligible
                if node not in eligible_nodes:
                    continue
                
                # Check if commit matches reveal
                if round_num in self.commits and node in self.commits[round_num]:
                    try:
                        expected_commit = hashlib.sha256(proposal.encode()).hexdigest()
                        actual_commit = self.commits[round_num][node]
                        
                        if expected_commit == actual_commit:
                            valid_reveals.append(node)
                    except Exception as e:
                        logging.error(f"Error validating reveal for {node}: {e}")
            
            min_reveals = max(2, len(eligible_nodes) // 3)
            if len(valid_reveals) < min_reveals:
                logging.warning(f"Not enough valid reveals for round {round_num}. Got {len(valid_reveals)}, need {min_reveals}")
                return None
            
            # Check if reputation-based selection is available
            if REPUTATION_AVAILABLE and hasattr(self, "reputation_manager"):
                return self._select_leader_with_reputation(valid_reveals, random_beacon, round_num)
            else:
                # Fallback to standard selection
                # Sort nodes for deterministic selection
                valid_reveals.sort()
                
                # Use random beacon to select leader
                hash_input = f"{random_beacon}-{round_num}".encode()
                hash_output = hashlib.sha256(hash_input).digest()
                
                # Convert hash to integer and select leader
                selection = int.from_bytes(hash_output, byteorder='big')
                leader_index = selection % len(valid_reveals)
                
                return valid_reveals[leader_index]
    
    def _select_leader_with_reputation(self, valid_nodes, random_beacon, round_num):
        """Select leader using reputation-weighted selection"""
        if not hasattr(self, "reputation_influence"):
            self.reputation_influence = 0.7  # Default value
            
        # Get reputation scores
        reputation_scores = {}
        for node in valid_nodes:
            try:
                reputation_scores[node] = self.reputation_manager.get_reputation(node)
            except Exception as e:
                logging.error(f"Error getting reputation for {node}: {e}")
                reputation_scores[node] = 0.5  # Default reputation on error
            
        # Calculate weighted scores
        weighted_scores = {}
        for node, score in reputation_scores.items():
            # Blend reputation with uniform probability
            uniform_weight = 1.0 / len(valid_nodes)
            weighted_scores[node] = (self.reputation_influence * score + 
                                    (1 - self.reputation_influence) * uniform_weight)
        
        # Normalize scores
        total_weight = sum(weighted_scores.values())
        if total_weight > 0:
            normalized_scores = {node: score/total_weight for node, score in weighted_scores.items()}
        else:
            # Fallback to uniform
            normalized_scores = {node: 1.0/len(valid_nodes) for node in valid_nodes}
            
        # Create cumulative distribution
        cumulative = 0.0
        distribution = []
        for node, score in normalized_scores.items():
            cumulative += score
            distribution.append((node, cumulative))
            
        # Use random beacon to generate value between 0-1
        try:
            hash_input = f"{random_beacon}-{round_num}".encode()
            hash_output = hashlib.sha256(hash_input).digest()
            random_value = int.from_bytes(hash_output, byteorder='big') / (2**256)
            
            # Select based on random value
            for node, threshold in distribution:
                if random_value <= threshold:
                    return node
        except Exception as e:
            logging.error(f"Error in reputation-weighted selection: {e}")
            if valid_nodes:
                return valid_nodes[0]
                
        # Fallback to first node if something went wrong
        if valid_nodes:
            return valid_nodes[0]
        return None"""
    
    # Replace the original method with the enhanced one
    modified_content = modified_content.replace(original_method, enhanced_method)
    
    # Write the modified file
    try:
        with open("consensus.py", "w") as f:
            f.write(modified_content)
        
        logging.info("Modified consensus.py to enhance leader selection with reputation")
        return True
    except Exception as e:
        logging.error(f"Failed to write modified consensus.py: {e}")
        return False

def create_integration_script():
    """Create a script to activate the enhanced consensus system"""
    script_content = """#!/usr/bin/env python3
# -*- coding: utf-8 -*-
\"\"\"
Script: activate_enhanced_consensus.py
Activates the enhanced consensus system in QNet
\"\"\"

import os
import sys
import logging
import importlib
import traceback

# Configure logging
logging.basicConfig(level=logging.INFO,
                   format='%(asctime)s [%(levelname)s] %(message)s')

def check_modules_installed():
    """Check if consensus modules are properly installed"""
    try:
        from consensus_modules import ConsensusScalingManager
        logging.info("Enhanced consensus modules found")
        return True
    except ImportError as e:
        logging.error(f"Enhanced consensus modules not found: {e}")
        logging.error(traceback.format_exc())
        return False

def update_config():
    """Update config.ini to enable enhanced consensus"""
    try:
        import configparser
        config = configparser.ConfigParser()
        
        config_file = "config.ini"
        if os.path.exists(config_file):
            config.read(config_file)
        
        # Add enhanced consensus section if not exists
        if "EnhancedConsensus" not in config:
            config["EnhancedConsensus"] = {}
        
        # Enable enhanced consensus
        config["EnhancedConsensus"]["enabled"] = "true"
        config["EnhancedConsensus"]["reputation_influence"] = "0.7"
        config["EnhancedConsensus"]["min_reveals"] = "2"
        config["EnhancedConsensus"]["adaptive_timing"] = "true"
        config["EnhancedConsensus"]["partition_detection"] = "true"
        config["EnhancedConsensus"]["safety_factor"] = "1.5"
        config["EnhancedConsensus"]["detection_interval"] = "300"
        config["EnhancedConsensus"]["recovery_cooldown"] = "600"
        
        # Write the updated config
        with open(config_file, "w") as f:
            config.write(f)
        
        logging.info(f"Updated {config_file} to enable enhanced consensus")
        return True
    except Exception as e:
        logging.error(f"Error updating config.ini: {e}")
        logging.error(traceback.format_exc())
        return False

def main():
    """Main function to activate enhanced consensus"""
    print("======================================")
    print(" QNet Enhanced Consensus Activator")
    print("======================================")
    
    # Check if consensus modules are installed
    if not check_modules_installed():
        print("Error: Consensus modules not properly installed.")
        print("Please run 'python integrate_enhanced_consensus.py' first.")
        return 1
    
    # Update config.ini
    if not update_config():
        print("Error: Failed to update configuration.")
        return 1
    
    print("\\nEnhanced consensus system activated successfully.")
    print("Settings:")
    print("  - Reputation-based leader selection: ENABLED")
    print("  - Adaptive consensus timing: ENABLED")
    print("  - Network partition detection: ENABLED")
    print("  - Reputation influence: 70%")
    print("\\nRestart your node to apply the changes with:")
    print("  docker restart qnet-container")
    print("\\nUse the following API endpoints to monitor the enhanced consensus:")
    print("  - /api/v1/consensus/stats")
    print("  - /api/v1/network/health")
    print("  - /api/v1/consensus/reputation")
    print("\\nYou can modify parameters using:")
    print("  - /api/v1/consensus/config (POST)")
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
"""
    
    try:
        with open("activate_enhanced_consensus.py", "w") as f:
            f.write(script_content)
        
        # Make it executable
        os.chmod("activate_enhanced_consensus.py", 0o755)
        
        logging.info("Created activation script: activate_enhanced_consensus.py")
        return True
    except Exception as e:
        logging.error(f"Failed to create activation script: {e}")
        return False

def rollback_changes():
    """Rollback changes in case of failure"""
    backup_dir = os.path.join(os.getcwd(), "backup")
    files_to_restore = ["node.py", "api.py", "consensus.py"]
    
    for file in files_to_restore:
        # Find the most recent backup
        backups = [f for f in os.listdir(backup_dir) if f.startswith(f"{file}.bak.")]
        if backups:
            most_recent = sorted(backups, key=lambda x: int(x.split('.')[-1]))[-1]
            backup_file = os.path.join(backup_dir, most_recent)
            
            try:
                shutil.copy2(backup_file, file)
                logging.info(f"Restored {file} from {backup_file}")
            except Exception as e:
                logging.error(f"Failed to restore {file}: {e}")
        else:
            logging.warning(f"No backup found for {file}")
    
    logging.info("Rollback completed")

def main():
    """Main function to integrate enhanced consensus"""
    parser = argparse.ArgumentParser(description="Integrate enhanced consensus into QNet")
    parser.add_argument("--no-backup", action="store_true", help="Skip backup of original files")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be changed without making changes")
    parser.add_argument("--rollback", action="store_true", help="Rollback to original files if backups exist")
    parser.add_argument("--force", action="store_true", help="Force integration even if files already contain changes")
    args = parser.parse_args()
    
    # Setup logging
    setup_logging()
    
    if args.rollback:
        logging.info("Rolling back changes as requested")
        rollback_changes()
        return 0
    
    logging.info("Starting integration of enhanced consensus")
    
    # Create necessary directories
    create_directories()
    
    # Backup original files
    if not args.no_backup:
        backup_files()
    
    # Variable to track success
    success = True
    
    # Create consensus modules
    if not args.dry_run:
        logging.info("Creating consensus modules...")
        create_consensus_modules()
    else:
        logging.info("[DRY RUN] Would create consensus modules")
    
    # Modify node.py
    if not args.dry_run:
        logging.info("Modifying node.py...")
        if not modify_node_py():
            logging.error("Failed to modify node.py")
            success = False
    else:
        logging.info("[DRY RUN] Would modify node.py")
    
    # Modify api.py
    if not args.dry_run:
        logging.info("Modifying api.py...")
        if not modify_api_py():
            logging.error("Failed to modify api.py")
            success = False
    else:
        logging.info("[DRY RUN] Would modify api.py")
    
    # Modify consensus.py
    if not args.dry_run:
        logging.info("Modifying consensus.py...")
        if not modify_consensus_py():
            logging.error("Failed to modify consensus.py")
            success = False
    else:
        logging.info("[DRY RUN] Would modify consensus.py")
    
    # Create activation script
    if not args.dry_run:
        logging.info("Creating activation script...")
        if not create_integration_script():
            logging.error("Failed to create activation script")
            success = False
    else:
        logging.info("[DRY RUN] Would create activation script")
    
    # Rollback if failed
    if not success and not args.dry_run and not args.no_backup:
        logging.error("Integration failed. Rolling back changes...")
        rollback_changes()
        return 1
    
    if args.dry_run:
        logging.info("Dry run completed successfully. No changes were made.")
        print("\nDry run completed. To apply changes, run without --dry-run")
    elif success:
        logging.info("Integration completed successfully!")
        print("\nIntegration complete!")
        print("Run 'python activate_enhanced_consensus.py' to enable the enhanced consensus system")
    else:
        logging.error("Integration failed!")
        print("\nIntegration failed. Check the log file for details.")
        return 1
    
    return 0

if __name__ == "__main__":
    sys.exit(main())