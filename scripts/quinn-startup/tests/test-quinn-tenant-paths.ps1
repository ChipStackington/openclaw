$ErrorActionPreference = "Stop"

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) { throw "$Message (expected=$Expected actual=$Actual)" }
}

function Assert-Match {
    param([string]$Text, [string]$Pattern, [string]$Message)
    if ($Text -notmatch $Pattern) { throw "$Message (actual=$Text)" }
}

function Assert-True {
    param([bool]$Actual, [string]$Message)
    if (-not $Actual) { throw $Message }
}

$source = Join-Path (Split-Path -Parent $PSScriptRoot) "quinn-process-lib.ps1"
$scratch = Join-Path $env:TEMP ("quinn-tenant-paths-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    Copy-Item -LiteralPath $source -Destination (Join-Path $scratch "quinn-process-lib.ps1")
    @'
{
  "stateDir": "C:\\scratch\\tenant-state",
  "workspace": "C:\\scratch\\tenant-workspace",
  "mcDir": "C:\\scratch\\tenant-mc",
  "nodeExe": "C:\\Program Files\\nodejs\\node.exe",
  "taskName": "Quinn & Co Supervisor (tenant-test)",
  "serviceMarker": "openclaw-tenant-test",
  "ports": {
    "gateway": 29100,
    "proxy": 29101,
    "dashboard": 14242,
    "marketplace": 14246,
    "webhook": 14244,
    "admin": 14245,
    "mc": 13000
  }
}
'@ | Set-Content -LiteralPath (Join-Path $scratch "quinn-paths.json") -Encoding utf8

    . (Join-Path $scratch "quinn-process-lib.ps1")

    Assert-Equal $true $Script:QuinnHasPathsFile "Tenant paths file was not loaded"
    Assert-Equal "C:\scratch\tenant-workspace" $Script:QuinnWorkspace "Workspace path did not parameterize"
    Assert-Equal 14246 $Script:QuinnPorts.Marketplace "Marketplace port did not parameterize"
    Assert-Equal "Quinn & Co Supervisor (tenant-test)" $Script:QuinnTaskName "Task name did not parameterize"
    Assert-Equal "Local\QuinnCoLauncher-openclaw-tenant-test" $Script:QuinnLauncherMutexName "Launcher mutex is not tenant-scoped"
    Assert-Equal "Local\QuinnCoSupervisor-openclaw-tenant-test" $Script:QuinnSupervisorMutexName "Supervisor mutex is not tenant-scoped"
    Assert-Equal "http://127.0.0.1:14246/marketplace/ping" $Script:QuinnServices.Marketplace.Health "Marketplace health URL is stale"
    Assert-True $Script:QuinnRegex.Admin.Contains([regex]::Escape("C:\scratch\tenant-workspace")) "Admin regex is not path-anchored"
    Assert-True $Script:QuinnRegex.MC.Contains([regex]::Escape("C:\scratch\tenant-mc")) "Mission Control regex is not path-anchored"
    Assert-Match $Script:QuinnRegex.Gateway '29100' "Gateway regex is not port-scoped"
    Write-Output "PASS: Quinn tenant path contract"
} finally {
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
