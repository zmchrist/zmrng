@echo off
REM zmrng Windows setup wizard launcher.
REM Double-click this file, or run it from a terminal. It runs setup.ps1 with an
REM execution-policy bypass so you don't have to change any PowerShell settings.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
pause
