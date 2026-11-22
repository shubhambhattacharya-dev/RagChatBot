@echo off
title RAG ChatBot dev server
cd /d "%~dp0Backend"
echo ===============================================================
echo  RAG ChatBot backend starting - open http://localhost:3000
echo  Keep this window OPEN while using the app (Ctrl+C stops it).
echo ===============================================================
echo.
call bun run dev
echo.
echo ---------------------------------------------------------------
echo The server stopped (exit code %ERRORLEVEL%).
echo If the message above says "Missing required runtime configuration",
echo fill in Backend\.env (copy .env.example and add your keys),
echo then run this file again.
pause
