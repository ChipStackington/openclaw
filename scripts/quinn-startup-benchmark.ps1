param(
  [string]$LauncherLog = "$env:USERPROFILE\.openclaw-quinn-co\launcher.log"
)

$lastStart = Select-String -LiteralPath $LauncherLog -Pattern "=== Quinn & Company Launcher started ===" |
  Select-Object -Last 1

if (-not $lastStart) {
  throw "No launcher start found in $LauncherLog"
}

$lines = Get-Content -LiteralPath $LauncherLog | Select-Object -Skip ($lastStart.LineNumber - 1)
$events = foreach ($line in $lines) {
  if ($line -match "^(?<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})  (?<msg>.+)$") {
    [pscustomobject]@{
      Time = [datetime]::ParseExact($Matches.ts, "yyyy-MM-dd HH:mm:ss", $null)
      Message = $Matches.msg
    }
  }
}

$start = $events | Where-Object Message -eq "=== Quinn & Company Launcher started ===" | Select-Object -First 1
$complete = $events | Where-Object Message -eq "=== Launcher complete - entering monitor mode ===" | Select-Object -First 1
$ready = $events | Where-Object Message -match "ready \(attempt" |
  Select-Object Time, Message

[pscustomobject]@{
  TotalSeconds = if ($complete) { [math]::Round(($complete.Time - $start.Time).TotalSeconds, 1) } else { $null }
  ReadyEvents = $ready
}
