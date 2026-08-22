$ErrorActionPreference = "Stop"

$stateDir = Split-Path -Parent $PSScriptRoot
$libPath = Join-Path $stateDir "quinn-process-lib.ps1"
$supervisorPath = Join-Path $stateDir "supervisor-quinn-co.ps1"
$launcherPath = Join-Path $stateDir "start-quinn.ps1"
$installerPath = Join-Path $stateDir "install-quinn-startup-tasks.ps1"

. $libPath

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) {
        throw "$Message (expected=$Expected actual=$Actual)"
    }
}

function Assert-Match {
    param([string]$Text, [string]$Pattern, [string]$Message)
    if ($Text -notmatch $Pattern) { throw $Message }
}

function Assert-NotMatch {
    param([string]$Text, [string]$Pattern, [string]$Message)
    if ($Text -match $Pattern) { throw $Message }
}

# The slowest services have enough grace to survive a heavily loaded Windows boot.
Assert-Equal 240 (Get-QuinnServiceStartupGraceSeconds -Name "Gateway") "Gateway startup grace is too short"
Assert-Equal 180 (Get-QuinnServiceStartupGraceSeconds -Name "Dashboard") "Dashboard startup grace is too short"
Assert-Equal 180 (Get-QuinnServiceStartupGraceSeconds -Name "MC") "Mission Control startup grace is too short"
Assert-Equal 120 (Get-QuinnServiceStartupGraceSeconds -Name "Marketplace") "Marketplace startup grace is too short"

$startedAt = [datetime]"2026-08-06T12:00:00"
Assert-Equal $false (Test-QuinnServiceRestartDue -Name "Gateway" -StartedAt $startedAt -Now $startedAt.AddSeconds(239)) "Gateway restarted during startup grace"
Assert-Equal $true (Test-QuinnServiceRestartDue -Name "Gateway" -StartedAt $startedAt -Now $startedAt.AddSeconds(240)) "Gateway did not become restartable after grace"

# Docker readiness is observable, but it must not gate the local Quinn UI stack.
Assert-Equal "Ready" (Get-QuinnDockerStartupAction -Ready $true -DesktopRunning $false) "Ready Docker action is wrong"
Assert-Equal "Wait" (Get-QuinnDockerStartupAction -Ready $false -DesktopRunning $true) "Running Docker action is wrong"
Assert-Equal "Start" (Get-QuinnDockerStartupAction -Ready $false -DesktopRunning $false) "Stopped Docker action is wrong"

$supervisor = Get-Content -LiteralPath $supervisorPath -Raw
$launcher = Get-Content -LiteralPath $launcherPath -Raw
$library = Get-Content -LiteralPath $libPath -Raw

Assert-NotMatch $supervisor 'Log "\$name not responding - cleaning and cold-starting\."' "Cold boot still performs blocking WMI cleanup"
Assert-Match $supervisor 'Test-QuinnServiceRestartDue' "Supervisor does not enforce startup grace"
Assert-NotMatch $launcher 'Start-QuinnDockerDesktop' "Launcher still starts Docker during Quinn's critical startup window"
Assert-Match $launcher 'Docker is optional and was not started' "Launcher does not explain that Docker is optional"
Assert-NotMatch $launcher 'AddMinutes\(5\)' "Launcher still waits five minutes"
Assert-Match $launcher 'AddSeconds\(45\)' "Launcher lacks the 45-second sign-in target"
Assert-Match $launcher 'AddSeconds\(90\)' "Launcher lacks the 90-second conversation target"
Assert-Match $launcher 'AddSeconds\(120\)' "Launcher lacks the absolute two-minute deadline"
Assert-Match $launcher 'startup-telemetry\.jsonl' "Launcher does not emit structured startup telemetry"
Assert-Match $launcher 'Get-QuinnStableServices' "Launcher does not require stable readiness probes"
Assert-Match $launcher 'New-QuinnStartupFailureBundle' "Launcher does not create a diagnostic bundle on failure"

# A cold Windows/Quinn launch must require Jared's Mission Control password,
# while a repeat click on an already-healthy stack keeps the active session.
Assert-Match $launcher '\$requireFreshLogin\s*=\s*-not\s*\(' "Launcher does not distinguish cold launches from repeat clicks"
Assert-Match $launcher '\$Script:QuinnPorts\.MC.*api/auth/startup' "Cold launch does not use the instance Mission Control port"
Assert-Match $launcher 'if \(\$requireFreshLogin\)' "Fresh-login route is not conditional on a cold launch"

# The main Quinn UI must not wait for Docker, and repeat clicks must be idempotent.
Assert-NotMatch $launcher 'docker_requested' "Launcher still records an automatic Docker startup request"
Assert-Match $launcher 'QuinnLauncherMutexName' "Launcher mutex is not instance-scoped"
Assert-Match $supervisor 'QuinnSupervisorMutexName' "Supervisor mutex is not instance-scoped"
Assert-Match $launcher 'QuinnTaskName' "Launcher task name is not instance-scoped"
Assert-NotMatch $supervisor 'Get-CimInstance Win32_Process -Filter "ProcessId=' "Supervisor still uses the boot-blocking WMI PID lock"

# Avoid npm/npx startup resolution on the critical path.
Assert-NotMatch $library '\bnpx\s+tsx\b' "Service startup still pays the npx resolution penalty"
Assert-NotMatch $library '\bnpm\s+run\s+start\b' "Mission Control still launches through npm"
Assert-Match $library 'node_modules[\\/]+tsx[\\/]+dist[\\/]+cli\.mjs' "Direct tsx entrypoint is missing"
Assert-Match $library 'node_modules[\\/]+next[\\/]+dist[\\/]+bin[\\/]+next' "Direct Next.js entrypoint is missing"
Assert-Match $library 'TimeoutSec 1' "Local readiness probes are too slow for the startup budget"

# Critical services launch together; Admin is explicitly deferred.
Assert-Match $supervisor '\$criticalBootOrder\s*=\s*@\("Dashboard",\s*"MC",\s*"Gateway",\s*"Proxy"\)' "Critical boot order is missing"
Assert-Match $supervisor '\$deferredBootOrder\s*=\s*@\("Admin",\s*"Marketplace"\)' "Admin/Marketplace deferred order is missing"
Assert-NotMatch $supervisor 'AddSeconds\(25\)' "Supervisor still serially waits for Dashboard before starting MC"
Assert-Match $library 'marketplace\[/\\\\\]server\\\.ts' "Marketplace process is not managed"
Assert-Match $library 'QuinnPorts\.Marketplace' "Marketplace port is not parameterized"

# Scheduled tasks are reproducible: supervisor is on-demand and legacy Docker
# prewarm is actively removed so Docker stays off until Jared starts it.
if (-not (Test-Path -LiteralPath $installerPath)) { throw "Scheduled-task installer is missing" }
$installer = Get-Content -LiteralPath $installerPath -Raw
Assert-Match $installer 'QuinnTaskName' "Installer task name is not instance-scoped"
Assert-Match $installer '(?m)^Unregister-ScheduledTask.*Quinn & Co Docker Prewarm' "Installer does not remove the legacy Docker prewarm task"
Assert-NotMatch $installer 'New-ScheduledTaskTrigger -AtLogOn' "Installer still starts Docker at Windows logon"
Assert-NotMatch $installer '(?m)^Register-ScheduledTask.*Quinn & Co Docker Prewarm' "Installer still registers Docker auto-start"
Assert-NotMatch $installer 'PT15M' "Installer still schedules the supervisor every 15 minutes"

Write-Output "PASS: Quinn one-click startup contract"
