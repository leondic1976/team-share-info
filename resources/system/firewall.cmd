@echo off
rem TeamHub inbound firewall rules, for private and domain (office) networks only.
rem TeamHub runs this file with administrator rights only after the person pressed
rem the register or remove button for the firewall rules and accepted the Windows prompt.
rem Kept to plain ASCII: cmd.exe reads it in the code page of the PC.
rem
rem   firewall.cmd add-server <tcp-port> <udp-port>   server PC: TeamHub port, server search, the program
rem   firewall.cmd add-app                            member PC: the program (meetings between PCs)
rem   firewall.cmd remove                             delete every rule above
rem
rem Exit codes: 0 done, 2 wrong arguments, 3 netsh failed, 4 TeamHub.exe not found.
setlocal EnableExtensions DisableDelayedExpansion
set "NETSH=%SystemRoot%\System32\netsh.exe"
set "FINDSTR=%SystemRoot%\System32\findstr.exe"
rem the program next to this file: <install>\resources\resources\system\firewall.cmd
for %%I in ("%~dp0..\..\..\TeamHub.exe") do set "EXE=%%~fI"
set "ACTION=%~1"
set "TCP=%~2"
set "UDP=%~3"
if /i not "%ACTION%"=="remove" if /i not "%ACTION%"=="add-server" if /i not "%ACTION%"=="add-app" exit /b 2
set "PORTS_OK=1"
echo(%TCP%| "%FINDSTR%" /r /x "[1-9][0-9]*" >nul || set "PORTS_OK="
echo(%UDP%| "%FINDSTR%" /r /x "[1-9][0-9]*" >nul || set "PORTS_OK="
if /i "%ACTION%"=="add-server" if not defined PORTS_OK exit /b 2
if /i not "%ACTION%"=="remove" if not exist "%EXE%" exit /b 4

"%NETSH%" advfirewall firewall delete rule name="TeamHub Server TCP" >nul 2>&1
"%NETSH%" advfirewall firewall delete rule name="TeamHub Discovery UDP" >nul 2>&1
"%NETSH%" advfirewall firewall delete rule name="TeamHub App" >nul 2>&1
if /i "%ACTION%"=="remove" exit /b 0

"%NETSH%" advfirewall firewall add rule name="TeamHub App" dir=in action=allow program="%EXE%" enable=yes profile=private,domain >nul || exit /b 3
if /i "%ACTION%"=="add-app" exit /b 0
"%NETSH%" advfirewall firewall add rule name="TeamHub Server TCP" dir=in action=allow protocol=TCP localport=%TCP% profile=private,domain >nul || exit /b 3
"%NETSH%" advfirewall firewall add rule name="TeamHub Discovery UDP" dir=in action=allow protocol=UDP localport=%UDP% profile=private,domain >nul || exit /b 3
exit /b 0
