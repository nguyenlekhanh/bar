@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

rem ============================================================
rem  ONG CHU MMO LIVE - one-click launcher
rem  Starts the Node bridge, Control Panel and the Unity game.
rem  Every started process is recorded in .runtime so that
rem  STOP_TIKTOK_LIVE_BAR.bat only stops this project.
rem ============================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "BRIDGE_DIR=%ROOT%\TikTokBridge"
set "RUNTIME=%ROOT%\.runtime"
set "GAME_EXE="

rem --- Keep temporary files and the npm cache on D: -------------------
if not exist "D:\AI\temp" mkdir "D:\AI\temp" 2>nul
if not exist "D:\AI\cache\npm" mkdir "D:\AI\cache\npm" 2>nul
set "TEMP=D:\AI\temp"
set "TMP=D:\AI\temp"
set "npm_config_cache=D:\AI\cache\npm"
if not exist "%RUNTIME%" mkdir "%RUNTIME%" 2>nul

echo ========================================
echo     KHOI DONG ONG CHU MMO LIVE
echo ========================================
echo Project : %ROOT%
echo TEMP    : %TEMP%
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [LOI] Khong tim thay Node.js trong PATH.
    echo Hay cai Node.js 20 tro len: https://nodejs.org/  roi chay lai.
    goto :failed
)
if not exist "%BRIDGE_DIR%\package.json" (
    echo [LOI] Khong tim thay TikTokBridge\package.json trong:
    echo       %BRIDGE_DIR%
    goto :failed
)

rem --- Dependency check -----------------------------------------------
if not exist "%BRIDGE_DIR%\node_modules\express\package.json" (
    echo [1/4] Dang cai dat thu vien Node.js...
    pushd "%BRIDGE_DIR%"
    if exist package-lock.json (
        call npm ci
    ) else (
        call npm install
    )
    if errorlevel 1 (
        popd
        echo [LOI] npm install khong thanh cong. Kiem tra ket noi Internet roi thu lai.
        goto :failed
    )
    popd
) else (
    echo [1/4] Thu vien Node.js da san sang.
)

rem --- Configured port -------------------------------------------------
set "BRIDGE_PORT=3000"
pushd "%BRIDGE_DIR%"
for /f "usebackq delims=" %%p in (`node -e "const e=require('./src/config/environment');e.loadEnvironmentFile();process.stdout.write(String(e.getServerSettings().port))"`) do set "BRIDGE_PORT=%%p"
popd
set "HEALTH_URL=http://127.0.0.1:%BRIDGE_PORT%/api/health"
set "CONTROL_URL=http://127.0.0.1:%BRIDGE_PORT%/control.html"

rem --- Do not start a second bridge ------------------------------------
call :bridge_is_ready
if defined BRIDGE_READY (
    call :kill_recorded "%RUNTIME%\bridge.pid" node
    echo [2/4] TikTok Bridge da chay san tren cong %BRIDGE_PORT%.
    goto :launch_game
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":%BRIDGE_PORT% .*LISTENING" 2^>nul') do (
    if not defined PORT_PID set "PORT_PID=%%a"
)
if defined PORT_PID (
    echo [LOI] Cong %BRIDGE_PORT% dang bi chuong trinh khac dung ^(PID %PORT_PID%^).
    echo Launcher khong tu tat chuong trinh khac. Hay dong no roi chay lai.
    goto :failed
)

echo [2/4] Dang khoi dong TikTok Bridge...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; $p = Start-Process -FilePath 'node' -ArgumentList '"%BRIDGE_DIR%\server.js"' -WorkingDirectory '%BRIDGE_DIR%' -WindowStyle Minimized -RedirectStandardOutput '%RUNTIME%\bridge.log' -RedirectStandardError '%RUNTIME%\bridge.err.log' -PassThru; $p.Id | Out-File -Encoding ascii -NoNewline '%RUNTIME%\bridge.pid'; Write-Host ('Bridge PID ' + $p.Id)"
if errorlevel 1 (
    echo [LOI] Khong the khoi dong Node. Xem %RUNTIME%\bridge.err.log
    goto :failed
)

set "BRIDGE_READY="
for /l %%i in (1,1,40) do (
    if not defined BRIDGE_READY (
        call :bridge_is_ready
        if not defined BRIDGE_READY ping 127.0.0.1 -n 2 >nul
    )
)
if not defined BRIDGE_READY (
    echo [LOI] TikTok Bridge khong phan hoi sau 40 giay.
    echo Xem log: %RUNTIME%\bridge.log va %RUNTIME%\bridge.err.log
    goto :failed
)
echo [OK] Bridge san sang: %HEALTH_URL%

:launch_game
echo [3/4] Dang mo Control Panel...
start "" "%CONTROL_URL%"

if not "%BRIDGE_PORT%"=="3000" (
    echo [CANH BAO] Game dung san chi ket noi cong 3000; Bridge dang o cong %BRIDGE_PORT%.
    goto :done
)

if exist "%ROOT%\Build\OngChuMMO_Live.exe" set "GAME_EXE=%ROOT%\Build\OngChuMMO_Live.exe"
if not defined GAME_EXE if exist "%ROOT%\Build\TIKTOK_LIVE_BAR.exe" set "GAME_EXE=%ROOT%\Build\TIKTOK_LIVE_BAR.exe"
if not defined GAME_EXE if exist "%ROOT%\UnityProject\Builds\TikTokLiveGameUnity.exe" set "GAME_EXE=%ROOT%\UnityProject\Builds\TikTokLiveGameUnity.exe"

if defined GAME_EXE (
    call :game_running
    if defined GAME_RUNNING (
        echo [4/4] Game da chay - khong mo trung.
        goto :done
    )
    echo [4/4] Dang mo Game: %GAME_EXE%
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "$ErrorActionPreference='Stop'; $p = Start-Process -FilePath '%GAME_EXE%' -WorkingDirectory '%ROOT%\Build' -PassThru; $p.Id | Out-File -Encoding ascii -NoNewline '%RUNTIME%\game.pid'"
    if errorlevel 1 echo [CANH BAO] Khong the mo Game. Hay mo file tren bang tay.
) else (
    echo [4/4] [CANH BAO] Chua co file game trong Build.
    echo        Chay build.bat sau khi cai Unity 6, hoac mo UnityProject bang Unity Hub.
)

:done
echo.
echo Da khoi dong xong.
echo   Control Panel : %CONTROL_URL%
echo   Doi live      : mo TikFinity Desktop, sau do nhap username TikTok trong Control Panel.
echo   Dung tat ca   : chay STOP_TIKTOK_LIVE_BAR.bat
exit /b 0

rem ---------------------------------------------------------------
:bridge_is_ready
set "BRIDGE_READY="
for /f "usebackq delims=" %%r in (`powershell -NoProfile -Command "try { $h = Invoke-RestMethod -Uri '%HEALTH_URL%' -TimeoutSec 2; if ($h.status -eq 'ok' -and $h.appId -eq 'ongchu-mmo-live-bridge') { 'YES' } } catch {}"`) do set "BRIDGE_READY=%%r"
exit /b 0

:game_running
set "GAME_RUNNING="
if not exist "%RUNTIME%\game.pid" exit /b 0
set /p OLD_GAME_PID=<"%RUNTIME%\game.pid"
if defined OLD_GAME_PID (
    for /f "usebackq delims=" %%c in (`powershell -NoProfile -Command "if (Get-Process -Id !OLD_GAME_PID! -ErrorAction SilentlyContinue) { 'YES' }"`) do set "GAME_RUNNING=%%c"
)
exit /b 0

:kill_recorded
rem Removes a stale pid file when the recorded process is gone.
if not exist "%~1" exit /b 0
set "STALE_PID="
set /p STALE_PID=<"%~1"
if not defined STALE_PID del /q "%~1" >nul 2>&1 & exit /b 0
for /f "usebackq delims=" %%c in (`powershell -NoProfile -Command "if (Get-Process -Id !STALE_PID! -ErrorAction SilentlyContinue) { 'ALIVE' }"`) do (
    if /i "%%c"=="ALIVE" exit /b 0
)
del /q "%~1" >nul 2>&1
exit /b 0

:failed
echo.
echo [THAT BAI] Xem thong bao loi o tren.
echo Thu muc log: %RUNTIME%
pause
exit /b 1
