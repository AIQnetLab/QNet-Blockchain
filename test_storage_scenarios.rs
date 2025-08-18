//! Test realistic storage scenarios for QNet nodes

fn main() {
    println!("🧪 QNet Storage Scenarios Analysis");
    
    // Scenario 1: Small testnet (20 nodes)
    test_scenario(20, 300, "Small Testnet");
    
    // Scenario 2: Growing mainnet (100 nodes)  
    test_scenario(100, 400, "Growing Mainnet");
    
    // Scenario 3: Large network (1000 nodes)
    test_scenario(1000, 500, "Large Network");
    
    // Scenario 4: Very large network (5000 nodes)
    test_scenario(5000, 500, "Very Large Network");
}

fn test_scenario(node_count: usize, storage_gb_per_node: u64, scenario_name: &str) {
    println!("\n📊 === {} ({} nodes, {} GB each) ===", scenario_name, node_count, storage_gb_per_node);
    
    // Calculate network composition
    let genesis_nodes = 5;
    let super_nodes = std::cmp::min(node_count / 4, node_count - genesis_nodes);
    let full_nodes = node_count - genesis_nodes - super_nodes;
    
    // Calculate adaptive quotas
    let (full_quota, super_quota, min_replicas) = match node_count {
        0..=15 => (8, 15, 1),   // Emergency
        16..=50 => (6, 12, 2),  // Small
        51..=200 => (4, 10, 3), // Medium  
        _ => (3, 8, 3),         // Large
    };
    
    // Storage calculations
    let total_network_storage = node_count as u64 * storage_gb_per_node;
    let archive_capacity = (genesis_nodes + super_nodes) * super_quota + full_nodes * full_quota;
    
    // Estimate data growth (conservative: 1 GB per day per network)
    let daily_growth_gb = std::cmp::max(1, node_count / 100); // Scale with network
    let monthly_growth_gb = daily_growth_gb * 30;
    let yearly_growth_gb = daily_growth_gb * 365;
    
    println!("🏗️ Network composition:");
    println!("   Genesis: {}, Super: {}, Full: {}", genesis_nodes, super_nodes, full_nodes);
    
    println!("📦 Archive system:");
    println!("   Archive capacity: {} chunks total", archive_capacity);
    println!("   Replication: {} copies minimum", min_replicas);
    
    println!("💾 Storage analysis:");
    println!("   Total network storage: {} TB", total_network_storage);
    println!("   Estimated growth: {} GB/day, {} GB/month, {} GB/year", 
            daily_growth_gb, monthly_growth_gb, yearly_growth_gb);
    
    // Time until storage exhaustion per node
    let months_until_full = if monthly_growth_gb > 0 {
        storage_gb_per_node / monthly_growth_gb as u64
    } else {
        999
    };
    
    println!("⏱️ Sustainability:");
    if months_until_full > 24 {
        println!("   ✅ EXCELLENT: Node storage lasts {}+ months", months_until_full);
    } else if months_until_full > 12 {
        println!("   ✅ GOOD: Node storage lasts {} months", months_until_full);
    } else if months_until_full > 6 {
        println!("   ⚠️ ADEQUATE: Node storage lasts {} months", months_until_full);
    } else {
        println!("   ❌ INSUFFICIENT: Node storage lasts only {} months", months_until_full);
    }
    
    // Network resilience
    let nodes_that_can_fail = node_count / 3; // Assume 1/3 can fail safely
    println!("🛡️ Fault tolerance: Network can lose up to {} nodes safely", nodes_that_can_fail);
    
    // Emergency recommendations
    if months_until_full < 12 {
        println!("💡 Recommendations:");
        println!("   - Increase storage to {} GB per node", storage_gb_per_node * 2);
        println!("   - Enable more aggressive cleanup (keep 24h instead of 7 days)");
        println!("   - Add more archive nodes to distribute load");
    }
}
