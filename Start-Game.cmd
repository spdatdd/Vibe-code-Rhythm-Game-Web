@echo off
rem Mo may chu game cuc bo bang Node trong PATH hoac runtime Codex tren may.
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel% equ 0 (
  node server.mjs
) else (
  "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.mjs
)
pause
