@echo off
plink -ssh root@195.246.231.53 -pw abraKadab1a "cd /var/qnet-fresh/applications/qnet-explorer/frontend && pm2 list && pm2 restart all && pm2 save"
pause


