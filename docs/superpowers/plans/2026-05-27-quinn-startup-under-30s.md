# Quinn Startup Under 30 Seconds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Quinn & Company desktop launcher open Mission Control and reach a conversation-ready orchestrator state in under 30 seconds on Jared's Windows machine.

**Architecture:** Keep security gates, auth, and loopback binding intact, but remove development-server startup from the launch path and start independent services concurrently. The launcher should treat `next start` production Mission Control, gateway proxy, admin, dashboard, and OpenClaw gateway as separate readiness targets, then open the UI when MC, dashboard auth, gateway proxy, and gateway are healthy.

**Tech Stack:** Windows PowerShell launcher, Node.js 24, OpenClaw gateway dist, Next.js Mission Control, Quinn-Co Express admin/dashboard servers via tsx initially.

---

## Evidence From 2026-05-27

- Latest launch: `12:28:36` to `12:30:13`, about 97 seconds.
- Gateway: `12:28:37` start to `12:29:01` ready, about 24 seconds.
- Gateway proxy: about 1 second.
- Admin server: `12:29:02` start to `12:29:16` ready, about 14 seconds.
- Dashboard server: `12:29:16` start to `12:29:23` ready, about 7 seconds.
- Mission Control: `12:29:23` start to `12:30:12` ready, about 49 seconds.
- Mission Control dev log: middleware compile at `24.738s`, dev server ready at `23.2s`, `/login` compile starts at `32.319s`.
- Production `next start` smoke on port `3005` using existing `.next` build reported ready in `1071ms`.

---

### Task 1: Add a Repeatable Startup Benchmark

**Files:**
- Create: `scripts/quinn-startup-benchmark.ps1`

- [ ] **Step 1: Create the benchmark script**

```powershell
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
```

- [ ] **Step 2: Run the benchmark against the current launcher log**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File C:\AI\openclaw\scripts\quinn-startup-benchmark.ps1
```

Expected: Reports about 97 seconds for the current 2026-05-27 launch.

---

### Task 2: Build Mission Control Before Launcher Fast Path

**Files:**
- Modify: `C:\Users\jared\Projects\mission-control\package.json`
- Runtime command: `npm run build`

- [ ] **Step 1: Verify production build exists**

Run:

```powershell
Test-Path C:\Users\jared\Projects\mission-control\.next\BUILD_ID
```

Expected: `True`.

- [ ] **Step 2: Rebuild Mission Control before changing the launcher**

Run:

```powershell
cd C:\Users\jared\Projects\mission-control
npm run build
```

Expected: Build exits 0. Existing middleware deprecation warning is acceptable.

- [ ] **Step 3: Smoke production start on alternate port**

Run:

```powershell
cd C:\Users\jared\Projects\mission-control
node node_modules\next\dist\bin\next start -p 3005
```

In another PowerShell:

```powershell
Invoke-WebRequest http://localhost:3005/login -UseBasicParsing
```

Expected: HTTP 200 or valid login page response in about 1-2 seconds after server start.

---

### Task 3: Switch Launcher From `next dev` to Production `next start`

**Files:**
- Backup: `C:\Users\jared\.openclaw-quinn-co\launch-quinn-co.ps1`
- Modify: `C:\Users\jared\.openclaw-quinn-co\launch-quinn-co.ps1`

- [ ] **Step 1: Back up the live launcher**

Run:

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item C:\Users\jared\.openclaw-quinn-co\launch-quinn-co.ps1 C:\Users\jared\.openclaw-quinn-co\launch-quinn-co.backup-startup-fast-$stamp.ps1
```

- [ ] **Step 2: Replace Mission Control command**

Change:

```powershell
$mcCmd = "cd '$missionControlDir'; npm run dev"
```

To:

```powershell
$mcCmd = "cd '$missionControlDir'; npm run start"
```

- [ ] **Step 3: Reduce MC readiness probe interval**

Change the Mission Control loop sleep:

```powershell
Start-Sleep -Seconds 3
```

To:

```powershell
Start-Sleep -Milliseconds 500
```

Expected: MC production server readiness should be detected in about 1-3 seconds instead of waiting on dev compilation and 3-second polling.

---

### Task 4: Parallelize Independent Service Starts

**Files:**
- Modify: `C:\Users\jared\.openclaw-quinn-co\launch-quinn-co.ps1`

- [ ] **Step 1: Start all independent services after tier reset**

Replace the serial service sections with a two-phase pattern:

```powershell
Write-Log "Starting gateway on port 19100..."
Start-Process -FilePath "$stateDir\gateway-quinn-co.cmd" -WindowStyle Hidden | Out-Null

Write-Log "Starting gateway-proxy on port 19101..."
Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
    -ArgumentList "`"$gatewayProxyScript`"" `
    -WorkingDirectory $missionControlDir `
    -WindowStyle Hidden | Out-Null

Write-Log "Starting admin server on port 4245..."
$adminCmd = "cd '$quinnWorkspace'; `$env:ADMIN_API_KEY='$adminApiKey'; `$env:ADMIN_PORT='$adminPort'; `$env:DATA_DIR='data'; npx tsx admin/server.ts"
Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-WindowStyle Hidden -Command `"$adminCmd`"" `
    -WorkingDirectory $quinnWorkspace `
    -WindowStyle Hidden | Out-Null

Write-Log "Starting dashboard server on port $dashboardPort..."
$dashboardCmd = "cd '$quinnWorkspace'; `$env:DASHBOARD_PORT='$dashboardPort'; `$env:DATA_DIR='data'; npx tsx --env-file=.env dashboard/server.ts"
Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-WindowStyle Hidden -Command `"$dashboardCmd`"" `
    -WorkingDirectory $quinnWorkspace `
    -WindowStyle Hidden | Out-Null

Write-Log "Starting Mission Control..."
$mcCmd = "cd '$missionControlDir'; npm run start"
Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-WindowStyle Hidden -Command `"$mcCmd`"" `
    -WindowStyle Hidden | Out-Null
```

- [ ] **Step 2: Poll all readiness targets after launching them**

Add a helper:

```powershell
function Wait-QuinnUrl($Name, $Url, $TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $attempt = 0
    while ((Get-Date) -lt $deadline) {
        $attempt += 1
        if (Test-Url $Url) {
            Write-Log "$Name ready (attempt $attempt)."
            return $true
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Log "ERROR: $Name failed to become ready within ${TimeoutSeconds}s."
    return $false
}
```

Then call:

```powershell
$gatewayReady = Wait-QuinnUrl "Gateway" $gatewayUrl 35
$proxyReady = Wait-QuinnUrl "Gateway-proxy" $gatewayProxyUrl 10
$adminReady = Wait-QuinnUrl "Admin server" $adminUrl 20
$dashboardReady = Wait-QuinnUrl "Dashboard server" $dashboardUrl 20
$mcReady = Wait-QuinnUrl "Mission Control" $missionControlUrl 10
```

Expected: Total launch time becomes roughly the slowest service instead of the sum of all services.

---

### Task 5: Verify Under-30-Second Startup

**Files:**
- Runtime only.

- [ ] **Step 1: Stop current Quinn services**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\jared\.openclaw-quinn-co\stop-quinn-co.ps1
```

Expected: Ports `3000`, `4242`, `4245`, `19100`, and `19101` report free.

- [ ] **Step 2: Start launcher**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\jared\.openclaw-quinn-co\launch-quinn-co.ps1
```

Expected: Launcher reaches monitor mode within 30 seconds.

- [ ] **Step 3: Verify conversation readiness**

Run:

```powershell
Invoke-WebRequest http://localhost:3000/login -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:4242/ -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:19101/ -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:19100/ -UseBasicParsing
```

Expected: Each endpoint responds without timeout.

---

### Task 6: Security Follow-Up, Separate From Speed

**Files:**
- Inspect only unless Jared approves security config changes.

- [ ] **Step 1: Confirm Quinn remains loopback-only**

Run:

```powershell
Get-NetTCPConnection -LocalPort 19100,19101,4242,4245,3000 -State Listen |
  Select-Object LocalAddress,LocalPort,OwningProcess
```

Expected: Quinn gateway and proxy bind loopback; dashboard/admin/MC should not be exposed publicly in a commercial install without proper auth and firewall posture.

- [ ] **Step 2: Treat `allowInsecureAuth=true` as a separate hardening task**

Do not change this during the speed pass. It is not causing the 97-second startup, but it is a commercial-readiness security issue.

- [ ] **Step 3: Treat the main OpenClaw Haiku startup as separate from Quinn-Co**

Main OpenClaw on `18789` currently reports `anthropic/claude-haiku-4-5-20251001`. Quinn-Co on `19100` currently reports `openai-codex/gpt-5.5`. Do not conflate the two services.
