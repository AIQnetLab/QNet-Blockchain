//! Command-line interface for QNet node

use clap::{Parser, Subcommand};
use std::path::PathBuf;

/// QNet Node CLI
#[derive(Parser, Debug)]
#[command(name = "qnet-node")]
#[command(about = "QNet blockchain node", long_about = None)]
pub struct Cli {
    /// Configuration file path
    #[arg(short, long, value_name = "FILE")]
    pub config: Option<PathBuf>,
    
    /// Data directory
    #[arg(short, long, value_name = "DIR")]
    pub data_dir: Option<PathBuf>,
    
    /// Log level (trace, debug, info, warn, error)
    #[arg(short, long, default_value = "info")]
    pub log_level: String,
    
    /// Command to execute
    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Start the node
    Start {
        /// Node type (light, full, super)
        #[arg(short, long, default_value = "full")]
        node_type: String,
        
        /// Enable mining/validation
        #[arg(short, long)]
        validator: bool,
        
        /// API port
        #[arg(long, default_value = "8080")]
        api_port: u16,
        
        /// P2P port
        #[arg(long, default_value = "30303")]
        p2p_port: u16,
        
        /// Bootstrap nodes
        #[arg(long, value_delimiter = ',')]
        bootnodes: Vec<String>,
    },
    
    /// Node status and information
    Status {
        /// Output format (json, text)
        #[arg(short, long, default_value = "text")]
        format: String,
    },
    
    /// Blockchain information
    Chain {
        #[command(subcommand)]
        command: ChainCommands,
    },
    
    /// Network operations
    Network {
        #[command(subcommand)]
        command: NetworkCommands,
    },
    
    /// Account management
    Account {
        #[command(subcommand)]
        command: AccountCommands,
    },
    
    /// Transaction operations
    Tx {
        #[command(subcommand)]
        command: TxCommands,
    },
    
    /// Export/Import operations
    Export {
        /// Export type (blocks, state)
        #[arg(short, long)]
        export_type: String,
        
        /// Output file
        #[arg(short, long)]
        output: PathBuf,
        
        /// From height
        #[arg(long)]
        from: Option<u64>,
        
        /// To height
        #[arg(long)]
        to: Option<u64>,
    },
    
    /// Import blockchain data
    Import {
        /// Input file
        #[arg(short, long)]
        input: PathBuf,
        
        /// Verify before import
        #[arg(long)]
        verify: bool,
    },
    
    /// Database operations
    Db {
        #[command(subcommand)]
        command: DbCommands,
    },
}

#[derive(Subcommand, Debug)]
pub enum ChainCommands {
    /// Get blockchain info
    Info,
    
    /// Get block by height or hash
    Block {
        /// Block identifier (height or hash)
        #[arg(value_name = "HEIGHT_OR_HASH")]
        identifier: String,
        
        /// Include transactions
        #[arg(long)]
        full: bool,
    },
    
    /// Validate chain integrity
    Validate {
        /// From height
        #[arg(long)]
        from: Option<u64>,
        
        /// To height
        #[arg(long)]
        to: Option<u64>,
    },
}

#[derive(Subcommand, Debug)]
pub enum NetworkCommands {
    /// List connected peers
    Peers {
        /// Show detailed info
        #[arg(long)]
        detailed: bool,
    },
    
    /// Add peer
    AddPeer {
        /// Peer multiaddr
        #[arg(value_name = "MULTIADDR")]
        addr: String,
    },
    
    /// Remove peer
    RemovePeer {
        /// Peer ID
        #[arg(value_name = "PEER_ID")]
        peer_id: String,
    },
    
    /// Network statistics
    Stats,
}

#[derive(Subcommand, Debug)]
pub enum AccountCommands {
    /// Create new account
    New {
        /// Account label
        #[arg(long)]
        label: Option<String>,
    },
    
    /// List accounts
    List,
    
    /// Get account balance
    Balance {
        /// Account address
        #[arg(value_name = "ADDRESS")]
        address: String,
    },
    
    /// Import account
    Import {
        /// Private key file
        #[arg(value_name = "FILE")]
        key_file: PathBuf,
    },
    
    /// Export account
    Export {
        /// Account address
        #[arg(value_name = "ADDRESS")]
        address: String,
        
        /// Output file
        #[arg(short, long)]
        output: PathBuf,
    },
}

#[derive(Subcommand, Debug)]
pub enum TxCommands {
    /// Send transaction
    Send {
        /// From address
        #[arg(long)]
        from: String,
        
        /// To address
        #[arg(long)]
        to: String,
        
        /// Amount
        #[arg(long)]
        amount: String,
        
        /// Gas price
        #[arg(long)]
        gas_price: Option<String>,
        
        /// Nonce
        #[arg(long)]
        nonce: Option<u64>,
    },
    
    /// Get transaction
    Get {
        /// Transaction hash
        #[arg(value_name = "HASH")]
        hash: String,
    },
    
    /// Get transaction receipt
    Receipt {
        /// Transaction hash
        #[arg(value_name = "HASH")]
        hash: String,
    },
    
    /// List pending transactions
    Pending {
        /// Limit
        #[arg(long, default_value = "10")]
        limit: usize,
    },
}

#[derive(Subcommand, Debug)]
pub enum DbCommands {
    /// Compact database
    Compact,
    
    /// Database statistics
    Stats,
    
    /// Prune old data
    Prune {
        /// Keep last N blocks
        #[arg(long)]
        keep_blocks: u64,
    },
    
    /// Repair database
    Repair {
        /// Dry run
        #[arg(long)]
        dry_run: bool,
    },
}

/// Parse CLI arguments
pub fn parse() -> Cli {
    Cli::parse()
}

/// Execute CLI command
pub async fn execute(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging
    init_logging(&cli.log_level)?;
    
    match cli.command {
        Some(Commands::Start { node_type, validator, api_port, p2p_port, bootnodes }) => {
            cmd_start(cli.config, cli.data_dir, node_type, validator, api_port, p2p_port, bootnodes).await?;
        }
        Some(Commands::Status { format }) => {
            cmd_status(format).await?;
        }
        Some(Commands::Chain { command }) => {
            cmd_chain(command).await?;
        }
        Some(Commands::Network { command }) => {
            cmd_network(command).await?;
        }
        Some(Commands::Account { command }) => {
            cmd_account(command).await?;
        }
        Some(Commands::Tx { command }) => {
            cmd_tx(command).await?;
        }
        Some(Commands::Export { export_type, output, from, to }) => {
            cmd_export(export_type, output, from, to).await?;
        }
        Some(Commands::Import { input, verify }) => {
            cmd_import(input, verify).await?;
        }
        Some(Commands::Db { command }) => {
            cmd_db(command).await?;
        }
        None => {
            // No command specified, start node with defaults
            cmd_start(cli.config, cli.data_dir, "full".to_string(), false, 8080, 30303, vec![]).await?;
        }
    }
    
    Ok(())
}

/// Initialize logging
fn init_logging(level: &str) -> Result<(), Box<dyn std::error::Error>> {
    let filter = match level {
        "trace" => tracing::Level::TRACE,
        "debug" => tracing::Level::DEBUG,
        "info" => tracing::Level::INFO,
        "warn" => tracing::Level::WARN,
        "error" => tracing::Level::ERROR,
        _ => tracing::Level::INFO,
    };
    
    tracing_subscriber::fmt()
        .with_max_level(filter)
        .with_target(false)
        .with_thread_ids(true)
        .with_file(true)
        .with_line_number(true)
        .init();
    
    Ok(())
}

/// Start node command
async fn cmd_start(
    config_path: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    node_type: String,
    validator: bool,
    api_port: u16,
    p2p_port: u16,
    bootnodes: Vec<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    use crate::{Node, NodeConfig};
    
    println!("Starting QNet node...");
    println!("Node type: {}", node_type);
    println!("Validator: {}", validator);
    println!("API port: {}", api_port);
    println!("P2P port: {}", p2p_port);
    
    // Load or create config
    let config = if let Some(path) = config_path {
        NodeConfig::from_file(path)?
    } else {
        let mut config = NodeConfig::default();
        if let Some(dir) = data_dir {
            config.data_dir = dir;
        }
        config.api_port = api_port;
        config.p2p_port = p2p_port;
        config.bootnodes = bootnodes;
        config.validator = validator;
        config
    };
    
    // Create and start node
    let node = Node::new(config).await?;
    node.start().await?;
    
    // Wait for shutdown signal
    tokio::signal::ctrl_c().await?;
    
    println!("\nShutting down node...");
    node.stop().await?;
    
    Ok(())
}

/// Status command
async fn cmd_status(format: String) -> Result<(), Box<dyn std::error::Error>> {
    // Connect to running node
    let client = connect_to_node().await?;
    let status = client.get_status().await?;
    
    match format.as_str() {
        "json" => {
            println!("{}", serde_json::to_string_pretty(&status)?);
        }
        _ => {
            println!("Node Status:");
            println!("  Version: {}", status.version);
            println!("  Network: {}", status.network);
            println!("  Height: {}", status.height);
            println!("  Peers: {}", status.peers);
            println!("  Sync: {}", status.sync_status);
            println!("  Uptime: {}s", status.uptime);
        }
    }
    
    Ok(())
}

/// Chain commands
async fn cmd_chain(command: ChainCommands) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        ChainCommands::Info => {
            let client = connect_to_node().await?;
            let info = client.get_chain_info().await?;
            println!("Chain Info:");
            println!("  Height: {}", info.height);
            println!("  Hash: {}", info.hash);
            println!("  Difficulty: {}", info.difficulty);
        }
        ChainCommands::Block { identifier, full } => {
            let client = connect_to_node().await?;
            let block = client.get_block(&identifier, full).await?;
            println!("{}", serde_json::to_string_pretty(&block)?);
        }
        ChainCommands::Validate { from, to } => {
            println!("Validating chain from {} to {}", 
                     from.unwrap_or(0), 
                     to.map(|t| t.to_string()).unwrap_or("latest".to_string()));
            // Implementation would validate chain
        }
    }
    Ok(())
}

/// Network commands
async fn cmd_network(command: NetworkCommands) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        NetworkCommands::Peers { detailed } => {
            let client = connect_to_node().await?;
            let peers = client.get_peers(detailed).await?;
            for peer in peers {
                println!("{}", peer);
            }
        }
        NetworkCommands::AddPeer { addr } => {
            let client = connect_to_node().await?;
            client.add_peer(&addr).await?;
            println!("Peer added: {}", addr);
        }
        NetworkCommands::RemovePeer { peer_id } => {
            let client = connect_to_node().await?;
            client.remove_peer(&peer_id).await?;
            println!("Peer removed: {}", peer_id);
        }
        NetworkCommands::Stats => {
            let client = connect_to_node().await?;
            let stats = client.get_network_stats().await?;
            println!("{}", serde_json::to_string_pretty(&stats)?);
        }
    }
    Ok(())
}

/// Account commands
async fn cmd_account(command: AccountCommands) -> Result<(), Box<dyn std::error::Error>> {
    // Account command implementations
    println!("Account command: {:?}", command);
    Ok(())
}

/// Transaction commands
async fn cmd_tx(command: TxCommands) -> Result<(), Box<dyn std::error::Error>> {
    // Transaction command implementations
    println!("Transaction command: {:?}", command);
    Ok(())
}

/// Export command
async fn cmd_export(
    export_type: String,
    output: PathBuf,
    from: Option<u64>,
    to: Option<u64>,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("Exporting {} to {:?}", export_type, output);
    // Export implementation
    Ok(())
}

/// Import command
async fn cmd_import(input: PathBuf, verify: bool) -> Result<(), Box<dyn std::error::Error>> {
    println!("Importing from {:?} (verify: {})", input, verify);
    // Import implementation
    Ok(())
}

/// Database commands
async fn cmd_db(command: DbCommands) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        DbCommands::Compact => {
            println!("Compacting database...");
        }
        DbCommands::Stats => {
            println!("Database statistics:");
        }
        DbCommands::Prune { keep_blocks } => {
            println!("Pruning database, keeping last {} blocks", keep_blocks);
        }
        DbCommands::Repair { dry_run } => {
            println!("Repairing database (dry run: {})", dry_run);
        }
    }
    Ok(())
}

/// Connect to running node
async fn connect_to_node() -> Result<NodeClient, Box<dyn std::error::Error>> {
    // In real implementation, would connect to node API
    Ok(NodeClient {})
}

/// Mock node client
struct NodeClient;

impl NodeClient {
    async fn get_status(&self) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        Ok(serde_json::json!({
            "version": "0.1.0",
            "network": "mainnet",
            "height": 12345,
            "peers": 8,
            "sync_status": "synced",
            "uptime": 3600
        }))
    }
    
    async fn get_chain_info(&self) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        Ok(serde_json::json!({
            "height": 12345,
            "hash": "0x1234...",
            "difficulty": "1000000"
        }))
    }
    
    async fn get_block(&self, _id: &str, _full: bool) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        Ok(serde_json::json!({}))
    }
    
    async fn get_peers(&self, _detailed: bool) -> Result<Vec<String>, Box<dyn std::error::Error>> {
        Ok(vec!["peer1".to_string(), "peer2".to_string()])
    }
    
    async fn add_peer(&self, _addr: &str) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }
    
    async fn remove_peer(&self, _id: &str) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }
    
    async fn get_network_stats(&self) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        Ok(serde_json::json!({}))
    }
} 