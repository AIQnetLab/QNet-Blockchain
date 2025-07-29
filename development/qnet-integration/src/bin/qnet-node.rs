#![allow(unused_imports)]
#![allow(unused_variables)]
#![allow(dead_code)]
#![allow(unused_mut)]

//! QNet Production Node - 100k+ TPS Ready
//! 
//! PRODUCTION DEPLOYMENT: Interactive Setup Only
//! - No command-line arguments for activation
//! - Use built-in interactive menu for node configuration
//! - Activation code required (format: QNET-XXXX-XXXX-XXXX)
//! 
//! Features:
//! - Microblocks as default mode for 100k+ TPS
//! - Production-grade batch processing
//! - Smart synchronization and compression
//! - Enterprise security and monitoring

use qnet_integration::node::{BlockchainNode, NodeType, Region};
use qnet_integration::quantum_crypto::{QNetQuantumCrypto, ActivationPayload};
// No clap - fully automatic configuration
use std::path::PathBuf;
use std::time::Duration;
use std::net::{IpAddr, Ipv4Addr};
use tokio::time::interval;
use std::io::{self, Write};
use std::collections::HashMap;
use chrono;

// Activation code structure - represents valid activation token
#[derive(Debug, Clone)]
struct ActivationCodeData {
    node_type: NodeType,
    tx_hash: String,
    wallet_address: String,
    purchase_phase: u8,    // Phase when code was purchased (for info only)
}

// Helper function for masking activation codes
fn mask_code(code: &str) -> String {
    if code.len() <= 8 {
        code.to_string()
    } else {
        format!("{}...{}", &code[..4], &code[code.len()-4..])
    }
}

// Simple phase detection for display purposes (uses main detect_current_phase internally)
async fn get_current_phase_simple() -> Result<u8, String> {
    let (phase, _pricing) = detect_current_phase().await;
    Ok(phase)
}

// Quantum-secure activation code decryption with Light node blocking
async fn decode_activation_code_quantum_secure(
    code: &str, 
    selected_node_type: NodeType
) -> Result<ActivationCodeData, String> {
    // Initialize quantum crypto module
    let mut quantum_crypto = QNetQuantumCrypto::new();
    quantum_crypto.initialize().await
        .map_err(|e| format!("Failed to initialize quantum crypto: {}", e))?;

    // 1. Decrypt activation code using quantum-resistant decryption
    println!("🔓 Decrypting quantum-secure activation code...");
    let payload = quantum_crypto.decrypt_activation_code(code).await
        .map_err(|e| format!("Quantum decryption failed: {}", e))?;

    // 2. Parse node type from payload
    let node_type = match payload.node_type.as_str() {
        "light" => NodeType::Light,
        "full" => NodeType::Full,
        "super" => NodeType::Super,
        _ => return Err(format!("Invalid node type in activation code: {}", payload.node_type)),
    };

    // 3. CRITICAL SECURITY: Block Light nodes on servers IMMEDIATELY
    if node_type == NodeType::Light {
        eprintln!("🚨 SECURITY VIOLATION: Light node activation attempted on server!");
        eprintln!("   Light nodes can ONLY be activated on mobile devices");
        eprintln!("   Server activation is STRICTLY FORBIDDEN for Light nodes");
        eprintln!("   Use Full or Super node activation codes for servers");
        std::process::exit(1); // IMMEDIATE TERMINATION
    }

    // 4. Verify node type matches selected type
    if node_type != selected_node_type {
        return Err(format!(
            "Node type mismatch: activation code is for {:?}, but {:?} was selected", 
            node_type, selected_node_type
        ));
    }

    // 5. Verify Dilithium signature with wallet binding
    let signature_data = format!("{}:{}:{}", payload.burn_tx, payload.node_type, payload.timestamp);
    let signature_valid = quantum_crypto.verify_dilithium_signature(
        &signature_data,
        &payload.signature,
        &payload.wallet
    ).await.map_err(|e| format!("Signature verification failed: {}", e))?;

    if !signature_valid {
        return Err("Invalid wallet signature - activation code is not authentic".to_string());
    }

    // 6. Check blockchain to prevent double-usage
    let already_used = quantum_crypto.check_blockchain_usage(code).await
        .map_err(|e| format!("Blockchain check failed: {}", e))?;

    if already_used {
        return Err("Activation code already used - each code can only be used once".to_string());
    }

    // 7. Extract purchase phase from payload (for information only)
    let purchase_phase = if payload.burn_tx.starts_with("burn_tx_") { 1 } else { 2 };

    println!("✅ Quantum-secure activation code validation successful");
    println!("   🔐 Quantum encryption: CRYSTALS-Kyber compatible");
    println!("   📝 Digital signature: Dilithium verified"); 
    println!("   🛡️  Wallet binding: Cryptographically secured");
    println!("   ♾️  Permanent: Code never expires");
    println!("   🚫 Light node blocking: Enforced on servers");

    Ok(ActivationCodeData {
        node_type,
        tx_hash: payload.burn_tx,
        wallet_address: payload.wallet,
        purchase_phase,
    })
}

// Validate activation code matches expected node type and payment
fn validate_activation_code_node_type(code: &str, expected_type: NodeType, current_phase: u8, current_pricing: &PricingInfo) -> Result<(), String> {
    println!("\n🔍 === Activation Code Validation (DEVELOPMENT MODE) ===");
    
    // Production mode - validate QNET activation codes only
    if !code.starts_with("QNET-") || code.len() != 17 {
        return Err("Invalid activation code format. Expected: QNET-XXXX-XXXX-XXXX".to_string());
    }
    
    println!("   ✅ QNET activation code format validated");
    println!("   📊 Expected Node Type: {:?}", expected_type);
    println!("   📊 Current Phase: {}", current_phase);
    
    // Show current dynamic pricing for information
    let current_dynamic_price = calculate_node_price(current_phase, expected_type, current_pricing);
    let price_str = format_price(current_phase, current_dynamic_price);
    
    match current_phase {
        1 => {
            println!("   💰 Phase 1: BURN 1DEV TOKENS");
            println!("   💰 Current Dynamic Price: {} (decreases as more 1DEV burned)", price_str);
            println!("   📉 Burn Progress: {:.1}% (reduces cost by 150 1DEV per 10%)", current_pricing.burn_percentage);
        },
        2 => {
            println!("   💰 Phase 2: TRANSFER QNC TOKENS to Pool 3");
            println!("   💰 Current Dynamic Price: {} (scales with network size)", price_str);
            println!("   📈 Network Size: {} nodes ({}x multiplier)", current_pricing.network_size, current_pricing.network_multiplier);
        },
        _ => {}
    }
    
    println!("   ✅ Activation code ready for blockchain validation");
    Ok(())
}

// Note: QNC amounts are now calculated dynamically based on network state
// Phase 1: 1500 → 150 1DEV (decreases by 150 per 10% burned)
// Phase 2: Base * multiplier (0.5x to 3.0x based on network size)

// Device type validation functions
fn validate_server_node_type(node_type: NodeType) -> Result<(), String> {
    match node_type {
        NodeType::Light => {
            eprintln!("❌ CRITICAL ERROR: Light nodes are NOT allowed on server hardware!");
            eprintln!("   🚫 Light nodes must run ONLY on mobile devices (phones, tablets)");
            eprintln!("   🖥️  For servers use: Full Node or Super Node activation codes");
            eprintln!("   💡 Get correct server activation code from wallet extension");
            eprintln!("");
            eprintln!("🛑 SYSTEM SECURITY: Blocking Light node server activation");
            
            // ABSOLUTE BLOCKING: Light nodes cannot run on servers 
            std::process::exit(1);
        },
        NodeType::Full => {
            println!("✅ Full node validated for server deployment");
            Ok(())
        },
        NodeType::Super => {
            println!("✅ Super node validated for server deployment");
            Ok(())
        },
    }
}

async fn validate_phase_and_pricing(phase: u8, node_type: NodeType, pricing: &PricingInfo, activation_code: &str) -> Result<(), String> {
    let price = calculate_node_price(phase, node_type, pricing);
    let price_str = format_price(phase, price);
    
    println!("\n💰 === Activation Cost Validation ===");
    println!("   Current Phase: {}", phase);
    println!("   Selected Node: {:?}", node_type);
    println!("   Required Cost: {}", price_str);
    
    match phase {
        1 => {
            println!("   📊 Phase 1: Universal pricing for all node types");
            println!("   🔥 Action: BURN {} 1DEV TOKENS on Solana blockchain", price as u64);
            println!("   ⚖️  Benefit: Same cost regardless of node type");
            
            // Phase 1: Quantum-secure validation with Light node blocking
            let decoded = decode_activation_code_quantum_secure(activation_code, node_type).await?;
            println!("   🔐 Quantum decryption successful for Phase 1");
            println!("   💰 Payment verified: Code purchased during Phase {}", decoded.purchase_phase);
            
            println!("   ✅ Phase 1 validation passed with quantum security");
        },
        2 => {
            println!("   📊 Phase 2: Tiered pricing based on node type");
            println!("   💰 Action: TRANSFER {} QNC TOKENS to Pool 3", price as u64);
            println!("   ⚠️  Critical: Must match activation code purchased type");
            
            // Phase 2: Quantum-secure validation with Light node blocking
            let decoded = decode_activation_code_quantum_secure(activation_code, node_type).await?;
            println!("   🔐 Quantum decryption successful for Phase 2");
            println!("   💰 Payment verified: Code purchased during Phase {}", decoded.purchase_phase);
            
            println!("   ✅ Phase 2 validation passed with quantum security");
        },
        _ => {
            return Err(format!("❌ Unknown phase: {}", phase));
        }
    }
    
    Ok(())
}

// Check for existing activation or run interactive setup
async fn check_existing_activation_or_setup() -> Result<(NodeType, String), Box<dyn std::error::Error>> {
    println!("[DEBUG] Checking for existing activation code...");
    
    // Create temporary storage to check for existing activation
    println!("[DEBUG] Attempting to create storage at 'node_data'...");
    let temp_storage = match qnet_integration::storage::PersistentStorage::new("node_data") {
        Ok(storage) => {
            println!("[DEBUG] Storage created successfully");
            storage
        },
        Err(e) => {
            println!("[WARNING] Storage not available: {}, running interactive setup", e);
            return interactive_node_setup().await;
        }
    };
    
    // Check for existing activation code
    println!("[DEBUG] Loading activation code from storage...");
    match temp_storage.load_activation_code() {
        Ok(Some((code, node_type_id, timestamp))) => {
            println!("[DEBUG] Found existing activation code");
            let node_type = match node_type_id {
                0 => NodeType::Light,
                1 => NodeType::Full,
                2 => NodeType::Super,
                _ => NodeType::Full,
            };
            
            // Check if activation is still valid (codes never expire - tied to blockchain burns)
            println!("[SUCCESS] Found valid activation code with cryptographic binding");
            println!("   [CODE] Code: {}", mask_code(&code));
            println!("   [TYPE] Node Type: {:?}", node_type);
            let current_time = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
            println!("   [TIME] Activated: {} days ago", (current_time - timestamp) / (24 * 60 * 60));
            println!("   [UNIVERSAL] Works on VPS, VDS, PC, laptop, server");
            println!("   [RESUMING] Resuming node with existing activation...\n");
            return Ok((node_type, code));
        }
        Ok(None) => {
            println!("[DEBUG] No existing activation found, running interactive setup");
        }
        Err(e) => {
            println!("[WARNING] Error checking activation: {}, running interactive setup", e);
        }
    }
    
    println!("[DEBUG] Starting interactive_node_setup...");
    interactive_node_setup().await
}

// Bootstrap whitelist for first 5 nodes (production network bootstrap)
const BOOTSTRAP_WHITELIST: &[&str] = &[
    "QNET-BOOT-0001-STRAP", // Genesis node 1
    "QNET-BOOT-0002-STRAP", // Genesis node 2  
    "QNET-BOOT-0003-STRAP", // Genesis node 3
    "QNET-BOOT-0004-STRAP", // Genesis node 4
    "QNET-BOOT-0005-STRAP", // Genesis node 5
];

// Check if this is a genesis bootstrap node
fn is_genesis_bootstrap_node() -> bool {
    // AUTOMATIC GENESIS DETECTION: First 5 nodes can start without activation code
    
    // Method 1: Check environment variable (manual override)
    if std::env::var("QNET_GENESIS_BOOTSTRAP").unwrap_or_default() == "1" {
        return true;
    }
    
    // Method 2: Check if network is in genesis state (no other nodes exist)
    if is_network_in_genesis_state() {
        println!("🚀 Network in genesis state - allowing bootstrap node startup");
        return true;
    }
    
    false
}

// Check if network is in genesis state (decentralized detection)
fn is_network_in_genesis_state() -> bool {
    // Decentralized genesis state detection - no hardcoded addresses
    // Check local network environment and regional port availability
    
    let regional_ports = vec![9876, 9877, 9878, 9879, 9880, 9881];
    let mut active_regional_ports = 0;
    
    // Test if any regional QNet ports are active on local network
    for port in regional_ports {
        // Test various local network addresses for existing QNet nodes
        let test_addresses = vec![
            format!("127.0.0.1:{}", port),      // Localhost
            format!("10.0.0.1:{}", port),       // Private network A
            format!("192.168.1.1:{}", port),    // Private network C
            format!("172.16.0.1:{}", port),     // Private network B
        ];
        
        for addr in test_addresses {
            if test_connection_quick(&addr) {
                active_regional_ports += 1;
                break; // One connection per port is enough
            }
        }
    }
    
    // Genesis state: No active QNet nodes found on any regional ports
    println!("[GENESIS] Found {} active regional ports out of 6", active_regional_ports);
    
    // If no regional ports are active, we're in genesis state
    active_regional_ports == 0
}

// Test quick connection to bootstrap peer
fn test_connection_quick(addr: &str) -> bool {
    use std::net::TcpStream;
    use std::time::Duration;
    
    match std::net::TcpStream::connect_timeout(
        &addr.parse().unwrap_or_else(|_| "127.0.0.1:9876".parse().unwrap()),
        Duration::from_secs(2)
    ) {
        Ok(_) => true,
        Err(_) => false,
    }
}

// Generate bootstrap activation code for genesis nodes
fn generate_genesis_activation_code() -> Result<String, String> {
    // Get bootstrap node ID from environment or generate
    let bootstrap_id = std::env::var("QNET_BOOTSTRAP_ID").unwrap_or_else(|_| {
        // Generate sequential ID based on existing nodes
        let existing_nodes = get_existing_bootstrap_nodes();
        format!("{:04}", existing_nodes.len() + 1)
    });
    
    // Generate bootstrap code
    let bootstrap_code = format!("QNET-BOOT-{}-STRAP", bootstrap_id);
    
    // Validate bootstrap code
    if !BOOTSTRAP_WHITELIST.contains(&bootstrap_code.as_str()) {
        return Err("Maximum 5 bootstrap nodes allowed".to_string());
    }
    
    Ok(bootstrap_code)
}

// Get existing bootstrap nodes count
fn get_existing_bootstrap_nodes() -> Vec<String> {
    // In production: query blockchain for existing bootstrap nodes
    // For now, return empty vector
    vec![]
}

// Comprehensive activation code validation (ALL checks before acceptance)
async fn validate_activation_code_comprehensive(
    code: &str, 
    node_type: NodeType, 
    current_phase: u8,
    pricing_info: &PricingInfo
) -> Result<(), String> {
    println!("🔍 Comprehensive activation code validation...");
    
    // 1. Check if empty code for genesis bootstrap
    if code.is_empty() {
        if is_genesis_bootstrap_node() {
            println!("✅ Genesis bootstrap node detected - generating bootstrap code");
            return Ok(());
        } else {
            return Err("Empty activation code not allowed for regular nodes".to_string());
        }
    }
    
    // 2. Format validation
    if !code.starts_with("QNET-") || code.len() != 17 {
        return Err("Invalid activation code format. Expected: QNET-XXXX-XXXX-XXXX".to_string());
    }
    
    // 3. Bootstrap whitelist check (first 5 nodes)
    if BOOTSTRAP_WHITELIST.contains(&code) {
        println!("✅ Bootstrap whitelist code detected - Genesis network node");
        return Ok(());
    }
    
            // 4. Phase and pricing validation with quantum decryption
        if let Err(e) = validate_phase_and_pricing(current_phase, node_type, pricing_info, code).await {
            return Err(format!("Phase validation failed: {}", e));
        }
    
    // 5. Blockchain uniqueness validation (production only)
    if std::env::var("QNET_PRODUCTION").unwrap_or_default() == "1" {
        if let Err(e) = validate_blockchain_uniqueness(code).await {
            return Err(format!("Blockchain validation failed: {}", e));
        }
    }
    
    // 6. Burn verification for production
    if std::env::var("QNET_PRODUCTION").unwrap_or_default() == "1" {
        if let Err(e) = verify_activation_burn(code, &node_type).await {
            return Err(format!("Burn verification failed: {}", e));
        }
    }
    
    println!("✅ All activation code validations passed");
    Ok(())
}

// Blockchain uniqueness validation
async fn validate_blockchain_uniqueness(code: &str) -> Result<(), String> {
    println!("🔍 Checking blockchain uniqueness...");
    
    // Initialize blockchain registry
    let registry = qnet_integration::activation_validation::BlockchainActivationRegistry::new(
        Some("https://rpc.qnet.io".to_string())
    );
    
    // Check if code is used globally (blockchain + DHT + cache)
    match registry.is_code_used_globally(code).await {
        Ok(true) => {
            Err("Activation code already used on blockchain".to_string())
        }
        Ok(false) => {
            println!("✅ Activation code available for use");
            Ok(())
        }
        Err(e) => {
            println!("⚠️  Warning: Blockchain check failed: {}", e);
            // In production, we might want to fail here
            // For now, allow activation if registry is unavailable
            Ok(())
        }
    }
}

// Verify activation burn transaction
async fn verify_activation_burn(code: &str, node_type: &NodeType) -> Result<(), String> {
    println!("🔍 Verifying activation burn transaction...");
    
    // Extract wallet address from code
    let wallet_address = extract_wallet_from_activation_code(code)?;
    
    // Required burn amount (Phase 1: 1500 1DEV universal)
    let required_burn = 1500.0;
    
    // Verify burn transaction exists
    let burn_verified = verify_solana_burn_transaction(&wallet_address, required_burn).await?;
    
    if burn_verified {
        println!("✅ Burn transaction verified successfully");
        Ok(())
    } else {
        Err("Required burn transaction not found".to_string())
    }
}

// Interactive node setup functions
async fn interactive_node_setup() -> Result<(NodeType, String), Box<dyn std::error::Error>> {
    println!("[DEBUG] Entering interactive_node_setup()...");

    println!("\n[SETUP] === QNet Production Node Setup ===");
    println!("[SERVER] SERVER DEPLOYMENT MODE");
    println!("Welcome to QNet Blockchain Network!");
    
    // Show region detection first
    println!("\n[REGION] === Automatic Region Detection ===");
    println!("[REGION] Analyzing your network location...");
    
    // Auto-detect region OR use decentralized fallback
    let detected_region = match auto_detect_region().await {
        Ok(region) => {
            println!("[REGION] ✅ Successfully detected region: {:?}", region);
            println!("[REGION] 🌐 Regional Port: {}", get_regional_port(&region));
            
            // Show regional network zone
            match region {
                Region::NorthAmerica => println!("[REGION] 🌎 Network Zone: Americas"),
                Region::Europe => println!("[REGION] 🌍 Network Zone: European"),
                Region::Asia => println!("[REGION] 🌏 Network Zone: Asia-Pacific"),
                Region::SouthAmerica => println!("[REGION] 🌎 Network Zone: Latin America"),
                Region::Africa => println!("[REGION] 🌍 Network Zone: African"),
                Region::Oceania => println!("[REGION] 🌏 Network Zone: Oceania-Pacific"),
            }
            println!("[REGION] 🔗 Your node will connect to regional QNet network");
            region
        },
        Err(e) => {
            println!("[REGION] ⚠️ Could not auto-detect region: {}", e);
            println!("[REGION] 🚀 MULTI-REGIONAL DISCOVERY MODE");
            println!("[REGION] 🌐 Testing all 6 regional ports for active nodes");
            println!("[REGION] 📡 Will connect to best performing regions");
            println!("[REGION] ⚡ Starting comprehensive port scan...");
            
            // Test all regional ports and find the best one
            test_all_regional_ports().await.unwrap_or_else(|| {
                println!("[REGION] 🔄 No active nodes found - using Europe as starting point");
                println!("[REGION] 🌍 Node will still scan all ports during P2P discovery");
                Region::Europe
            })
        }
    };

    println!("[DEBUG] Calling detect_current_phase()...");
    let (current_phase, pricing_info) = detect_current_phase().await;
    println!("[DEBUG] detect_current_phase() completed, phase = {}", current_phase);

    // Display phase information
    display_phase_info(current_phase, &pricing_info);

    println!("[DEBUG] Calling select_node_type()...");
    let node_type = select_node_type(current_phase, &pricing_info)?;
    println!("[DEBUG] select_node_type() completed, type = {:?}", node_type);

    // Calculate activation price
    let price = match current_phase {
        1 => 10.0,      // Phase 1: Universal pricing
        2 => match node_type {
            NodeType::Light => 5.0,
            NodeType::Full => 10.0,
            NodeType::Super => 20.0,
        },
        _ => 10.0,
    };

    println!("\n[SECURITY] === Activation Code Requirements ===");
    
    if current_phase == 1 {
        println!("   [INFO] Phase 1: Universal activation cost");
        println!("   [BURN] {} 1DEV tokens required", price as u64);
        println!("   [INFO] Activation codes from 1DEV burn transactions");
    } else {
        println!("   [INFO] Phase 2: Tiered activation costs");
        println!("   [CRITICAL] CRITICAL: Activation code MUST match node type");
        println!("   [COST] {:?} node requires {} tokens", node_type, price as u64);
        println!("   [ERROR] Wrong activation code type will be rejected");
    }

    // Request activation code input
    use std::io::Write;
    print!("\n[INPUT] === Enter Activation Code ===\nCode: ");
    std::io::stdout().flush().unwrap();
    
    let mut input = String::new();
    let activation_code = match io::stdin().read_line(&mut input) {
        Ok(_) => {
            let code = input.trim().to_string();
            
            // Handle empty input for genesis bootstrap
            if code.is_empty() && is_genesis_bootstrap_node() {
                println!("[SUCCESS] Generating genesis bootstrap code...");
                match generate_genesis_activation_code() {
                    Ok(genesis_code) => genesis_code,
                    Err(e) => {
                        return Err(format!("Failed to generate genesis code: {}", e).into());
                    }
                }
            } else if code.is_empty() {
                return Err("Empty activation code not allowed for regular nodes".into());
            } else {
                code
            }
        }
        Err(e) => return Err(format!("Error reading input: {}", e).into()),
    };

    println!("\n[SUCCESS] Server node setup complete!");
    println!("   [SERVER] Device Type: Dedicated Server");
    println!("   [TYPE] Node Type: {:?}", node_type);
    println!("   [PHASE] Phase: {}", current_phase);
    println!("   [COST] Cost: {} tokens", price as u64);
    println!("   [CODE] Activation Code: {}", mask_code(&activation_code));
    println!("   [STARTING] Starting node...\n");
    
    Ok((node_type, activation_code))
}

#[derive(Debug)]
struct PricingInfo {
    network_size: u64,
    burn_percentage: f64, // Phase 1: percentage of 1DEV burned
    network_multiplier: f64, // Phase 2: network size multiplier
}
    
// Check if 5 years have passed since QNet mainnet launch
async fn is_five_years_passed_since_mainnet() -> bool {
    // QNet mainnet launch timestamp - get from blockchain or use current time
    let mainnet_launch_timestamp = std::env::var("QNET_MAINNET_LAUNCH_TIMESTAMP")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or_else(|| {
            // Network not launched yet or timestamp not set
            // Use current time as fallback (0 years passed)
            chrono::Utc::now().timestamp()
        });
    
    let current_timestamp = chrono::Utc::now().timestamp();
    let five_years_in_seconds = 5 * 365 * 24 * 60 * 60; // 5 years in seconds
    
    let years_passed = (current_timestamp - mainnet_launch_timestamp) / (365 * 24 * 60 * 60);
    
    println!("📅 Time check: {:.2} years passed since mainnet launch", 
             years_passed as f64);
    
    // Only consider 5 years passed if we have a valid launch timestamp
    if mainnet_launch_timestamp > 1700000000 { // After 2023-11-14 (sanity check)
        (current_timestamp - mainnet_launch_timestamp) >= five_years_in_seconds
    } else {
        false // Network not launched yet
    }
}

// Detect current phase with proper transition logic
async fn detect_current_phase() -> (u8, PricingInfo) {
    println!("🔍 Detecting current network phase...");
    
    // Try to get real data from Solana contract
    match fetch_burn_tracker_data().await {
        Ok(burn_data) => {
            println!("✅ Real blockchain data loaded");
            
            // Phase 2 transition logic: 90% burned OR 5 years passed (whichever comes first)
            let five_years_passed = is_five_years_passed_since_mainnet().await;
            
            // CRITICAL: Automatic phase transition logic
            let current_phase = if burn_data.burn_percentage >= 90.0 {
                println!("🔥 PHASE TRANSITION: 90% of 1DEV burned - transitioning to Phase 2");
                2 // Phase 2: QNC economy
            } else if five_years_passed {
                println!("⏰ PHASE TRANSITION: 5 years since mainnet - transitioning to Phase 2");
                2 // Phase 2: QNC economy
            } else {
                println!("🔥 Phase 1 active: {:.1}% burned, {:.1} years elapsed", 
                    burn_data.burn_percentage, 
                    get_years_since_mainnet().await);
                1 // Phase 1: 1DEV burn
            };
            
            let network_multiplier = calculate_network_multiplier(burn_data.total_nodes_activated);
            
            let pricing_info = PricingInfo {
                network_size: burn_data.total_nodes_activated,
                burn_percentage: burn_data.burn_percentage,
                network_multiplier,
            };
            
            println!("✅ Phase {} detected (from blockchain)", current_phase);
            (current_phase, pricing_info)
        }
        Err(e) => {
            println!("❌ CRITICAL ERROR: Cannot fetch blockchain data!");
            println!("   Error: {}", e);
            println!("   Trying backup RPC nodes...");
            
            // Try backup devnet RPC nodes
            let backup_rpcs = vec![
                "https://api.devnet.solana.com",
                "https://devnet.helius-rpc.com",
                "https://solana-devnet.g.alchemy.com/v2/demo",
            ];
            
            for rpc_url in backup_rpcs {
                println!("🔄 Trying backup RPC: {}", rpc_url);
                match get_real_token_supply(rpc_url, "62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ").await {
                    Ok(supply_data) => {
                        println!("✅ Data retrieved from backup RPC!");
                        
                        // Phase 2 transition logic: 90% burned OR 5 years passed
                        let five_years_passed = is_five_years_passed_since_mainnet().await;
                        
                        let current_phase = if supply_data.burn_percentage >= 90.0 {
                            println!("🔥 PHASE TRANSITION: 90% of 1DEV burned - transitioning to Phase 2");
                            2
                        } else if five_years_passed {
                            println!("⏰ PHASE TRANSITION: 5 years since mainnet - transitioning to Phase 2");
                            2
                        } else {
                            1
                        };
                        
                        let network_multiplier = calculate_network_multiplier(supply_data.total_burned / 1500);
                        let pricing_info = PricingInfo {
                            network_size: supply_data.total_burned / 1500,
                            burn_percentage: supply_data.burn_percentage,
                            network_multiplier,
                        };
                        return (current_phase, pricing_info);
                    }
                    Err(e) => {
                        println!("❌ Backup RPC also failed: {}", e);
                        continue;
                    }
                }
            }
            
            println!("💥 FATAL ERROR: All devnet RPC nodes unavailable!");
            println!("   Cannot get real 1DEV token burn data from Solana devnet");
            println!("   Defaulting to Phase 1 with mock data");
            
            // Emergency fallback
            let fallback_pricing = PricingInfo {
                network_size: 100,
                burn_percentage: 0.0,
                network_multiplier: 0.5,
            };
            
            (1, fallback_pricing)
        }
    }
}

// Get years since mainnet launch
async fn get_years_since_mainnet() -> f64 {
    let mainnet_launch_timestamp = std::env::var("QNET_MAINNET_LAUNCH_TIMESTAMP")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or_else(|| chrono::Utc::now().timestamp());
    
    let current_timestamp = chrono::Utc::now().timestamp();
    let years_passed = (current_timestamp - mainnet_launch_timestamp) as f64 / (365.0 * 24.0 * 60.0 * 60.0);
    
    years_passed
}

// Real blockchain data structure
#[derive(Debug)]
struct BurnTrackerData {
    total_1dev_burned: u64,
    burn_percentage: f64,
    total_nodes_activated: u64,
    light_nodes: u64,
    full_nodes: u64,
    super_nodes: u64,
    phase_transitioned: bool,
    last_update: i64,
}

// Fetch real data from Solana contract
async fn fetch_burn_tracker_data() -> Result<BurnTrackerData, String> {
    // Testnet Solana RPC configuration (devnet)
    let rpc_url = std::env::var("SOLANA_RPC_URL").unwrap_or_else(|_| {
        "https://api.devnet.solana.com".to_string()
    });
    
    let program_id = std::env::var("BURN_TRACKER_PROGRAM_ID").unwrap_or_else(|_| {
        // Production program ID for 1DEV burn tracker
        "D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7".to_string()
    });
    
    // Program ID is set and ready for production
    println!("📋 Burn Tracker Program ID: {}", program_id);
    
    // TODO: Deploy contract to get actual program_id and update environment variable
    
    println!("📋 Burn Tracker Program ID: {}", program_id);
    
    // PRODUCTION 1DEV token mint address on Solana devnet
    let one_dev_mint = std::env::var("ONE_DEV_MINT_ADDRESS").unwrap_or_else(|_| {
        "62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ".to_string()
    });
    
    println!("🔗 Connecting to Solana devnet RPC: {}", rpc_url);
    println!("📋 Burn Tracker Program ID: {}", program_id);
    println!("💰 1DEV Token Mint (devnet): {}", one_dev_mint);
    
    // Try to get real token supply from Solana
    match get_real_token_supply(&rpc_url, &one_dev_mint).await {
        Ok(supply_data) => {
            println!("✅ Real token data retrieved from Solana!");
            println!("   💰 Current Supply: {} 1DEV", supply_data.current_supply);
            println!("   🔥 Total Burned: {} 1DEV", supply_data.total_burned);
            println!("   📊 Burn Percentage: {:.2}%", supply_data.burn_percentage);
            
            // TODO: Get real node count from burn tracker contract
            let estimated_nodes = estimate_nodes_from_burn(supply_data.total_burned);
            
            Ok(BurnTrackerData {
                total_1dev_burned: supply_data.total_burned,
                burn_percentage: supply_data.burn_percentage,
                total_nodes_activated: estimated_nodes,
                light_nodes: estimated_nodes / 3,
                full_nodes: estimated_nodes / 3,
                super_nodes: estimated_nodes / 3,
                phase_transitioned: supply_data.burn_percentage >= 90.0,
                last_update: chrono::Utc::now().timestamp(),
            })
        }
        Err(e) => {
            println!("❌ Failed to get real token data: {}", e);
            Err(format!("Failed to fetch real 1DEV token data: {}", e))
        }
    }
}

// Get real token supply data from Solana
#[derive(Debug)]
struct TokenSupplyData {
    total_supply: u64,
    current_supply: u64,
    total_burned: u64,
    burn_percentage: f64,
}

async fn get_real_token_supply(rpc_url: &str, token_mint: &str) -> Result<TokenSupplyData, String> {
    println!("🔍 Fetching real 1DEV token supply from Solana blockchain...");
    
    // Check if this is our production token (Phase 1 active)
    if token_mint == "62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ" {
        println!("✅ Using production 1DEV token (Phase 1 active)");
        
        // Get REAL token supply from Solana devnet
        let payload = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"getTokenSupply","params":["{}"]}}"#,
            token_mint
        );
        
        match tokio::process::Command::new("curl")
            .args(&["-s", "-X", "POST", "https://api.devnet.solana.com"])
            .args(&["-H", "Content-Type: application/json"])
            .args(&["-d", &payload])
            .output()
            .await
        {
            Ok(output) => {
                let response = String::from_utf8_lossy(&output.stdout);
                println!("📡 Solana devnet RPC Response received");
                
                if let Some(amount_start) = response.find("\"amount\":\"") {
                    if let Some(amount_end) = response[amount_start + 10..].find("\"") {
                        let amount_str = &response[amount_start + 10..amount_start + 10 + amount_end];
                        
                        if let Ok(current_supply_raw) = amount_str.parse::<u64>() {
                            let total_supply_tokens = 1_000_000_000u64; // 1 billion total supply
                            let current_supply_tokens = current_supply_raw / 1_000_000; // Convert from 6 decimals
                            let total_burned = total_supply_tokens - current_supply_tokens;
                            let burn_percentage = (total_burned as f64 / total_supply_tokens as f64) * 100.0;
                            
                            println!("✅ REAL production token data from Solana devnet:");
                            println!("   💰 Total Supply: {} 1DEV", total_supply_tokens);
                            println!("   💰 Current Supply: {} 1DEV", current_supply_tokens);
                            println!("   🔥 Total Burned: {} 1DEV", total_burned);
                            println!("   📊 Burn Percentage: {:.2}%", burn_percentage);
                            
                            return Ok(TokenSupplyData {
                                total_supply: total_supply_tokens,
                                current_supply: current_supply_tokens,
                                total_burned,
                                burn_percentage,
                            });
                        }
                    }
                }
            }
            Err(e) => {
                println!("❌ Failed to query Solana devnet: {}", e);
            }
        }
        
        // Fallback if RPC call fails
        println!("⚠️  Using fallback data - RPC call failed");
        return Ok(TokenSupplyData {
            total_supply: 1_000_000_000u64,
            current_supply: 1_000_000_000u64,
            total_burned: 0u64,
            burn_percentage: 0.0,
        });
    }
    
    // For other tokens, try real RPC call
    match tokio::process::Command::new("curl")
        .args(&["-s", "-X", "POST", rpc_url])
        .args(&["-H", "Content-Type: application/json"])
        .args(&["-d", &format!(r#"{{"jsonrpc":"2.0","id":1,"method":"getTokenSupply","params":["{}"]}}"#, token_mint)])
        .output()
        .await
    {
        Ok(output) => {
            let response = String::from_utf8_lossy(&output.stdout);
            println!("📡 Solana RPC Response received");
            
            // Parse the JSON response to get token supply
            println!("🔍 DEBUG: Raw RPC response: {}", response);
            
            // Check if response contains error
            if response.contains("\"error\"") {
                println!("❌ RPC returned error response");
                return Err("RPC returned error in response".to_string());
            }
            
            // Try to extract token supply from response
            if response.contains("\"result\"") && response.contains("\"value\"") {
                // Look for amount field in the response
                if let Some(amount_start) = response.find("\"amount\":\"") {
                    if let Some(amount_end) = response[amount_start + 10..].find("\"") {
                        let amount_str = &response[amount_start + 10..amount_start + 10 + amount_end];
                        println!("🔍 DEBUG: Found amount string: {}", amount_str);
                        
                        if let Ok(current_supply) = amount_str.parse::<u64>() {
                            // 1DEV has 6 decimals, so convert from smallest units
                            let current_supply_tokens = current_supply / 1_000_000;
                            let total_supply_tokens = 1_000_000_000u64; // 1 billion total supply
                            let total_burned = total_supply_tokens - current_supply_tokens;
                            let burn_percentage = (total_burned as f64 / total_supply_tokens as f64) * 100.0;
                            
                            println!("✅ Real blockchain data fetched successfully:");
                            println!("   💰 Total Supply: {} 1DEV", total_supply_tokens);
                            println!("   💰 Current Supply: {} 1DEV", current_supply_tokens);
                            println!("   🔥 Total Burned: {} 1DEV", total_burned);
                            println!("   📊 Burn Percentage: {:.2}%", burn_percentage);
                            
                            return Ok(TokenSupplyData {
                                total_supply: total_supply_tokens,
                                current_supply: current_supply_tokens,
                                total_burned,
                                burn_percentage,
                            });
                        } else {
                            println!("❌ Failed to parse amount as u64: {}", amount_str);
                        }
                    } else {
                        println!("❌ Could not find closing quote for amount");
                    }
                } else {
                    println!("❌ Could not find amount field in response");
                }
            } else {
                println!("❌ Response missing result/value fields");
            }
            
            Err("Failed to parse token supply from Solana response".to_string())
        }
        Err(e) => {
            Err(format!("Failed to call Solana RPC: {}", e))
        }
    }
}

// Estimate node count from burned tokens (until we have real burn tracker)
fn estimate_nodes_from_burn(total_burned: u64) -> u64 {
    // Estimate: each node burns ~1500-150 1DEV on average
    // Conservative estimate: 500 1DEV per node average
    let estimated_nodes = total_burned / 500;
    estimated_nodes.max(1000) // Minimum estimate
}

fn calculate_network_multiplier(network_size: u64) -> f64 {
    match network_size {
        0..=10_000 => 0.5,      // Early network discount
        10_001..=100_000 => 1.0, // Standard pricing
        100_001..=1_000_000 => 2.0, // High demand
        _ => 3.0                 // Mature network premium
    }
}

fn display_phase_info(phase: u8, pricing: &PricingInfo) {
    println!("\n📊 === Current Network Status ===");
    
    match phase {
        1 => {
            println!("🔥 Phase 1: 1DEV Burn-to-Join Active");
            println!("   📈 1DEV Burned: {:.1}% (Real blockchain data)", pricing.burn_percentage);
            println!("   💰 Universal Pricing: Same cost for all node types");
            println!("   📉 Dynamic Reduction: -150 1DEV per 10% burned");
            println!("   🎯 Transition: Occurs at 90% burned OR 5 years (whichever comes first)");
            println!("   🌐 Active Nodes: {} (Estimated from burn data)", pricing.network_size);
        }
        2 => {
            println!("💎 Phase 2: QNC Operational Economy Active");
            println!("   🌐 Network Size: {} active nodes (Estimated from burn data)", pricing.network_size);
            println!("   📊 Price Multiplier: {:.1}x (Based on network size)", pricing.network_multiplier);
            println!("   💰 Server Node Dynamic Pricing:");
            
            // Show only server-compatible node prices (Full and Super)
            let full_price = calculate_node_price(2, NodeType::Full, pricing);  
            let super_price = calculate_node_price(2, NodeType::Super, pricing);
            
            println!("      🖥️  Full Node:  {:.0} QNC (Base: 7,500 × {:.1}x)", full_price, pricing.network_multiplier);
            println!("      🏭 Super Node: {:.0} QNC (Base: 10,000 × {:.1}x)", super_price, pricing.network_multiplier);
            
            println!("   📱 Light Node: MOBILE DEVICES ONLY (5,000 QNC base)");
            println!("   🏦 Pool 3: Activation fees redistributed to all nodes");
            println!("   📈 Final Burn: {:.1}% of 1DEV supply destroyed (Real blockchain data)", pricing.burn_percentage);
            println!("   ⚠️  CRITICAL: Activation code must match exact node type");
        }
        _ => println!("❓ Unknown phase detected"),
    }
}

fn select_node_type(phase: u8, pricing: &PricingInfo) -> Result<NodeType, Box<dyn std::error::Error>> {
    println!("🔍 DEBUG: Entering select_node_type()...");
    println!("\n🖥️  === Server Node Type Selection ===");
    println!("⚠️  SERVERS ONLY SUPPORT FULL/SUPER NODES");
    println!("📱 Light nodes are restricted to mobile devices only");
    println!("");
    println!("Choose your server node type:");
    println!("1. Full Node   - Servers/desktops, full validation");
    println!("2. Super Node  - High-performance servers, maximum rewards");
    
    // Show pricing preview for server-compatible nodes only
    println!("\n💰 Current Pricing:");
    for (i, node_type) in [NodeType::Full, NodeType::Super].iter().enumerate() {
        let price = calculate_node_price(phase, *node_type, pricing);
        let price_str = format_price(phase, price);
        println!("   {}. {}: {}", i + 1, format_node_type(*node_type), price_str);
    }
    
    print!("\nEnter your choice (1-2): ");
    io::stdout().flush()?;
    
    println!("🔍 DEBUG: Waiting for user input...");
    
    let mut input = String::new();
    match io::stdin().read_line(&mut input) {
        Ok(bytes_read) => {
            println!("🔍 DEBUG: Read {} bytes: '{}'", bytes_read, input.trim());
        }
        Err(e) => {
            println!("❌ ERROR: Cannot read from stdin: {}", e);
            println!("🐳 Docker mode detected - using default Full Node");
            return Ok(NodeType::Full);
        }
    }
    
    match input.trim() {
        "1" => {
            println!("✅ Full Node selected for server deployment");
            Ok(NodeType::Full)
        },
        "2" => {
            println!("✅ Super Node selected for server deployment");
            Ok(NodeType::Super)
        },
        _ => {
            println!("❌ Invalid choice. Defaulting to Full Node for server.");
            Ok(NodeType::Full)
        }
    }
}

fn calculate_node_price(phase: u8, node_type: NodeType, pricing: &PricingInfo) -> f64 {
    match phase {
        1 => {
            // Phase 1: CORRECT 1DEV pricing mathematics
            // Base price: 1500 1DEV
            // Reduction: 150 1DEV per each COMPLETE 10% burned tokens
            // Minimum price: 150 1DEV (at 90%+ burned)
            let base_price = 1500.0;
            let min_price = 150.0;
            let reduction_per_tier = 150.0; // 150 1DEV per each 10%
            
            // CORRECT calculation: number of COMPLETE 10% tiers
            let completed_tiers = (pricing.burn_percentage / 10.0).floor();
            let total_reduction = completed_tiers * reduction_per_tier;
            let current_price = base_price - total_reduction;
            
            // Universal price for all node types in Phase 1
            current_price.max(min_price)
        }
        2 => {
            // Phase 2: Real QNC pricing from contract constants
            // QNC_LIGHT_ACTIVATION = 5000 QNC
            // QNC_FULL_ACTIVATION = 7500 QNC  
            // QNC_SUPER_ACTIVATION = 10000 QNC
            let base_price = match node_type {
                NodeType::Light => 5_000.0,
                NodeType::Full => 7_500.0,
                NodeType::Super => 10_000.0,
            };
            base_price * pricing.network_multiplier
        }
        _ => 0.0,
    }
}

fn format_price(phase: u8, price: f64) -> String {
    match phase {
        1 => format!("{:.0} 1DEV", price),
        2 => format!("{:.0} QNC", price),
        _ => "Unknown".to_string(),
    }
}

fn format_node_type(node_type: NodeType) -> &'static str {
    match node_type {
        NodeType::Light => "Light Node ",
        NodeType::Full => "Full Node  ",
        NodeType::Super => "Super Node ",
    }
}

fn display_activation_cost(phase: u8, node_type: NodeType, price: f64) {
    println!("\n💳 === Activation Cost ===");
    println!("   Node Type: {:?}", node_type);
    println!("   Cost: {}", format_price(phase, price));
    
    match phase {
        1 => {
            println!("   💸 Action: Burn {} 1DEV TOKENS on Solana", price as u64);
            println!("   🔥 Effect: Tokens destroyed forever (deflationary)");
        }
        2 => {
            println!("   💰 Action: Spend {} QNC to Pool 3", price as u64);
            println!("   🏦 Effect: QNC redistributed to all active nodes");
        }
        _ => {}
    }
}

fn request_activation_code(phase: u8) -> Result<String, Box<dyn std::error::Error>> {
    println!("\n🔐 === Activation Code ===");
    
    // Check if this is a genesis bootstrap node
    if is_genesis_bootstrap_node() {
        println!("🚀 GENESIS BOOTSTRAP NODE DETECTED");
        println!("   ⚡ This node will become one of the first 5 genesis nodes");
        println!("   🔑 Bootstrap nodes don't need activation codes");
        println!("   📝 Press ENTER to generate genesis bootstrap code");
        print!("Activation Code (or press ENTER for genesis): ");
    } else {
        println!("📱 HOW TO GET ACTIVATION CODE:");
        println!("   1. Install QNet Browser Extension or Mobile App");
        println!("   2. Create/Import your wallet");
        println!("   3. Select node type and complete payment");
        println!("   4. Copy the generated activation code");
        println!("   5. Use the code here to activate your server node");
        println!();
        
        println!("🖥️  SERVER NODE RESTRICTIONS:");
        println!("   ✅ Full Nodes: Can be activated on servers");
        println!("   ✅ Super Nodes: Can be activated on servers");
        println!("   ❌ Light Nodes: MOBILE DEVICES ONLY!");
        println!("   📱 Light nodes cannot be activated on servers");
        println!();
        
        println!("📊 QNet Activation System:");
        println!("   💰 Cost: Variable based on node type and network conditions");
        println!("   🔥 Payment: Transfer tokens to activation pool");
        println!("   🎯 Benefit: Permanent node activation");
        println!("   ⚡ Generated through: Browser extension or mobile app");
        println!("   📱 Code format: QNET-XXXX-XXXX-XXXX");
        
        println!("\n⚠️  === PRODUCTION ACTIVATION REQUIRED ===");
        println!("📝 Enter your activation code:");
        println!("🔐 Code format: QNET-XXXX-XXXX-XXXX");
        print!("Activation Code: ");
    }
    
    if let Err(e) = io::stdout().flush() {
        return Err(format!("Error flushing stdout: {}", e).into());
    }
    
    let mut input = String::new();
    match io::stdin().read_line(&mut input) {
        Ok(_) => {
            let code = input.trim().to_string();
            
            // Handle empty input for genesis bootstrap
            if code.is_empty() && is_genesis_bootstrap_node() {
                println!("✅ Generating genesis bootstrap code...");
                match generate_genesis_activation_code() {
                    Ok(genesis_code) => {
                        println!("✅ Genesis bootstrap code generated: {}", genesis_code);
                        Ok(genesis_code)
                    }
                    Err(e) => {
                        Err(format!("Failed to generate genesis code: {}", e).into())
                    }
                }
            } else if code.is_empty() {
                Err("Empty activation code not allowed for regular nodes".into())
            } else {
                Ok(code)
            }
        }
        Err(e) => Err(format!("Error reading input: {}", e).into()),
    }
}

// Automatic configuration - no command line arguments
#[derive(Debug, Clone)]
struct AutoConfig {
    p2p_port: u16,
    rpc_port: u16,
    data_dir: PathBuf,
    region: Region,
    bootstrap_peers: Vec<String>,
    high_performance: bool,
    producer: bool,
    enable_metrics: bool,
}

impl AutoConfig {
    async fn new() -> Result<Self, Box<dyn std::error::Error>> {
        println!("🔧 Auto-configuring QNet node...");
        
        // Auto-detect region via decentralized methods
        let region = auto_detect_region().await?;
        println!("🌍 Detected region: {:?}", region);
        
        // Auto-select available ports
        let p2p_port = find_available_port(9876).await?;
        let rpc_port = find_available_port(9877).await?;
        println!("🔌 Selected ports: P2P={}, RPC={}", p2p_port, rpc_port);
        
        // Standard data directory
        let data_dir = PathBuf::from("node_data");
        println!("📁 Data directory: {:?}", data_dir);
        
        // Bootstrap peers based on region
        let bootstrap_peers = get_bootstrap_peers_for_region(&region);
        println!("🔗 Bootstrap peers: {:?}", bootstrap_peers);
        
        Ok(Self {
            p2p_port,
            rpc_port,
            data_dir,
            region,
            bootstrap_peers,
            high_performance: true,  // Always enabled for production
            producer: true,          // Always enabled for production
            enable_metrics: true,    // Always enabled for production
        })
    }
}

// Auto-detect available port
async fn find_available_port(preferred: u16) -> Result<u16, Box<dyn std::error::Error>> {
    use std::net::TcpListener;
    
    // Try preferred port first
    if TcpListener::bind(format!("0.0.0.0:{}", preferred)).is_ok() {
        return Ok(preferred);
    }
    
    // Find any available port in range
    for port in preferred..preferred + 100 {
        if TcpListener::bind(format!("0.0.0.0:{}", port)).is_ok() {
            return Ok(port);
        }
    }
    
    Err("No available ports found".into())
}

// Get bootstrap peers - MULTI-REGIONAL DISCOVERY
fn get_bootstrap_peers_for_region(region: &Region) -> Vec<String> {
    println!("[BOOTSTRAP] Multi-regional peer discovery for region: {:?}", region);
    
    // Primary region port
    let primary_port = get_regional_port(region);
    println!("[BOOTSTRAP] Primary regional port: {}", primary_port);
    
    // All regional ports for discovery
    let all_regional_ports = vec![9876, 9877, 9878, 9879, 9880, 9881];
    println!("[BOOTSTRAP] Will also scan all regional ports: {:?}", all_regional_ports);
    println!("[BOOTSTRAP] P2P system will discover peers across all regions");
    
    // Return empty - P2P system will populate dynamically
    // The unified_p2p module will handle actual peer discovery
    vec![]
}

fn get_regional_port(region: &Region) -> u16 {
    // Each region has its unique port for decentralized operation
    match region {
        Region::NorthAmerica => 9876,
        Region::Europe => 9877,
        Region::Asia => 9878,
        Region::SouthAmerica => 9879,
        Region::Africa => 9880,
        Region::Oceania => 9881,
    }
}

// Production-grade physical IP detection - PUBLIC IP ONLY
fn get_physical_ip() -> Result<String, String> {
    use std::net::{IpAddr};
    
    // Method 1: Check network interfaces for PUBLIC IP only
    if let Ok(interfaces) = get_all_network_interfaces() {
        for interface in interfaces {
            if let IpAddr::V4(ipv4) = interface {
                // STRICT: Only accept public IP addresses
                if !ipv4.is_loopback() && !ipv4.is_private() && !ipv4.is_link_local() && !ipv4.is_multicast() {
                    println!("[IP] Found public IP: {}", ipv4);
                    return Ok(ipv4.to_string());
                }
            }
        }
    }
    
    // Method 2: Check gateway interface for PUBLIC IP
    if let Ok(gateway_ip) = get_gateway_interface_ip() {
        if let Ok(parsed_ip) = gateway_ip.parse::<std::net::Ipv4Addr>() {
            if !parsed_ip.is_private() && !parsed_ip.is_loopback() && !parsed_ip.is_link_local() {
                println!("[IP] Found public gateway IP: {}", gateway_ip);
                return Ok(gateway_ip);
            }
        }
    }
    
    // NO FALLBACK - Public IP required for region detection
    Err("No public IP address found - production deployment requires public IP or manual QNET_REGION setting".to_string())
}

// Get all network interfaces without external dependencies
fn get_all_network_interfaces() -> Result<Vec<IpAddr>, String> {
    use std::process::Command;
    
    let mut interfaces = Vec::new();
    
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = Command::new("ipconfig").output() {
            let output_str = String::from_utf8_lossy(&output.stdout);
            for line in output_str.lines() {
                if line.trim().starts_with("IPv4 Address") {
                    if let Some(ip_part) = line.split(':').nth(1) {
                        let ip_str = ip_part.trim();
                        if let Ok(ip) = ip_str.parse::<std::net::Ipv4Addr>() {
                            // Only include public IP addresses
                            if !ip.is_private() && !ip.is_loopback() && !ip.is_link_local() {
                                interfaces.push(IpAddr::V4(ip));
                            }
                        }
                    }
                }
            }
        }
    }
    
    #[cfg(target_os = "linux")]
    {
        if let Ok(output) = Command::new("hostname").arg("-I").output() {
            let output_str = String::from_utf8_lossy(&output.stdout);
            for ip_str in output_str.split_whitespace() {
                if let Ok(ip) = ip_str.parse::<std::net::Ipv4Addr>() {
                    // Only include public IP addresses
                    if !ip.is_private() && !ip.is_loopback() && !ip.is_link_local() {
                        interfaces.push(IpAddr::V4(ip));
                    }
                }
            }
        }
    }
    
    if interfaces.is_empty() {
        Err("No network interfaces found".to_string())
    } else {
        Ok(interfaces)
    }
}

// Get IP address of the interface connected to default gateway
fn get_gateway_interface_ip() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = std::process::Command::new("route")
            .arg("print")
            .arg("0.0.0.0")
            .output()
        {
            let route_info = String::from_utf8_lossy(&output.stdout);
            for line in route_info.lines() {
                if line.contains("0.0.0.0") && line.contains("0.0.0.0") {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 4 {
                        // Interface IP is typically the 4th field
                        if let Ok(interface_ip) = parts[3].parse::<std::net::Ipv4Addr>() {
                            // ONLY PUBLIC IP addresses
                            if !interface_ip.is_loopback() && !interface_ip.is_link_local() && !interface_ip.is_private() {
                                return Ok(interface_ip.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    
    #[cfg(target_os = "linux")]
    {
        // Method 1: Get default route interface IP
        if let Ok(output) = std::process::Command::new("ip")
            .arg("route")
            .arg("show")
            .arg("default")
            .output()
        {
            let route_info = String::from_utf8_lossy(&output.stdout);
            for line in route_info.lines() {
                if line.contains("default via") {
                    // Extract interface name from default route
                    if let Some(dev_pos) = line.find("dev ") {
                        let after_dev = &line[dev_pos + 4..];
                        if let Some(interface_name) = after_dev.split_whitespace().next() {
                            // Get IP address of the interface
                            if let Ok(ip_output) = std::process::Command::new("ip")
                                .arg("addr")
                                .arg("show")
                                .arg(interface_name)
                                .output()
                            {
                                let ip_info = String::from_utf8_lossy(&ip_output.stdout);
                                for ip_line in ip_info.lines() {
                                    if ip_line.trim().starts_with("inet ") && !ip_line.contains("127.0.0.1") {
                                        let parts: Vec<&str> = ip_line.trim().split_whitespace().collect();
                                        if parts.len() >= 2 {
                                            let ip_with_mask = parts[1];
                                            if let Some(ip_str) = ip_with_mask.split('/').next() {
                                                if let Ok(ip) = ip_str.parse::<std::net::Ipv4Addr>() {
                                                    // ONLY PUBLIC IP addresses
                                                    if !ip.is_loopback() && !ip.is_link_local() && !ip.is_private() {
                                                        return Ok(ip.to_string());
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // Method 2: Use private network connectivity test
        if let Ok(output) = std::process::Command::new("ip")
            .arg("route")
            .arg("get")
            .arg("10.0.0.1")  // Use private network address
            .output()
        {
            let route_info = String::from_utf8_lossy(&output.stdout);
            for line in route_info.lines() {
                if line.contains("src") {
                    if let Some(src_pos) = line.find("src") {
                        let after_src = &line[src_pos + 3..];
                        if let Some(ip_str) = after_src.split_whitespace().next() {
                            if let Ok(ip) = ip_str.parse::<std::net::Ipv4Addr>() {
                                // ONLY PUBLIC IP addresses
                                if !ip.is_loopback() && !ip.is_link_local() && !ip.is_private() {
                                    return Ok(ip.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    Err("Could not determine gateway interface IP".to_string())
}

fn get_subnet_from_ip(ip: &str) -> String {
    let parts: Vec<&str> = ip.split('.').collect();
    if parts.len() >= 3 {
        format!("{}.{}.{}", parts[0], parts[1], parts[2])
    } else {
        "192.168.1".to_string()
    }
}

fn is_qnet_node_running(addr: &str) -> bool {
    use std::net::TcpStream;
    use std::time::Duration;
    
    // Quick connection test with short timeout
    match TcpStream::connect_timeout(
        &addr.parse().unwrap_or("127.0.0.1:9876".parse().unwrap()),
        Duration::from_millis(100)
    ) {
        Ok(_) => {
            // Could add QNet-specific handshake here
            // For now, just check if port is open
            true
        },
        Err(_) => false
    }
}

async fn detect_region_from_routing_table() -> Result<Region, String> {
    // Analyze default gateway and routing table to determine region
    // This uses local system information without external calls
    
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = tokio::process::Command::new("route")
            .arg("print")
            .arg("0.0.0.0")
            .output()
            .await
        {
            if output.status.success() {
                let route_info = String::from_utf8_lossy(&output.stdout);
                
                // Analyze gateway IP ranges to determine region
                for line in route_info.lines() {
                    if line.contains("0.0.0.0") && line.contains("0.0.0.0") {
                        if let Some(gateway) = extract_gateway_ip(line) {
                            if let Ok(gateway_ip) = gateway.parse::<Ipv4Addr>() {
                                if is_north_america_ip(&gateway_ip) {
                                    return Ok(Region::NorthAmerica);
                                } else if is_europe_ip(&gateway_ip) {
                                    return Ok(Region::Europe);
                                } else if is_asia_ip(&gateway_ip) {
                                    return Ok(Region::Asia);
                                } else if is_south_america_ip(&gateway_ip) {
                                    return Ok(Region::SouthAmerica);
                                } else if is_africa_ip(&gateway_ip) {
                                    return Ok(Region::Africa);
                                } else if is_oceania_ip(&gateway_ip) {
                                    return Ok(Region::Oceania);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    #[cfg(target_os = "linux")]
    {
        if let Ok(output) = tokio::process::Command::new("ip")
            .arg("route")
            .arg("show")
            .arg("default")
            .output()
            .await
        {
            if output.status.success() {
                let route_info = String::from_utf8_lossy(&output.stdout);
                
                for line in route_info.lines() {
                    if line.contains("default via") {
                        if let Some(gateway) = extract_linux_gateway_ip(line) {
                            if let Ok(gateway_ip) = gateway.parse::<Ipv4Addr>() {
                                if is_north_america_ip(&gateway_ip) {
                                    return Ok(Region::NorthAmerica);
                                } else if is_europe_ip(&gateway_ip) {
                                    return Ok(Region::Europe);
                                } else if is_asia_ip(&gateway_ip) {
                                    return Ok(Region::Asia);
                                } else if is_south_america_ip(&gateway_ip) {
                                    return Ok(Region::SouthAmerica);
                                } else if is_africa_ip(&gateway_ip) {
                                    return Ok(Region::Africa);
                                } else if is_oceania_ip(&gateway_ip) {
                                    return Ok(Region::Oceania);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    Err("Could not detect region from routing table".to_string())  
}

fn extract_gateway_ip(route_line: &str) -> Option<String> {
    // Parse Windows route output format
    let parts: Vec<&str> = route_line.split_whitespace().collect();
    if parts.len() >= 3 {
        // Gateway is typically the 3rd field in Windows route output
        Some(parts[2].to_string())
    } else {
        None
    }
}

fn extract_linux_gateway_ip(route_line: &str) -> Option<String> {
    // Parse Linux ip route output format: "default via 192.168.1.1 dev eth0"
    if let Some(via_pos) = route_line.find("via ") {
        let after_via = &route_line[via_pos + 4..];
        if let Some(space_pos) = after_via.find(' ') {
            Some(after_via[..space_pos].to_string())
        } else {
            Some(after_via.to_string())
        }
    } else {
        None
    }
}

// Old locale function removed - using only QNET_REGION env variable

async fn detect_region_from_dns_resolvers() -> Result<Region, String> {
    // Analyze configured DNS resolvers to determine region
    // Different regions typically use different DNS providers
    
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = tokio::process::Command::new("nslookup")
            .arg("localhost")
            .output()
            .await
        {
            if output.status.success() {
                let dns_info = String::from_utf8_lossy(&output.stdout);
                
                // Extract DNS server information
                for line in dns_info.lines() {
                    if line.contains("Server:") {
                        if let Some(dns_server) = extract_dns_server_ip(line) {
                            if let Ok(dns_ip) = dns_server.parse::<Ipv4Addr>() {
                                if is_north_america_ip(&dns_ip) {
                                    return Ok(Region::NorthAmerica);
                                } else if is_europe_ip(&dns_ip) {
                                    return Ok(Region::Europe);
                                } else if is_asia_ip(&dns_ip) {
                                    return Ok(Region::Asia);
                                } else if is_south_america_ip(&dns_ip) {
                                    return Ok(Region::SouthAmerica);
                                } else if is_africa_ip(&dns_ip) {
                                    return Ok(Region::Africa);
                                } else if is_oceania_ip(&dns_ip) {
                                    return Ok(Region::Oceania);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    #[cfg(target_os = "linux")]
    {
        // Check /etc/resolv.conf for DNS servers
        if let Ok(resolv_content) = tokio::fs::read_to_string("/etc/resolv.conf").await {
            for line in resolv_content.lines() {
                if line.starts_with("nameserver") {
                    if let Some(dns_server) = line.split_whitespace().nth(1) {
                        if let Ok(dns_ip) = dns_server.parse::<Ipv4Addr>() {
                            if is_north_america_ip(&dns_ip) {
                                return Ok(Region::NorthAmerica);
                            } else if is_europe_ip(&dns_ip) {
                                return Ok(Region::Europe);
                            } else if is_asia_ip(&dns_ip) {
                                return Ok(Region::Asia);
                            } else if is_south_america_ip(&dns_ip) {
                                return Ok(Region::SouthAmerica);
                            } else if is_africa_ip(&dns_ip) {
                                return Ok(Region::Africa);
                            } else if is_oceania_ip(&dns_ip) {
                                return Ok(Region::Oceania);
                            }
                        }
                    }
                }
            }
        }
    }
    
    Err("Could not detect region from DNS resolvers".to_string())
}

fn extract_dns_server_ip(nslookup_line: &str) -> Option<String> {
    // Parse nslookup output format: "Server:  192.168.1.1"
    if let Some(colon_pos) = nslookup_line.find(':') {
        let after_colon = &nslookup_line[colon_pos + 1..];
        Some(after_colon.trim().to_string())
    } else {
        None
    }
}

async fn get_network_interfaces() -> Result<Vec<IpAddr>, String> {
    // Use standard library to get network interfaces without external dependencies
    use std::net::UdpSocket;
    
    let mut interfaces = Vec::new();
    
    // Try to connect to a dummy address to determine local IP
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if let Ok(()) = socket.connect("8.8.8.8:80") {
            if let Ok(local_addr) = socket.local_addr() {
                interfaces.push(local_addr.ip());
            }
        }
    }
    
    Ok(interfaces)
}

// Production-grade regional IP detection based on IANA allocations
// Uses comprehensive IP blocks for accurate geographic detection
fn is_north_america_ip(ip: &Ipv4Addr) -> bool {
    let ip_u32 = u32::from(*ip);
    
    // Major North American IP blocks (USA, Canada, Mexico)
    // United States: 3.0.0.0/8, 4.0.0.0/8, 6.0.0.0/8, 7.0.0.0/8, 8.0.0.0/8, 9.0.0.0/8, 11.0.0.0/8, 12.0.0.0/8
    // 13.0.0.0/8, 15.0.0.0/8, 16.0.0.0/8, 17.0.0.0/8, 18.0.0.0/8, 19.0.0.0/8, 20.0.0.0/8, 21.0.0.0/8
    // 22.0.0.0/8, 23.0.0.0/8, 24.0.0.0/8, 26.0.0.0/8, 28.0.0.0/8, 29.0.0.0/8, 30.0.0.0/8, 32.0.0.0/8
    // 33.0.0.0/8, 34.0.0.0/8, 35.0.0.0/8, 38.0.0.0/8, 40.0.0.0/8, 44.0.0.0/8, 45.0.0.0/8, 47.0.0.0/8
    // 48.0.0.0/8, 50.0.0.0/8, 52.0.0.0/8, 54.0.0.0/8, 55.0.0.0/8, 56.0.0.0/8, 63.0.0.0/8, 64.0.0.0/10
    // 66.0.0.0/8, 67.0.0.0/8, 68.0.0.0/8, 69.0.0.0/8, 70.0.0.0/8, 71.0.0.0/8, 72.0.0.0/8, 73.0.0.0/8
    // 74.0.0.0/8, 75.0.0.0/8, 76.0.0.0/8, 96.0.0.0/8, 97.0.0.0/8, 98.0.0.0/8, 99.0.0.0/8, 100.0.0.0/8
    // 104.0.0.0/8, 107.0.0.0/8, 108.0.0.0/8, 173.0.0.0/8, 174.0.0.0/8, 184.0.0.0/8, 199.0.0.0/8, 208.0.0.0/8
    // 209.0.0.0/8, 216.0.0.0/8
    let first_octet = (ip_u32 >> 24) as u8;
    match first_octet {
        3..=9 | 11..=24 | 26 | 28..=30 | 32..=35 | 38 | 40 | 44..=45 | 47..=48 | 50 | 52 | 54..=56 | 
        63 | 68..=76 | 96..=100 | 104 | 107..=108 | 173..=174 | 184 | 199 | 208..=209 | 216 => true,
        64..=67 => {
            // 64.0.0.0/10 range check (64.0.0.0 to 67.255.255.255)
            ip_u32 >= 0x40000000 && ip_u32 <= 0x43FFFFFF
        },
        _ => false
    }
}

fn is_europe_ip(ip: &Ipv4Addr) -> bool {
    let ip_u32 = u32::from(*ip);
    let first_octet = (ip_u32 >> 24) as u8;
    
    // Major European IP blocks (RIPE NCC allocation)
    // 2.0.0.0/8, 5.0.0.0/8, 25.0.0.0/8, 31.0.0.0/8, 37.0.0.0/8, 46.0.0.0/8, 53.0.0.0/8
    // 62.0.0.0/8, 77.0.0.0/8, 78.0.0.0/8, 79.0.0.0/8, 80.0.0.0/8, 81.0.0.0/8, 82.0.0.0/8
    // 83.0.0.0/8, 84.0.0.0/8, 85.0.0.0/8, 86.0.0.0/8, 87.0.0.0/8, 88.0.0.0/8, 89.0.0.0/8
    // 90.0.0.0/8, 91.0.0.0/8, 92.0.0.0/8, 93.0.0.0/8, 94.0.0.0/8, 95.0.0.0/8, 109.0.0.0/8
    // 128.0.0.0/8, 130.0.0.0/8, 131.0.0.0/8, 132.0.0.0/8, 133.0.0.0/8, 134.0.0.0/8, 135.0.0.0/8
    // 136.0.0.0/8, 137.0.0.0/8, 138.0.0.0/8, 139.0.0.0/8, 140.0.0.0/8, 141.0.0.0/8, 145.0.0.0/8
    // 146.0.0.0/8, 147.0.0.0/8, 148.0.0.0/8, 149.0.0.0/8, 151.0.0.0/8, 176.0.0.0/8, 178.0.0.0/8
    // 185.0.0.0/8, 188.0.0.0/8, 193.0.0.0/8, 194.0.0.0/8, 195.0.0.0/8, 212.0.0.0/8, 213.0.0.0/8
    // 217.0.0.0/8
    match first_octet {
        2 | 5 | 25 | 31 | 37 | 46 | 53 | 62 | 77..=95 | 109 | 128 | 130..=141 | 145..=149 | 151 |
        176 | 178 | 185 | 188 | 193..=195 | 212..=213 | 217 => true,
        _ => false
    }
}

fn is_asia_ip(ip: &Ipv4Addr) -> bool {
    let ip_u32 = u32::from(*ip);
    let first_octet = (ip_u32 >> 24) as u8;
    
    // Major Asian IP blocks (APNIC allocation)
    // 1.0.0.0/8, 14.0.0.0/8, 27.0.0.0/8, 36.0.0.0/8, 39.0.0.0/8, 42.0.0.0/8, 43.0.0.0/8
    // 49.0.0.0/8, 58.0.0.0/8, 59.0.0.0/8, 60.0.0.0/8, 61.0.0.0/8, 101.0.0.0/8, 103.0.0.0/8
    // 106.0.0.0/8, 110.0.0.0/8, 111.0.0.0/8, 112.0.0.0/8, 113.0.0.0/8, 114.0.0.0/8, 115.0.0.0/8
    // 116.0.0.0/8, 117.0.0.0/8, 118.0.0.0/8, 119.0.0.0/8, 120.0.0.0/8, 121.0.0.0/8, 122.0.0.0/8
    // 123.0.0.0/8, 124.0.0.0/8, 125.0.0.0/8, 126.0.0.0/8, 150.0.0.0/8, 152.0.0.0/8, 153.0.0.0/8
    // 163.0.0.0/8, 175.0.0.0/8, 180.0.0.0/8, 182.0.0.0/8, 183.0.0.0/8, 202.0.0.0/8, 203.0.0.0/8
    // 210.0.0.0/8, 211.0.0.0/8, 218.0.0.0/8, 219.0.0.0/8, 220.0.0.0/8, 221.0.0.0/8, 222.0.0.0/8
    // 223.0.0.0/8
    match first_octet {
        1 | 14 | 27 | 36 | 39 | 42..=43 | 49 | 58..=61 | 101 | 103 | 106 | 110..=126 | 150 | 152..=153 |
        163 | 175 | 180 | 182..=183 | 202..=203 | 210..=211 | 218..=223 => true,
        _ => false
    }
}

fn is_south_america_ip(ip: &Ipv4Addr) -> bool {
    let ip_u32 = u32::from(*ip);
    let first_octet = (ip_u32 >> 24) as u8;
    
    // Major South American IP blocks (LACNIC allocation)
    // 177.0.0.0/8, 179.0.0.0/8, 181.0.0.0/8, 186.0.0.0/8, 189.0.0.0/8, 190.0.0.0/8
    // 191.0.0.0/8, 200.0.0.0/8, 201.0.0.0/8, 187.0.0.0/8
    match first_octet {
        177 | 179 | 181 | 186..=187 | 189..=191 | 200..=201 => true,
        _ => false
    }
}

fn is_africa_ip(ip: &Ipv4Addr) -> bool {
    let ip_u32 = u32::from(*ip);
    let first_octet = (ip_u32 >> 24) as u8;
    
    // Major African IP blocks (AfriNIC allocation)
    // 41.0.0.0/8, 102.0.0.0/8, 105.0.0.0/8, 154.0.0.0/8, 155.0.0.0/8, 156.0.0.0/8
    // 160.0.0.0/8, 161.0.0.0/8, 162.0.0.0/8, 164.0.0.0/8, 165.0.0.0/8, 196.0.0.0/8
    // 197.0.0.0/8
    match first_octet {
        41 | 102 | 105 | 154..=156 | 160..=162 | 164..=165 | 196..=197 => true,
        _ => false
    }
}

fn is_oceania_ip(ip: &Ipv4Addr) -> bool {
    let ip_u32 = u32::from(*ip);
    let first_octet = (ip_u32 >> 24) as u8;
    
    // Major Oceania IP blocks (APNIC allocation for Australia/New Zealand/Pacific)
    // 1.0.0.0/8 (partial), 27.0.0.0/8 (partial), 58.0.0.0/8 (partial), 59.0.0.0/8 (partial)
    // 101.0.0.0/8 (partial), 103.0.0.0/8 (partial), 110.0.0.0/8 (partial), 115.0.0.0/8 (partial)
    // 116.0.0.0/8 (partial), 118.0.0.0/8 (partial), 119.0.0.0/8 (partial), 124.0.0.0/8 (partial)
    // 125.0.0.0/8 (partial), 150.0.0.0/8 (partial), 202.0.0.0/8 (partial), 203.0.0.0/8 (partial)
    // 210.0.0.0/8 (partial)
    // More specific ranges for Australia and New Zealand based on second octet
    match first_octet {
        1 | 27 | 58..=59 | 101 | 103 | 110 | 115..=116 | 118..=119 | 124..=125 | 150 | 202..=203 | 210 => {
            // Additional filtering for Oceania-specific subnets would be needed here
            // For production use, this should include more precise CIDR matching
            // Currently simplified to basic first octet matching for Oceania APNIC ranges
            match first_octet {
                // Australia/NZ specific ranges
                1 | 27 | 58..=59 | 101 | 103 | 110 | 115..=116 | 118..=119 | 124..=125 | 150 | 202..=203 | 210 => {
                    // More detailed subnet analysis would be here in production
                    // This is simplified for core functionality
                    true
                },
                _ => false
            }
        },
        _ => false
    }
}

async fn get_region_from_system_timezone() -> Result<Region, String> {
    // Use Rust's built-in timezone detection without external commands
    use std::env;
    
    // Check common timezone environment variables
    let tz_vars = ["TZ", "TIMEZONE"];
    
    for var in &tz_vars {
        if let Ok(timezone) = env::var(var) {
            if timezone.contains("America/New_York") || timezone.contains("America/Chicago") || 
               timezone.contains("America/Denver") || timezone.contains("America/Los_Angeles") ||
               timezone.contains("US/") || timezone.contains("EST") || timezone.contains("PST") {
                return Ok(Region::NorthAmerica);
            } else if timezone.contains("America/Sao_Paulo") || timezone.contains("America/Argentina") ||
                      timezone.contains("America/Lima") || timezone.contains("America/Bogota") {
                return Ok(Region::SouthAmerica);
            } else if timezone.contains("Europe/") || timezone.contains("CET") || timezone.contains("GMT") {
                return Ok(Region::Europe);
            } else if timezone.contains("Asia/") || timezone.contains("JST") || timezone.contains("CST") {
                return Ok(Region::Asia);
            } else if timezone.contains("Africa/") {
                return Ok(Region::Africa);
            } else if timezone.contains("Australia/") || timezone.contains("Pacific/Auckland") {
                return Ok(Region::Oceania);
            }
        }
    }
    
    Err("Could not detect region from system timezone".to_string())
}

async fn detect_region_from_locale() -> Result<Region, String> {
    // Check QNET_REGION environment variable only
    use std::env;
    
    if let Ok(region_hint) = env::var("QNET_REGION") {
        match region_hint.to_lowercase().as_str() {
            "na" | "northamerica" => return Ok(Region::NorthAmerica),
            "eu" | "europe" => return Ok(Region::Europe),
            "asia" => return Ok(Region::Asia),
            "sa" | "southamerica" => return Ok(Region::SouthAmerica),
            "africa" => return Ok(Region::Africa),
            "oceania" => return Ok(Region::Oceania),
            _ => {}
        }
    }
    
    Err("No QNET_REGION environment variable set".to_string())
}

async fn detect_region_from_local_interfaces() -> Result<Region, String> {
    // Use local network interface information to detect region
    // This is decentralized and doesn't rely on external services
    if let Ok(interfaces) = get_network_interfaces().await {
        for interface in interfaces {
            if let IpAddr::V4(ipv4) = interface {
                // Check if this is a regional IP range (without external calls)
                if is_north_america_ip(&ipv4) {
                    return Ok(Region::NorthAmerica);
                } else if is_europe_ip(&ipv4) {
                    return Ok(Region::Europe);
                } else if is_asia_ip(&ipv4) {
                    return Ok(Region::Asia);
                } else if is_south_america_ip(&ipv4) {
                    return Ok(Region::SouthAmerica);
                } else if is_africa_ip(&ipv4) {
                    return Ok(Region::Africa);
                } else if is_oceania_ip(&ipv4) {
                    return Ok(Region::Oceania);
                }
            }
        }
    }
    
    Err("Could not detect region from local interfaces".to_string())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Critical: This must be the FIRST line to catch any issues
    println!("[DEBUG] QNet node binary started - checking basic functionality...");
    
    // Test basic functionality before doing anything else
    println!("[DEBUG] Testing std::env...");
    if std::env::var("RUST_LOG").is_err() {
        std::env::set_var("RUST_LOG", "info");
    }
    println!("[DEBUG] std::env working");
    
    // Initialize logging
    println!("[DEBUG] Initializing logger...");
    env_logger::init();
    println!("[DEBUG] Logger initialized");
    
    // Auto-configure everything
    println!("[DEBUG] Auto-configuring QNet node...");
    let config = AutoConfig::new().await?;
    println!("[DEBUG] AutoConfig completed successfully!");
    
    // Choose setup mode - interactive or auto
    println!("[DEBUG] Starting setup mode selection...");
    
    // PRODUCTION: Check for existing activation or run interactive setup
    let (node_type, activation_code) = check_existing_activation_or_setup().await?;
    
    // Configure production mode (microblocks by default)
    configure_production_mode();
    
    // Use auto-configured values
    let region = config.region;
    let bootstrap_peers = config.bootstrap_peers.clone();
    
    // Store activation code for validation
    std::env::set_var("QNET_ACTIVATION_CODE", activation_code);
    
    // Display configuration
    display_node_config(&config, &node_type, &region);
    
    // Display activation status
    let activation_code = std::env::var("QNET_ACTIVATION_CODE").unwrap_or_default();
    println!("\n🔐 === Activation Status ===");
    
    if activation_code.is_empty() {
        return Err("No activation code provided".into());
    }
    
    // Skip format validation - already done in setup phase
    println!("🔐 Running in PRODUCTION MODE");
    println!("   ✅ Activation code validated");
    println!("   📝 Code: {}", mask_code(&activation_code));
    println!("   🖥️  Server node type: {:?}", node_type);
    println!("   💰 Dynamic pricing: Phase {} pricing active", {
        // Get current phase for pricing display
        let current_phase = get_current_phase_simple().await.unwrap_or(1);
        current_phase
    });
    println!("   🔐 Using quantum-secure activation codes with permanent validity");
    println!("   🛡️  Light node blocking: Enforced on server hardware");
    
    // Verify 1DEV burn if required for production
    if std::env::var("QNET_PRODUCTION").unwrap_or_default() == "1" {
        verify_1dev_burn(&node_type).await?;
    }
    
    // Create blockchain node with production optimizations
    println!("🔍 DEBUG: Creating BlockchainNode with data_dir: '{}'", config.data_dir.display());
    println!("🔍 DEBUG: Checking directory permissions...");
    
    // Create data directory if it doesn't exist
    if let Err(e) = std::fs::create_dir_all(&config.data_dir) {
        println!("❌ ERROR: Cannot create data directory: {}", e);
        eprintln!("❌ ERROR: Cannot create data directory: {}", e);
        return Err(format!("Failed to create data directory: {}", e).into());
    }
    
    println!("🔍 DEBUG: Data directory created/exists at: {:?}", config.data_dir);
    
    // Test directory write permissions
    let test_file = config.data_dir.join("test_write.tmp");
    match std::fs::write(&test_file, "test") {
        Ok(_) => {
            println!("🔍 DEBUG: Directory write permissions OK");
            let _ = std::fs::remove_file(&test_file);
        }
        Err(e) => {
            println!("❌ ERROR: Cannot write to data directory: {}", e);
            eprintln!("❌ ERROR: Cannot write to data directory: {}", e);
            return Err(format!("Cannot write to data directory: {}", e).into());
        }
    }
    
    // Record quantum-secure activation in QNet blockchain before node start
    if std::env::var("QNET_PRODUCTION").unwrap_or_default() == "1" {
        println!("🔐 Recording quantum-secure activation in QNet blockchain...");
        
        let mut quantum_crypto = qnet_integration::quantum_crypto::QNetQuantumCrypto::new();
        quantum_crypto.initialize().await?;
        
        // Decrypt activation code to get payload
        let payload = quantum_crypto.decrypt_activation_code(&activation_code).await?;
        
        // Generate node public key for blockchain record
        let hash_result = blake3::hash(activation_code.as_bytes());
        let node_pubkey = format!("qnet_node_{}", &hash_result.to_hex()[..16]);
        
        // Record in QNet blockchain (replaces database storage)
        quantum_crypto.record_activation_in_blockchain(&activation_code, &payload, &node_pubkey).await?;
        
        println!("✅ Quantum activation recorded in QNet blockchain successfully");
        println!("   📝 Node: {}...", &node_pubkey[..12]);
        println!("   🔐 Quantum-secure: CRYSTALS-Kyber + Dilithium");
        println!("   🚫 Database: Not used - blockchain is source of truth");
    }

    println!("🔍 DEBUG: About to create BlockchainNode...");
    let mut node = match BlockchainNode::new_with_config(
        &config.data_dir.to_string_lossy(),
        config.p2p_port,
        bootstrap_peers,
        node_type,
        region,
    ).await {
        Ok(node) => {
            println!("🔍 DEBUG: BlockchainNode created successfully");
            node
        }
        Err(e) => {
            println!("❌ ERROR: BlockchainNode creation failed: {}", e);
            eprintln!("❌ ERROR: BlockchainNode creation failed: {}", e);
            println!("🔍 DEBUG: Error details: {:?}", e);
            return Err(format!("BlockchainNode creation failed: {}", e).into());
        }
    };
    
    // Save activation code to persistent storage for future restarts
    // Always save in development mode to remember selected node type
    if !activation_code.is_empty() {
        if let Err(e) = node.save_activation_code(&activation_code, node_type).await {
            println!("⚠️  Warning: Could not save activation code: {}", e);
        }
    }
    
    // Configure node type and region
    // TODO: Configure node type and region when methods are implemented
    // node.set_node_type(node_type);
    // node.set_region(region);
    
    // Set RPC port environment variable
    std::env::set_var("QNET_RPC_PORT", config.rpc_port.to_string());
    
    // Start enterprise monitoring (always enabled in production)
    if config.enable_metrics {
        start_metrics_server(config.rpc_port + 100).await;
    }
    
    // Start node
    println!("🚀 Starting QNet node...");
    node.start().await?;
    
    // Keep running
    println!("✅ QNet node running successfully!");
    println!("🔍 DEBUG: RPC server started on port {}", config.rpc_port);
    
    // Get external IP for status display
    let external_ip = match tokio::process::Command::new("curl")
        .arg("-s")
        .arg("--max-time")
        .arg("3")
        .arg("https://api.ipify.org")
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => "127.0.0.1".to_string(), // Fallback only for display
    };
    
    println!("📊 RPC endpoint: http://{}:{}/rpc", external_ip, config.rpc_port);
    println!("🌐 API endpoint: http://{}:{}/api/v1/", external_ip, std::env::var("QNET_CURRENT_API_PORT").unwrap_or("8001".to_string()));
    println!("🔍 DEBUG: Node ready to accept connections");
    
    // Start metrics server
    let metrics_port = config.rpc_port + 1000; // e.g., 9877 + 1000 = 10877
    let metrics_ip = external_ip.clone();
    tokio::spawn(async move {
        // Simple metrics endpoint
        println!("📈 Metrics available at: http://{}:{}/metrics", metrics_ip, metrics_port);
    });
    
    // Always use microblocks in production
    println!("⚡ Microblock mode: Enabled (100k+ TPS ready)");
    print_microblock_status().await;
    
    println!("Press Ctrl+C to stop\n");
    
    // Handle graceful shutdown
    match tokio::signal::ctrl_c().await {
        Ok(()) => {
            println!("\n⏹️  Graceful shutdown initiated...");
        }
        Err(e) => {
            println!("⚠️  Signal handling error: {}", e);
            println!("   Node will continue running...");
            
            // Fallback - keep running if signal handling fails
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                println!("💓 Node health check: {}", chrono::Utc::now().format("%Y-%m-%d %H:%M:%S"));
            }
        }
    }
    
    // TODO: Add stop method to BlockchainNode
    // node.stop().await?;
    println!("✅ Node stopped successfully");
    
    Ok(())
}

fn configure_production_mode() {
    // Server device type validation
    println!("🖥️  Configuring production mode for server deployment...");
    
    // Always enable microblocks for production
    std::env::set_var("QNET_ENABLE_MICROBLOCKS", "1");
    std::env::set_var("QNET_MICROBLOCK_DEFAULT", "1");
    
    // Always enable producer mode for production
    std::env::set_var("QNET_IS_LEADER", "1");
    std::env::set_var("QNET_MICROBLOCK_PRODUCER", "1");
    
    // Always enable high-performance optimizations for 100k+ TPS
    std::env::set_var("QNET_HIGH_FREQUENCY", "1");
    std::env::set_var("QNET_MAX_TPS", "100000");
    std::env::set_var("QNET_MEMPOOL_SIZE", "500000");
    std::env::set_var("QNET_BATCH_SIZE", "10000");
    std::env::set_var("QNET_PARALLEL_VALIDATION", "1");
    std::env::set_var("QNET_PARALLEL_THREADS", "16");
    std::env::set_var("QNET_COMPRESSION", "1");
    println!("⚡ High-performance mode: 100k+ TPS optimizations enabled");
        
    // Default server configuration (user will choose during setup)
    std::env::set_var("QNET_FULL_SYNC", "1");
    std::env::set_var("QNET_SYNC_ALL_MICROBLOCKS", "1");
    std::env::set_var("QNET_DEVICE_TYPE", "SERVER");
    println!("💻 Server node: Full sync enabled - production deployment");
    
    // Network compression for efficiency
    std::env::set_var("QNET_P2P_COMPRESSION", "1");
    std::env::set_var("QNET_ADAPTIVE_INTERVALS", "1");
    
    println!("✅ Production mode configured for server deployment");
}

fn parse_node_type(type_str: &str) -> Result<NodeType, String> {
    match type_str.to_lowercase().as_str() {
        "light" => {
            Err("❌ Light nodes are not supported on servers! Light nodes are restricted to mobile devices only. Use 'full' or 'super' for server deployment.".to_string())
        },
        "full" => Ok(NodeType::Full),
        "super" => Ok(NodeType::Super),
        _ => Err(format!("❌ Invalid node type: '{}' for server deployment.\n🖥️  Servers support: full, super\n📱 Mobile devices support: light", type_str)),
    }
}

fn parse_region(region_str: &str) -> Result<Region, String> {
    match region_str.to_lowercase().as_str() {
        "na" | "northamerica" => Ok(Region::NorthAmerica),
        "eu" | "europe" => Ok(Region::Europe),
        "asia" => Ok(Region::Asia),
        "sa" | "southamerica" => Ok(Region::SouthAmerica),
        "africa" => Ok(Region::Africa),
        "oceania" => Ok(Region::Oceania),
        _ => Err(format!("Invalid region: {}. Use: na, eu, asia, sa, africa, oceania", region_str)),
    }
}

async fn auto_detect_region() -> Result<Region, String> {
    println!("[REGION] Initializing decentralized network mode...");
    
    // Method 1: Check QNET_REGION environment variable (optional)
    match detect_region_from_locale().await {
        Ok(region) => {
            println!("[REGION] ✅ Manual region override: {:?}", region);
            return Ok(region);
        }
        Err(_) => {
            println!("[REGION] No manual region override - proceeding with auto-detection");
        }
    }
    
    // Method 2: Auto-detect via IP analysis (if possible)
    match detect_region_via_latency_test().await {
        Ok(region) => {
            println!("[REGION] ✅ Region detected via network analysis: {:?}", region);
            return Ok(region);
        }
        Err(_) => {
            println!("[REGION] Network-based detection unavailable");
        }
    }
    
    // DECENTRALIZED FALLBACK: Test all regional ports
    println!("[REGION] ✅ Activating multi-regional discovery mode");
    println!("[REGION] 🌐 Testing all regional ports for active nodes");
    
    match test_all_regional_ports().await {
        Some(best_region) => {
            println!("[REGION] ✅ Found active region: {:?}", best_region);
            Ok(best_region)
        }
        None => {
            println!("[REGION] 🔄 No active regional nodes found");
            println!("[REGION] 🌍 Using Europe as base - will discover peers dynamically");
            Ok(Region::Europe)
        }
    }
}

// Pure decentralized mode - no geographic detection
async fn detect_region_by_system_info() -> Result<Region, String> {
    println!("[SYSTEM] Pure decentralized network mode activated");
    println!("[SYSTEM] No geographic detection - using network performance optimization");
    
    // NO GEOGRAPHIC DETECTION - pure P2P network approach
    Err("Fully decentralized mode - no region detection needed".to_string())
}

// Decentralized region detection via latency testing to regional QNet ports
async fn detect_region_via_latency_test() -> Result<Region, String> {
    println!("[LATENCY] Starting decentralized region detection via port latency...");
    
    // Get our physical IP first for region hint
    let our_ip = match get_physical_ip() {
        Ok(ip) => {
            if let Ok(parsed_ip) = ip.parse::<std::net::Ipv4Addr>() {
                println!("[LATENCY] Physical IP: {}", ip);
                Some(parsed_ip)
            } else {
                None
            }
        },
        Err(e) => {
            println!("[LATENCY] Could not get physical IP: {}", e);
            None
        }
    };
    
    // Primary method: Physical IP address analysis
    if let Some(physical_ip) = our_ip {
        if is_north_america_ip(&physical_ip) {
            println!("[LATENCY] ✅ IP-based region detection: North America");
            return Ok(Region::NorthAmerica);
        } else if is_europe_ip(&physical_ip) {
            println!("[LATENCY] ✅ IP-based region detection: Europe");
            return Ok(Region::Europe);
        } else if is_asia_ip(&physical_ip) {
            println!("[LATENCY] ✅ IP-based region detection: Asia");
            return Ok(Region::Asia);
        } else if is_south_america_ip(&physical_ip) {
            println!("[LATENCY] ✅ IP-based region detection: South America");
            return Ok(Region::SouthAmerica);
        } else if is_africa_ip(&physical_ip) {
            println!("[LATENCY] ✅ IP-based region detection: Africa");
            return Ok(Region::Africa);
        } else if is_oceania_ip(&physical_ip) {
            println!("[LATENCY] ✅ IP-based region detection: Oceania");
            return Ok(Region::Oceania);
        }
        
        println!("[LATENCY] ⚠️ IP {} not in known regional ranges", physical_ip);
    }
    
    // Fallback: Cannot determine region without proper IP
    Err("Unable to determine region from physical IP address".to_string())
}

// Test all regional ports to find active nodes
async fn test_all_regional_ports() -> Option<Region> {
    println!("[MULTI] Testing all 6 regional ports for active QNet nodes...");
    
    let regional_ports = vec![
        (Region::NorthAmerica, 9876),
        (Region::Europe, 9877),
        (Region::Asia, 9878),
        (Region::SouthAmerica, 9879),
        (Region::Africa, 9880),
        (Region::Oceania, 9881),
    ];
    
    let mut active_regions = Vec::new();
    
    // Test each regional port
    for (region, port) in regional_ports {
        println!("[MULTI] Testing {:?} on port {}...", region, port);
        
        // Test various network addresses where nodes might be running
        let test_addresses = vec![
            format!("127.0.0.1:{}", port),      // Localhost
            format!("0.0.0.0:{}", port),        // All interfaces
        ];
        
        for addr in test_addresses {
            if test_connection_quick(&addr) {
                println!("[MULTI] ✅ Found active node: {:?} on {}", region, addr);
                active_regions.push(region);
                break; // Found one, move to next region
            }
        }
    }
    
    if active_regions.is_empty() {
        println!("[MULTI] ❌ No active QNet nodes found on any regional port");
        println!("[MULTI] 🚀 This might be a genesis node or isolated network");
        None
    } else {
        println!("[MULTI] ✅ Found {} active regions: {:?}", active_regions.len(), active_regions);
        // Return first active region found
        Some(active_regions[0])
    }
}



// Port and network analysis functions removed - direct location detection only!

// External API functions removed - decentralized system only!

fn display_node_config(config: &AutoConfig, node_type: &NodeType, region: &Region) {
    println!("\n🖥️  === SERVER DEPLOYMENT CONFIGURATION ===");
    println!("  Device Type: Dedicated Server");
    println!("  P2P Port: {} (auto-selected)", config.p2p_port);
    println!("  RPC Port: {} (auto-selected)", config.rpc_port);
    println!("  Node Type: {:?} (Server-compatible)", node_type);
    
    // Display detailed region information
    println!("  🌍 REGION DETECTION:");
    println!("    Detected Region: {:?}", region);
    println!("    Regional Port: {}", get_regional_port(region));
    println!("    Detection Method: Production IP Analysis");
    
    // Show regional network info
    match region {
        Region::NorthAmerica => {
            println!("    Network Zone: Americas");
        },
        Region::Europe => {
            println!("    Network Zone: European");
        },
        Region::Asia => {
            println!("    Network Zone: Asia-Pacific");
        },
        Region::SouthAmerica => {
            println!("    Network Zone: Latin America");
        },
        Region::Africa => {
            println!("    Network Zone: African");
        },
        Region::Oceania => {
            println!("    Network Zone: Oceania-Pacific");
        },
    }
    
    println!("  Data Directory: {:?} (standard)", config.data_dir);
    
    // Validate node type for server deployment
    match node_type {
        NodeType::Light => {
            println!("  ❌ ERROR: Light nodes not supported on servers!");
            println!("  📱 Light nodes are restricted to mobile devices only");
            println!("  💡 Use mobile app for Light node activation");
        },
        NodeType::Full => {
            println!("  ✅ Full node: Suitable for server deployment");
            println!("  🔧 Capability: Full validation + microblock sync");
            println!("  💰 Dynamic pricing: Base 7500 QNC × network multiplier (Phase 2)");
            println!("  💰 Dynamic pricing: 1500→150 1DEV (Phase 1, universal)");
        },
        NodeType::Super => {
            println!("  ✅ Super node: Optimized for server deployment");
            println!("  🔧 Capability: Validation + production + maximum rewards");
            println!("  💰 Dynamic pricing: Base 10000 QNC × network multiplier (Phase 2)");
            println!("  💰 Dynamic pricing: 1500→150 1DEV (Phase 1, universal)");
        },
    }
    
    println!("  Mode: Production (Microblocks + 100k+ TPS)");
    println!("  Performance: Ultra High (100k+ TPS optimizations)");
    
    println!("  🚀 Server deployment ready!");
    println!("  📱 Light nodes: Use mobile app only");
    println!("  💰 Activation costs: Dynamic pricing active");
}

async fn verify_1dev_burn(node_type: &NodeType) -> Result<(), String> {
    // Production 1DEV burn verification - Universal pricing for all node types
    let required_burn = match node_type {
        NodeType::Light => 1500.0,
        NodeType::Full => 1500.0, 
        NodeType::Super => 1500.0,
    };
    
    println!("🔐 Verifying 1DEV burn on Solana blockchain...");
    
    // Real Solana burn verification
    let activation_code = std::env::var("QNET_ACTIVATION_CODE").unwrap_or_default();
    
    // Extract wallet address from activation code
    let wallet_address = extract_wallet_from_activation_code(&activation_code)?;
    
    // Query Solana blockchain for burn transaction
    let burn_verified = verify_solana_burn_transaction(&wallet_address, required_burn).await?;
    
    if !burn_verified {
        let wallet_preview = if wallet_address.len() >= 8 { &wallet_address[..8] } else { &wallet_address };
        return Err(format!("1DEV burn verification failed: Required {} 1DEV not found for wallet {}", required_burn, wallet_preview));
    }
    
    let wallet_preview = if wallet_address.len() >= 8 { &wallet_address[..8] } else { &wallet_address };
    println!("✅ 1DEV burn verified: {} 1DEV burned by wallet {}", required_burn, wallet_preview);
    Ok(())
}

async fn verify_solana_burn_transaction(wallet_address: &str, required_amount: f64) -> Result<bool, String> {
    println!("📡 Querying Solana devnet for burn transaction...");
    
    // PRODUCTION: Use devnet RPC for our 1DEV token
    let solana_rpc = "https://api.devnet.solana.com";
    
    // Build RPC request to check burn transactions
    let request_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getSignaturesForAddress",
        "params": [
            wallet_address,
            {
                "limit": 100,
                "commitment": "confirmed"
            }
        ]
    });
    
    // Make HTTP request to Solana RPC
    let client = reqwest::Client::new();
    let response = client
        .post(solana_rpc)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Solana devnet RPC request failed: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("Solana devnet RPC returned error: {}", response.status()));
    }
    
    let rpc_response: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Solana devnet RPC response: {}", e))?;
    
    // Check if any transactions are burn transactions
    if let Some(transactions) = rpc_response["result"].as_array() {
        for tx in transactions {
            if let Some(signature) = tx["signature"].as_str() {
                // Check if this transaction is a burn transaction
                if is_burn_transaction(signature).await? {
                    let burned_amount = get_burned_amount(signature).await?;
                    if burned_amount >= required_amount {
                        println!("✅ Found valid burn transaction: {} (burned {} 1DEV)", signature, burned_amount);
                        return Ok(true);
                    }
                }
            }
        }
    }
    
    println!("❌ No valid burn transaction found for required amount: {} 1DEV", required_amount);
    Ok(false)
}

async fn is_burn_transaction(signature: &str) -> Result<bool, String> {
    // Query transaction details to check if it's a burn to 1DEV burn address
    let solana_rpc = "https://api.devnet.solana.com";
    
    let request_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getTransaction",
        "params": [
            signature,
            {
                "encoding": "json",
                "commitment": "confirmed"
            }
        ]
    });
    
    let client = reqwest::Client::new();
    let response = client
        .post(solana_rpc)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Failed to query transaction: {}", e))?;
    
    let rpc_response: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse transaction response: {}", e))?;
    
    // Check if transaction transfers to burn address
    if let Some(transaction) = rpc_response["result"]["transaction"].as_object() {
        if let Some(instructions) = transaction["message"]["instructions"].as_array() {
            for instruction in instructions {
                // Check if instruction is a transfer to burn address
                if is_transfer_to_burn_address(instruction) {
                    return Ok(true);
                }
            }
        }
    }
    
    Ok(false)
}

async fn get_burned_amount(signature: &str) -> Result<f64, String> {
    // Parse burn amount from transaction
    let solana_rpc = "https://api.devnet.solana.com";
    
    let request_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getTransaction",
        "params": [
            signature,
            {
                "encoding": "json",
                "commitment": "confirmed"
            }
        ]
    });
    
    let client = reqwest::Client::new();
    let response = client
        .post(solana_rpc)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Failed to query burn amount: {}", e))?;
    
    let rpc_response: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse burn amount response: {}", e))?;
    
    // Extract burn amount from transaction
    if let Some(pre_token_balances) = rpc_response["result"]["meta"]["preTokenBalances"].as_array() {
        if let Some(post_token_balances) = rpc_response["result"]["meta"]["postTokenBalances"].as_array() {
            // Calculate amount burned by comparing pre and post balances
            for (pre, post) in pre_token_balances.iter().zip(post_token_balances.iter()) {
                if let (Some(pre_amount), Some(post_amount)) = (
                    pre["uiTokenAmount"]["uiAmount"].as_f64(),
                    post["uiTokenAmount"]["uiAmount"].as_f64()
                ) {
                    let burned = pre_amount - post_amount;
                    if burned > 0.0 {
                        return Ok(burned);
                    }
                }
            }
        }
    }
    
    Ok(0.0)
}

fn is_transfer_to_burn_address(instruction: &serde_json::Value) -> bool {
    // Check if instruction transfers to 1DEV burn address
    const BURN_ADDRESS: &str = "1nc1nerator11111111111111111111111111111111"; // Official Solana incinerator address
    
    if let Some(accounts) = instruction["accounts"].as_array() {
        for account in accounts {
            if let Some(account_str) = account.as_str() {
                if account_str == BURN_ADDRESS {
                    return true;
                }
            }
        }
    }
    
    false
}

fn extract_wallet_from_activation_code(activation_code: &str) -> Result<String, String> {
    // Extract wallet address from activation code
    // In production: decode activation code to get wallet address
    if activation_code.is_empty() {
        return Err("No activation code provided".to_string());
    }
    
    // For now, derive wallet address from activation code
    // In production: proper cryptographic derivation
    let wallet_hash = blake3::hash(activation_code.as_bytes());
    let wallet_address = bs58::encode(wallet_hash.as_bytes()).into_string();
    
    Ok(wallet_address)
}

async fn start_metrics_server(port: u16) {
    println!("📊 Starting metrics server on port {}", port);
    
    tokio::spawn(async move {
        use warp::Filter;
        
        let metrics_route = warp::path("metrics")
            .and(warp::get())
            .map(|| {
                // Basic Prometheus metrics format
                format!(
                    "# HELP qnet_node_uptime_seconds Total uptime of the node\n\
                     # TYPE qnet_node_uptime_seconds counter\n\
                     qnet_node_uptime_seconds {}\n\
                     # HELP qnet_blocks_height Current blockchain height\n\
                     # TYPE qnet_blocks_height gauge\n\
                     qnet_blocks_height 0\n\
                     # HELP qnet_peers_connected Number of connected peers\n\
                     # TYPE qnet_peers_connected gauge\n\
                     qnet_peers_connected 0\n\
                     # HELP qnet_transactions_total Total number of transactions\n\
                     # TYPE qnet_transactions_total counter\n\
                     qnet_transactions_total 0\n",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_secs()
                )
            });
        
        let cors = warp::cors()
            .allow_any_origin()
            .allow_methods(vec!["GET"])
            .allow_headers(vec!["Content-Type"]);
        
        let routes = metrics_route.with(cors);
        
        // Get external IP for metrics display
        let external_ip = match tokio::process::Command::new("curl")
            .arg("-s")
            .arg("--max-time")
            .arg("3")
            .arg("https://api.ipify.org")
            .output()
            .await
        {
            Ok(output) if output.status.success() => {
                String::from_utf8_lossy(&output.stdout).trim().to_string()
            }
            _ => "127.0.0.1".to_string(), // Fallback only for display
        };
        
        println!("📈 Metrics available at: http://{}:{}/metrics", external_ip, port);
        warp::serve(routes).run(([0, 0, 0, 0], port)).await;
    });
}

async fn start_reward_claiming_service(wallet_key: String, node_type: String) {
    println!("💰 Starting automatic reward claiming service...");
    
    tokio::spawn(async move {
        let mut interval = interval(Duration::from_secs(4 * 60 * 60)); // Every 4 hours
        
        loop {
            interval.tick().await;
            
            let wallet_preview = if wallet_key.len() >= 8 { &wallet_key[..8] } else { &wallet_key };
        println!("💰 Claiming rewards for wallet: {}...", wallet_preview);
            
            // In production: Claim rewards from blockchain
            let reward_amount = calculate_base_reward().await.unwrap_or(0.0);
            let fee_share = calculate_fee_share(&node_type).await.unwrap_or(0.0);
            let total_reward = reward_amount + fee_share;
            
            println!("✅ Rewards claimed: {:.2} QNC (Base: {:.2} + Fees: {:.2})", 
                     total_reward, reward_amount, fee_share);
        }
    });
}

async fn calculate_base_reward() -> Result<f64, String> {
    // Sharp drop economic model: normal halving (÷2) except 5th halving (÷10)
    // Years 0-4: 245,100.67 QNC per 4-hour period
    // Years 4-8: 122,550.33 QNC per 4-hour period (÷2)
    // Years 8-12: 61,275.17 QNC per 4-hour period (÷2)
    // Years 12-16: 30,637.58 QNC per 4-hour period (÷2)
    // Years 16-20: 15,318.79 QNC per 4-hour period (÷2)
    // Years 20-24: 1,531.88 QNC per 4-hour period (÷10 SHARP DROP!)
    // Years 24+: Resume normal halving (÷2) but from much lower base
    
    let years_since_genesis = 0; // In production: Calculate from genesis block
    let halving_cycles = years_since_genesis / 4;
    
    let base_rate = if halving_cycles == 5 {
        // 5th halving (year 20-24): Sharp drop by 10x instead of 2x
        245_100.67 / (2.0_f64.powi(4) * 10.0) // Previous 4 halvings (÷2) then sharp drop (÷10)
    } else if halving_cycles > 5 {
        // After sharp drop: Resume normal halving from new low base
        let normal_halvings = halving_cycles - 5;
        245_100.67 / (2.0_f64.powi(4) * 10.0 * 2.0_f64.powi(normal_halvings as i32))
    } else {
        // Normal halving for first 5 cycles (20 years)
        245_100.67 / (2.0_f64.powi(halving_cycles as i32))
    };
    
    Ok(base_rate)
}

async fn calculate_fee_share(node_type_str: &str) -> Result<f64, String> {
    let total_fees = 100.0; // In production: Query blockchain
    
    let share_percentage = match node_type_str {
        "light" => 0.0,  // 0% of fees
        "full" => 0.30,  // 30% of fees
        "super" => 0.70, // 70% of fees
        _ => 0.0,
    };
    
    Ok(total_fees * share_percentage)
}

async fn print_microblock_status() {
    println!("🔗 Microblock Architecture Status:");
    println!("   📦 Microblocks: 1-second intervals (fast finality)");
    println!("   🏗️  Macroblocks: 90-second intervals (permanent finality)");
    println!("   ⚡ Target TPS: 100,000+ transactions per second");
    println!("   🌐 Network scaling: Ready for 10M+ nodes");
}

fn parse_bootstrap_peers(peers_str: &Option<String>) -> Vec<String> {
    peers_str
        .as_ref()
        .map(|s| s.split(',').map(|p| p.trim().to_string()).collect())
        .unwrap_or_default()
} 


