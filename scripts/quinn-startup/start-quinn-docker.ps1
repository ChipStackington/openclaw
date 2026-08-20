. "$PSScriptRoot\quinn-process-lib.ps1"

# Docker is a warm-up optimization for sandboxed secondary agents. It is never
# a prerequisite for Quinn's main UI, authentication, or primary conversation.
$action = Start-QuinnDockerDesktop
$record = [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
    event = "docker_prewarm"
    action = $action
}
($record | ConvertTo-Json -Compress) | Add-Content -LiteralPath (Join-Path $PSScriptRoot "startup-telemetry.jsonl") -Encoding utf8

