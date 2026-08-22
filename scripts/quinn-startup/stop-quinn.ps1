. "$PSScriptRoot\quinn-process-lib.ps1"

$ErrorActionPreference = "Stop"
Disable-ScheduledTask -TaskName $Script:QuinnTaskName -ErrorAction SilentlyContinue | Out-Null
Stop-AllQuinnServices
Write-Host "Stopped '$($Script:QuinnTaskName)'." -ForegroundColor Green
