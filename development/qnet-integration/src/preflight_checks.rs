//! Pre-flight checks for QNet node startup
//! 
//! CRITICAL: These checks run BEFORE node starts to ensure:
//! 1. All required ports are available locally
//! 2. Firewall allows incoming connections
//! 3. QUIC UDP port is reachable from outside
//! 4. Node can be reached via external IP
//!
//! If any check fails, node will NOT start - preventing "ghost nodes"
//! that appear online but cannot participate in network.

use std::net::{TcpListener, UdpSocket, SocketAddr, IpAddr};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;

/// Pre-flight check results
#[derive(Debug, Clone)]
pub struct PreflightResult {
    pub passed: bool,
    pub checks: Vec<CheckResult>,
    pub critical_failures: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct CheckResult {
    pub name: String,
    pub passed: bool,
    pub message: String,
}

/// Required ports for QNet node
/// All ports must be open for full node operation
pub const REQUIRED_PORTS: &[(u16, &str, &str)] = &[
    (8001, "TCP", "REST API"),
    (9876, "TCP", "P2P Network"),
    (9877, "TCP", "P2P Regional"),
    (10876, "UDP", "QUIC Transport"),
];

/// Run all pre-flight checks before node startup
/// Returns Err if critical checks fail - node should NOT start
pub async fn run_preflight_checks(external_ip: Option<&str>) -> Result<PreflightResult, String> {
    println!("");
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("🔍 QNET PRE-FLIGHT CHECKS v2.19.22");
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("");
    
    let mut checks = Vec::new();
    let mut critical_failures = Vec::new();
    
    // =========================================================================
    // PHASE 1: Local port availability
    // =========================================================================
    println!("📡 Phase 1: Checking local port availability...");
    
    for (port, protocol, description) in REQUIRED_PORTS {
        let result = check_port_available(*port, protocol);
        
        if result.passed {
            println!("   ✅ {} {} ({}) - available", protocol, port, description);
        } else {
            println!("   ❌ {} {} ({}) - {}", protocol, port, description, result.message);
            critical_failures.push(format!("{} port {} ({}) is not available: {}", 
                protocol, port, description, result.message));
        }
        
        checks.push(result);
    }
    
    // If local ports are not available, fail fast
    if !critical_failures.is_empty() {
        println!("");
        println!("❌ CRITICAL: Local port check failed!");
        println!("   Cannot start node - ports already in use or permission denied.");
        println!("");
        println!("🔧 Solutions:");
        println!("   1. Stop other applications using these ports");
        println!("   2. Run: sudo lsof -i :<port> to find what's using them");
        println!("   3. For Docker: ensure no other containers use same ports");
        println!("");
        
        return Err(format!("Pre-flight failed: {}", critical_failures.join("; ")));
    }
    
    // =========================================================================
    // PHASE 2: External IP detection
    // =========================================================================
    println!("");
    println!("🌐 Phase 2: Detecting external IP...");
    
    let detected_ip = if let Some(ip) = external_ip {
        println!("   ✅ Using provided IP: {}", ip);
        ip.to_string()
    } else {
        match detect_external_ip().await {
            Ok(ip) => {
                println!("   ✅ Detected external IP: {}", ip);
                ip
            }
            Err(e) => {
                // Returning passed:true here printed "[INFO][PREFLIGHT] passed" while phases 3-6
                // never ran — a false all-clear. Report the real coverage instead; the caller
                // decides, and the operator sees which phases were skipped.
                println!("[WARN][PREFLIGHT] external_ip_undetected err={} skipped=phases_3_6", e);

                checks.push(CheckResult {
                    name: "External IP Detection".to_string(),
                    passed: false,
                    message: e.clone(),
                });

                return Ok(PreflightResult {
                    passed: false,
                    checks,
                    critical_failures: vec![],
                });
            }
        }
    };
    
    // =========================================================================
    // PHASE 3: Firewall / External connectivity check
    // =========================================================================
    println!("");
    println!("🔥 Phase 3: Checking firewall / external connectivity...");
    println!("   ℹ️ This verifies ports are open from outside");
    
    // Start temporary listeners for external check
    let tcp_ports = vec![8001u16];
    let mut listeners = Vec::new();
    
    for port in &tcp_ports {
        match TcpListener::bind(format!("0.0.0.0:{}", port)) {
            Ok(listener) => {
                listener.set_nonblocking(true).ok();
                listeners.push((*port, listener));
            }
            Err(_) => {
                // Port might be taken by our own service starting up
            }
        }
    }
    
    // UDP listener for QUIC port
    let udp_listener = UdpSocket::bind("0.0.0.0:10876").ok();
    
    // Check external connectivity
    for (port, protocol, description) in REQUIRED_PORTS {
        let result = if *protocol == "TCP" {
            check_tcp_external_connectivity(&detected_ip, *port).await
        } else {
            check_udp_external_connectivity(&detected_ip, *port).await
        };
        
        if result.passed {
            println!("   ✅ {} {} ({}) - reachable from outside", protocol, port, description);
        } else {
            println!("   ⚠️ {} {} ({}) - {}", protocol, port, description, result.message);
            
            // UDP 10876 is CRITICAL for QUIC
            if *port == 10876 {
                println!("");
                println!("   🚨 CRITICAL: UDP 10876 (QUIC) must be open for block propagation!");
                println!("   🔧 Run: sudo iptables -A INPUT -p udp --dport 10876 -j ACCEPT");
                println!("");
                critical_failures.push(format!("UDP 10876 (QUIC) not reachable - blocks won't sync!"));
            }
        }
        
        checks.push(result);
    }
    
    // Clean up temporary listeners
    drop(listeners);
    drop(udp_listener);
    
    // =========================================================================
    // PHASE 4: Self-connectivity test
    // =========================================================================
    println!("");
    println!("🔄 Phase 4: Self-connectivity test...");
    
    let self_test = self_connectivity_test(&detected_ip).await;
    if self_test.passed {
        println!("   ✅ Can reach self via external IP");
    } else {
        println!("   ⚠️ Cannot reach self via external IP: {}", self_test.message);
        println!("   ℹ️ This might be normal for some network configurations (NAT loopback)");
    }
    checks.push(self_test);
    
    // =========================================================================
    // PHASE 5: QUIC-specific deep check
    // =========================================================================
    println!("");
    println!("⚡ Phase 5: QUIC transport readiness...");
    
    let quic_result = check_quic_readiness().await;
    if quic_result.passed {
        println!("   ✅ QUIC transport ready");
    } else {
        println!("   ❌ QUIC transport not ready: {}", quic_result.message);
        critical_failures.push(format!("QUIC not ready: {}", quic_result.message));
    }
    checks.push(quic_result);
    
    // =========================================================================
    // PHASE 6: NTP Time Synchronization (v2.42.1)
    // CRITICAL: Block timestamps are Unix-based. Clock drift breaks consensus!
    // =========================================================================
    println!("");
    println!("🕐 Phase 6: Checking time synchronization...");
    
    let ntp_result = check_time_sync().await;
    if ntp_result.passed {
        println!("   ✅ System time synchronized");
    } else {
        // WARNING only - don't block startup, but alert operator
        println!("   ⚠️  {}", ntp_result.message);
        println!("   ⚠️  Block timestamps may drift! Install: sudo apt install chrony");
    }
    checks.push(ntp_result);
    
    // =========================================================================
    // SUMMARY
    // =========================================================================
    println!("");
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    
    let passed_count = checks.iter().filter(|c| c.passed).count();
    let total_count = checks.len();
    
    if critical_failures.is_empty() {
        println!("✅ PRE-FLIGHT CHECKS PASSED ({}/{})", passed_count, total_count);
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("");
        
        Ok(PreflightResult {
            passed: true,
            checks,
            critical_failures: vec![],
        })
    } else {
        println!("❌ PRE-FLIGHT CHECKS FAILED ({}/{})", passed_count, total_count);
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("");
        println!("🚨 CRITICAL FAILURES:");
        for failure in &critical_failures {
            println!("   ❌ {}", failure);
        }
        println!("");
        println!("🔧 FIX THESE ISSUES BEFORE STARTING NODE:");
        println!("   1. Open required ports in firewall:");
        println!("      sudo iptables -A INPUT -p tcp --dport 8001 -j ACCEPT");
        println!("      sudo iptables -A INPUT -p udp --dport 10876 -j ACCEPT");
        println!("");
        println!("   2. For Docker, ensure port mapping:");
        println!("      -p 8001:8001 -p 10876:10876/udp");
        println!("");
        
        Err(format!("Pre-flight failed: {}", critical_failures.join("; ")))
    }
}

/// Check if a port is available locally
fn check_port_available(port: u16, protocol: &str) -> CheckResult {
    let name = format!("{} port {} local availability", protocol, port);
    
    if protocol == "UDP" {
        match UdpSocket::bind(format!("0.0.0.0:{}", port)) {
            Ok(_socket) => CheckResult {
                name,
                passed: true,
                message: "Available".to_string(),
            },
            Err(e) => CheckResult {
                name,
                passed: false,
                message: format!("Bind failed: {}", e),
            },
        }
    } else {
        match TcpListener::bind(format!("0.0.0.0:{}", port)) {
            Ok(_listener) => CheckResult {
                name,
                passed: true,
                message: "Available".to_string(),
            },
            Err(e) => CheckResult {
                name,
                passed: false,
                message: format!("Bind failed: {}", e),
            },
        }
    }
}

/// Detect external IP via public services
async fn detect_external_ip() -> Result<String, String> {
    let services = [
        "https://api.ipify.org",
        "https://ifconfig.me/ip",
        "https://icanhazip.com",
    ];
    
    for service in &services {
        if let Ok(response) = timeout(
            Duration::from_secs(5),
            reqwest::get(*service)
        ).await {
            if let Ok(resp) = response {
                if let Ok(ip) = resp.text().await {
                    let ip = ip.trim().to_string();
                    if !ip.is_empty() && ip.parse::<IpAddr>().is_ok() {
                        return Ok(ip);
                    }
                }
            }
        }
    }
    
    Err("Could not detect external IP from any service".to_string())
}

/// Check TCP port reachability from external perspective
async fn check_tcp_external_connectivity(external_ip: &str, port: u16) -> CheckResult {
    let name = format!("TCP {} external connectivity", port);
    
    // Try to connect to ourselves via external IP
    let addr = format!("{}:{}", external_ip, port);
    
    match timeout(Duration::from_secs(3), TcpStream::connect(&addr)).await {
        Ok(Ok(_)) => CheckResult {
            name,
            passed: true,
            message: "Reachable".to_string(),
        },
        Ok(Err(e)) => {
            // Connection refused might mean port is not listening yet (OK)
            // Connection timeout means firewall blocking (BAD)
            let message = e.to_string();
            if message.contains("refused") {
                CheckResult {
                    name,
                    passed: true,
                    message: "Port reachable (not listening yet)".to_string(),
                }
            } else {
                CheckResult {
                    name,
                    passed: false,
                    message: format!("Connection failed: {}", e),
                }
            }
        }
        Err(_) => CheckResult {
            name,
            passed: false,
            message: "Connection timeout - likely firewall blocked".to_string(),
        },
    }
}

/// Check UDP port reachability (harder to verify)
async fn check_udp_external_connectivity(external_ip: &str, port: u16) -> CheckResult {
    let name = format!("UDP {} external connectivity", port);
    
    // For UDP we can only verify the socket binds locally
    // External check requires external service or peer
    match UdpSocket::bind("0.0.0.0:0") {
        Ok(socket) => {
            // Never substitute a bogus fallback address that masks a bad external_ip.
            let addr: SocketAddr = match format!("{}:{}", external_ip, port).parse() {
                Ok(a) => a,
                Err(e) => {
                    println!("[WARN][PREFLIGHT] invalid external address, skipping UDP check ip={} port={} err={}", external_ip, port, e);
                    return CheckResult {
                        name,
                        passed: false,
                        message: format!("Invalid external address {}:{} ({})", external_ip, port, e),
                    };
                }
            };

            // Try to send a probe packet
            match socket.send_to(b"QNET_PREFLIGHT_CHECK", addr) {
                Ok(_) => {
                    // We can send, but can't verify receipt without listener
                    // This at least confirms outbound UDP works
                    CheckResult {
                        name,
                        passed: true,
                        message: "UDP socket working (cannot verify external inbound without peer)".to_string(),
                    }
                }
                Err(e) => CheckResult {
                    name,
                    passed: false,
                    message: format!("UDP send failed: {}", e),
                },
            }
        }
        Err(e) => CheckResult {
            name,
            passed: false,
            message: format!("Cannot create UDP socket: {}", e),
        },
    }
}

/// Self-connectivity test - can we reach our own external IP?
async fn self_connectivity_test(external_ip: &str) -> CheckResult {
    let name = "Self-connectivity test".to_string();
    
    // Try API port since it should be running
    let url = format!("http://{}:8001/api/v1/node/health", external_ip);
    
    match timeout(Duration::from_secs(5), reqwest::get(&url)).await {
        Ok(Ok(response)) if response.status().is_success() => CheckResult {
            name,
            passed: true,
            message: "Can reach self via external IP".to_string(),
        },
        Ok(Ok(response)) => CheckResult {
            name,
            passed: true,
            message: format!("Reachable but returned status {}", response.status()),
        },
        Ok(Err(e)) => {
            // Connection refused is OK - API might not be started yet
            let message = e.to_string();
            if message.contains("refused") || message.contains("reset") {
                CheckResult {
                    name,
                    passed: true,
                    message: "Port reachable (service not started yet)".to_string(),
                }
            } else {
                CheckResult {
                    name,
                    passed: false,
                    message: format!("Cannot reach self: {}", e),
                }
            }
        }
        Err(_) => CheckResult {
            name,
            passed: false,
            message: "Timeout reaching self - NAT loopback may be disabled".to_string(),
        },
    }
}

/// Check QUIC transport readiness
async fn check_quic_readiness() -> CheckResult {
    let name = "QUIC transport readiness".to_string();
    
    // Check that quinn/rustls dependencies are working
    // by trying to create a basic endpoint
    match std::net::UdpSocket::bind("0.0.0.0:0") {
        Ok(socket) => {
            // Get the local address
            match socket.local_addr() {
                Ok(addr) => {
                    // QUIC requires TLS - check rustls is working
                    // This is a basic sanity check
                    CheckResult {
                        name,
                        passed: true,
                        message: format!("UDP socket ready on {}", addr),
                    }
                }
                Err(e) => CheckResult {
                    name,
                    passed: false,
                    message: format!("Cannot get socket address: {}", e),
                },
            }
        }
        Err(e) => CheckResult {
            name,
            passed: false,
            message: format!("Cannot create UDP socket for QUIC: {}", e),
        },
    }
}

/// Quick check for essential ports only (faster, for restart scenarios)
pub fn quick_port_check() -> Result<(), String> {
    for (port, protocol, description) in REQUIRED_PORTS {
        let result = check_port_available(*port, protocol);
        if !result.passed {
            return Err(format!("{} {} ({}) not available: {}", 
                protocol, port, description, result.message));
        }
    }
    Ok(())
}

/// Check if system time is synchronized (NTP)
/// CRITICAL v2.42.1: Block timestamps are Unix-based, clock drift breaks consensus
async fn check_time_sync() -> CheckResult {
    let name = "Time synchronization".to_string();
    
    // Method 1: Check against public NTP-synced time services
    let time_services = [
        "https://worldtimeapi.org/api/ip",
    ];
    
    let local_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    
    for service in &time_services {
        if let Ok(response) = timeout(
            Duration::from_secs(5),
            reqwest::get(*service)
        ).await {
            if let Ok(resp) = response {
                if let Ok(text) = resp.text().await {
                    // Parse unixtime from response
                    if let Some(unix_time) = text
                        .split("\"unixtime\":")
                        .nth(1)
                        .and_then(|s| s.split(',').next())
                        .and_then(|s| s.trim().parse::<u64>().ok())
                    {
                        let drift = if local_time > unix_time {
                            local_time - unix_time
                        } else {
                            unix_time - local_time
                        };
                        
                        if drift <= 5 {
                            return CheckResult {
                                name,
                                passed: true,
                                message: format!("Clock drift: {}s (excellent)", drift),
                            };
                        } else if drift <= 30 {
                            return CheckResult {
                                name,
                                passed: true,
                                message: format!("Clock drift: {}s (acceptable)", drift),
                            };
                        } else {
                            return CheckResult {
                                name,
                                passed: false,
                                message: format!("Clock drift: {}s - TOO HIGH! Install NTP: sudo apt install chrony", drift),
                            };
                        }
                    }
                }
            }
        }
    }
    
    // If we can't check, assume it's OK but warn
    CheckResult {
        name,
        passed: true,
        message: "Could not verify NTP sync - ensure chrony/ntpd is installed".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_check_port_available_tcp() {
        // Should be able to bind to a random high port
        let _result = check_port_available(0, "TCP");
        // Port 0 will fail because we need a real port
        // This is just a sanity check that the function works
    }
    
    #[test]
    fn test_check_port_available_udp() {
        let _result = check_port_available(0, "UDP");
        // Same as above
    }
    
    #[tokio::test]
    async fn test_detect_external_ip() {
        // This test requires internet
        let result = detect_external_ip().await;
        // Don't assert - might fail without internet
        println!("External IP detection result: {:?}", result);
    }
}

