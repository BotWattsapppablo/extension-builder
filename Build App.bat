@echo off
rem Launches the MihonPC Extension Builder desktop app.
cd /d "%~dp0"
node start-app.mjs
if errorlevel 1 pause
