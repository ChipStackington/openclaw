. "$PSScriptRoot\quinn-process-lib.ps1"

$task = Get-ScheduledTask -TaskName $Script:QuinnTaskName -ErrorAction SilentlyContinue
Write-Host "Task: $($Script:QuinnTaskName)" -ForegroundColor Cyan
Write-Host "  State: $(if ($task) { $task.State } else { 'not registered' })"
foreach ($name in $Script:QuinnServices.Keys) {
    $healthy = Test-QuinnServiceHealth -Url $Script:QuinnServices[$name].Health
    $color = if ($healthy) { "Green" } else { "Red" }
    Write-Host "  $name : $(if ($healthy) { 'healthy' } else { 'down' })" -ForegroundColor $color
}
