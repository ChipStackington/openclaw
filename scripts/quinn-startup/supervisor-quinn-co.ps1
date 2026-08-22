# Quinn & Co. Always-On Supervisor (2026-07-04)
# Headless replacement for launch-quinn-co.ps1 + watchdog-quinn-co.ps1.
# Run by the "Quinn & Co Supervisor" Scheduled Task (at logon + every 15 min,
# no-second-instance). Adopts healthy services, restarts dead ones, backs off
# crash-loops, alerts via ntfy. Stop via stop-quinn.ps1 (disables the task).
#
# -Once : run a single monitor pass and exit (testing).

param([switch]$Once)

. "$PSScriptRoot\quinn-process-lib.ps1"

$stateDir  = $Script:QuinnStateDir
$logFile   = Join-Path $stateDir "supervisor.log"
$pidFile   = Join-Path $stateDir "supervisor.pid"
$pauseFlag = Join-Path $stateDir "supervisor-pause.flag"

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts  $msg" | Out-File -Append -FilePath $logFile -Encoding utf8
}

# â”€â”€ Log rotation (5 MB, one generation) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 5MB)) {
    Move-Item -Force $logFile "$logFile.old"
}

# â”€â”€ Single-instance lock (belt; task's IgnoreNew is suspenders) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
$supervisorMutex = New-Object System.Threading.Mutex($false, $Script:QuinnSupervisorMutexName)
if (-not $supervisorMutex.WaitOne(0)) {
    Log "Another supervisor owns the startup mutex - exiting."
    exit 0
}
Set-Content -Path $pidFile -Value $PID -Encoding ascii
Log "=== Supervisor started (PID $PID) ==="

# â”€â”€ Pause flag: fresh (<60 min) = skip restarts; stale = delete + proceed â”€â”€â”€
function Test-QuinnPaused {
    if (-not (Test-Path $pauseFlag)) { return $false }
    $age = (Get-Date) - (Get-Item $pauseFlag).LastWriteTime
    if ($age.TotalMinutes -lt 60) { return $true }
    Log "Pause flag stale ($([int]$age.TotalMinutes) min) - removing."
    Remove-Item $pauseFlag -Force -ErrorAction SilentlyContinue
    return $false
}

# â”€â”€ Restart bookkeeping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
$failCounts     = @{}   # consecutive failed health checks per service
$restartTimes   = @{}   # per service: recent restart timestamps (List[datetime])
$backoffUntil   = @{}   # per service: do-not-restart-before time
$wasInBackoff   = @{}   # for the "recovered" alert
$serviceStartedAt = @{} # startup grace prevents slow processes being killed
foreach ($name in $Script:QuinnServices.Keys) {
    $failCounts[$name] = 0
    $restartTimes[$name] = New-Object System.Collections.Generic.List[datetime]
    $backoffUntil[$name] = [datetime]::MinValue
    $wasInBackoff[$name] = $false
    $serviceStartedAt[$name] = [datetime]::MinValue
}

function Restart-QuinnServiceSupervised {
    param([Parameter(Mandatory)][string]$Name)
    $now = Get-Date
    # prune restart history to the last 10 minutes
    $recent = New-Object System.Collections.Generic.List[datetime]
    foreach ($t in $restartTimes[$Name]) { if (($now - $t).TotalMinutes -le 10) { $recent.Add($t) } }
    $restartTimes[$Name] = $recent
    # 3 restarts may complete within 10 min; the would-be 4th converts to backoff (spec: "3 restarts/10 min -> back off").
    if ($recent.Count -ge 3) {
        $backoffUntil[$Name] = $now.AddMinutes(30)
        $wasInBackoff[$Name] = $true
        $restartTimes[$Name].Clear()
        Log "CRASH-LOOP: $Name restarted 3x in 10 min - backing off 30 min."
        Send-QuinnAlert -Title "Quinn: $Name crash-looping" -Message "$Name restarted 3x in 10 min. Backing off 30 min. Check logs on the laptop."
        return
    }
    Log "Restarting $Name..."
    Stop-QuinnService -DisplayName $Name -Regex $Script:QuinnServices[$Name].Regex | Out-Null
    Start-QuinnServiceProcess -Name $Name
    $serviceStartedAt[$Name] = Get-Date
    $restartTimes[$Name].Add($now)
}

function Invoke-MonitorPass {
    $paused = Test-QuinnPaused
    foreach ($name in $Script:QuinnServices.Keys) {
        try {
            $healthy = Test-QuinnServiceHealth -Url $Script:QuinnServices[$name].Health
            if ($healthy) {
                if ($wasInBackoff[$name]) {
                    Log "$name recovered."
                    Send-QuinnAlert -Title "Quinn: $name recovered" -Message "$name is healthy again."
                    $wasInBackoff[$name] = $false
                }
                $failCounts[$name] = 0
                $backoffUntil[$name] = [datetime]::MinValue
                $serviceStartedAt[$name] = [datetime]::MinValue
                continue
            }
            if ($paused) { Log "$name unhealthy - PAUSED, skipping."; $failCounts[$name] = 0; continue }
            if (-not (Test-QuinnServiceRestartDue -Name $name -StartedAt $serviceStartedAt[$name])) {
                $failCounts[$name] = 0
                continue
            }
            if ((Get-Date) -lt $backoffUntil[$name]) { $failCounts[$name] = 0; continue }
            $failCounts[$name] += 1
            if ($failCounts[$name] -ge 2) {
                Restart-QuinnServiceSupervised -Name $name
                $failCounts[$name] = 0
                if ($name -eq "Dashboard") { Log "Dashboard restarted - deferring remaining checks to next pass."; break }
            }
        } catch {
            Log "Monitor error for ${name}: $_"
            continue
        }
    }
}

# â”€â”€ Boot: adopt-or-start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Order matters on cold start: dashboard must be up before MC (MC's auth
# backend). Service definitions are instance-scoped by quinn-process-lib.ps1.
$coldStarted = @()
$criticalBootOrder = @("Dashboard", "MC", "Gateway", "Proxy")
$deferredBootOrder = @("Admin", "Marketplace")
foreach ($name in @($criticalBootOrder + $deferredBootOrder)) {
    try {
        if (Test-QuinnServiceHealth -Url $Script:QuinnServices[$name].Health) {
            Log "$name healthy - adopted."
            continue
        }
        # A WMI process scan can block for minutes during a busy Windows boot.
        # Start optimistically; only do targeted cleanup after startup grace expires.
        Log "$name not responding - cold-starting with $((Get-QuinnServiceStartupGraceSeconds -Name $name))s grace."
        Start-QuinnServiceProcess -Name $name
        $serviceStartedAt[$name] = Get-Date
        $coldStarted += $name
    } catch {
        Log "BOOT ERROR for ${name}: $_"
        continue
    }
}
if ($coldStarted.Count -gt 0) {
    Log "Cold-started: $($coldStarted -join ', ')"
    Send-QuinnAlert -Title "Quinn stack (re)started" -Message "Supervisor cold-started: $($coldStarted -join ', ')"
    # codex auth pre-flight only when we actually started something
    try {
        $codexStatus = & codex login status 2>&1
        if ($LASTEXITCODE -ne 0) {
            Log "WARNING: codex auth check failed: $codexStatus"
            Send-QuinnAlert -Title "Quinn: codex auth problem" -Message "codex login status failed - brain may be down. Run: openclaw models auth login"
        }
    } catch {
        Log "codex pre-flight unavailable: $_"
    }
} else {
    Log "All services healthy - full adopt, zero downtime."
}

# â”€â”€ Monitor loop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if ($Once) { Invoke-MonitorPass; Log "Single pass done (-Once)."; exit 0 }
while ($true) {
    Start-Sleep -Seconds 30
    try { Invoke-MonitorPass } catch { Log "Monitor pass error: $_" }
}
