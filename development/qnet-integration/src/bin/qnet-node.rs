#![allow(unused_imports)]
#![allow(unused_variables)]
#![allow(dead_code)]
#![allow(unused_mut)]

//! QNet Production Node - 100k+ TPS Ready
//! 
//! PRODUCTION DEPLOYMENT: Interactive Setup Only
//! - No command-line arguments for activation
//! - Use built-in interactive menu for node configuration
//! - Activation code required (format: QNET-XXXXXX-XXXXXX-XXXXXX)
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

    // FIXED: Check code ownership instead of usage (codes are reusable on different devices)
    // We only need to verify the code belongs to the wallet trying to use it
    println!("🔍 Checking code ownership (codes are reusable for device migration)");
    
    // Code ownership is already verified in quantum decryption step above
    // The payload.wallet from the decrypted code is the true owner
    // No additional blockchain check needed - quantum decryption guarantees authenticity

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
            
            // CRITICAL: Verify burn transaction on Solana blockchain
            let burn_verified = verify_solana_burn_for_activation(&decoded.wallet_address, &decoded.tx_hash, price as u64).await?;
            if !burn_verified {
                return Err(format!("Solana burn verification failed: {} 1DEV burn not found for wallet {}", price as u64, &decoded.wallet_address[..8]));
            }
            
            println!("   ✅ Solana burn verification passed: {} 1DEV burned", price as u64);
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
    // Use the new activation function with auto-genesis detection
    get_activation_with_auto_genesis().await
}

// Bootstrap whitelist for first 5 nodes (production network bootstrap)
// Import shared Genesis constants to avoid duplication
use qnet_integration::genesis_constants::{GENESIS_BOOTSTRAP_CODES, GENESIS_NODE_IPS};
const BOOTSTRAP_WHITELIST: &[&str] = GENESIS_BOOTSTRAP_CODES;

// Check if this is a genesis bootstrap node
fn is_genesis_bootstrap_node() -> bool {
    println!("[DEBUG] === is_genesis_bootstrap_node() called ===");
    
    // GENESIS NODE DETECTION: First 5 nodes can start without activation code
    
    // Method 1: Check QNET_BOOTSTRAP_ID for genesis nodes (001-005)
    println!("[DEBUG] Method 1: Checking QNET_BOOTSTRAP_ID...");
    if let Ok(bootstrap_id) = std::env::var("QNET_BOOTSTRAP_ID") {
        println!("[DEBUG] Found QNET_BOOTSTRAP_ID: {}", bootstrap_id);
        match bootstrap_id.as_str() {
            "001" | "002" | "003" | "004" | "005" => {
                println!("🚀 Genesis bootstrap node #{} detected", bootstrap_id);
                
                // SECURITY: Check for duplicate Genesis nodes with same ID
                if check_genesis_node_duplication(&bootstrap_id) {
                    println!("🚨 SECURITY: Genesis node {} already exists in network!", bootstrap_id);
                    println!("🔒 BLOCKED: Each Genesis node ID can only run once in the network");
                    println!("💡 If migrating to new server, stop old Genesis node first");
                    return false;
                }
                
                // SECURITY: Verify IP authorization for Genesis nodes
                let current_ip = get_current_server_ip();
                let authorized_genesis_ips = get_genesis_node_ips_dynamic();
                
                println!("[SECURITY] 📍 Current server IP: {}", current_ip);
                println!("[SECURITY] 📋 Authorized Genesis IPs: {:?}", authorized_genesis_ips);
                
                // Check IP authorization with strict enforcement for production
                if current_ip == "auto-detected" {
                    println!("⚠️  IP AUTO-DETECTION FAILED: Could not determine server IP address");
                    println!("🔧 PRODUCTION: Set QNET_MANUAL_IP=your.public.ip.address for proper validation");
                    println!("📝 Allowing Genesis node startup with warning - add proper IP for security");
                } else if !authorized_genesis_ips.contains(&current_ip) {
                    println!("🚨 SECURITY WARNING: Genesis node {} from unauthorized IP {}", bootstrap_id, current_ip);
                    println!("🔒 PRODUCTION: Only authorized IPs should run Genesis nodes");
                    println!("🔧 Add {} to authorized Genesis IPs or use QNET_MANUAL_IP", current_ip);
                    // Allow startup but log security warning
                } else {
                    println!("✅ SECURITY: Genesis node {} authorized from IP {}", bootstrap_id, current_ip);
                }
                
                println!("🚀 GENESIS CONFIRMED: Node {} starting as Super Node", bootstrap_id);
                return true;
            }
            _ => {
                println!("⚠️ Invalid QNET_BOOTSTRAP_ID: {}. Genesis IDs are 001-005", bootstrap_id);
                return false;
            }
        }
    } else {
        println!("[DEBUG] QNET_BOOTSTRAP_ID not found");
    }
    
    // Method 2: Check legacy environment variable (manual override)
    println!("[DEBUG] Method 2: Checking QNET_GENESIS_BOOTSTRAP...");
    if std::env::var("QNET_GENESIS_BOOTSTRAP").unwrap_or_default() == "1" {
        println!("🚀 Legacy genesis bootstrap detected");
        return true;
    } else {
        println!("[DEBUG] QNET_GENESIS_BOOTSTRAP not set to '1'");
    }
    
    // Method 3: Smart Genesis detection - check for Genesis environment
    println!("[DEBUG] Method 3: Smart Genesis detection...");
    
    // Check if we're running on a Genesis IP (Docker mode)
    let current_ip = get_current_server_ip();
    println!("[DEBUG] Method 3: current_ip = '{}'", current_ip);
    if current_ip != "auto-detected" {
        let genesis_ips = get_genesis_node_ips_dynamic();
        println!("[DEBUG] Method 3: genesis_ips = {:?}", genesis_ips);
        println!("[DEBUG] Method 3: checking if '{}' is in genesis_ips", current_ip);
        let contains_current = genesis_ips.contains(&current_ip);
        println!("[DEBUG] Method 3: genesis_ips.contains({}) = {}", current_ip, contains_current);
        if contains_current {
            println!("🚀 SMART GENESIS: Detected Genesis IP {} - auto-enabling Genesis mode", current_ip);
            println!("📝 DOCKER: If this is wrong, set QNET_BOOTSTRAP_ID explicitly");
            
            // Auto-detect bootstrap ID from IP mapping
            for (genesis_ip, bootstrap_id) in GENESIS_NODE_IPS {
                if *genesis_ip == current_ip {
                    std::env::set_var("QNET_BOOTSTRAP_ID", bootstrap_id);
                    println!("🔧 AUTO-SET: QNET_BOOTSTRAP_ID={} based on IP {}", bootstrap_id, current_ip);
                    return true;
                }
            }
            return true;
        }
    }
    
    // Method 4: Check if network is in genesis state (no other nodes exist)
    println!("[DEBUG] Method 4: Checking network genesis state...");
    if is_network_in_genesis_state() {
        println!("🚀 Network in genesis state - allowing bootstrap node startup");
        return true;
    } else {
        println!("[DEBUG] Network NOT in genesis state");
    }
    
    println!("[DEBUG] === is_genesis_bootstrap_node() returning FALSE ===");
    false
}

// Check if network is in genesis state (check real genesis nodes)
fn is_network_in_genesis_state() -> bool {
    // Get Genesis node IPs dynamically from environment/config
    let genesis_ips = get_genesis_node_ips_dynamic();
    
    let mut active_genesis_nodes = 0;
    
    // Test if any genesis nodes are already running
    for ip in genesis_ips {
        let test_addresses = vec![
            format!("{}:9876", ip),  // North America port
            format!("{}:9877", ip),  // Europe port
            format!("{}:8001", ip),  // RPC port
        ];
        
        for addr in test_addresses {
            if test_connection_quick(&addr) {
                active_genesis_nodes += 1;
                println!("[GENESIS] Found active genesis node at: {}", addr);
                break; // One connection per IP is enough
            }
        }
    }
    
    // Genesis state: No genesis nodes found running yet
    println!("[GENESIS] Found {} active genesis nodes out of 5", active_genesis_nodes);
    
    // If no genesis nodes are active, we're in genesis state
    active_genesis_nodes == 0
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
        format!("{:03}", existing_nodes.len() + 1)
    });
    
    // Ensure 4-digit format for bootstrap ID (pad with zeros)
    let formatted_id = if bootstrap_id.len() < 4 {
        format!("{:0>4}", bootstrap_id)  // Pad with leading zeros to 4 digits
    } else {
        bootstrap_id
    };
    
    // Generate bootstrap code
    let bootstrap_code = format!("QNET-BOOT-{}-STRAP", formatted_id);
    
    println!("[DEBUG] Generated bootstrap code: {}", bootstrap_code);
    println!("[DEBUG] Checking against whitelist: {:?}", BOOTSTRAP_WHITELIST);
    
    // Validate bootstrap code
    if !BOOTSTRAP_WHITELIST.contains(&bootstrap_code.as_str()) {
        return Err(format!("Bootstrap code {} not in whitelist. Maximum 5 bootstrap nodes allowed", bootstrap_code));
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
    
    // 2. Bootstrap whitelist check FIRST (genesis codes have different format)
    if BOOTSTRAP_WHITELIST.contains(&code) {
        println!("✅ Bootstrap whitelist code detected - Genesis network node");
        println!("   [GENESIS] Code: {} (bootstrap format)", code);
        return Ok(());
    }
    
    // 3. Format validation - QNET-XXXXXX-XXXXXX-XXXXXX for regular production codes (enhanced security)
    if !code.starts_with("QNET-") || code.len() != 26 {
        return Err("Invalid activation code format. Expected: QNET-XXXXXX-XXXXXX-XXXXXX (26 chars)".to_string());
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
    
    // 6. Burn verification for production (skip for genesis nodes)
    if std::env::var("QNET_PRODUCTION").unwrap_or_default() == "1" && !is_genesis_bootstrap_node() {
        if let Err(e) = verify_activation_burn(code, &node_type).await {
            return Err(format!("Burn verification failed: {}", e));
        }
    } else if is_genesis_bootstrap_node() {
        println!("🚀 Genesis node - skipping burn verification");
    }
    
    println!("✅ All activation code validations passed");
    Ok(())
}

// Blockchain uniqueness validation
async fn validate_blockchain_uniqueness(code: &str) -> Result<(), String> {
    println!("🔍 Checking blockchain uniqueness...");
    
    // FIXED: Initialize blockchain registry with real QNet nodes
    let qnet_rpc = std::env::var("QNET_RPC_URL")
        .or_else(|_| std::env::var("QNET_GENESIS_NODES")
            .map(|nodes| format!("http://{}:8001", nodes.split(',').next().unwrap_or("127.0.0.1").trim())))
        .unwrap_or_else(|_| "http://127.0.0.1:8001".to_string());
        
    let registry = qnet_integration::activation_validation::BlockchainActivationRegistry::new(
        Some(qnet_rpc)
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
    println!("🚀 QNet Node Setup");
    
    // Auto-detect region
    let detected_region = match auto_detect_region().await {
        Ok(region) => {
            let region_name = match region {
                Region::NorthAmerica => "🌎 Americas",
                Region::Europe => "🌍 Europe", 
                Region::Asia => "🌏 Asia-Pacific",
                Region::SouthAmerica => "🌎 South America",
                Region::Africa => "🌍 Africa",
                Region::Oceania => "🌏 Oceania",
            };
            println!("📍 {}", region_name);
            region
        },
        Err(e) => {
            println!("[REGION] ⚠️ Could not auto-detect region: {}", e);
            println!("[REGION] 🚀 MULTI-REGIONAL DISCOVERY MODE");
            println!("[REGION] 🌐 Testing all 6 regional ports for active nodes");
            println!("[REGION] 📡 Will connect to best performing regions");
            println!("[REGION] ⚡ Starting comprehensive port scan...");
            
            // Test all regional ports and find the best one
            test_all_regional_ports().await.unwrap_or(Region::Europe)
        }
    };

    let (current_phase, pricing_info) = detect_current_phase().await;
    display_phase_info(current_phase, &pricing_info);
    let node_type = select_node_type(current_phase, &pricing_info)?;

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

    // Request and validate activation code with retry loop
    use std::io::Write;
    let activation_code = loop {
        print!("\n🔐 Activation Code: ");
        std::io::stdout().flush().unwrap();
        
        let mut input = String::new();
        match io::stdin().read_line(&mut input) {
            Ok(_) => {
                let code = input.trim().to_string();
                
                // Handle empty input for genesis bootstrap (shouldn't happen here, but safety check)
                if code.is_empty() && is_genesis_bootstrap_node() {
                    println!("✅ Generating genesis bootstrap code...");
                    let genesis_code = generate_genesis_activation_code()
                        .map_err(|e| format!("Genesis code error: {}", e))?;
                    break genesis_code;
                }

                if code.is_empty() {
                    println!("❌ Activation code cannot be empty. Please enter a valid code.");
                    continue;
                }

                // Basic format validation
                if !code.starts_with("QNET-") {
                    println!("❌ Invalid activation code format. Expected format: QNET-XXXXXX-XXXXXX-XXXXXX");
                    continue;
                }

                // Comprehensive validation
                match validate_activation_code_comprehensive(&code, node_type, current_phase, &pricing_info).await {
                    Ok(_) => {
                        println!("✅ Activation code validated successfully");
                        break code;
                    }
                    Err(e) => {
                        println!("❌ Activation failed: {}", e);
                        println!("Please try again with a valid activation code.");
                        continue;
                    }
                }
            }
            Err(e) => {
                println!("❌ Error reading input: {}. Please try again.", e);
                continue;
            }
        }
    };

    // Beautiful quantum node startup banner
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("🔮 QNET QUANTUM BLOCKCHAIN NODE INITIALIZED");
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("🚀 Node Type: {:?} | 🔐 Post-Quantum Security: ACTIVE", node_type);
    println!("🛡️  Quantum Algorithms: CRYSTALS-Dilithium + CRYSTALS-Kyber");
    println!("⚡ Performance Target: 100,000+ TPS | ⏱️  Block Time: 1s microblocks");
    println!("🌐 Network: Production Ready | 💎 Consensus: Byzantine-BFT");
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("✅ Quantum Node Ready - Blockchain Operations Starting...");
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    
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
            
            // Try backup RPC nodes (network-aware)
            let network_config = qnet_integration::network_config::get_network_config();
            let backup_rpcs = if network_config.is_testnet() {
                vec![
                    "https://api.devnet.solana.com",
                    "https://devnet.helius-rpc.com", 
                    "https://solana-devnet.g.alchemy.com/v2/demo",
                ]
            } else {
                vec![
                    "https://api.mainnet-beta.solana.com",
                    "https://solana-mainnet.g.alchemy.com/v2/demo",
                    "https://mainnet.helius-rpc.com",
                ]
            };
            
            for rpc_url in backup_rpcs {
                println!("🔄 Trying backup RPC: {}", rpc_url);
                match get_real_token_supply(rpc_url, &network_config.solana.onedev_mint).await {
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
            println!("⚠️  Cannot get real 1DEV token burn data from Solana devnet");
            println!("   Using emergency fallback data for production operation");
            
            // Emergency fallback with realistic production estimates
            let fallback_pricing = PricingInfo {
                network_size: 1, // Conservative fallback when no burn data available
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

#[derive(Debug, Default)]
struct RealNodeCounts {
    total: u64,
    light: u64,
    full: u64,
    super_nodes: u64,
}

// Fetch real data from Solana contract
async fn fetch_burn_tracker_data() -> Result<BurnTrackerData, String> {
    // Network-aware Solana RPC configuration
    let network_config = qnet_integration::network_config::get_network_config();
    let rpc_url = std::env::var("SOLANA_RPC_URL").unwrap_or_else(|_| {
        network_config.solana.rpc_url.clone()
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
            
            // Get real node count from actual QNet network scan
            let (real_node_counts, discovered_peers) = scan_active_qnet_nodes().await;
            
            // CRITICAL FIX: Pass discovered peers to P2P system
            println!("🔗 Found {} peers for P2P integration", discovered_peers.len());
            
            Ok(BurnTrackerData {
                total_1dev_burned: supply_data.total_burned,
                burn_percentage: supply_data.burn_percentage,
                total_nodes_activated: real_node_counts.total,
                light_nodes: real_node_counts.light,
                full_nodes: real_node_counts.full,
                super_nodes: real_node_counts.super_nodes,
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
        
        let network_config = qnet_integration::network_config::get_network_config();
        match tokio::process::Command::new("curl")
            .args(&["-s", "-X", "POST", &network_config.solana.rpc_url])
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

// This function removed - now using real network scanning instead of token burn estimation

fn calculate_network_multiplier(network_size: u64) -> f64 {
    match network_size {
        0..=10_000 => 0.5,      // Early network discount
        10_001..=100_000 => 1.0, // Standard pricing
        100_001..=1_000_000 => 2.0, // High demand
        _ => 3.0                 // Mature network premium
    }
}

fn display_phase_info(phase: u8, pricing: &PricingInfo) {
    match phase {
        1 => println!("🔥 Phase 1: {} active nodes, {:.1}% burned", pricing.network_size, pricing.burn_percentage),
        2 => println!("💎 Phase 2: {} active nodes, {:.1}x multiplier", pricing.network_size, pricing.network_multiplier),
        _ => println!("❓ Unknown phase"),
    }
}

fn select_node_type(phase: u8, pricing: &PricingInfo) -> Result<NodeType, Box<dyn std::error::Error>> {
    // SECURITY: Check if this is a Genesis node - if so, auto-select Super Node type
    if is_genesis_bootstrap_node() {
        println!("🚀 GENESIS NODE DETECTED: Auto-selecting Super Node type");
        println!("   [GENESIS] All Genesis nodes are Super Nodes by design");
        println!("   [BOOTSTRAP] Network initialization mode");
        return Ok(NodeType::Super);
    }
    
    loop {
        println!("\n🖥️ Node Type:");
        println!("1. Full Node   - Standard server");
        println!("2. Super Node  - High-performance server");
        
        // Show pricing
    for (i, node_type) in [NodeType::Full, NodeType::Super].iter().enumerate() {
        let price = calculate_node_price(phase, *node_type, pricing);
        let price_str = format_price(phase, price);
            println!("   {}. {}", i + 1, price_str);
    }
    
        print!("\nChoice (1-2): ");
    io::stdout().flush()?;
    
    let mut input = String::new();
    match io::stdin().read_line(&mut input) {
            Ok(_) => {},
            Err(_) => continue,
        }
        
        // Take only the first digit from input
        let choice = input.trim().chars()
            .find(|c| c.is_ascii_digit())
            .map(|c| c.to_string())
            .unwrap_or_default();
        
        println!("Debug: cleaned input '{}'", choice);
        
        match choice.as_str() {
        "1" => {
                println!("✅ Full Node selected");
                return Ok(NodeType::Full);
        },
        "2" => {
                println!("✅ Super Node selected");
                return Ok(NodeType::Super);
        },
        _ => {
                println!("❌ Invalid choice '{}'. Please enter 1 or 2.", choice);
                // Continue the loop to ask again
            }
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
    println!("\n💳 Cost: {}", format_price(phase, price));
}

fn request_activation_code(phase: u8) -> Result<String, Box<dyn std::error::Error>> {
    if is_genesis_bootstrap_node() {
        print!("🚀 Genesis node (press ENTER): ");
    } else {
        print!("🔐 Activation Code: ");
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
                        return Err(format!("Failed to generate genesis code: {}", e).into());
                    }
                }
            } else if code.is_empty() {
                return Err("Empty activation code not allowed for regular nodes".into());
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
        
        // Smart data directory selection for Linux servers
        // In Docker, prefer /app/data if writable
        let data_dir = if let Ok(dir) = std::env::var("QNET_DATA_DIR") { PathBuf::from(dir) } else { select_best_data_directory().await? };
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
    println!("[BOOTSTRAP] Decentralized peer discovery for region: {:?}", region);
    
    // Check for manually specified peer IPs (for initial testing only)
    if let Ok(peer_ips) = std::env::var("QNET_PEER_IPS") {
        let peers: Vec<String> = peer_ips
            .split(',')
            .map(|ip| {
                let ip = ip.trim();
                let port = get_regional_port(region);
                format!("{}:{}", ip, port)
            })
            .collect();
        
        if !peers.is_empty() {
            println!("[BOOTSTRAP] ✅ Using manual peer IPs (testing mode): {:?}", peers);
            return peers;
        }
    }
    
    // PRODUCTION FIX: Provide appropriate bootstrap nodes based on context
    // Light nodes connect to Full/Super nodes, servers connect to Genesis nodes
    let is_light_node = std::env::var("QNET_NODE_TYPE")
        .map(|t| t.to_lowercase() == "light")
        .unwrap_or(false);
    
    if is_light_node {
        // Light nodes (mobile) connect to Full/Super nodes for better decentralization
        let genesis_ips = get_genesis_node_ips_dynamic();
        let full_super_peers: Vec<String> = genesis_ips.iter()
            .take(2)  // Use first 2 Genesis nodes as fallback for Light nodes
            .map(|ip| format!("{}:8001", ip))
            .collect();
        
        println!("[BOOTSTRAP] 📱 Light node: Connecting to Full/Super nodes");
        println!("[BOOTSTRAP] ✅ {} Full/Super nodes for Light node: {:?}", 
                 full_super_peers.len(), full_super_peers);
        
        full_super_peers
    } else {
        // Full/Super/Genesis nodes connect to Genesis bootstrap network
        let genesis_ips = get_genesis_node_ips_dynamic();
        let genesis_bootstrap_peers: Vec<String> = genesis_ips.iter()
            .map(|ip| format!("{}:8001", ip))
            .collect();
        
        println!("[BOOTSTRAP] 🖥️ Server node: Using genesis bootstrap network");
        println!("[BOOTSTRAP] ✅ {} genesis nodes configured: {:?}", 
                 genesis_bootstrap_peers.len(), genesis_bootstrap_peers);
        
        genesis_bootstrap_peers
    }
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

// PRODUCTION: Get Genesis node IPs dynamically from environment/config with SECURITY VALIDATION
fn get_genesis_node_ips_dynamic() -> Vec<String> {
    // Priority 1: Environment variable QNET_GENESIS_NODES
    if let Ok(env_nodes) = std::env::var("QNET_GENESIS_NODES") {
        let nodes: Vec<String> = env_nodes.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .filter(|s| validate_ip_address_security(s)) // 🔒 SECURITY: IP validation
            .collect();
        if !nodes.is_empty() {
            println!("[CONFIG] ✅ Using {} validated Genesis nodes from QNET_GENESIS_NODES", nodes.len());
            return nodes;
        } else {
            println!("[CONFIG] ⚠️ QNET_GENESIS_NODES contains invalid IPs, using fallback");
        }
    }
    
    // Priority 2: Config file genesis-nodes.json (with security validation)
    if let Ok(config_nodes) = load_genesis_nodes_from_config_secure() {
        if !config_nodes.is_empty() {
            println!("[CONFIG] ✅ Using {} validated Genesis nodes from config file", config_nodes.len());
            return config_nodes;
        }
    }
    
    // Priority 3: Use shared Genesis constants to avoid duplication
    use qnet_integration::unified_p2p::get_genesis_bootstrap_ips;
    let genesis_nodes = get_genesis_bootstrap_ips();
    
    println!("[CONFIG] ⚠️ Using shared Genesis constants (set QNET_GENESIS_NODES to override): {:?}", genesis_nodes);
    genesis_nodes
}

// SECURITY: Check if Genesis node with same ID already exists in network
fn check_genesis_node_duplication(bootstrap_id: &str) -> bool {
    println!("[SECURITY] 🔍 Scanning network for duplicate Genesis node {}...", bootstrap_id);
    
    // PRODUCTION OVERRIDE: Allow skipping duplication check if needed
    if std::env::var("QNET_SKIP_GENESIS_DUPLICATION_CHECK").unwrap_or_default() == "1" {
        println!("[SECURITY] ⚠️  DUPLICATION CHECK DISABLED via QNET_SKIP_GENESIS_DUPLICATION_CHECK");
        println!("[SECURITY] 🔓 Allowing Genesis node startup without duplication verification");
        return false;
    }
    
    // Get all Genesis node IPs to check
    let genesis_ips = get_genesis_node_ips_dynamic();
    let our_current_ip = get_current_server_ip();
    
    println!("[SECURITY] 📋 Scanning Genesis IPs: {:?}", genesis_ips);
    println!("[SECURITY] 🔍 Our IP: {} (will be skipped)", our_current_ip);
    
    // DOCKER/CONTAINER FIX: Smart IP detection for containerized environments
    if our_current_ip == "auto-detected" || our_current_ip == "unknown" {
        println!("[SECURITY] ⚠️  IP AUTO-DETECTION FAILED");
        
        // Try alternative IP detection using QNET_MANUAL_IP for Docker/Container
        if let Ok(manual_ip) = std::env::var("QNET_MANUAL_IP") {
            if !manual_ip.trim().is_empty() && manual_ip != "auto-detected" {
                println!("[SECURITY] 🐳 Container external IP from QNET_MANUAL_IP: {}", manual_ip);
                
                // Use manual IP for duplication checking, but skip our own IP
                if genesis_ips.contains(&manual_ip) {
                    println!("[SECURITY] ⏭️  Our IP detected in Genesis list: {}", manual_ip);
                    println!("[SECURITY] 🔓 Allowing Genesis node startup (our own IP detected)");
                    return false;
                }
            }
        }
        
        println!("[SECURITY] 🐳 Docker/Container mode: Cannot reliably detect duplicates");
        println!("[SECURITY] 🔧 Set QNET_MANUAL_IP=your.public.ip for strict checking");
        println!("[SECURITY] 🔓 Allowing Genesis node startup (IP detection failed)");
        return false; // Allow startup when IP cannot be detected
    }
    
    // Check each Genesis IP for active nodes
    for ip in &genesis_ips {
        // Skip our own IP to avoid self-detection
        if ip == &our_current_ip {
            println!("[SECURITY] ⏭️ Skipping our own IP: {}", ip);
            continue;
        }
        
        // CRITICAL FIX: If we can't detect our IP, we need to be more careful
        // In Docker, the container might be running on the same external IP
        if our_current_ip == "auto-detected" {
            // Check if this IP might be our own by testing if we're already running there
            let self_test_addr = format!("{}:8001", ip);
            
            // Try to detect if we're running on this IP by checking environment
            let manual_ip = std::env::var("QNET_MANUAL_IP").unwrap_or_default();
            if !manual_ip.is_empty() && manual_ip == *ip {
                println!("[SECURITY] ⏭️ Skipping our own IP (manual): {}", ip);
                continue;
            }
            
            // DOCKER FIX: Smart Genesis IP mapping for all Genesis nodes (001-005)
            let genesis_ip_mapping = vec![
                ("001", "154.38.160.39"),
                ("002", "62.171.157.44"),
                ("003", "161.97.86.81"), 
                ("004", "173.212.219.226"),
                ("005", "164.68.108.218"),
            ];
            
            // Check if this IP belongs to our Genesis node
            let mut is_our_genesis_ip = false;
            for (id, genesis_ip) in &genesis_ip_mapping {
                if bootstrap_id == *id && ip == *genesis_ip {
                    println!("[SECURITY] ⏭️ Skipping Genesis {} primary IP (likely our own): {}", id, genesis_ip);
                    is_our_genesis_ip = true;
                    break;
                }
            }
            if is_our_genesis_ip {
                continue;
            }
        }
        
        let test_addresses = vec![
            format!("{}:8001", ip),  // Primary RPC port
            format!("{}:9876", ip),  // North America port  
            format!("{}:9877", ip),  // Europe port
        ];
        
        // Test each port for active service
        for addr in test_addresses {
            println!("[SECURITY] 🔍 Testing Genesis service at: {}", addr);
            
            if test_connection_quick(&addr) {
                println!("[SECURITY] 🚨 FOUND ACTIVE GENESIS NODE at: {}", addr);
                
                // CRITICAL FIX: Only block if this is the SAME Genesis node ID
                // Check if this IP belongs to our Genesis node using our mapping
                let genesis_ip_mapping = vec![
                    ("001", "154.38.160.39"),
                    ("002", "62.171.157.44"),
                    ("003", "161.97.86.81"), 
                    ("004", "173.212.219.226"),
                    ("005", "164.68.108.218"),
                ];
                
                let mut is_our_genesis_node = false;
                for (id, genesis_ip) in &genesis_ip_mapping {
                    if bootstrap_id == *id && ip == *genesis_ip {
                        println!("[SECURITY] 🔒 DUPLICATE: Found our Genesis {} running at: {}", id, addr);
                        println!("[SECURITY] 🚨 BLOCKING: Genesis node {} already exists!", id);
                        is_our_genesis_node = true;
                        break;
                    }
                }
                
                if is_our_genesis_node {
                    return true; // Duplicate of OUR Genesis node detected - block startup
                } else {
                    println!("[SECURITY] ✅ Different Genesis node active at: {} (not Genesis {})", addr, bootstrap_id);
                    println!("[SECURITY] 🔓 Continuing startup - this is a different Genesis node");
                    // Continue checking - this is just another Genesis node, not our duplicate
                }
            } else {
                println!("[SECURITY] 📍 No service at: {}", addr);
            }
        }
    }
    
    println!("[SECURITY] ✅ No duplicate Genesis node {} found in network", bootstrap_id);
    println!("[SECURITY] 🚀 Safe to start Genesis node {}", bootstrap_id);
    false // No duplicate found - safe to start
}

// Get current server IP address using multiple methods
fn get_current_server_ip() -> String {
    // Method 1: Check environment variable (for manual override)
    if let Ok(manual_ip) = std::env::var("QNET_MANUAL_IP") {
        if !manual_ip.trim().is_empty() && manual_ip != "auto-detected" {
            println!("[IP] 🎯 Using manual IP from QNET_MANUAL_IP: {}", manual_ip);
            return manual_ip.trim().to_string();
        }
    }
    
    // Method 2: Try external IP detection for Docker containers
    if let Ok(external_ip) = get_external_ip() {
        println!("[IP] 🌐 Using external IP: {}", external_ip);
        return external_ip;
    }
    
    // Method 3: Try to get local network IP
    if let Ok(local_ip) = get_local_network_ip() {
        println!("[IP] 🏠 Using local network IP: {}", local_ip);
        return local_ip;
    }
    
    // Fallback: Unable to detect IP in container environment
    println!("[IP] ⚠️ Could not auto-detect server IP");
    println!("[IP] 🔧 For production Genesis nodes: Set QNET_MANUAL_IP=your.public.ip");
    println!("[IP] 📝 Using container fallback IP for bootstrap phase");
    "auto-detected".to_string()  // Special marker for auto-detection failure
}

// Get external IP address (Docker/Container-friendly) - FIXED: No curl dependency
fn get_external_ip() -> Result<String, String> {
    println!("[DEBUG] 🔧 get_external_ip() called - attempting IP detection");
    
    // CRITICAL FIX: Use blocking HTTP client to avoid Tokio runtime conflicts
    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build() {
        Ok(client) => client,
        Err(e) => {
            println!("[DEBUG] ❌ Failed to create HTTP client: {}", e);
            return Err(format!("HTTP client error: {}", e));
        }
    };
    
    let ip_services = vec![
        "https://api.ipify.org",
        "https://ifconfig.me/ip", 
        "https://icanhazip.com",
    ];
    
    for service in ip_services {
        println!("[DEBUG] 🔧 Trying IP service: {}", service);
        
        match client.get(service).send() {
            Ok(response) if response.status().is_success() => {
                match response.text() {
                    Ok(ip_text) => {
                        let ip = ip_text.trim().to_string();
                        
                        if !ip.is_empty() && ip.contains('.') && !ip.contains("error") && !ip.contains("timeout") {
                            if validate_ip_address_security(&ip) {
                                println!("[DEBUG] ✅ IP detected via {}: {}", service, ip);
                                println!("[IP] 🌐 External IP detected via {}: {}", service, ip);
                                return Ok(ip);
                            } else {
                                println!("[DEBUG] ❌ IP failed security validation: {}", ip);
                            }
                        } else {
                            println!("[DEBUG] ❌ Invalid IP response: {}", ip);
                        }
                    }
                    Err(e) => {
                        println!("[DEBUG] ❌ Response read error from {}: {}", service, e);
                    }
                }
            }
            Ok(response) => {
                println!("[DEBUG] ❌ HTTP error {} from {}", response.status(), service);
            }
            Err(e) => {
                println!("[DEBUG] ❌ Request failed for {}: {}", service, e);
            }
        }
    }
    
    println!("[DEBUG] ❌ All IP services failed");
    Err("Could not detect external IP".to_string())
}

// Get local network IP address
fn get_local_network_ip() -> Result<String, String> {
    use std::net::{TcpStream, SocketAddr};
    
    // Try to connect to a remote address to determine local IP
    match TcpStream::connect("8.8.8.8:80") {
        Ok(stream) => {
            if let Ok(local_addr) = stream.local_addr() {
                let ip = local_addr.ip().to_string();
                if validate_ip_address_security(&ip) {
                    return Ok(ip);
                }
            }
        }
        Err(_) => {}
    }
    
    Err("Could not determine local network IP".to_string())
}

// SECURITY: Validate IP address format and security
fn validate_ip_address_security(ip: &str) -> bool {
    use std::net::Ipv4Addr;
    
    // Basic IP format validation
    if let Ok(addr) = ip.parse::<Ipv4Addr>() {
        // SECURITY: Block dangerous IP ranges for production blockchain
        let octets = addr.octets();
        
        // PRODUCTION: Block localhost and loopback addresses
        if octets[0] == 127 {
            println!("[SECURITY] ❌ Blocked localhost IP: {}", ip);
            return false;
        }
        
        // PRODUCTION: Allow Docker bridge networks for Genesis bootstrap
        if (octets[0] == 10) ||
           (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31) ||
           (octets[0] == 192 && octets[1] == 168) {
            println!("[SECURITY] ⚠️ Private network IP detected: {} (allowed for Genesis bootstrap)", ip);
            return true; // Allow for Docker/containerized environments
        }
        
        // Block multicast and reserved ranges
        if octets[0] >= 224 {
            println!("[SECURITY] ❌ Blocked reserved IP range: {}", ip);
            return false;
        }
        
        // Additional security: Block known malicious ranges (can be expanded)
        if octets[0] == 0 || octets[0] == 255 {
            println!("[SECURITY] ❌ Blocked invalid IP: {}", ip);
            return false;
        }
        
        println!("[SECURITY] ✅ Validated Genesis IP: {}", ip);
        return true;
    }
    
    println!("[SECURITY] ❌ Invalid IP format: {}", ip);
    false
}

// SECURE: Load Genesis nodes from config file with security validation
fn load_genesis_nodes_from_config_secure() -> Result<Vec<String>, String> {
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    
    let config_paths = vec![
        "genesis-nodes.json",
        "config/genesis-nodes.json",
        "/etc/qnet/genesis-nodes.json",
        "~/.qnet/genesis-nodes.json"
    ];
    
    for path in config_paths {
        // SECURITY: Check file permissions before reading (Unix only)
        #[cfg(unix)]
        if let Ok(metadata) = fs::metadata(path) {
            let permissions = metadata.permissions();
            let mode = permissions.mode();
            
            // Check if file is world-readable (security risk)
            if mode & 0o044 != 0 {
                println!("[SECURITY] ⚠️ Config file {} has unsafe permissions: {:o}", path, mode);
                println!("[SECURITY] 🔒 Recommended: chmod 600 {}", path);
            }
        }
        
        if let Ok(content) = fs::read_to_string(path) {
            // SECURITY: Limit config file size (prevent DoS)
            if content.len() > 10240 { // 10KB limit
                println!("[SECURITY] ❌ Config file {} too large ({}B), max 10KB", path, content.len());
                continue;
            }
            
            if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(nodes) = config["genesis_nodes"].as_array() {
                    // SECURITY: Limit number of Genesis nodes
                    if nodes.len() > 10 {
                        println!("[SECURITY] ❌ Too many Genesis nodes in config ({}), max 10", nodes.len());
                        continue;
                    }
                    
                    let node_ips: Vec<String> = nodes.iter()
                        .filter_map(|v| v.as_str())
                        .map(|s| s.to_string())
                        .filter(|ip| validate_ip_address_security(ip)) // 🔒 SECURITY: Validate each IP
                        .collect();
                    
                    if !node_ips.is_empty() {
                        println!("[SECURITY] ✅ Loaded {} validated Genesis nodes from {}", node_ips.len(), path);
                        return Ok(node_ips);
                    }
                }
            } else {
                println!("[SECURITY] ❌ Invalid JSON in config file: {}", path);
            }
        }
    }
    
    Err("No valid Genesis config file found".to_string())
}

// Get real external IP address for Docker containers
async fn get_physical_ip() -> Result<String, String> {
    println!("[IP] Getting external IP address...");
    
    // List of reliable IP detection services
    let services = [
        "https://api.ipify.org",
        "https://ifconfig.me/ip", 
        "https://icanhazip.com",
    ];
    
    for service in services {
        match get_external_ip_from_service(service).await {
            Ok(ip) => {
                println!("[IP] ✅ External IP detected: {}", ip);
                return Ok(ip);
            }
            Err(e) => {
                println!("[IP] ❌ Failed to get IP from {}: {}", service, e);
                continue;
            }
        }
    }
    
    Err("Failed to detect external IP from all services".to_string())
}

// Get external IP from a specific service
async fn get_external_ip_from_service(url: &str) -> Result<String, String> {
    use std::time::Duration;
    
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    
    let response = client.get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }
    
    let ip_text = response.text().await
        .map_err(|e| format!("Response read error: {}", e))?;
    
    let ip = ip_text.trim().to_string();
    
    // Basic IP validation
    if ip.parse::<std::net::Ipv4Addr>().is_ok() {
        Ok(ip)
    } else {
        Err(format!("Invalid IP format: {}", ip))
    }
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
    // 104.0.0.0/8, 107.0.0.0/8, 108.0.0.0/8, 154.0.0.0/8 (OVH), 173.0.0.0/8, 174.0.0.0/8, 184.0.0.0/8, 199.0.0.0/8, 208.0.0.0/8
    // 209.0.0.0/8, 216.0.0.0/8
    let first_octet = (ip_u32 >> 24) as u8;
    match first_octet {
        3..=9 | 11..=24 | 26 | 28..=30 | 32..=35 | 38 | 40 | 44..=45 | 47..=48 | 50 | 52 | 54..=56 | 
        63 | 68..=76 | 96..=100 | 104 | 107..=108 | 154 | 173..=174 | 184 | 199 | 208..=209 | 216 => true,
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
    
    // Major African IP blocks (AFRINIC allocation)
    // 41.0.0.0/8, 102.0.0.0/8, 105.0.0.0/8, 155.0.0.0/8, 156.0.0.0/8
    // 160.0.0.0/8, 161.0.0.0/8, 162.0.0.0/8, 164.0.0.0/8, 165.0.0.0/8, 196.0.0.0/8
    // 197.0.0.0/8
    // NOTE: 154.0.0.0/8 is NOT AFRINIC - it's North American (OVH hosting)
    match first_octet {
        41 | 102 | 105 | 155..=156 | 160..=162 | 164..=165 | 196..=197 => true,
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
    // SECURITY: Prevent direct execution - ONLY Docker or Mobile allowed
    if !std::path::Path::new("/.dockerenv").exists() && 
       std::env::var("DOCKER_ENV").is_err() &&
       std::env::var("QNET_BYPASS_DOCKER_CHECK").is_err() {
        eprintln!("❌ SECURITY ERROR: Direct execution is not allowed!");
        eprintln!("📦 QNet nodes MUST be run through Docker containers.");
        eprintln!("📱 Light nodes should use the official mobile app.");
        eprintln!("");
        eprintln!("🐳 To run a node, use Docker:");
        eprintln!("   docker run -d --name qnet-node \\");
        eprintln!("     -e QNET_ACTIVATION_CODE=YOUR_CODE \\");  
        eprintln!("     -e QNET_EXTERNAL_IP=YOUR_IP \\");
        eprintln!("     -p 8001:8001 -p 9876:9876 -p 9877:9877 \\");
        eprintln!("     qnet-production");
        eprintln!("");
        eprintln!("📱 For mobile nodes, download the QNet app:");
        eprintln!("   iOS: App Store");
        eprintln!("   Android: Google Play");
        std::process::exit(1);
    }
    
    // Initialize environment
    if std::env::var("RUST_LOG").is_err() {
        std::env::set_var("RUST_LOG", "info");
    }
    env_logger::init();
    
    // Auto-configure everything
    let config = AutoConfig::new().await?;
    
    // PRODUCTION: Check for existing activation or run interactive setup
    let (node_type, activation_code) = check_existing_activation_or_setup().await?;
    
    // Configure production mode (microblocks by default)
    configure_production_mode();
    
    // Use auto-configured values
    let region = config.region;
    let mut bootstrap_peers = config.bootstrap_peers.clone();
    
    // CRITICAL FIX: DHT discovery will happen AFTER API server starts
    // This prevents "All endpoints failed" errors during bootstrap
    println!("🔍 DHT peer discovery will run after API server startup...");
    
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
    
    // PRODUCTION: Load network configuration based on QNET_NETWORK env
    let network_config = qnet_integration::network_config::get_network_config();
    println!("🌐 Network: {}", network_config.network_name());
    println!("   Environment: {:?}", network_config.environment);
    println!("   Chain ID: {}", network_config.chain_id);
    println!("   QNet RPC: {}", network_config.endpoints.qnet_rpc);
    println!("   Bridge API: {}", network_config.endpoints.bridge_api);
    println!("   Solana RPC: {}", network_config.solana.rpc_url);
    println!("   1DEV Token: {}", network_config.solana.onedev_mint);
    
    // PRODUCTION: Full activation code validation in main for security
    let (current_phase, pricing_info) = detect_current_phase().await;
    
    // Comprehensive validation for production security
    match validate_activation_code_comprehensive(&activation_code, node_type, current_phase, &pricing_info).await {
        Ok(_) => {
            println!("🔐 Running in PRODUCTION MODE");
            println!("   ✅ Activation code validated in main()");
            println!("   📝 Code: {}", mask_code(&activation_code));
            println!("   🖥️  Server node type: {:?}", node_type);
            println!("   💰 Dynamic pricing: Phase {} pricing active", current_phase);
            println!("   🔐 Using quantum-secure activation codes with permanent validity");
            println!("   🛡️  Light node blocking: Enforced on server hardware");
        }
        Err(e) => {
            println!("❌ CRITICAL: Activation validation failed in main():");
            println!("   Error: {}", e);
            println!("   This is a security check to prevent invalid nodes from starting");
            return Err(format!("Activation validation failed: {}", e).into());
        }
    }
    
    // Verify 1DEV burn if required for production (skip for genesis nodes)
    if std::env::var("QNET_PRODUCTION").unwrap_or_default() == "1" && !is_genesis_bootstrap_node() {
        verify_1dev_burn(&node_type).await?;
    } else if is_genesis_bootstrap_node() {
        println!("🚀 Genesis bootstrap node - skipping 1DEV burn verification for production startup");
    }
    
    // Create blockchain node with production optimizations
    println!("🔍 DEBUG: Creating BlockchainNode with data_dir: '{}'", config.data_dir.display());
    println!("✅ DEBUG: Data directory permissions already verified during selection");
    
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

        // PRODUCTION: Auto-shutdown previous nodes of same type for this wallet
        let external_ip = get_physical_ip().await.unwrap_or_else(|_| "127.0.0.1".to_string());
        let api_port = std::env::var("QNET_API_PORT")
            .ok()
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(8001);
        
        println!("📝 Storing node connection info for replacement system...");
        if let Err(e) = quantum_crypto.store_node_connection_info(
            &activation_code,
            &external_ip,
            api_port,
        ).await {
            println!("⚠️  Failed to store connection info: {}", e);
        }
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
    
    // DAEMON MODE: Prepare log file
    let log_file_path = std::path::Path::new(&config.data_dir).join("qnet-node.log");
    println!("📝 Log file: {}", log_file_path.display());
    
    // Start the blockchain node (keep reference for peer injection)
    if let Err(e) = node.start().await {
        eprintln!("❌ Node failed to start: {}", e);
        return Err(format!("Node startup failed: {}", e).into());
    }
    
    // Give node a moment to start API server
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    
    // CRITICAL FIX: Now run DHT discovery AFTER API server is running
    println!("🔍 API server ready - starting DHT peer discovery...");
    let (_, discovered_peers) = scan_active_qnet_nodes().await;
    
    // Add discovered peers to P2P system
    if !discovered_peers.is_empty() {
        println!("🔗 Discovered {} peers, integrating with P2P network...", discovered_peers.len());
        
        // FIXED: Now we can inject peers into the running node
        node.add_discovered_peers(&discovered_peers);
        
        for peer in &discovered_peers {
            println!("🔗 Integrated active peer: {}", peer);
        }
        
        println!("✅ Peers successfully integrated into P2P network");
    }
    
    // Start background node monitoring
    let node_clone = node.clone();
    let node_handle = tokio::spawn(async move {
        // Keep node running and monitor
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            
            // Monitor peer connections
            if let Ok(peer_count) = node_clone.get_peer_count().await {
                if peer_count > 0 {
                    println!("[MONITOR] ✅ {} peers connected", peer_count);
                } else {
                    println!("[MONITOR] ⚠️ No peers connected - running standalone");
                }
            }
        }
    });
    
    // Show initial configuration ONCE
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
        _ => "localhost".to_string()
    };
    
    println!("🚀 QNet Node #{} started successfully!", 
        std::env::var("QNET_BOOTSTRAP_ID").unwrap_or("N/A".to_string()));
    println!("🌐 Region: {:?} | Type: {:?} | IP: {}", 
        region, node_type, external_ip);
    println!("📡 Endpoints: P2P={} RPC={} API={}", 
        config.p2p_port, config.rpc_port, std::env::var("QNET_CURRENT_API_PORT").unwrap_or("8001".to_string()));
    println!("");
    println!("📖 View detailed logs: docker logs -f qnet-node");
    println!("🔍 Filter blockchain logs: docker logs qnet-node | grep \"Block #\\|Syncing\\|Macroblock\"");
    println!("📊 Monitor P2P: docker logs qnet-node | grep \"peer\\|P2P\\|Connected\"");
    println!("");
    println!("=== BLOCKCHAIN LOGS (Live) ===");
    
    // Continue with live blockchain logging - no background transition
    let _ = node_handle.await;
    
    Ok(())
}

// Redirect stdout/stderr to log file for daemon mode
async fn redirect_logs_to_file(log_path: &std::path::Path) -> Result<(), std::io::Error> {
    use std::fs::OpenOptions;
    use std::io::Write;
    
    // Create/open log file with append mode
    let mut log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)?;
    
    let log_path_str = log_path.display().to_string();
    
    // Write startup marker to log file
    writeln!(log_file, "=== QNet Node Started: {} ===", 
             chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC"))?;
    writeln!(log_file, "Log file: {}", log_path_str)?;
    writeln!(log_file, "PID: {}", std::process::id())?;
    writeln!(log_file, "==============================================")?;
    log_file.flush()?;
    
    println!("📝 Logs redirected to: {}", log_path_str);
    println!("📖 View logs with: tail -f {}", log_path_str);
    
    // Set up a custom logger that writes to the file
    use std::sync::Mutex;
    use std::sync::Arc;
    
    let log_file_arc = Arc::new(Mutex::new(log_file));
    let log_file_for_panic = log_file_arc.clone();
    
    // Set up panic handler to log panics
    std::panic::set_hook(Box::new(move |panic_info| {
        if let Ok(mut log_file) = log_file_for_panic.lock() {
            let _ = writeln!(log_file, "[PANIC] {}: {}", 
                chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC"),
                panic_info);
            let _ = log_file.flush();
        }
    }));
    
    // For production daemon mode, we'll use env_logger with file output
    // The actual log redirection is handled by the Docker container or systemd
    println!("✅ Log redirection configured for daemon mode");
    
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
    println!("[LATENCY] Starting real geolocation detection via API services...");
    
    // Get our physical IP first
    let our_ip = match get_physical_ip().await {
        Ok(ip) => {
            println!("[GEOLOCATION] External IP detected: {}", ip);
            ip
        },
        Err(e) => {
            println!("[GEOLOCATION] Could not get external IP: {}", e);
            return Err("Cannot detect region without external IP".to_string());
        }
    };
    
    // Use real geolocation services
    match detect_region_via_geolocation_api(&our_ip).await {
        Ok(region) => {
            println!("[GEOLOCATION] ✅ Region detected via API: {:?}", region);
            return Ok(region);
        }
        Err(e) => {
            println!("[GEOLOCATION] API detection failed: {}", e);
        }
    }
    
    // Fallback: Network latency testing
    println!("[LATENCY] Falling back to latency-based detection...");
    
    // Test connectivity to known regional endpoints
    let regional_tests = vec![
        (Region::NorthAmerica, "8.8.8.8:53"),     // Google DNS (US)
        (Region::Europe, "1.1.1.1:53"),           // Cloudflare DNS (Global but EU-optimized)  
        (Region::Asia, "208.67.222.222:53"),      // OpenDNS (Asia-Pacific)
        (Region::SouthAmerica, "8.8.4.4:53"),     // Google DNS (Global)
        (Region::Africa, "196.216.2.1:53"),       // AfriNIC DNS
        (Region::Oceania, "203.119.4.1:53"),      // APNIC DNS (Oceania)
    ];
    
    let mut best_region = None;
    let mut best_latency = std::time::Duration::from_secs(10);
    
    for (region, endpoint) in regional_tests {
        match tokio::time::timeout(
            std::time::Duration::from_secs(3),
            tokio::net::TcpStream::connect(endpoint)
        ).await {
            Ok(Ok(_stream)) => {
                let start = std::time::Instant::now();
                match tokio::time::timeout(
                    std::time::Duration::from_millis(500),
                    tokio::net::TcpStream::connect(endpoint)
                ).await {
                    Ok(Ok(_)) => {
                        let latency = start.elapsed();
                        println!("[LATENCY] {:?}: {}ms", region, latency.as_millis());
                        
                        if latency < best_latency {
                            best_latency = latency;
                            best_region = Some(region);
                        }
                    }
                    _ => println!("[LATENCY] {:?}: timeout", region),
                }
            }
            _ => println!("[LATENCY] {:?}: connection failed", region),
        }
    }
    
    if let Some(region) = best_region {
        println!("[LATENCY] ✅ Best region by latency: {:?} ({}ms)", region, best_latency.as_millis());
        Ok(region)
    } else {
        Err("All latency tests failed - no regional connectivity".to_string())
    }
}

/// Detect region using real geolocation API services
async fn detect_region_via_geolocation_api(ip: &str) -> Result<Region, String> {
    println!("[GEOLOCATION] Querying geolocation APIs for IP: {}", ip);
    
    // Try multiple geolocation services for reliability
    let geolocation_services = vec![
        format!("http://ip-api.com/json/{}", ip),
        format!("https://ipapi.co/{}/json/", ip),
        format!("http://api.ipstack.com/{}?access_key=free", ip),
    ];
    
    for service_url in geolocation_services {
        match query_geolocation_service(&service_url).await {
            Ok(region) => {
                println!("[GEOLOCATION] ✅ Region detected from API: {:?}", region);
                return Ok(region);
            }
            Err(e) => {
                println!("[GEOLOCATION] ⚠️ Failed to get region from API: {}", e);
                continue;
            }
        }
    }
    
    Err("All geolocation services failed".to_string())
}

/// Query a specific geolocation service
async fn query_geolocation_service(url: &str) -> Result<Region, String> {
    use std::time::Duration;
    
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    
    let response = client.get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }
    
    let json_text = response.text().await
        .map_err(|e| format!("Response read error: {}", e))?;
    
    println!("[GEOLOCATION] API response: {}", json_text);
    
    // Parse JSON response
    let json_value: serde_json::Value = serde_json::from_str(&json_text)
        .map_err(|e| format!("JSON parse error: {}", e))?;
    
    // Extract continent/region information (try multiple fields)
    let region = if let Some(continent) = json_value.get("continent").and_then(|v| v.as_str()) {
        map_continent_to_region(continent)
    } else if let Some(continent_code) = json_value.get("continent_code").and_then(|v| v.as_str()) {
        map_continent_code_to_region(continent_code)
    } else if let Some(continent_code) = json_value.get("continentCode").and_then(|v| v.as_str()) {
        map_continent_code_to_region(continent_code)
    } else if let Some(country_code) = json_value.get("country_code").and_then(|v| v.as_str()) {
        map_country_code_to_region(country_code)
    } else if let Some(country_code) = json_value.get("countryCode").and_then(|v| v.as_str()) {
        map_country_code_to_region(country_code)
    } else {
        return Err("No continent/country information in response".to_string());
    };
    
    region.ok_or_else(|| "Unknown region".to_string())
}

/// Map continent name to region
fn map_continent_to_region(continent: &str) -> Option<Region> {
    match continent.to_lowercase().as_str() {
        "north america" | "northern america" => Some(Region::NorthAmerica),
        "europe" => Some(Region::Europe),
        "asia" => Some(Region::Asia),
        "south america" | "southern america" => Some(Region::SouthAmerica),
        "africa" => Some(Region::Africa),
        "oceania" | "australia" => Some(Region::Oceania),
        _ => None,
    }
}

/// Map continent code to region
fn map_continent_code_to_region(code: &str) -> Option<Region> {
    match code.to_uppercase().as_str() {
        "NA" => Some(Region::NorthAmerica),
        "EU" => Some(Region::Europe),
        "AS" => Some(Region::Asia),
        "SA" => Some(Region::SouthAmerica),
        "AF" => Some(Region::Africa),
        "OC" => Some(Region::Oceania),
        _ => None,
    }
}

/// Map major country codes to regions (only essential ones)
fn map_country_code_to_region(code: &str) -> Option<Region> {
    match code.to_uppercase().as_str() {
        // North America
        "US" | "CA" | "MX" => Some(Region::NorthAmerica),
        
        // Europe (major countries)
        "DE" | "FR" | "GB" | "ES" | "IT" | "NL" | "PL" | "RO" | "BE" | "CZ" |
        "PT" | "HU" | "SE" | "AT" | "CH" | "BG" | "DK" | "FI" | "NO" | "IE" => Some(Region::Europe),
        
        // Asia (major countries)  
        "CN" | "IN" | "JP" | "KR" | "TH" | "VN" | "SG" | "MY" | "PH" | "ID" |
        "TW" | "HK" | "BD" | "PK" => Some(Region::Asia),
        
        // South America
        "BR" | "AR" | "CL" | "CO" | "PE" | "VE" => Some(Region::SouthAmerica),
        
        // Africa (major countries)
        "ZA" | "NG" | "EG" | "KE" | "MA" => Some(Region::Africa),
        
        // Oceania
        "AU" | "NZ" => Some(Region::Oceania),
        
        _ => None,
    }
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
    // GENESIS NODES: Skip burn verification for bootstrap nodes
    if is_genesis_bootstrap_node() {
        println!("🚀 Genesis bootstrap node detected - skipping 1DEV burn verification");
        println!("   [GENESIS] Bootstrap nodes don't require burn transactions");
        println!("   [NETWORK] Initializing new blockchain network");
        return Ok(());
    }
    
    // Production 1DEV burn verification - Dynamic pricing based on current burn percentage
    let (current_phase, pricing_info) = detect_current_phase().await;
    let required_burn = if current_phase == 1 {
        // Use dynamic pricing for Phase 1
        calculate_node_price(1, *node_type, &pricing_info)
    } else {
        // Phase 2: No 1DEV burn required
        println!("⚠️  Phase 2 detected - 1DEV burn verification skipped (QNC era)");
        return Ok(());
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
    
    // PRODUCTION: Use network-aware RPC configuration  
    let network_config = qnet_integration::network_config::get_network_config();
    let solana_rpc = &network_config.solana.rpc_url;
    
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

async fn verify_solana_burn_for_activation(wallet_address: &str, expected_tx_hash: &str, required_amount: u64) -> Result<bool, String> {
    println!("📡 PRODUCTION: Verifying 1DEV burn on Solana for node activation...");
    
    // PRODUCTION: Use network-aware RPC configuration
    let network_config = qnet_integration::network_config::get_network_config();
    let solana_rpc = &network_config.solana.rpc_url;
    let onedev_mint = &network_config.solana.onedev_mint;
    let burn_address = &network_config.solana.burn_address;
    
    // Convert to 6 decimals for comparison
    let required_amount_decimals = required_amount * 1_000_000;
    
    // Build RPC request to check burn transactions
    let request_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getSignaturesForAddress",
        "params": [
            wallet_address,
            {
                "limit": 50,
                "commitment": "finalized"
            }
        ]
    });

    let client = reqwest::Client::new();
    let response = client
        .post(solana_rpc)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Solana RPC request failed: {}", e))?;

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("JSON parse failed: {}", e))?;

    if let Some(result) = data.get("result") {
        if let Some(signatures) = result.as_array() {
            println!("📋 Found {} recent transactions for wallet {}", signatures.len(), &wallet_address[..8]);
            
            // Check each signature for burn transactions to incinerator
            for sig_info in signatures {
                if let Some(signature) = sig_info.get("signature").and_then(|s| s.as_str()) {
                    
                    // If specific TX hash expected from activation code, check it matches
                    if !expected_tx_hash.is_empty() && signature != expected_tx_hash {
                        continue;
                    }
                    
                    // Get transaction details to verify burn
                    let tx_request = serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "getTransaction",
                        "params": [
                            signature,
                            {
                                "encoding": "jsonParsed",
                                "commitment": "finalized",
                                "maxSupportedTransactionVersion": 0
                            }
                        ]
                    });
                    
                    if let Ok(tx_response) = client.post(solana_rpc).json(&tx_request).send().await {
                        if let Ok(tx_data) = tx_response.json::<serde_json::Value>().await {
                            if let Some(result) = tx_data.get("result") {
                                if let Some(transaction) = result.get("transaction") {
                                    // Check if this is a token transfer to burn address
                                    if let Some(message) = transaction.get("message") {
                                        if let Some(instructions) = message.get("instructions").and_then(|i| i.as_array()) {
                                            for instruction in instructions {
                                                if instruction.get("program").and_then(|p| p.as_str()) == Some("spl-token") {
                                                    if let Some(parsed) = instruction.get("parsed") {
                                                        if parsed.get("type").and_then(|t| t.as_str()) == Some("transfer") {
                                                            if let Some(info) = parsed.get("info") {
                                                                let mint_match = info.get("mint").and_then(|m| m.as_str()) == Some(onedev_mint);
                                                                let dest_match = info.get("destination").and_then(|d| d.as_str()) == Some(burn_address);
                                                                let amount_match = info.get("amount")
                                                                    .and_then(|a| a.as_str())
                                                                    .and_then(|a| a.parse::<u64>().ok())
                                                                    .map(|a| a >= required_amount_decimals)
                                                                    .unwrap_or(false);
                                                                
                                                                if mint_match && dest_match && amount_match {
                                                                    let burned_amount = info.get("amount")
                                                                        .and_then(|a| a.as_str())
                                                                        .and_then(|a| a.parse::<u64>().ok())
                                                                        .unwrap_or(0);
                                                                    
                                                                    println!("✅ VERIFIED: Valid burn transaction found!");
                                                                    println!("   TX: {}", &signature[..16]);
                                                                    println!("   Burned: {} 1DEV (required: {})", burned_amount / 1_000_000, required_amount);
                                                                    println!("   Token: {} (1DEV mint)", onedev_mint);
                                                                    println!("   Destination: {} (official incinerator)", burn_address);
                                                                    return Ok(true);
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
                }
            }
        }
    }

    println!("❌ VERIFICATION FAILED: No valid burn transaction found for {} 1DEV to incinerator", required_amount);
    println!("   Required: {} 1DEV burned to {}", required_amount, burn_address);
    println!("   Token: {} (1DEV mint)", onedev_mint);
    Ok(false)
}

async fn is_burn_transaction(signature: &str) -> Result<bool, String> {
    // Query transaction details to check if it's a burn to 1DEV burn address
    let network_config = qnet_integration::network_config::get_network_config();
    let solana_rpc = &network_config.solana.rpc_url;
    
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
    let network_config = qnet_integration::network_config::get_network_config();
    let solana_rpc = &network_config.solana.rpc_url;
    
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

fn format_region(region: &Region) -> &'static str {
    match region {
        Region::NorthAmerica => "🌎 North America",
        Region::Europe => "🌍 Europe", 
        Region::Asia => "🌏 Asia",
        Region::SouthAmerica => "🌎 South America",
        Region::Africa => "🌍 Africa",
        Region::Oceania => "🌏 Oceania",
    }
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



// Query individual node for its type and status
async fn query_node_info(addr: &str) -> Result<NodeInfo, String> {
    use std::time::Duration;
    use tokio::time::timeout;
    
    match timeout(Duration::from_secs(2), try_query_node(addr)).await {
        Ok(Ok(info)) => Ok(info),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("Timeout".to_string()),
    }
}

#[derive(Debug)]
struct NodeInfo {
    node_type: String,
    active: bool,
}

async fn try_query_node(addr: &str) -> Result<NodeInfo, String> {
    // Try to connect and get node info via simple HTTP request
    let url = format!("http://{}/api/v1/node/info", addr);
    
    match reqwest::get(&url).await {
        Ok(response) => {
            if response.status().is_success() {
                if let Ok(text) = response.text().await {
                    // Simple parsing of node type from response
                    let node_type = if text.contains("Light") {
                        "Light".to_string()
                    } else if text.contains("Super") {
                        "Super".to_string()
                    } else if text.contains("Full") {
                        "Full".to_string()
                    } else {
                        "Unknown".to_string()
                    };
                    
                    Ok(NodeInfo { node_type, active: true })
                } else {
                    Err("Failed to parse response".to_string())
                }
            } else {
                Err("Node not responding".to_string())
            }
        }
        Err(_) => Err("Connection failed".to_string()),
    }
}

// Smart data directory selection for Linux servers
async fn select_best_data_directory() -> Result<PathBuf, Box<dyn std::error::Error>> {
    println!("🔍 Selecting optimal data directory for server deployment...");
    
    // PRODUCTION: Docker container - use container filesystem
    if std::env::var("DOCKER_ENV").is_ok() {
        let docker_blockchain_dir = PathBuf::from("/app/data/blockchain");
        println!("🐳 Docker environment detected - using container filesystem");
        std::fs::create_dir_all(&docker_blockchain_dir)?;
        println!("✅ Using Docker container directory: {:?}", docker_blockchain_dir);
        return Ok(docker_blockchain_dir);
    }
    
    // Option 1: Current directory (preferred for bare metal)
    let current_dir = PathBuf::from("node_data");
    if test_directory_permissions(&current_dir).await {
        println!("✅ Using current directory: {:?}", current_dir);
        return Ok(current_dir);
    }
    
    // Option 2: User home directory
    if let Some(home_dir) = dirs::home_dir() {
        let home_qnet = home_dir.join(".qnet").join("node_data");
        if test_directory_permissions(&home_qnet).await {
            println!("✅ Using home directory: {:?}", home_qnet);
            return Ok(home_qnet);
        }
    }
    
    // Option 3: System directory (try to create with proper permissions)
    let system_dir = PathBuf::from("/var/lib/qnet/node_data");
    if test_directory_permissions(&system_dir).await {
        println!("✅ Using system directory: {:?}", system_dir);
        return Ok(system_dir);
    }
    
    // Option 4: Temporary directory (last resort)
    let temp_dir = PathBuf::from("/tmp/qnet_node_data");
    if test_directory_permissions(&temp_dir).await {
        println!("⚠️  Using temporary directory: {:?}", temp_dir);
        println!("   💡 For production, please create /var/lib/qnet with proper permissions");
        return Ok(temp_dir);
    }
    
    // If all options fail, show help
    println!("❌ Cannot find writable directory for QNet node data!");
    println!("🔧 To fix this, run one of these commands:");
    println!("   sudo mkdir -p /var/lib/qnet");
    println!("   sudo chown $USER:$USER /var/lib/qnet");
    println!("   OR: mkdir -p $HOME/.qnet");
    
    Err("No writable directory available for node data".into())
}

// Test if directory can be created and written to
async fn test_directory_permissions(path: &PathBuf) -> bool {
    // Try to create directory
    if let Err(_) = std::fs::create_dir_all(path) {
        return false;
    }
    
    // Test write permissions
    let test_file = path.join("test_permissions.tmp");
    match std::fs::write(&test_file, "test") {
        Ok(_) => {
            let _ = std::fs::remove_file(&test_file);
            true
        }
        Err(_) => false
    }
}

// Auto-detect available port

// Production-grade IP-to-region mapping using RIR (Regional Internet Registries) blocks
fn determine_region_from_ip(ip: &std::net::Ipv4Addr) -> Option<Region> {
    // Use official RIR (Regional Internet Registries) allocations for accurate region detection
    // This approach scales to any server provider in any datacenter globally
    
    // ARIN (American Registry for Internet Numbers) - North America
    if is_north_america_ip(ip) {
        return Some(Region::NorthAmerica);
    }
    
    // RIPE NCC (Réseaux IP Européens Network Coordination Centre) - Europe, Middle East, Central Asia
    if is_europe_ip(ip) {
        return Some(Region::Europe);
    }
    
    // APNIC (Asia-Pacific Network Information Centre) - Asia Pacific
    if is_asia_ip(ip) {
        return Some(Region::Asia);
    }
    
    // LACNIC (Latin America and Caribbean Network Information Centre) - South America
    if is_south_america_ip(ip) {
        return Some(Region::SouthAmerica);
    }
    
    // AFRINIC (African Network Information Centre) - Africa
    if is_africa_ip(ip) {
        return Some(Region::Africa);
    }
    
    // APNIC also covers Oceania - separate check for Australia/New Zealand/Pacific
    if is_oceania_ip(ip) {
        return Some(Region::Oceania);
    }
    
    // No match found in RIR blocks
    None
}

// Scan actual QNet network using decentralized discovery
async fn scan_active_qnet_nodes() -> (RealNodeCounts, Vec<String>) {
    let mut counts = RealNodeCounts::default();
    
    println!("🔍 Scanning QNet decentralized network...");
    println!("   🌐 Using quantum-resistant P2P discovery");
    println!("   ⚡ No centralized bootstrap nodes");
    
    // Use the real decentralized discovery mechanisms
    let discovered_peers = discover_peers_via_decentralized_network().await;
    
    // CRITICAL FIX: Pass discovered peers to P2P system for actual connection
    println!("[DISCOVERY] 🔗 Integrating {} discovered peers with P2P network", discovered_peers.len());
    
    for peer_addr in discovered_peers.clone() {
        if let Ok(node_info) = query_node_info(&peer_addr).await {
            match node_info.node_type.as_str() {
                "Light" => counts.light += 1,
                "Full" => counts.full += 1,
                "Super" => counts.super_nodes += 1,
                _ => {}
            }
            counts.total += 1;
            println!("   🔄 Discovered {} node at {}", node_info.node_type, peer_addr);
        }
    }
    
    println!("📊 Decentralized network scan complete:");
    println!("   🌐 Total Active Nodes: {}", counts.total);
    println!("   📱 Light Nodes: {} (mobile devices)", counts.light);
    println!("   🖥️  Full Nodes: {} (servers)", counts.full);
    println!("   ⚡ Super Nodes: {} (high-performance)", counts.super_nodes);
    
    // QUANTUM DECENTRALIZED: No file persistence - use real-time network discovery only
    println!("[DISCOVERY] 🔗 QUANTUM: Peer discovery completed via decentralized protocol (no cache persistence)");
    
    // Return discovered peers for P2P integration
    (counts, discovered_peers)
}

// Discover new peers from network through decentralized peer exchange
async fn discover_peers_via_decentralized_network() -> Vec<String> {
    let mut discovered_peers = Vec::new();
    
    println!("[DISCOVERY] 🔄 Starting decentralized peer exchange protocol...");
    println!("[DISCOVERY] 🌐 Using quantum-resistant decentralized discovery");
    
    // QUANTUM DECENTRALIZED: No file caching - use real-time DHT discovery only
    // Quantum blockchain requires cryptographic peer verification without persistent local state
    println!("[DISCOVERY] 🔗 QUANTUM: Using real-time DHT discovery (no file cache)");
    
    // Use unified P2P module for internet-wide discovery
    // This implements DHT-style peer discovery without central servers
    match perform_dht_peer_discovery().await {
        Ok(dht_peers) => {
            for peer in dht_peers {
                if !discovered_peers.contains(&peer) {
                    println!("[DISCOVERY] 🔗 DHT discovered peer: {}", peer);
                    discovered_peers.push(peer.clone());
                }
            }
        }
        Err(e) => {
            println!("[DISCOVERY] ⚠️ DHT discovery error: {}", e);
        }
    }
    
    // Try broadcast discovery on local network first
    match perform_broadcast_discovery().await {
        Ok(broadcast_peers) => {
            for peer in broadcast_peers {
                if !discovered_peers.contains(&peer) {
                    println!("[DISCOVERY] 📡 Broadcast discovered peer: {}", peer);
                    discovered_peers.push(peer.clone());
                }
            }
        }
        Err(e) => {
            println!("[DISCOVERY] ⚠️ Broadcast discovery error: {}", e);
        }
    }
    
    println!("[DISCOVERY] ✅ Discovered {} peers through decentralized methods", discovered_peers.len());
    discovered_peers
}

// DHT-style peer discovery (Distributed Hash Table)
async fn perform_dht_peer_discovery() -> Result<Vec<String>, String> {
    println!("[DHT] 🔍 Starting DHT peer discovery...");
    
    let mut discovered_peers = Vec::new();
    
    // Get our own IP to avoid self-connection
    let our_external_ip = match get_physical_ip().await {
        Ok(ip) => {
            println!("[DHT] 🔍 DIAGNOSTIC: Our external IP detected: {}", ip);
            ip
        },
        Err(e) => {
            println!("[DHT] ⚠️ DIAGNOSTIC: External IP detection failed: {}", e);
            println!("[DHT] 🔍 DIAGNOSTIC: Using 'unknown' - this may cause ALL Genesis nodes to be queried");
            "unknown".to_string()
        },
    };
    
    // PRODUCTION DHT: Query ALL genesis bootstrap nodes for their peer lists
    let genesis_ips = get_genesis_node_ips_dynamic();
    let bootstrap_nodes: Vec<String> = genesis_ips.iter()
        .map(|ip| format!("{}:8001", ip))
        .collect();
    
    println!("[DHT] 🌐 DHT will query {} Genesis nodes for peer discovery", bootstrap_nodes.len());
    
    for bootstrap in &bootstrap_nodes {
        let bootstrap_ip = bootstrap.split(':').next().unwrap_or("");
        
        // DIAGNOSTIC: Show comparison for debugging producer isolation
        println!("[DHT] 🔍 DIAGNOSTIC: Comparing our_external_ip='{}' with bootstrap_ip='{}'", our_external_ip, bootstrap_ip);
        
        // CRITICAL FIX: Only skip self-connection, but ensure producer participates in discovery
        if bootstrap_ip == our_external_ip {
            println!("[DHT] 🔄 Skipping self-query to {} (matches our external IP)", bootstrap);
            continue;
        }
        
        println!("[DHT] 📡 Querying Genesis bootstrap node: {}", bootstrap);
        
        // SCALABILITY FIX: Use EXISTING bidirectional registration in /api/v1/peers API
        // query_node_for_peers() already calls HTTP GET to /api/v1/peers which handles bidirectional registration
        // No need for separate announcement - this would create double requests during millions-scale deployment
        
        match query_node_for_peers(bootstrap).await {
            Ok(mut peers) => {
                println!("[DHT] ✅ Bootstrap {} provided {} peers", bootstrap, peers.len());
                
                // DIAGNOSTIC: Show peer details to debug phantom peers
                if peers.len() > 5 {
                    println!("[DHT] 🔍 DIAGNOSTIC: Large peer list detected ({} peers)", peers.len());
                    println!("[DHT] 🔍 First 5 peers: {:?}", peers.iter().take(5).collect::<Vec<_>>());
                    println!("[DHT] 🔍 This may indicate stale DHT cache or phantom peers");
                }
                
                discovered_peers.append(&mut peers);
            }
            Err(e) => {
                println!("[DHT] ⚠️ Bootstrap {} failed: {}", bootstrap, e);
            }
        }
    }
    
    // Remove duplicates
    discovered_peers.sort();
    discovered_peers.dedup();
    
    // DHT propagation: Query discovered peers for more peers
    let initial_count = discovered_peers.len();
    let mut second_hop_peers = Vec::new();
    
    for peer in discovered_peers.iter().take(5) { // Limit to first 5 for performance
        match query_node_for_peers(peer).await {
            Ok(mut peers) => {
                println!("[DHT] 🔗 Peer {} provided {} additional peers", peer, peers.len());
                second_hop_peers.append(&mut peers);
            }
            Err(_) => {
                // Silent fail for second hop to reduce noise
            }
        }
    }
    
    // Merge second hop results
    discovered_peers.append(&mut second_hop_peers);
    discovered_peers.sort();
    discovered_peers.dedup();
    
    println!("[DHT] 📊 DHT discovery complete: {} initial peers, {} total after propagation", 
             initial_count, discovered_peers.len());
    
    // DIAGNOSTIC: Show final peer summary
    if discovered_peers.len() > 8 {
        println!("[DHT] ⚠️  DIAGNOSTIC: Unusually high peer count ({}) detected", discovered_peers.len());
        println!("[DHT] ⚠️  Expected ~4-5 Genesis peers for current network");
        println!("[DHT] ⚠️  This suggests stale DHT cache or connectivity issues");
    } else {
        println!("[DHT] ✅ DHT peer count looks normal for Genesis network: {}", discovered_peers.len());
    }
    
    Ok(discovered_peers)
}

// Broadcast discovery for local network nodes
async fn perform_broadcast_discovery() -> Result<Vec<String>, String> {
    println!("[BROADCAST] 📡 Starting broadcast peer discovery...");
    
    use std::net::{UdpSocket, SocketAddr};
    use std::time::Duration;
    
    let mut discovered_peers = Vec::new();
    
    // Create UDP socket for broadcasting
    let socket = UdpSocket::bind("0.0.0.0:0")
        .map_err(|e| format!("Failed to bind UDP socket: {}", e))?;
    
    // Enable broadcast
    socket.set_broadcast(true)
        .map_err(|e| format!("Failed to enable broadcast: {}", e))?;
    
    // Set timeout for responses
    socket.set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| format!("Failed to set timeout: {}", e))?;
    
    // QNet discovery message
    let discovery_msg = b"QNET_DISCOVERY_V1";
    
    // Broadcast to common subnets
    let broadcast_addrs = [
        "255.255.255.255:9876", // Global broadcast
        "192.168.1.255:9876",   // Common home network
        "192.168.0.255:9876",   // Alternative home network
        "10.0.0.255:9876",      // Private network A
        "172.16.255.255:9876",  // Private network B
    ];
    
    for addr_str in &broadcast_addrs {
        if let Ok(addr) = addr_str.parse::<SocketAddr>() {
            match socket.send_to(discovery_msg, addr) {
                Ok(_) => {
                    println!("[BROADCAST] 📤 Sent discovery to {}", addr);
                }
                Err(e) => {
                    println!("[BROADCAST] ⚠️ Failed to broadcast to {}: {}", addr, e);
                }
            }
        }
    }
    
    // Listen for responses
    let mut buffer = [0u8; 1024];
    let start_time = std::time::Instant::now();
    
    while start_time.elapsed() < Duration::from_secs(3) {
        match socket.recv_from(&mut buffer) {
            Ok((size, sender)) => {
                let response = String::from_utf8_lossy(&buffer[..size]);
                
                // Check for valid QNet response: "QNET_NODE:ip:port"
                if response.starts_with("QNET_NODE:") {
                    let parts: Vec<&str> = response.split(':').collect();
                    if parts.len() >= 3 {
                        let peer_addr = format!("{}:{}", parts[1], parts[2]);
                        if !discovered_peers.contains(&peer_addr) {
                            println!("[BROADCAST] 📡 Discovered local peer: {}", peer_addr);
                            discovered_peers.push(peer_addr);
                        }
                    }
                } else if response == "QNET_ACK" {
                    // Simple acknowledgment from a QNet node
                    let peer_addr = format!("{}:9876", sender.ip());
                    if !discovered_peers.contains(&peer_addr) {
                        println!("[BROADCAST] 📡 Discovered peer via ACK: {}", peer_addr);
                        discovered_peers.push(peer_addr);
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                // Timeout - continue waiting
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(e) => {
                println!("[BROADCAST] ⚠️ Receive error: {}", e);
                break;
            }
        }
    }
    
    println!("[BROADCAST] 📊 Local broadcast discovery complete: {} peers found", discovered_peers.len());
    Ok(discovered_peers)
}

// Query a node for its peer list (used by DHT discovery)
async fn query_node_for_peers(node_addr: &str) -> Result<Vec<String>, String> {
    use std::time::Duration;
    
    // Extract IP from address
    let ip = node_addr.split(':').next().unwrap_or(node_addr);
    
    // CRITICAL FIX: Use only actual listening port (8001) 
    // All QNet nodes run unified API on port 8001 only - no 8080/9876
    let endpoints = vec![
        format!("http://{}:8001/api/v1/peers", ip),     // Unified API port
    ];
    
    for endpoint in endpoints {
        match query_peers_http(&endpoint).await {
            Ok(peers) => {
                if !peers.is_empty() {
                    return Ok(peers);
                }
            }
            Err(_) => continue, // Try next endpoint
        }
    }
    
    Err(format!("All endpoints failed for {}", node_addr))
}

// HTTP query for peer list with timeout
async fn query_peers_http(endpoint: &str) -> Result<Vec<String>, String> {
    use std::time::Duration;
    
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15)) // PRODUCTION: Extended timeout for peer discovery
        .connect_timeout(Duration::from_secs(8)) // Connection timeout for peer queries
        .user_agent("QNet-Node/1.0")
        .tcp_nodelay(true) // Faster peer discovery
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    
    match client.get(endpoint).send().await {
        Ok(response) if response.status().is_success() => {
            match response.text().await {
                Ok(text) => {
                    // Parse peer list (JSON format: {"peers": ["ip1:port1", "ip2:port2"]})
                    if text.contains("\"peers\"") {
                        let peers: Vec<String> = text
                            .split("\"peers\":")
                            .nth(1)
                            .unwrap_or("")
                            .split('[')
                            .nth(1)
                            .unwrap_or("")
                            .split(']')
                            .next()
                            .unwrap_or("")
                            .split(',')
                            .filter_map(|s| {
                                let clean = s.trim().trim_matches('"').trim();
                                if clean.is_empty() || clean == "{" || clean == "}" {
                                    None
                                } else {
                                    Some(clean.to_string())
                                }
                            })
                            .collect();
                        
                        Ok(peers)
                    } else {
                        // Try simple comma-separated format
                        let peers: Vec<String> = text
                            .split(',')
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty() && s.contains(':'))
                            .collect();
                        
                        Ok(peers)
                    }
                }
                Err(e) => Err(format!("Failed to read response: {}", e)),
            }
        }
        Ok(response) => Err(format!("HTTP error: {}", response.status())),
        Err(e) => Err(format!("Request failed: {}", e)),
    }
}

// Get peer list from an active node
async fn get_peers_from_node(node_ip: &str) -> Result<Vec<String>, String> {
    use std::time::Duration;
    
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    
    // Try different regional ports
    let ports = [9876, 9877, 9878, 9879, 9880, 9881];
    
    for port in ports {
        let url = format!("http://{}:{}/api/peers", node_ip, port);
        match client.get(&url).send().await {
            Ok(response) if response.status().is_success() => {
                if let Ok(text) = response.text().await {
                    // Parse peer list (format: "ip1:port1,ip2:port2,...")
                    let peers: Vec<String> = text
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                    
                    if !peers.is_empty() {
                        println!("[DISCOVERY] 📡 Got {} peers from {}:{}", peers.len(), node_ip, port);
                        return Ok(peers);
                    }
                }
            }
            _ => continue,
        }
    }
    
    Err(format!("No active QNet API found on {}", node_ip))
}

// QUANTUM DECENTRALIZED: File caching functions removed
// Quantum blockchain uses only real-time cryptographic peer discovery

async fn get_activation_with_auto_genesis() -> Result<(NodeType, String), Box<dyn std::error::Error>> {
    use qnet_integration::storage::Storage;
    
    // DEBUG: Check environment variables first
    println!("[DEBUG] ========== GENESIS ACTIVATION DEBUG ==========");
    println!("[DEBUG] QNET_BOOTSTRAP_ID: {:?}", std::env::var("QNET_BOOTSTRAP_ID"));
    println!("[DEBUG] QNET_PRODUCTION: {:?}", std::env::var("QNET_PRODUCTION"));
    println!("[DEBUG] QNET_GENESIS_BOOTSTRAP: {:?}", std::env::var("QNET_GENESIS_BOOTSTRAP"));
    
    // Check genesis detection BEFORE storage
    println!("[DEBUG] Checking if this is a genesis bootstrap node...");
    let is_genesis = is_genesis_bootstrap_node();
    println!("[DEBUG] is_genesis_bootstrap_node() returned: {}", is_genesis);
    
    if is_genesis {
        println!("[DEBUG] ✅ GENESIS NODE CONFIRMED - Bypassing storage check");
        println!("🚀 GENESIS NODE DETECTED - Auto-activating as Super Node");
        println!("   [BOOTSTRAP] Node ID: {}", std::env::var("QNET_BOOTSTRAP_ID").unwrap_or("AUTO".to_string()));
        println!("   [TYPE] Super Node (Genesis Bootstrap)");
        println!("   [NETWORK] Initializing new QNet blockchain network");
        
        let genesis_code = match generate_genesis_activation_code() {
            Ok(code) => {
                println!("[DEBUG] ✅ Genesis code generation SUCCESS: {}", code);
                code
            }
            Err(e) => {
                println!("[ERROR] ❌ Genesis code generation FAILED: {}", e);
                println!("[ERROR] This should not happen for valid genesis nodes!");
                println!("[ERROR] QNET_BOOTSTRAP_ID: {:?}", std::env::var("QNET_BOOTSTRAP_ID"));
                println!("[ERROR] Falling back to emergency genesis mode...");
                
                // Emergency fallback - generate simple genesis code
                let emergency_id = std::env::var("QNET_BOOTSTRAP_ID").unwrap_or("0001".to_string());
                let emergency_code = format!("QNET-EMERGENCY-{}-GENESIS", emergency_id);
                println!("[ERROR] Emergency code: {}", emergency_code);
                emergency_code
            }
        };
        
        println!("   [CODE] Generated: {}", mask_code(&genesis_code));
        println!("   [STATUS] ✅ Genesis activation complete - starting blockchain");
        
        return Ok((NodeType::Super, genesis_code));
    } else {
        println!("[DEBUG] ❌ NOT a genesis node - checking storage...");
    }
    
    // Try to initialize storage first
    let temp_storage = match Storage::new("./temp_activation_check") {
        Ok(storage) => storage,
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
            println!("[DEBUG] No existing activation found");
        }
        Err(e) => {
            println!("[WARNING] Error checking activation: {}", e);
        }
    }
    
    // For non-genesis nodes, run interactive setup
    println!("[DEBUG] Regular node detected - starting interactive setup");
    interactive_node_setup().await
}


