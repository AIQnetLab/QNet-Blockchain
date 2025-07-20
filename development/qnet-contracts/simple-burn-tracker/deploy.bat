@echo off
echo Deploying Simple 1DEV Burn Tracker to Solana devnet...

REM Build the program
echo Building program...
cargo build --release --target wasm32-unknown-unknown

REM Deploy using solana program deploy
echo Deploying program...
solana program deploy target\wasm32-unknown-unknown\release\simple_burn_tracker.wasm

echo Deployment complete!
echo.
echo Next steps:
echo 1. Note the Program ID from above
echo 2. Update all config files with the new Program ID
echo 3. Test the deployment
pause 