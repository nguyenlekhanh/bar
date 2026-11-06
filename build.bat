@echo off
setlocal EnableExtensions
chcp 65001 >nul

set "ROOT=%~dp0"
set "PROJECT_DIR=%ROOT%UnityProject"
set "OUTPUT_EXE=%ROOT%Build\OngChuMMO_Live.exe"
set "LOG_FILE=%ROOT%build_log.txt"
set "PROJECT_VERSION="

for /f "tokens=2 delims=:" %%v in ('findstr /b "m_EditorVersion:" "%PROJECT_DIR%\ProjectSettings\ProjectVersion.txt" 2^>nul') do for /f "tokens=*" %%w in ("%%v") do set "PROJECT_VERSION=%%w"

if not defined PROJECT_VERSION (
    echo [LOI] Khong doc duoc phien ban Unity tu ProjectVersion.txt.
    goto :failed
)

echo =======================================
echo     BUILD GAME ONG CHU MMO LIVE
echo =======================================
echo Unity can dung: %PROJECT_VERSION%
echo Output: %OUTPUT_EXE%
echo.

rem Unity co the duoc cai o nhieu vi tri; kiem tra tat ca truoc khi ket luan.
set "UNITY_EXE=%TIKTOK_UNITY_EXE%"
if defined UNITY_EXE if not exist "%UNITY_EXE%" (
    echo [CANH BAO] TIKTOK_UNITY_EXE khong ton tai: %UNITY_EXE%
    set "UNITY_EXE="
)

set "UNITY_ROOTS=UNITY_ROOT_PLACEHOLDER;D:\AI\Unity\Editors;C:\Program Files\Unity\Hub\Editor;D:\Program Files\Unity\Hub\Editor;C:\Program Files\Unity;D:\Unity\Hub\Editor"
set "UNITY_ROOTS=%UNITY_ROOTS:UNITY_ROOT_PLACEHOLDER=%UNITY_ROOT%"
if not defined UNITY_EXE for %%R in ("%UNITY_ROOTS:;=" "%") do (
    if not defined UNITY_EXE if exist "%%~R\%PROJECT_VERSION%\Editor\Unity.exe" set "UNITY_EXE=%%~R\%PROJECT_VERSION%\Editor\Unity.exe"
)

if not defined UNITY_EXE (
    for /f "delims=" %%E in ('dir /b /ad /o-n "%UNITY_ROOT%\Editors" "D:\AI\Unity\Editors" "C:\Program Files\Unity\Hub\Editor" "D:\Program Files\Unity\Hub\Editor" 2^>nul') do (
        if not defined UNITY_FALLBACK if exist "%UNITY_ROOT%\Editors\%%E\Editor\Unity.exe" set "UNITY_FALLBACK=%UNITY_ROOT%\Editors\%%E\Editor\Unity.exe"
        if not defined UNITY_FALLBACK if exist "D:\AI\Unity\Editors\%%E\Editor\Unity.exe" set "UNITY_FALLBACK=D:\AI\Unity\Editors\%%E\Editor\Unity.exe"
        if not defined UNITY_FALLBACK if exist "C:\Program Files\Unity\Hub\Editor\%%E\Editor\Unity.exe" set "UNITY_FALLBACK=C:\Program Files\Unity\Hub\Editor\%%E\Editor\Unity.exe"
        if not defined UNITY_FALLBACK if exist "D:\Program Files\Unity\Hub\Editor\%%E\Editor\Unity.exe" set "UNITY_FALLBACK=D:\Program Files\Unity\Hub\Editor\%%E\Editor\Unity.exe"
    )
)

if not defined UNITY_EXE if defined UNITY_FALLBACK (
    echo [CANH BAO] Chua cai dung Unity %PROJECT_VERSION%.
    echo [CANH BAO] Tam dung Unity da cai: %UNITY_FALLBACK%
    echo [CANH BAO] Unity se nang cap project mot chieu. Hay sao luu truoc khi build ban phan phoi.
    set "UNITY_EXE=%UNITY_FALLBACK%"
)

if not defined UNITY_EXE (
    echo [LOI] Khong tim thay Unity Editor %PROJECT_VERSION% tren may.
    echo Hay cai bang Unity Hub, hoac dat bien TIKTOK_UNITY_EXE tro toi Unity.exe.
    goto :failed
)

if not exist "%ROOT%Build" mkdir "%ROOT%Build"
"%UNITY_EXE%" -quit -batchmode -projectPath "%PROJECT_DIR%" -buildWindows64Player "%OUTPUT_EXE%" -logFile "%LOG_FILE%"
set "BUILD_RESULT=%ERRORLEVEL%"

if not "%BUILD_RESULT%"=="0" (
    echo [LOI] Unity build that bai ^(ma loi %BUILD_RESULT%^).
    echo Xem log: %LOG_FILE%
    goto :failed
)

if not exist "%OUTPUT_EXE%" (
    echo [LOI] Unity khong tao file %OUTPUT_EXE%.
    echo Xem log: %LOG_FILE%
    goto :failed
)

echo.
echo Build thanh cong: %OUTPUT_EXE%
pause
exit /b 0

:failed
echo.
pause
exit /b 1
