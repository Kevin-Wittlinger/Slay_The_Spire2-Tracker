@echo off
cd /d "%~dp0"
node tools\sync-runs.js %*
echo.
pause
