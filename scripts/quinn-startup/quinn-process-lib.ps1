# Quinn & Co. â€” Shared Process Library
# Dot-sourced by launch-quinn-co.ps1 and stop-quinn-co.ps1.
# Single source of truth for kill regexes and Stop-QuinnService helper.
#
# SAFETY RULE (per memory feedback_gateway_restart_safe.md):
# Never use `Stop-Process -Name 'node' -Force`. Always match by command-line
# regex so Claude Code's own node processes survive. The 2025-03-25 incident
# crashed mid-conversation when a previous agent killed all node.exe.

# Canonical regexes per service. Anchored on command-line patterns that are
# unique to each service so Stop-QuinnService never matches Claude Code,
# VS Code servers, npm caches, or other innocent node processes.
$Script:QuinnRegex = @{
    Gateway   = 'openclaw-quinn-co|--port 19100\b'
    Proxy     = 'gateway-proxy\.js'
    Admin     = 'admin[/\\]server\.ts'
    Dashboard = 'dashboard[/\\]server\.ts'
    MC        = 'mission-control.*(next.*dev|next.*start|start-server\.js|postcss\.js)|node_modules[\\/]+next[\\/]+dist[\\/]+bin[\\/]+next"? start -p 3000'
}

function Stop-QuinnService {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $DisplayName,
        [Parameter(Mandatory)] [string] $Regex
    )

    $found = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match $Regex }

    if (-not $found) {
        Write-Host "  $DisplayName : not running" -ForegroundColor DarkGray
        return @()
    }

    $procIds = @($found | Select-Object -ExpandProperty ProcessId)
    Write-Host "  Stopping $DisplayName (PIDs: $($procIds -join ', '))..." -ForegroundColor Yellow
    foreach ($p in $procIds) {
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
    return $procIds
}

function Stop-AllQuinnServices {
    # Order matters: kill MC first (it depends on dashboard for auth, on
    # gateway/proxy for LLM calls), then dashboard, then admin, then proxy,
    # and finally gateway. This avoids brief 502s appearing in MC during
    # shutdown when MC tries to proxy to a dead backend.
    Write-Host "Stopping Quinn & Co. services..." -ForegroundColor Cyan
    Stop-QuinnService -DisplayName "Mission Control"   -Regex $QuinnRegex.MC        | Out-Null
    Stop-QuinnService -DisplayName "Dashboard server"  -Regex $QuinnRegex.Dashboard | Out-Null
    Stop-QuinnService -DisplayName "Admin server"      -Regex $QuinnRegex.Admin     | Out-Null
    Stop-QuinnService -DisplayName "Gateway proxy"     -Regex $QuinnRegex.Proxy     | Out-Null
    Stop-QuinnService -DisplayName "Gateway"           -Regex $QuinnRegex.Gateway   | Out-Null
}

function Test-QuinnPortsFree {
    $ports = @{
        3000  = "Mission Control"
        4242  = "Dashboard server"
        4245  = "Admin server"
        19100 = "Gateway"
        19101 = "Gateway proxy"
    }
    $allFree = $true
    foreach ($port in ($ports.Keys | Sort-Object)) {
        $listening = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count
        if ($listening -gt 0) {
            Write-Host "  Port $port ($($ports[$port])) : STILL LISTENING" -ForegroundColor Red
            $allFree = $false
        } else {
            Write-Host "  Port $port ($($ports[$port])) : free" -ForegroundColor Green
        }
    }
    return $allFree
}

# â”€â”€ Always-on supervisor support (2026-07-04) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Service table: health URL + start command per service. Start blocks use
# cmd.exe /c for byte-exact (UTF-8) log redirects â€” PS 5.1 *>> writes UTF-16
# and produced a mixed-encoding dashboard-debug.log. Secrets are read from
# .env files at child runtime so they never appear on a command line.

$Script:QuinnStateDir  = "C:\Users\jared\.openclaw-quinn-co"
$Script:QuinnWorkspace = "C:\AI\quinn-co\workspace"
$Script:QuinnMCDir     = "C:\Users\jared\Projects\mission-control"

function Get-QuinnEnvValue {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Key)
    if (-not (Test-Path $Path)) { return $null }
    $line = @(Get-Content $Path | Where-Object { $_ -match "^$Key=" })[0]
    if (-not $line) { return $null }
    return $line.Split("=", 2)[1].Trim()
}

function Test-QuinnServiceHealth {
    param([Parameter(Mandatory)][string]$Url)
    try {
        Invoke-WebRequest -Uri $Url -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop | Out-Null
        return $true
    } catch { return $false }
}

# Cold Windows boots can make Node/Next startup several times slower than usual.
# Keep this policy pure so the supervisor's restart decisions are testable.
function Get-QuinnServiceStartupGraceSeconds {
    param([Parameter(Mandatory)][string]$Name)
    $grace = @{
        Gateway   = 240
        Proxy     = 90
        Admin     = 120
        Dashboard = 180
        MC        = 180
    }
    if (-not $grace.ContainsKey($Name)) { throw "Unknown Quinn service: $Name" }
    return $grace[$Name]
}

function Test-QuinnServiceRestartDue {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][datetime]$StartedAt,
        [datetime]$Now = (Get-Date)
    )
    if ($StartedAt -eq [datetime]::MinValue) { return $true }
    $grace = Get-QuinnServiceStartupGraceSeconds -Name $Name
    return (($Now - $StartedAt).TotalSeconds -ge $grace)
}

function Test-QuinnDockerEngineReady {
    $dockerExe = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
    if (-not (Test-Path -LiteralPath $dockerExe)) { return $false }

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $dockerExe
    $startInfo.Arguments = 'info --format "{{.ServerVersion}}"'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { return $false }
        if (-not $process.WaitForExit(5000)) {
            try { $process.Kill() } catch {}
            return $false
        }
        return ($process.ExitCode -eq 0)
    } catch {
        return $false
    } finally {
        $process.Dispose()
    }
}

function Test-QuinnDockerDesktopRunning {
    return (@(Get-Process -Name "Docker Desktop", "com.docker.backend" -ErrorAction SilentlyContinue).Count -gt 0)
}

function Get-QuinnDockerStartupAction {
    param([bool]$Ready, [bool]$DesktopRunning)
    if ($Ready) { return "Ready" }
    if ($DesktopRunning) { return "Wait" }
    return "Start"
}

function Start-QuinnDockerDesktop {
    $ready = Test-QuinnDockerEngineReady
    $running = Test-QuinnDockerDesktopRunning
    $action = Get-QuinnDockerStartupAction -Ready $ready -DesktopRunning $running
    if ($action -ne "Ready") {
        $dockerExe = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
        if (Test-Path -LiteralPath $dockerExe) {
            # Reissuing detached start is safe and recovers a half-started/stopping backend.
            Start-Process -FilePath $dockerExe -ArgumentList "desktop", "start", "--detach" -WindowStyle Hidden | Out-Null
        }
    }
    return $action
}

function Send-QuinnAlert {
    param([Parameter(Mandatory)][string]$Title, [Parameter(Mandatory)][string]$Message)
    $topic = Get-QuinnEnvValue -Path (Join-Path $Script:QuinnWorkspace ".env") -Key "NTFY_TOPIC"
    if (-not $topic) { return }
    try {
        Invoke-RestMethod -Uri "https://ntfy.sh/$topic" -Method Post -Body $Message `
            -Headers @{ Title = $Title } -TimeoutSec 10 | Out-Null
    } catch { Write-Host "  ntfy alert failed: $_" -ForegroundColor DarkYellow }
}

$Script:QuinnServices = [ordered]@{
    Gateway = @{
        Health = "http://127.0.0.1:19100/"
        Regex  = $QuinnRegex.Gateway
        Start  = {
            # reset-to-economy BEFORE every gateway cold start (rewrites
            # model-tiers.json which the gateway reads at boot). Never on adopt.
            $reset = Join-Path $Script:QuinnStateDir "reset-to-economy.py"
            if (Test-Path $reset) {
                try { & python $reset 2>&1 | Out-Null } catch { Write-Host "  reset-to-economy failed (non-fatal): $_" }
            }
            # Sync canonical agent identities into workspace-* mirrors (idempotent,
            # <1s no-op when clean) so direct chat never loads a stale identity.
            $wsSync = "C:\AI\quinn-co\workspace\scripts\sync-agent-workspaces.mjs"
            if (Test-Path $wsSync) {
                try { & node $wsSync 2>&1 | Out-Null } catch { Write-Host "  workspace sync failed (non-fatal): $_" }
            }
            Start-Process -FilePath (Join-Path $Script:QuinnStateDir "gateway-quinn-co.cmd") -WindowStyle Hidden | Out-Null
        }
    }
    Proxy = @{
        Health = "http://127.0.0.1:19101/"
        Regex  = $QuinnRegex.Proxy
        Start  = {
            Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
                -ArgumentList "`"$Script:QuinnMCDir\gateway-proxy.js`"" `
                -WorkingDirectory $Script:QuinnMCDir -WindowStyle Hidden | Out-Null
        }
    }
    Admin = @{
        Health = "http://127.0.0.1:4245/admin/ping"
        Regex  = $QuinnRegex.Admin
        Start  = {
            $tsxCli = Join-Path $Script:QuinnWorkspace "node_modules\tsx\dist\cli.mjs"
            $previousKey = $env:ADMIN_API_KEY
            try {
                $env:ADMIN_API_KEY = Get-QuinnEnvValue -Path (Join-Path $Script:QuinnStateDir ".env") -Key "ADMIN_API_KEY"
                $env:ADMIN_PORT = "4245"
                $env:DATA_DIR = "data"
                Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
                    -ArgumentList "`"$tsxCli`"", "admin/server.ts" `
                    -WorkingDirectory $Script:QuinnWorkspace -WindowStyle Hidden `
                    -RedirectStandardOutput (Join-Path $Script:QuinnStateDir "logs\admin.log") `
                    -RedirectStandardError (Join-Path $Script:QuinnStateDir "logs\admin-error.log") | Out-Null
            } finally {
                $env:ADMIN_API_KEY = $previousKey
                Remove-Item Env:ADMIN_PORT, Env:DATA_DIR -ErrorAction SilentlyContinue
            }
        }
    }
    Dashboard = @{
        Health = "http://127.0.0.1:4242/"
        Regex  = $QuinnRegex.Dashboard
        Start  = {
            # cmd /c redirect = raw UTF-8 append (fixes mixed-encoding log).
            # Log stays at workspace\dashboard-debug.log â€” location is load-bearing.
            $tsxCli = Join-Path $Script:QuinnWorkspace "node_modules\tsx\dist\cli.mjs"
            $env:DASHBOARD_PORT = "4242"
            $env:DATA_DIR = "data"
            try {
                Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
                    -ArgumentList "`"$tsxCli`"", "--env-file=.env", "dashboard/server.ts" `
                    -WorkingDirectory $Script:QuinnWorkspace -WindowStyle Hidden `
                    -RedirectStandardOutput (Join-Path $Script:QuinnWorkspace "dashboard-debug.log") `
                    -RedirectStandardError (Join-Path $Script:QuinnStateDir "logs\dashboard-error.log") | Out-Null
            } finally {
                Remove-Item Env:DASHBOARD_PORT, Env:DATA_DIR -ErrorAction SilentlyContinue
            }
        }
    }
    MC = @{
        Health = "http://localhost:3000/"
        Regex  = $QuinnRegex.MC
        Start  = {
            $nextCli = Join-Path $Script:QuinnMCDir "node_modules\next\dist\bin\next"
            Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
                -ArgumentList "`"$nextCli`"", "start", "-p", "3000" `
                -WorkingDirectory $Script:QuinnMCDir -WindowStyle Hidden `
                -RedirectStandardOutput (Join-Path $Script:QuinnStateDir "logs\mc.log") `
                -RedirectStandardError (Join-Path $Script:QuinnStateDir "logs\mc-error.log") | Out-Null
        }
    }
}

function Start-QuinnServiceProcess {
    param([Parameter(Mandatory)][string]$Name)
    $svc = $Script:QuinnServices[$Name]
    if (-not $svc) { throw "Unknown Quinn service: $Name" }
    & $svc.Start
}
