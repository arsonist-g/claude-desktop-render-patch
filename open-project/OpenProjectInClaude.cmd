@echo off
setlocal
set "PS=powershell.exe -NoProfile -ExecutionPolicy Bypass"
if /i "%~1"=="uninstall" (
  %PS% -File "%~dp0uninstall.ps1"
) else (
  %PS% -File "%~dp0install.ps1" -Scope Machine
)
echo.
pause
