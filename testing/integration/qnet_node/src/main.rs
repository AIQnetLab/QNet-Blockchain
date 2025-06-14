//! QNet Node - Main executable

mod cli;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Parse CLI arguments
    let cli_args = cli::parse();
    
    // Execute command
    cli::execute(cli_args).await?;
    
    Ok(())
} 