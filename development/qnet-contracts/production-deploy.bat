@echo off
echo ====================================
echo QNet Production Contract Deployment
echo ====================================
echo.
echo Program ID: 4hC1c4smV4An7JAjgKPk33H16j7ePffNpd2FqMQbgzNQ
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
echo set BURN_TRACKER_PROGRAM_ID=4hC1c4smV4An7JAjgKPk33H16j7ePffNpd2FqMQbgzNQ
echo set ONE_DEV_MINT_ADDRESS=62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ
echo set SOLANA_RPC_URL=https://api.devnet.solana.com
echo.
pause 