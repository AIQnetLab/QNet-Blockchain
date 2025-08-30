warning: in the working copy of 'development/qnet-integration/src/bin/qnet-node.rs', LF will be replaced by CRLF the next time Git touches it
[1mdiff --git a/development/qnet-integration/src/bin/qnet-node.rs b/development/qnet-integration/src/bin/qnet-node.rs[m
[1mindex b66b1c9..f5b781a 100644[m
[1m--- a/development/qnet-integration/src/bin/qnet-node.rs[m
[1m+++ b/development/qnet-integration/src/bin/qnet-node.rs[m
[36m@@ -4035,11 +4035,10 @@[m [masync fn query_node_for_peers(node_addr: &str) -> Result<Vec<String>, String> {[m
     // Extract IP from address[m
     let ip = node_addr.split(':').next().unwrap_or(node_addr);[m
     [m
[31m-    // Try multiple API endpoints[m
[32m+[m[32m    // CRITICAL FIX: Use only actual listening port (8001)[m[41m [m
[32m+[m[32m    // All QNet nodes run unified API on port 8001 only - no 8080/9876[m
     let endpoints = vec![[m
[31m-        format!("http://{}:8001/api/v1/peers", ip),     // Primary API[m
[31m-        format!("http://{}:8080/api/v1/peers", ip),     // Alternative API  [m
[31m-        format!("http://{}:9876/api/peers", ip),        // P2P endpoint[m
[32m+[m[32m        format!("http://{}:8001/api/v1/peers", ip),     // Unified API port[m
     ];[m
     [m
     for endpoint in endpoints {[m
