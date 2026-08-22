$ErrorActionPreference = "Stop"

. "$PSScriptRoot\quinn-process-lib.ps1"

$stateDir = $PSScriptRoot
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([timespan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

# No trigger is intentional: the customer button starts this long-running task.
$supervisorAction = New-ScheduledTaskAction -Execute $powerShell `
    -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$stateDir\supervisor-quinn-co.ps1`""
$supervisorTask = New-ScheduledTask -Action $supervisorAction -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $Script:QuinnTaskName -InputObject $supervisorTask -Force | Out-Null

# A prior version pre-warmed Docker after login. Real reboot telemetry showed
# that Docker competed with both OpenClaw gateways for several minutes and its
# Electron dashboard became visible. Docker is optional for Quinn's main chat,
# so remove that legacy task and leave Docker under explicit user control.
Unregister-ScheduledTask -TaskName "Quinn & Co Docker Prewarm" -Confirm:$false -ErrorAction SilentlyContinue

Write-Output "Installed on-demand supervisor '$($Script:QuinnTaskName)'; Docker auto-start is disabled."
