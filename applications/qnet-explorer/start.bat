@echo off
echo Starting Qnet Explorer...
echo.
cd frontend
echo Installing dependencies if needed...
call npm install
echo.
echo Starting development server...
echo Open http://localhost:3000 in your browser
echo.
call npm run dev 