@echo off
title SFDC Middleware ^& Token Gateway (Port 4000)
cd /d "%~dp0"

echo ========================================================
echo   SFDC Middleware ^& Central Token Gateway
echo   Port: 4000
echo ========================================================
echo.

node api-server.js
pause
