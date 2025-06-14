use tokio::sync::mpsc;
use serde::{Serialize, Deserialize};
use crate::errors::QNetError;
use std::sync::{Arc, Mutex};

/// Message types for P2P communication
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NetworkMessage {
    NewBlock(Vec<u8>),
    NewTransaction(Vec<u8>),
    GetBlocks { start: u64, count: u32 },
    Blocks(Vec<Vec<u8>>),
    Ping,
    Pong,
}

/// Network interface for P2P communication
pub struct NetworkInterface {
    /// Channel to send messages to Go P2P layer
    tx: mpsc::Sender<NetworkCommand>,
    /// Channel to receive messages from Go P2P layer
    rx: mpsc::Receiver<NetworkEvent>,
}

/// Commands sent to the P2P layer
#[derive(Debug, Serialize, Deserialize)]
pub enum NetworkCommand {
    Broadcast(NetworkMessage),
    SendTo(String, NetworkMessage), // peer_id, message
    Connect(String), // multiaddr
    Disconnect(String), // peer_id
}

/// Events received from the P2P layer
#[derive(Debug)]
pub enum NetworkEvent {
    MessageReceived {
        peer_id: String,
        message: NetworkMessage,
    },
    PeerConnected(String),
    PeerDisconnected(String),
    Error(String),
}

impl NetworkInterface {
    /// Create a new network interface
    pub fn new() -> (Self, mpsc::Receiver<NetworkCommand>, mpsc::Sender<NetworkEvent>) {
        let (cmd_tx, cmd_rx) = mpsc::channel(1000);
        let (event_tx, event_rx) = mpsc::channel(1000);
        
        let interface = NetworkInterface {
            tx: cmd_tx,
            rx: event_rx,
        };
        
        (interface, cmd_rx, event_tx)
    }
    
    /// Broadcast a message to all peers
    pub async fn broadcast(&self, message: NetworkMessage) -> Result<(), QNetError> {
        self.tx.send(NetworkCommand::Broadcast(message))
            .await
            .map_err(|_| QNetError::NetworkError("Failed to send broadcast command".into()))
    }
    
    /// Send a message to a specific peer
    pub async fn send_to(&self, peer_id: String, message: NetworkMessage) -> Result<(), QNetError> {
        self.tx.send(NetworkCommand::SendTo(peer_id, message))
            .await
            .map_err(|_| QNetError::NetworkError("Failed to send message command".into()))
    }
    
    /// Connect to a peer
    pub async fn connect(&self, addr: String) -> Result<(), QNetError> {
        self.tx.send(NetworkCommand::Connect(addr))
            .await
            .map_err(|_| QNetError::NetworkError("Failed to send connect command".into()))
    }
    
    /// Process incoming network events
    pub async fn process_events(&mut self) -> Result<Option<NetworkEvent>, QNetError> {
        match self.rx.try_recv() {
            Ok(event) => Ok(Some(event)),
            Err(mpsc::error::TryRecvError::Empty) => Ok(None),
            Err(mpsc::error::TryRecvError::Disconnected) => {
                Err(QNetError::NetworkError("Network event channel disconnected".into()))
            }
        }
    }
}

/// Start the Go P2P process and create communication bridge
pub async fn start_p2p_network(
    port: u16,
    bootstrap_peers: Vec<String>,
) -> Result<(NetworkInterface, tokio::task::JoinHandle<()>), QNetError> {
    use std::process::{Command, Stdio};
    use std::io::{BufReader, BufRead};
    
    // Build the Go binary if needed
    println!("Building P2P network binary...");
    let output = Command::new("go")
        .args(&["build", "-o", "qnet-p2p.exe"])
        .current_dir("qnet-network")
        .output()
        .map_err(|e| QNetError::NetworkError(format!("Failed to build P2P binary: {}", e)))?;
    
    if !output.status.success() {
        return Err(QNetError::NetworkError(
            format!("Failed to build P2P binary: {}", String::from_utf8_lossy(&output.stderr))
        ));
    }
    
    println!("Starting P2P network on port {}...", port);
    
    // Create network interface
    let (interface, mut cmd_rx, event_tx) = NetworkInterface::new();
    
    // Start the Go process
    let mut child = Command::new("qnet-network/qnet-p2p.exe")
        .args(&[
            "--port", &port.to_string(),
            "--type", "full",
            "--bootstrap", &bootstrap_peers.join(","),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| QNetError::NetworkError(format!("Failed to start P2P process: {}", e)))?;
    
    let mut stdin = child.stdin.take()
        .ok_or_else(|| QNetError::NetworkError("Failed to get stdin".into()))?;
    let stdout = child.stdout.take()
        .ok_or_else(|| QNetError::NetworkError("Failed to get stdout".into()))?;
    
    // Task to handle communication with Go process
    let handle = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        let stdin = Arc::new(Mutex::new(stdin));
        
        loop {
            // Read events from Go process in blocking thread
            let line_result = tokio::task::spawn_blocking(move || {
                let line = lines.next();
                (line, lines)
            }).await;
            
            match line_result {
                Ok((Some(Ok(line)), returned_lines)) => {
                    lines = returned_lines;
                    
                    // Parse JSON event from Go
                    if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                        if let Some(event_type) = event.get("type").and_then(|v| v.as_str()) {
                            match event_type {
                                "Ready" => {
                                    println!("P2P network ready!");
                                    if let Some(payload) = event.get("payload") {
                                        if let Some(peer_id) = payload.get("peer_id").and_then(|v| v.as_str()) {
                                            println!("Node ID: {}", peer_id);
                                        }
                                    }
                                }
                                "MessageReceived" => {
                                    // Handle received message
                                    if let Some(payload) = event.get("payload") {
                                        // TODO: Parse and send to event channel
                                    }
                                }
                                "Metrics" => {
                                    // Log metrics
                                    if let Some(payload) = event.get("payload") {
                                        if let Some(peers) = payload.get("connected_peers").and_then(|v| v.as_u64()) {
                                            println!("Connected peers: {}", peers);
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
                Ok((Some(Err(e)), _)) => {
                    eprintln!("Error reading from P2P process: {}", e);
                    break;
                }
                Ok((None, _)) => {
                    eprintln!("P2P process stdout closed");
                    break;
                }
                Err(e) => {
                    eprintln!("Task error: {:?}", e);
                    break;
                }
            }
            
            // Check for commands to send
            match cmd_rx.try_recv() {
                Ok(cmd) => {
                    let json = serde_json::to_string(&cmd).unwrap();
                    // Use blocking write in a separate task
                    let stdin_clone = stdin.clone();
                    tokio::task::spawn_blocking(move || {
                        use std::io::Write;
                        let mut stdin = stdin_clone.lock().unwrap();
                        writeln!(stdin, "{}", json).unwrap();
                        stdin.flush().unwrap();
                    });
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {}
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                    break;
                }
            }
        }
        
        println!("P2P communication task ended");
    });
    
    // Wait a bit for the network to start
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
    
    Ok((interface, handle))
} 