@echo off
title Magnet to Google Drive Server
echo ========================================
echo   Magnet to Google Drive - Starting...
echo ========================================
echo.
cd /d "%~dp0"
node server.js
echo.
echo Server stopped. Press any key to close...
pause >nul
