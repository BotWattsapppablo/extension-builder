@echo off
rem Launches the Yomi Builder desktop app.
cd /d "%~dp0"
node start-app.mjs
if errorlevel 1 pause
