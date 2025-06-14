//! Automatic P2P mode selection based on network conditions
//! Decentralized system without administrators

use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::time::sleep;
use serde::{Deserialize, Serialize};

/// Network state metrics for automatic P2P selection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkMetrics {
    /// Total number of active peers in the network
    pub total_peers: usize,
    
    /// Geographical distribution of nodes by regions
    pub regional_distribution: HashMap<String, usize>,
    
    /// Average latency between nodes (ms)
    pub average_latency: f64,
    
    /// Percentage of unstable connections (disconnections per hour)
    pub connection_instability: f64,
    
    /// Current network load (TPS)
    pub current_tps: f64,
    
    /// Type of prevailing traffic
    pub traffic_type: TrafficType,
    
    /// Last update time of metrics
    pub last_updated: u64,
}

/// Network traffic types
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TrafficType {
    /// DeFi and gaming applications (speed is needed)
    HighFrequency,
    /// Standard transactions
    Standard,
    /// Banking and critical operations (reliability is needed)
    Critical,
}

/// Recommended P2P mode
#[derive(Debug, Clone, PartialEq)]
pub enum RecommendedP2PMode {
    /// Simple P2P for maximum performance
    Simple {
        reason: String,
        confidence: f64,
    },
    /// Regional P2P for geographical distribution
    Regional {
        reason: String,
        confidence: f64,
    },
    /// Dynamic switching based on load
    Dynamic {
        primary: Box<RecommendedP2PMode>,
        fallback: Box<RecommendedP2PMode>,
        switch_threshold: f64,
    },
}

/// Automatic P2P selector
pub struct AutoP2PSelector {
    /// Current network metrics
    current_metrics: NetworkMetrics,
    
    /// Metrics history for trend analysis
    metrics_history: Vec<(u64, NetworkMetrics)>,
    
    /// Current active P2P mode
    current_mode: RecommendedP2PMode,
    
    /// Last mode switch time
    last_mode_switch: Instant,
    
    /// Minimum interval between switches (stability)
    switch_cooldown: Duration,
}

impl AutoP2PSelector {
    /// Creates a new automatic P2P selector
    pub fn new() -> Self {
        let initial_metrics = NetworkMetrics {
            total_peers: 0,
            regional_distribution: HashMap::new(),
            average_latency: 0.0,
            connection_instability: 0.0,
            current_tps: 0.0,
            traffic_type: TrafficType::Standard,
            last_updated: chrono::Utc::now().timestamp() as u64,
        };

        let initial_mode = RecommendedP2PMode::Simple {
            reason: "Initial startup - default to Simple P2P".to_string(),
            confidence: 0.5,
        };

        Self {
            current_metrics: initial_metrics,
            metrics_history: Vec::new(),
            current_mode: initial_mode,
            last_mode_switch: Instant::now(),
            switch_cooldown: Duration::from_secs(300), // 5 minutes between switches
        }
    }

    /// Updates network metrics and recalculates the optimal P2P mode
    pub async fn update_metrics(&mut self, new_metrics: NetworkMetrics) -> Option<RecommendedP2PMode> {
        // Saves previous metrics to history
        let timestamp = chrono::Utc::now().timestamp() as u64;
        self.metrics_history.push((timestamp, self.current_metrics.clone()));
        
        // Limits history to 24 hours
        let cutoff_time = timestamp - 86400; // 24 hours
        self.metrics_history.retain(|(t, _)| *t > cutoff_time);
        
        // Updates current metrics
        self.current_metrics = new_metrics;
        
        // Analyzes and recommends P2P mode
        let recommended_mode = self.analyze_and_recommend().await;
        
        // Checks if mode needs to be switched
        if self.should_switch_mode(&recommended_mode) {
            println!("[AutoP2P] 🔄 Switching P2P mode: {:?}", recommended_mode);
            self.current_mode = recommended_mode.clone();
            self.last_mode_switch = Instant::now();
            Some(recommended_mode)
        } else {
            None
        }
    }

    /// Analyzes network conditions and recommends the optimal P2P mode
    async fn analyze_and_recommend(&self) -> RecommendedP2PMode {
        let metrics = &self.current_metrics;
        
        // Counters for decision making
        let mut simple_score = 0.0;
        let mut regional_score = 0.0;
        let mut reasons = Vec::new();

        // 1. Peers analysis
        if metrics.total_peers < 100 {
            simple_score += 3.0;
            reasons.push("Low peer count (<100) - Simple P2P is more efficient".to_string());
        } else if metrics.total_peers > 1000 {
            regional_score += 2.0;
            reasons.push("High peer count (>1000) - Regional P2P for scaling".to_string());
        }

        // 2. Geographical distribution analysis
        let active_regions = metrics.regional_distribution.len();
        if active_regions >= 3 {
            regional_score += 4.0;
            reasons.push(format!("Geographical distribution ({} regions) - Regional P2P for optimizing latency", active_regions));
        } else if active_regions <= 1 {
            simple_score += 2.0;
            reasons.push("Nodes in one region - Simple P2P is sufficient".to_string());
        }

        // 3. Latency analysis
        if metrics.average_latency > 200.0 {
            regional_score += 3.0;
            reasons.push(format!("High latency ({:.1}ms) - Regional P2P with geographic routing", metrics.average_latency));
        } else if metrics.average_latency < 50.0 {
            simple_score += 2.0;
            reasons.push(format!("Low latency ({:.1}ms) - Simple P2P is optimal", metrics.average_latency));
        }

        // 4. Connection stability analysis
        if metrics.connection_instability > 0.1 {
            regional_score += 3.0;
            reasons.push(format!("Unstable connections ({:.1}%) - Regional P2P with failover", metrics.connection_instability * 100.0));
        } else if metrics.connection_instability < 0.02 {
            simple_score += 1.0;
            reasons.push("Stable connections - Simple P2P works reliably".to_string());
        }

        // 5. Load and traffic type analysis
        match metrics.traffic_type {
            TrafficType::HighFrequency => {
                simple_score += 4.0;
                reasons.push("High-frequency traffic (DeFi/Gaming) - Simple P2P for maximum speed".to_string());
            }
            TrafficType::Critical => {
                regional_score += 4.0;
                reasons.push("Critical traffic (Banking) - Regional P2P for disaster recovery".to_string());
            }
            TrafficType::Standard => {
                // Neutral
            }
        }

        // 6. Current TPS analysis
        if metrics.current_tps > 10000.0 {
            simple_score += 2.0;
            reasons.push(format!("High TPS ({:.0}) - Simple P2P for performance", metrics.current_tps));
        }

        // Determines recommendation based on scores
        let total_score = simple_score + regional_score;
        let confidence = if total_score > 0.0 {
            (simple_score.max(regional_score) / total_score).min(1.0)
        } else {
            0.5
        };

        if simple_score > regional_score {
            RecommendedP2PMode::Simple {
                reason: reasons.join("; "),
                confidence,
            }
        } else if regional_score > simple_score {
            RecommendedP2PMode::Regional {
                reason: reasons.join("; "),
                confidence,
            }
        } else {
            // When scores are equal, create a dynamic mode
            RecommendedP2PMode::Dynamic {
                primary: Box::new(RecommendedP2PMode::Simple {
                    reason: "Primary mode for standard operations".to_string(),
                    confidence: 0.6,
                }),
                fallback: Box::new(RecommendedP2PMode::Regional {
                    reason: "Fallback mode for disaster recovery".to_string(),
                    confidence: 0.6,
                }),
                switch_threshold: 0.8,
            }
        }
    }

    /// Checks if mode needs to be switched
    fn should_switch_mode(&self, recommended: &RecommendedP2PMode) -> bool {
        // Checks cooldown
        if self.last_mode_switch.elapsed() < self.switch_cooldown {
            return false;
        }

        // Checks if recommendation differs from current mode
        match (&self.current_mode, recommended) {
            (RecommendedP2PMode::Simple { .. }, RecommendedP2PMode::Simple { .. }) => false,
            (RecommendedP2PMode::Regional { .. }, RecommendedP2PMode::Regional { .. }) => false,
            (RecommendedP2PMode::Dynamic { .. }, RecommendedP2PMode::Dynamic { .. }) => false,
            _ => {
                // Checks confidence level in recommendation
                match recommended {
                    RecommendedP2PMode::Simple { confidence, .. } |
                    RecommendedP2PMode::Regional { confidence, .. } => *confidence > 0.7,
                    RecommendedP2PMode::Dynamic { .. } => true,
                }
            }
        }
    }

    /// Gets current network metrics
    pub fn get_current_metrics(&self) -> &NetworkMetrics {
        &self.current_metrics
    }

    /// Gets current active P2P mode
    pub fn get_current_mode(&self) -> &RecommendedP2PMode {
        &self.current_mode
    }

    /// Gets trend analysis based on history
    pub fn get_trend_analysis(&self) -> String {
        if self.metrics_history.len() < 2 {
            return "Insufficient data for trend analysis".to_string();
        }

        let recent = &self.metrics_history[self.metrics_history.len() - 1].1;
        let older = &self.metrics_history[self.metrics_history.len() - 2].1;

        let mut trends = Vec::new();

        // Peers change analysis
        let peer_change = recent.total_peers as i32 - older.total_peers as i32;
        if peer_change.abs() > 10 {
            trends.push(format!("Peers: {:+} (trend: {})", peer_change, 
                if peer_change > 0 { "growing" } else { "shrinking" }));
        }

        // Latency change analysis
        let latency_change = recent.average_latency - older.average_latency;
        if latency_change.abs() > 10.0 {
            trends.push(format!("Latency: {:+.1}ms (trend: {})", latency_change,
                if latency_change > 0.0 { "increasing" } else { "decreasing" }));
        }

        // TPS change analysis
        let tps_change = recent.current_tps - older.current_tps;
        if tps_change.abs() > 100.0 {
            trends.push(format!("TPS: {:+.0} (trend: {})", tps_change,
                if tps_change > 0.0 { "increasing" } else { "decreasing" }));
        }

        if trends.is_empty() {
            "Stable network conditions".to_string()
        } else {
            format!("Trends: {}", trends.join(", "))
        }
    }
}

/// Collects network metrics for automatic analysis
pub async fn collect_network_metrics(
    peer_count: usize,
    regional_peers: HashMap<String, usize>,
    avg_latency: f64,
    instability: f64,
    current_tps: f64,
    traffic_type: TrafficType,
) -> NetworkMetrics {
    NetworkMetrics {
        total_peers: peer_count,
        regional_distribution: regional_peers,
        average_latency: avg_latency,
        connection_instability: instability,
        current_tps,
        traffic_type,
        last_updated: chrono::Utc::now().timestamp() as u64,
    }
}

/// Demonstration function for automatic P2P selection
pub async fn demo_auto_p2p_selection() {
    println!("🤖 QNet Auto P2P Selector Demo");
    println!("================================");
    
    let mut selector = AutoP2PSelector::new();

    // Simulates different network scenarios
    let scenarios = vec![
        ("Startup: Small network", collect_network_metrics(
            25, HashMap::from([("na".to_string(), 25)]), 30.0, 0.01, 100.0, TrafficType::Standard
        ).await),
        
        ("Growth: Multi-region expansion", collect_network_metrics(
            150, HashMap::from([
                ("na".to_string(), 60),
                ("eu".to_string(), 50),
                ("asia".to_string(), 40)
            ]), 120.0, 0.05, 500.0, TrafficType::Standard
        ).await),
        
        ("High-frequency trading spike", collect_network_metrics(
            200, HashMap::from([
                ("na".to_string(), 120),
                ("eu".to_string(), 80)
            ]), 80.0, 0.02, 15000.0, TrafficType::HighFrequency
        ).await),
        
        ("Banking integration", collect_network_metrics(
            300, HashMap::from([
                ("na".to_string(), 100),
                ("eu".to_string(), 100),
                ("asia".to_string(), 50),
                ("sa".to_string(), 30),
                ("africa".to_string(), 20)
            ]), 180.0, 0.08, 800.0, TrafficType::Critical
        ).await),
        
        ("Network instability", collect_network_metrics(
            180, HashMap::from([
                ("na".to_string(), 90),
                ("eu".to_string(), 90)
            ]), 250.0, 0.15, 300.0, TrafficType::Standard
        ).await),
    ];

    for (scenario_name, metrics) in scenarios {
        println!("\n📊 Scenario: {}", scenario_name);
        println!("   Peers: {}, Regions: {}, Latency: {:.1}ms, Instability: {:.1}%, TPS: {:.0}",
                 metrics.total_peers, metrics.regional_distribution.len(), 
                 metrics.average_latency, metrics.connection_instability * 100.0, metrics.current_tps);

        if let Some(recommendation) = selector.update_metrics(metrics).await {
            match recommendation {
                RecommendedP2PMode::Simple { reason, confidence } => {
                    println!("   🔧 RECOMMENDATION: Simple P2P (confidence: {:.1}%)", confidence * 100.0);
                    println!("   📝 Reason: {}", reason);
                }
                RecommendedP2PMode::Regional { reason, confidence } => {
                    println!("   🌍 RECOMMENDATION: Regional P2P (confidence: {:.1}%)", confidence * 100.0);
                    println!("   📝 Reason: {}", reason);
                }
                RecommendedP2PMode::Dynamic { primary, fallback, switch_threshold } => {
                    println!("   🔄 RECOMMENDATION: Dynamic P2P (threshold: {:.1}%)", switch_threshold * 100.0);
                    println!("   📝 Primary: {:?}", primary);
                    println!("   📝 Fallback: {:?}", fallback);
                }
            }
        } else {
            println!("   ✅ Keeping current mode: {:?}", selector.get_current_mode());
        }

        println!("   📈 Trends: {}", selector.get_trend_analysis());
        sleep(Duration::from_millis(100)).await; // Small pause for demonstration
    }

    println!("\n🎯 Auto P2P Selector successfully demonstrated!");
    println!("   The system automatically chooses the optimal P2P mode based on network conditions");
    println!("   without any administrator intervention - true decentralization!");
} 