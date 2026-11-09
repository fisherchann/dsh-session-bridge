@echo off
setlocal
set "DSH_SESSION_BIN=%~dp0dsh-session.mjs"
node "%DSH_SESSION_BIN%" %*
exit /b %ERRORLEVEL%