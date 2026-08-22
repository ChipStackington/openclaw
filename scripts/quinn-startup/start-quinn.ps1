. "$PSScriptRoot\quinn-process-lib.ps1"

$ErrorActionPreference = "Stop"
$startedAt = Get-Date
$launchId = [guid]::NewGuid().ToString("n")
$telemetryPath = Join-Path $PSScriptRoot "startup-telemetry.jsonl"
$stableCounts = @{}

function Write-QuinnStartupEvent {
    param([Parameter(Mandatory)][string]$Event, [hashtable]$Data = @{})
    $record = [ordered]@{
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
        launchId = $launchId
        event = $Event
        elapsedMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
    }
    foreach ($key in $Data.Keys) { $record[$key] = $Data[$key] }
    ($record | ConvertTo-Json -Compress) | Add-Content -LiteralPath $telemetryPath -Encoding utf8
}

function Get-QuinnStableServices {
    param([Parameter(Mandatory)][string[]]$Names, [int]$RequiredSamples = 2)
    $stable = @()
    foreach ($name in $Names) {
        if (Test-QuinnServiceHealth -Url $Script:QuinnServices[$name].Health) {
            $stableCounts[$name] = [int]$stableCounts[$name] + 1
        } else {
            $stableCounts[$name] = 0
        }
        if ($stableCounts[$name] -ge $RequiredSamples) { $stable += $name }
    }
    return $stable
}

function New-QuinnStartupFailureBundle {
    param([Parameter(Mandatory)][string[]]$Unavailable)
    $bundle = Join-Path $PSScriptRoot ("diagnostics\startup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
    New-Item -ItemType Directory -Path $bundle -Force | Out-Null
    [ordered]@{
        launchId = $launchId
        capturedAt = (Get-Date).ToString("o")
        elapsedSeconds = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
        unavailable = $Unavailable
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $bundle "summary.json") -Encoding utf8

    $logs = @(
        (Join-Path $PSScriptRoot "supervisor.log"),
        (Join-Path $PSScriptRoot "logs\mc.log"),
        (Join-Path $PSScriptRoot "logs\mc-error.log"),
        (Join-Path $PSScriptRoot "logs\dashboard-error.log"),
        (Join-Path $PSScriptRoot "logs\marketplace-error.log"),
        (Join-Path $PSScriptRoot "logs\gateway.log")
    )
    foreach ($log in $logs) {
        if (Test-Path -LiteralPath $log) {
            Get-Content -LiteralPath $log -Tail 200 -ErrorAction SilentlyContinue |
                Set-Content -LiteralPath (Join-Path $bundle (Split-Path $log -Leaf)) -Encoding utf8
        }
    }
    return $bundle
}

Write-Host "=== Starting Quinn & Co ===" -ForegroundColor Cyan
Write-QuinnStartupEvent -Event "launcher_started"

$launcherMutex = New-Object System.Threading.Mutex($false, $Script:QuinnLauncherMutexName)
if (-not $launcherMutex.WaitOne(0)) {
    Write-Host "Quinn is already starting." -ForegroundColor Yellow
    exit 0
}

try {
    # Windows preserves browser cookies across reboots. If the local UI stack
    # was cold when Jared clicked Quinn, route through Mission Control's
    # startup auth boundary so an old JWT cannot skip the password screen.
    # Repeat clicks on an already-healthy stack preserve the active session.
    $requireFreshLogin = -not (
        (Test-QuinnServiceHealth -Url $Script:QuinnServices.Dashboard.Health) -and
        (Test-QuinnServiceHealth -Url $Script:QuinnServices.MC.Health)
    )

    Enable-ScheduledTask -TaskName $Script:QuinnTaskName | Out-Null
    Start-ScheduledTask -TaskName $Script:QuinnTaskName
    Write-QuinnStartupEvent -Event "supervisor_requested"

    # Docker is only needed for non-main sandboxed agents. Starting it here can
    # monopolize this laptop's cold disk/CPU while Quinn's two gateways load.
    Write-Host "Docker is optional and was not started; Quinn's primary chat runs locally." -ForegroundColor DarkGray

    $signInDeadline = $startedAt.AddSeconds(45)
    $conversationDeadline = $startedAt.AddSeconds(90)
    $absoluteDeadline = $startedAt.AddSeconds(120)
    $browserOpened = $false
    $signInMissLogged = $false
    $conversationMissLogged = $false

    while ((Get-Date) -lt $absoluteDeadline) {
        $stable = @(Get-QuinnStableServices -Names @("Dashboard", "MC", "Gateway", "Proxy"))
        $uiReady = (@("Dashboard", "MC") | Where-Object { $_ -notin $stable }).Count -eq 0
        $conversationReady = (@("Gateway", "Proxy") | Where-Object { $_ -notin $stable }).Count -eq 0

        if ($uiReady -and -not $browserOpened) {
            Write-QuinnStartupEvent -Event "sign_in_ready"
            Write-Host "Quinn sign-in is ready." -ForegroundColor Green
            $missionControlUrl = if ($requireFreshLogin) {
                "http://localhost:$($Script:QuinnPorts.MC)/api/auth/startup"
            } else {
                "http://localhost:$($Script:QuinnPorts.MC)/"
            }
            Start-Process $missionControlUrl
            $browserOpened = $true
        }
        if ($browserOpened -and $conversationReady) {
            Write-QuinnStartupEvent -Event "conversation_ready"
            Write-Host "Quinn is conversation-ready." -ForegroundColor Green
            if (-not (Test-QuinnDockerEngineReady)) {
                Write-Host "Docker remains off. Start it only when you need sandboxed secondary agents." -ForegroundColor DarkGray
            }
            exit 0
        }
        if (-not $signInMissLogged -and (Get-Date) -ge $signInDeadline) {
            Write-QuinnStartupEvent -Event "sign_in_target_missed"
            Write-Host "Quinn is taking longer than the 45-second target; still working..." -ForegroundColor Yellow
            $signInMissLogged = $true
        }
        if (-not $conversationMissLogged -and (Get-Date) -ge $conversationDeadline) {
            Write-QuinnStartupEvent -Event "conversation_target_missed"
            Write-Host "Conversation services are taking longer than the 90-second target; still working..." -ForegroundColor Yellow
            $conversationMissLogged = $true
        }
        Start-Sleep -Milliseconds 250
    }

    $unavailable = @($Script:QuinnServices.Keys | Where-Object { -not (Test-QuinnServiceHealth -Url $Script:QuinnServices[$_].Health) })
    $bundle = New-QuinnStartupFailureBundle -Unavailable $unavailable
    Write-QuinnStartupEvent -Event "startup_failed" -Data @{ unavailable = ($unavailable -join ","); bundle = $bundle }
    Write-Host "Quinn did not become ready within two minutes. Diagnostics: $bundle" -ForegroundColor Red
    Start-Process -FilePath "notepad.exe" -ArgumentList "`"$(Join-Path $bundle 'summary.json')`"" | Out-Null
} catch {
    $bundle = New-QuinnStartupFailureBundle -Unavailable @("launcher_error")
    Write-QuinnStartupEvent -Event "launcher_error" -Data @{ message = $_.Exception.Message; bundle = $bundle }
    Write-Host "Quinn startup failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Diagnostics: $bundle" -ForegroundColor Red
    exit 1
} finally {
    if ($launcherMutex) {
        try { $launcherMutex.ReleaseMutex() } catch {}
        $launcherMutex.Dispose()
    }
}
