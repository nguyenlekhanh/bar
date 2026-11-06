@echo off
setlocal EnableExtensions
chcp 65001 >nul

rem ============================================================
rem  Ong Chu MMO Live - stop only what START_TIKTOK_LIVE_BAR.bat started.
rem  The recorded PID is re-validated against its command line so that
rem  unrelated Node.js or Unity processes are never touched.
rem ============================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "RUNTIME=%ROOT%\.runtime"

echo ========================================
echo     DUNG ONG CHU MMO LIVE
echo ========================================
echo.

if not exist "%RUNTIME%" (
    echo Khong co thu muc .runtime - khong co tien trinh nao do launcher nay khoi dong.
    goto :done
)

call :stop_recorded "%RUNTIME%\game.pid" "Build"
call :stop_recorded "%RUNTIME%\bridge.pid" "TikTokBridge"

:done
echo.
echo Da xu ly xong.
ping 127.0.0.1 -n 3 >nul
exit /b 0

rem ---------------------------------------------------------------
rem %1 = pid file, %2 = expected folder fragment of the command line
:stop_recorded
if not exist "%~1" (
    echo [SKIP] Khong co %~nx1 - tien trinh nay chua duoc khoi dong boi launcher.
    exit /b 0
)
set "PID_VALUE="
set /p PID_VALUE=<"%~1"
if not defined PID_VALUE (
    del /q "%~1" >nul 2>&1
    echo [SKIP] File %~nx1 rong, da xoa.
    exit /b 0
)

set "STOP_RESULT="
for /f "usebackq delims=" %%r in (`powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$id = %PID_VALUE%; $expected = '%~2'; $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if (-not $p) { 'GONE'; exit }; $cmd = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id) -ErrorAction SilentlyContinue).CommandLine; if (-not $cmd) { 'GONE'; exit }; if ($cmd -like ('*' + $expected + '*')) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 400; 'STOPPED' } else { 'MISMATCH' }"`) do set "STOP_RESULT=%%r"

del /q "%~1" >nul 2>&1
if /i "%STOP_RESULT%"=="STOPPED" echo [OK] Da dung PID %PID_VALUE% (%~nx1).
if /i "%STOP_RESULT%"=="GONE" echo [OK] PID %PID_VALUE% da tat truoc do.
if /i "%STOP_RESULT%"=="MISMATCH" (
    echo [CANH BAO] PID %PID_VALUE% khong thuoc du an nay - KHONG tat.
    echo            Hay tat chuong trinh do bang tay.
)
if not defined STOP_RESULT (
    echo [CANH BAO] Khong xac minh duoc PID %PID_VALUE% - KHONG tat.
)
exit /b 0
