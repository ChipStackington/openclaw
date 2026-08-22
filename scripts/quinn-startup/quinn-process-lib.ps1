# Quinn & Co. shared process library.
# quinn-paths.json scopes paths, ports, tasks, mutexes, process matching, and
# child launches to one instance. Without it, live WW defaults remain intact.

$Script:QuinnPathsFile = Join-Path $PSScriptRoot "quinn-paths.json"
$Script:QuinnStateDir = "C:\Users\jared\.openclaw-quinn-co"
$Script:QuinnWorkspace = "C:\AI\quinn-co\workspace"
$Script:QuinnMCDir = "C:\Users\jared\Projects\mission-control"
$Script:QuinnNodeExe = "C:\Program Files\nodejs\node.exe"
$Script:QuinnTaskName = "Quinn & Co Supervisor"
$Script:QuinnServiceMarker = "openclaw-quinn-co"
$Script:QuinnPorts = @{
    Gateway = 19100; Proxy = 19101; Dashboard = 4242; Marketplace = 4246
    Webhook = 4244; Admin = 4245; MC = 3000
}
$Script:QuinnHasPathsFile = $false

if (Test-Path -LiteralPath $Script:QuinnPathsFile) {
    try {
        $paths = Get-Content -LiteralPath $Script:QuinnPathsFile -Raw | ConvertFrom-Json
        $Script:QuinnHasPathsFile = $true
        if ($paths.stateDir) { $Script:QuinnStateDir = [string]$paths.stateDir }
        if ($paths.workspace) { $Script:QuinnWorkspace = [string]$paths.workspace }
        if ($paths.mcDir) { $Script:QuinnMCDir = [string]$paths.mcDir }
        if ($paths.nodeExe) { $Script:QuinnNodeExe = [string]$paths.nodeExe }
        if ($paths.taskName) { $Script:QuinnTaskName = [string]$paths.taskName }
        if ($paths.serviceMarker) { $Script:QuinnServiceMarker = [string]$paths.serviceMarker }
        if ($paths.ports) {
            foreach ($mapping in @(
                @{ Json = "gateway"; Name = "Gateway" }, @{ Json = "proxy"; Name = "Proxy" },
                @{ Json = "dashboard"; Name = "Dashboard" }, @{ Json = "marketplace"; Name = "Marketplace" },
                @{ Json = "webhook"; Name = "Webhook" }, @{ Json = "admin"; Name = "Admin" },
                @{ Json = "mc"; Name = "MC" }
            )) {
                $value = $paths.ports.($mapping.Json)
                if ($null -ne $value) { $Script:QuinnPorts[$mapping.Name] = [int]$value }
            }
        }
    } catch { throw "quinn-paths.json is unreadable: $_" }
}

$Script:QuinnLauncherMutexName = "Local\QuinnCoLauncher-$($Script:QuinnServiceMarker)"
$Script:QuinnSupervisorMutexName = "Local\QuinnCoSupervisor-$($Script:QuinnServiceMarker)"

if ($Script:QuinnHasPathsFile) {
    $workspacePattern = [regex]::Escape($Script:QuinnWorkspace)
    $mcPattern = [regex]::Escape($Script:QuinnMCDir)
    $Script:QuinnRegex = @{
        Gateway = ('{0}|--port {1}\b' -f [regex]::Escape($Script:QuinnServiceMarker), $Script:QuinnPorts.Gateway)
        Proxy = ('{0}.*gateway-proxy\.js' -f $mcPattern)
        Admin = ('{0}.*admin[/\\]server\.ts' -f $workspacePattern)
        Marketplace = ('{0}.*marketplace[/\\]server\.ts' -f $workspacePattern)
        Dashboard = ('{0}.*dashboard[/\\]server\.ts' -f $workspacePattern)
        MC = ('{0}.*next[\\/]dist[\\/]bin[\\/]next"? start' -f $mcPattern)
    }
} else {
    $Script:QuinnRegex = @{
        Gateway = 'openclaw-quinn-co|--port 19100\b'
        Proxy = 'gateway-proxy\.js'
        Admin = 'admin[/\\]server\.ts'
        Marketplace = 'marketplace[/\\]server\.ts'
        Dashboard = 'dashboard[/\\]server\.ts'
        MC = 'mission-control.*(next.*dev|next.*start|start-server\.js|postcss\.js)|node_modules[\\/]+next[\\/]+dist[\\/]+bin[\\/]+next"? start -p 3000'
    }
}

function Stop-QuinnService {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$DisplayName, [Parameter(Mandatory)][string]$Regex)
    $found = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $Regex }
    if (-not $found) { Write-Host "  $DisplayName : not running" -ForegroundColor DarkGray; return @() }
    $processIds = @($found | Select-Object -ExpandProperty ProcessId)
    Write-Host "  Stopping $DisplayName (PIDs: $($processIds -join ', '))..." -ForegroundColor Yellow
    foreach ($processId in $processIds) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
    return $processIds
}

function Stop-AllQuinnServices {
    Write-Host "Stopping Quinn & Co. services..." -ForegroundColor Cyan
    foreach ($entry in @(
        @("Mission Control", "MC"), @("Dashboard server", "Dashboard"), @("Marketplace", "Marketplace"),
        @("Admin server", "Admin"), @("Gateway proxy", "Proxy"), @("Gateway", "Gateway")
    )) { Stop-QuinnService -DisplayName $entry[0] -Regex $Script:QuinnRegex[$entry[1]] | Out-Null }
}

function Test-QuinnPortsFree {
    $ports = @{}
    foreach ($entry in @(
        @("MC", "Mission Control"), @("Dashboard", "Dashboard server"), @("Marketplace", "Marketplace"),
        @("Webhook", "Webhook"), @("Admin", "Admin server"), @("Gateway", "Gateway"), @("Proxy", "Gateway proxy")
    )) { $ports[$Script:QuinnPorts[$entry[0]]] = $entry[1] }
    $allFree = $true
    foreach ($port in ($ports.Keys | Sort-Object)) {
        if (@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -gt 0) {
            Write-Host "  Port $port ($($ports[$port])) : STILL LISTENING" -ForegroundColor Red; $allFree = $false
        } else { Write-Host "  Port $port ($($ports[$port])) : free" -ForegroundColor Green }
    }
    return $allFree
}

function Get-QuinnEnvValue {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Key)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $line = @(Get-Content -LiteralPath $Path | Where-Object { $_ -match "^$([regex]::Escape($Key))=" })[0]
    if (-not $line) { return $null }
    return $line.Split("=", 2)[1].Trim()
}

function Test-QuinnServiceHealth {
    param([Parameter(Mandatory)][string]$Url)
    try { Invoke-WebRequest -Uri $Url -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop | Out-Null; return $true }
    catch { return $false }
}

function Get-QuinnServiceStartupGraceSeconds {
    param([Parameter(Mandatory)][string]$Name)
    $grace = @{ Gateway = 240; Proxy = 90; Admin = 120; Marketplace = 120; Dashboard = 180; MC = 180 }
    if (-not $grace.ContainsKey($Name)) { throw "Unknown Quinn service: $Name" }
    return $grace[$Name]
}

function Test-QuinnServiceRestartDue {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][datetime]$StartedAt, [datetime]$Now = (Get-Date))
    if ($StartedAt -eq [datetime]::MinValue) { return $true }
    return (($Now - $StartedAt).TotalSeconds -ge (Get-QuinnServiceStartupGraceSeconds -Name $Name))
}

function Test-QuinnDockerEngineReady {
    $dockerExe = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
    if (-not (Test-Path -LiteralPath $dockerExe)) { return $false }
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $dockerExe; $startInfo.Arguments = 'info --format "{{.ServerVersion}}"'
    $startInfo.UseShellExecute = $false; $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true; $startInfo.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process; $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { return $false }
        if (-not $process.WaitForExit(5000)) { try { $process.Kill() } catch {}; return $false }
        return ($process.ExitCode -eq 0)
    } catch { return $false } finally { $process.Dispose() }
}
function Test-QuinnDockerDesktopRunning {
    return (@(Get-Process -Name "Docker Desktop", "com.docker.backend" -ErrorAction SilentlyContinue).Count -gt 0)
}
function Get-QuinnDockerStartupAction {
    param([bool]$Ready, [bool]$DesktopRunning)
    if ($Ready) { return "Ready" }; if ($DesktopRunning) { return "Wait" }; return "Start"
}
function Start-QuinnDockerDesktop {
    $action = Get-QuinnDockerStartupAction -Ready (Test-QuinnDockerEngineReady) -DesktopRunning (Test-QuinnDockerDesktopRunning)
    if ($action -ne "Ready") {
        $dockerExe = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
        if (Test-Path -LiteralPath $dockerExe) {
            Start-Process -FilePath $dockerExe -ArgumentList "desktop", "start", "--detach" -WindowStyle Hidden | Out-Null
        }
    }
    return $action
}

function Send-QuinnAlert {
    param([Parameter(Mandatory)][string]$Title, [Parameter(Mandatory)][string]$Message)
    $topic = Get-QuinnEnvValue -Path (Join-Path $Script:QuinnWorkspace ".env") -Key "NTFY_TOPIC"
    if (-not $topic) { return }
    try { Invoke-RestMethod -Uri "https://ntfy.sh/$topic" -Method Post -Body $Message -Headers @{ Title = $Title } -TimeoutSec 10 | Out-Null }
    catch { Write-Host "  ntfy alert failed: $_" -ForegroundColor DarkYellow }
}

$Script:QuinnServices = [ordered]@{
    Gateway = @{
        Health = "http://127.0.0.1:$($Script:QuinnPorts.Gateway)/"; Regex = $Script:QuinnRegex.Gateway
        Start = {
            $reset = Join-Path $Script:QuinnStateDir "reset-to-economy.py"
            if (Test-Path -LiteralPath $reset) { try { & python $reset 2>&1 | Out-Null } catch {} }
            $sync = Join-Path $Script:QuinnWorkspace "scripts\sync-agent-workspaces.mjs"
            if (Test-Path -LiteralPath $sync) { try { & $Script:QuinnNodeExe $sync 2>&1 | Out-Null } catch {} }
            Start-Process -FilePath (Join-Path $Script:QuinnStateDir "gateway-quinn-co.cmd") -WindowStyle Hidden | Out-Null
        }
    }
    Proxy = @{
        Health = "http://127.0.0.1:$($Script:QuinnPorts.Proxy)/"; Regex = $Script:QuinnRegex.Proxy
        Start = {
            $oldPort = $env:PROXY_PORT; $oldBind = $env:PROXY_BIND; $oldGateway = $env:GATEWAY_URL
            try {
                $env:PROXY_PORT = [string]$Script:QuinnPorts.Proxy; $env:PROXY_BIND = "127.0.0.1"
                $env:GATEWAY_URL = "http://127.0.0.1:$($Script:QuinnPorts.Gateway)"
                Start-Process -FilePath $Script:QuinnNodeExe -ArgumentList "`"$Script:QuinnMCDir\gateway-proxy.js`"" -WorkingDirectory $Script:QuinnMCDir -WindowStyle Hidden | Out-Null
            } finally { $env:PROXY_PORT = $oldPort; $env:PROXY_BIND = $oldBind; $env:GATEWAY_URL = $oldGateway }
        }
    }
    Admin = @{
        Health = "http://127.0.0.1:$($Script:QuinnPorts.Admin)/admin/ping"; Regex = $Script:QuinnRegex.Admin
        Start = {
            $tsx = Join-Path $Script:QuinnWorkspace "node_modules\tsx\dist\cli.mjs"
            $oldKey = $env:ADMIN_API_KEY; $oldPort = $env:ADMIN_PORT; $oldData = $env:DATA_DIR
            try {
                $env:ADMIN_API_KEY = Get-QuinnEnvValue -Path (Join-Path $Script:QuinnStateDir ".env") -Key "ADMIN_API_KEY"
                $env:ADMIN_PORT = [string]$Script:QuinnPorts.Admin; $env:DATA_DIR = "data"
                Start-Process -FilePath $Script:QuinnNodeExe -ArgumentList "`"$tsx`"", "admin/server.ts" -WorkingDirectory $Script:QuinnWorkspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Script:QuinnStateDir "logs\admin.log") -RedirectStandardError (Join-Path $Script:QuinnStateDir "logs\admin-error.log") | Out-Null
            } finally { $env:ADMIN_API_KEY = $oldKey; $env:ADMIN_PORT = $oldPort; $env:DATA_DIR = $oldData }
        }
    }
    Marketplace = @{
        Health = "http://127.0.0.1:$($Script:QuinnPorts.Marketplace)/marketplace/ping"; Regex = $Script:QuinnRegex.Marketplace
        Start = {
            $tsx = Join-Path $Script:QuinnWorkspace "node_modules\tsx\dist\cli.mjs"
            $oldKey = $env:ADMIN_API_KEY; $oldPort = $env:MARKETPLACE_PORT; $oldData = $env:DATA_DIR
            try {
                $env:ADMIN_API_KEY = Get-QuinnEnvValue -Path (Join-Path $Script:QuinnStateDir ".env") -Key "ADMIN_API_KEY"
                $env:MARKETPLACE_PORT = [string]$Script:QuinnPorts.Marketplace; $env:DATA_DIR = "data"
                Start-Process -FilePath $Script:QuinnNodeExe -ArgumentList "`"$tsx`"", "marketplace/server.ts" -WorkingDirectory $Script:QuinnWorkspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Script:QuinnStateDir "logs\marketplace.log") -RedirectStandardError (Join-Path $Script:QuinnStateDir "logs\marketplace-error.log") | Out-Null
            } finally { $env:ADMIN_API_KEY = $oldKey; $env:MARKETPLACE_PORT = $oldPort; $env:DATA_DIR = $oldData }
        }
    }
    Dashboard = @{
        Health = "http://127.0.0.1:$($Script:QuinnPorts.Dashboard)/"; Regex = $Script:QuinnRegex.Dashboard
        Start = {
            $tsx = Join-Path $Script:QuinnWorkspace "node_modules\tsx\dist\cli.mjs"
            $oldPort = $env:DASHBOARD_PORT; $oldData = $env:DATA_DIR
            try {
                $env:DASHBOARD_PORT = [string]$Script:QuinnPorts.Dashboard; $env:DATA_DIR = "data"
                Start-Process -FilePath $Script:QuinnNodeExe -ArgumentList "`"$tsx`"", "--env-file=.env", "dashboard/server.ts" -WorkingDirectory $Script:QuinnWorkspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Script:QuinnWorkspace "dashboard-debug.log") -RedirectStandardError (Join-Path $Script:QuinnStateDir "logs\dashboard-error.log") | Out-Null
            } finally { $env:DASHBOARD_PORT = $oldPort; $env:DATA_DIR = $oldData }
        }
    }
    MC = @{
        Health = "http://localhost:$($Script:QuinnPorts.MC)/"; Regex = $Script:QuinnRegex.MC
        Start = {
            $next = Join-Path $Script:QuinnMCDir "node_modules\next\dist\bin\next"
            Start-Process -FilePath $Script:QuinnNodeExe -ArgumentList "`"$next`"", "start", "-p", ([string]$Script:QuinnPorts.MC) -WorkingDirectory $Script:QuinnMCDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Script:QuinnStateDir "logs\mc.log") -RedirectStandardError (Join-Path $Script:QuinnStateDir "logs\mc-error.log") | Out-Null
        }
    }
}

function Start-QuinnServiceProcess {
    param([Parameter(Mandatory)][string]$Name)
    $service = $Script:QuinnServices[$Name]
    if (-not $service) { throw "Unknown Quinn service: $Name" }
    & $service.Start
}
