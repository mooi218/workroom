@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 or newer from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:4318 in your browser after Workroom starts.
node server.mjs --open
pause
