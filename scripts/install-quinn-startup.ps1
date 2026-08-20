param(
    [string]$Destination = "$env:USERPROFILE\.openclaw-quinn-co",
    [switch]$SkipTaskRegistration
)

$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "quinn-startup"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $Destination "backups\startup-$stamp"
$runtimeFiles = @(
    "start-quinn.ps1",
    "start-quinn-docker.ps1",
    "install-quinn-startup-tasks.ps1",
    "quinn-process-lib.ps1",
    "supervisor-quinn-co.ps1"
)

New-Item -ItemType Directory -Path $Destination, (Join-Path $Destination "tests"), $backup -Force | Out-Null
foreach ($name in $runtimeFiles) {
    $installed = Join-Path $Destination $name
    if (Test-Path -LiteralPath $installed) { Copy-Item -LiteralPath $installed -Destination $backup }
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination $installed -Force
}
Copy-Item -LiteralPath (Join-Path $source "tests\test-quinn-startup.ps1") `
    -Destination (Join-Path $Destination "tests\test-quinn-startup.ps1") -Force

& (Join-Path $Destination "tests\test-quinn-startup.ps1")
if (-not $SkipTaskRegistration) {
    Stop-ScheduledTask -TaskName "Quinn & Co Supervisor" -ErrorAction SilentlyContinue
    & (Join-Path $Destination "install-quinn-startup-tasks.ps1")
}

Write-Output "Installed Quinn one-click startup runtime. Backup: $backup"
