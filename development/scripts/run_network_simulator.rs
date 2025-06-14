//! Run network simulator for QNet testing

use qnet_integration::network_simulator::NetworkSimulator;
use qnet_integration::regional_p2p::Region;
use std::time::Duration;

fn main() {
    println!("=== QNet Network Simulator ===\n");
    
    // Create simulator
    let mut sim = NetworkSimulator::new();
    
    // Test 1: Standard network (6 Super, 150 Full, 6000 Light)
    println!("Test 1: Standard network configuration");
    sim.create_network(6, 150, 6000, 0);
    sim.establish_connections();
    sim.run_simulation(Duration::from_secs(30));
    
    // Test 2: Light node surge
    println!("\nTest 2: Light node surge (adding 10,000 more)");
    sim.test_light_node_surge(10000);
    sim.run_simulation(Duration::from_secs(20));
    
    // Test 3: Region failure
    println!("\nTest 3: Complete Europe region failure");
    sim.test_region_failure(Region::Europe);
    sim.run_simulation(Duration::from_secs(20));
    
    // Test 4: Multiple attacks
    println!("\nTest 4: Security testing with malicious nodes");
    let mut sim2 = NetworkSimulator::new();
    sim2.create_network(6, 150, 1000, 10); // 10 malicious nodes
    sim2.establish_connections();
    sim2.run_simulation(Duration::from_secs(30));
    
    println!("\n=== Simulation Complete ===");
} 