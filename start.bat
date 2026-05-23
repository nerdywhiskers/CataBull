@echo off
title CataBull dashboard
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo   Node.js is required but not found.
    echo   Download it from https://nodejs.org
    echo.
    pause
    exit /b 1
)
node "%~dp0start.mjs"
pause
