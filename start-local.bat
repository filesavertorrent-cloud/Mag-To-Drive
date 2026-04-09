@echo off
title Magnet to Google Drive (LOCAL MODE - No Size Limit!)
echo ========================================
echo   Magnet to Google Drive - LOCAL MODE
echo   (No Seedr - No Size Limit!)
echo ========================================
echo.
cd /d "%~dp0"
node server-local.js
echo.
echo Server stopped. Press any key to close...
pause >nul
