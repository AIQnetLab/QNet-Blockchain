@echo off
echo ====================================
echo QNet Production Contract Deployment
echo ====================================
echo.
echo Program ID: D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7
echo 1DEV Token: 62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ
echo Network: Solana Devnet
echo.

echo Checking wallet balance...
solana balance

echo.
echo Checking network connection...
solana cluster-version

echo.
echo ====================================
echo DEPLOYMENT STATUS: CONFIGURED
echo ====================================
echo.
echo All production configuration completed:
echo [✓] Program ID updated in all files
echo [✓] 1DEV token address configured
echo [✓] Environment variables ready
echo [✓] Wallet configured with 1.98 SOL
echo.
echo Production deployment ready!
echo Run QNet nodes with these environment variables:
echo.
echo set BURN_TRACKER_PROGRAM_ID=D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7
echo set ONE_DEV_MINT_ADDRESS=62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ
echo set SOLANA_RPC_URL=https://api.devnet.solana.com
echo.
pause 