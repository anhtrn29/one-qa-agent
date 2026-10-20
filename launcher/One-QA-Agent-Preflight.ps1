<#
  ONE QA Agent V1 - Preflight Launcher (idempotent)
  Reuses healthy components; starts only stopped ones.
  Logs operational status only - never credentials/tokens/cookies/API keys.
#>
[CmdletBinding()]
param(
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

$ConfigPath = Join-Path $PSScriptRoot 'launcher.config.json'
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Write-Host ('CONFIG MISSING: {0}' -f $ConfigPath) -ForegroundColor Red
    exit 4
}
$cfg = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json

$LogDir = $cfg.logging.dir
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
$LogFile = Join-Path $LogDir ('launcher-{0:yyyyMMdd}.log' -f (Get-Date))

function Write-Log {
    param([string]$Level, [string]$Message)
    $line = '{0:o} [{1}] {2}' -f (Get-Date), $Level, $Message
    try { Add-Content -LiteralPath $LogFile -Value $line } catch { }
    switch ($Level) {
        'PASS'            { Write-Host $line -ForegroundColor Green }
        'STARTED'         { Write-Host $line -ForegroundColor Cyan }
        'ACTION REQUIRED' { Write-Host $line -ForegroundColor Yellow }
        'BLOCKED'         { Write-Host $line -ForegroundColor Red }
        'FAILED'          { Write-Host $line -ForegroundColor Red }
        default           { Write-Host $line -ForegroundColor Gray }
    }
}

function Remove-OldLogs {
    try {
        $cutoff = (Get-Date).AddDays(-1 * [int]$cfg.logging.retentionDays)
        Get-ChildItem -LiteralPath $LogDir -Filter 'launcher-*.log' -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt $cutoff } |
            Remove-Item -Force -ErrorAction SilentlyContinue
    } catch { }
}

function Test-HttpOk {
    param([string]$Url, [int]$TimeoutSec = 5)
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400)
    } catch { return $false }
}

function Wait-HttpOk {
    param([string]$Url, [int]$TimeoutSec = 90)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-HttpOk -Url $Url -TimeoutSec 4) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Test-TcpPort {
    param([string]$TargetHost, [int]$Port, [int]$TimeoutMs = 1500)
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect($TargetHost, $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne($TimeoutMs)
        if ($ok) { $c.EndConnect($iar) }
        $c.Close()
        return [bool]$ok
    } catch { return $false }
}

function Test-DockerEngine {
    try {
        $out = & docker info --format '{{.ServerVersion}}' 2>$null
        if ($LASTEXITCODE -eq 0 -and $out) { return ($out -join ' ').Trim() }
        return $null
    } catch { return $null }
}

function Ensure-Docker {
    $engine = Test-DockerEngine
    if ($engine) { Write-Log 'PASS' ('Docker engine healthy (version {0})' -f $engine); return @{ State = 'PASS'; Detail = $engine } }
    Write-Log 'STARTED' 'Docker engine unavailable - starting Docker Desktop'
    if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
        if (Test-Path -LiteralPath $cfg.docker.desktopExe) { Start-Process -FilePath $cfg.docker.desktopExe | Out-Null }
        else { Write-Log 'BLOCKED' ('Docker Desktop executable not found: {0}' -f $cfg.docker.desktopExe); return @{ State = 'BLOCKED'; Detail = 'desktop_exe_missing' } }
    }
    $deadline = (Get-Date).AddSeconds([int]$cfg.docker.engineWaitSeconds)
    while ((Get-Date) -lt $deadline) {
        $engine = Test-DockerEngine
        if ($engine) { Write-Log 'STARTED' ('Docker engine started (version {0})' -f $engine); return @{ State = 'STARTED'; Detail = $engine } }
        Start-Sleep -Seconds 3
    }
    Write-Log 'BLOCKED' ('Docker engine still unavailable after {0}s' -f $cfg.docker.engineWaitSeconds)
    return @{ State = 'BLOCKED'; Detail = 'engine_wait_timeout' }
}
function Ensure-Hermes {
    $name = $cfg.hermes.containerName
    $state = & docker inspect -f '{{.State.Running}}' $name 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Log 'BLOCKED' ('Hermes container missing: {0}' -f $name); return @{ State = 'BLOCKED'; Detail = 'container_missing' } }
    $wasRunning = (($state -join '').Trim() -eq 'true')
    if (-not $wasRunning) {
        Write-Log 'STARTED' ('Hermes container stopped - starting {0}' -f $name)
        & docker start $name 2>$null | Out-Null
    }
    if (Wait-HttpOk -Url $cfg.hermes.healthUrl -TimeoutSec ([int]$cfg.hermes.startTimeoutSeconds)) {
        if ($wasRunning) { Write-Log 'PASS' ('Hermes healthy ({0})' -f $cfg.hermes.healthUrl); return @{ State = 'PASS'; Detail = 'reused' } }
        Write-Log 'STARTED' ('Hermes started and healthy ({0})' -f $cfg.hermes.healthUrl); return @{ State = 'STARTED'; Detail = 'started' }
    }
    Write-Log 'FAILED' ('Hermes health check failed: {0}' -f $cfg.hermes.healthUrl)
    return @{ State = 'FAILED'; Detail = 'health_failed' }
}

function Ensure-Service {
    param([string]$Name, [string]$HealthUrl, [int]$Port, [scriptblock]$Starter, [int]$StartTimeoutSeconds)
    if (Test-HttpOk -Url $HealthUrl -TimeoutSec 5) { Write-Log 'PASS' ('{0} healthy ({1})' -f $Name, $HealthUrl); return @{ State = 'PASS'; Detail = 'reused' } }
    if (Test-TcpPort -TargetHost '127.0.0.1' -Port $Port) {
        Write-Log 'STARTED' ('{0} port {1} open but not healthy - waiting' -f $Name, $Port)
        if (Wait-HttpOk -Url $HealthUrl -TimeoutSec 30) { Write-Log 'PASS' ('{0} became healthy' -f $Name); return @{ State = 'PASS'; Detail = 'reused_pending' } }
        Write-Log 'FAILED' ('{0} port {1} occupied but health never passed' -f $Name, $Port)
        return @{ State = 'FAILED'; Detail = 'port_occupied_unhealthy' }
    }
    Write-Log 'STARTED' ('{0} not running - starting' -f $Name)
    try { & $Starter } catch { Write-Log 'FAILED' ('{0} failed to start: {1}' -f $Name, $_.Exception.Message); return @{ State = 'FAILED'; Detail = 'start_exception' } }
    if (Wait-HttpOk -Url $HealthUrl -TimeoutSec $StartTimeoutSeconds) { Write-Log 'STARTED' ('{0} started and healthy' -f $Name); return @{ State = 'STARTED'; Detail = 'started' } }
    Write-Log 'FAILED' ('{0} did not become healthy within {1}s' -f $Name, $StartTimeoutSeconds)
    return @{ State = 'FAILED'; Detail = 'start_timeout' }
}

function Start-NineRouter {
    # 9Router is launched with PORT/HOSTNAME injected via the process environment.
    # Start-Process spawns a child that inherits the launcher's environment, so
    # these values must be removed/restored afterward - otherwise a later child
    # started by this same launcher (e.g. Paperclip) would inherit PORT=20128 and
    # bind to the wrong port. Save -> set -> start -> restore with try/finally.
    $hadPort = Test-Path -LiteralPath 'Env:\PORT'
    $savedPort = $env:PORT
    $hadHostname = Test-Path -LiteralPath 'Env:\HOSTNAME'
    $savedHostname = $env:HOSTNAME
    try {
        $env:PORT = $cfg.nineRouter.envPort
        $env:HOSTNAME = $cfg.nineRouter.envHostname
        $entry = '.' + [IO.Path]::DirectorySeparatorChar + $cfg.nineRouter.entry
        Start-Process -FilePath 'node' -ArgumentList '--dns-result-order=ipv4first', '--max-old-space-size=6144', $entry -WorkingDirectory $cfg.nineRouter.appDir -WindowStyle Hidden
    }
    finally {
        if ($hadPort) { $env:PORT = $savedPort } else { Remove-Item -LiteralPath 'Env:\PORT' -ErrorAction SilentlyContinue }
        if ($hadHostname) { $env:HOSTNAME = $savedHostname } else { Remove-Item -LiteralPath 'Env:\HOSTNAME' -ErrorAction SilentlyContinue }
    }
}

function Start-Paperclip {
    $pa = @()
    foreach ($a in $cfg.paperclip.commandArgs) { $pa += [string]$a }
    Start-Process -FilePath $cfg.paperclip.commandPath -ArgumentList $pa -WindowStyle Hidden
}

function Start-QaBrowser {
    Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $cfg.qaBrowser.guardianScript -WindowStyle Hidden
}

function Invoke-CdpEvaluate {
    param([string]$WsUrl, [string]$Expression, [int]$TimeoutSec = 10)
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $ct = [System.Threading.CancellationToken]::None
    try {
        if (-not $ws.ConnectAsync([Uri]$WsUrl, $ct).Wait($TimeoutSec * 1000)) { return $null }
        $payload = @{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $Expression; returnByValue = $true } } | ConvertTo-Json -Depth 6 -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
        $seg = New-Object 'System.ArraySegment[byte]' -ArgumentList (,$bytes)
        if (-not $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait($TimeoutSec * 1000)) { return $null }
        $buffer = New-Object byte[] 65536
        $deadline = (Get-Date).AddSeconds($TimeoutSec)
        while ((Get-Date) -lt $deadline) {
            $sb = New-Object Text.StringBuilder
            do {
                $recvSeg = New-Object 'System.ArraySegment[byte]' -ArgumentList (,$buffer)
                $task = $ws.ReceiveAsync($recvSeg, $ct)
                if (-not $task.Wait($TimeoutSec * 1000)) { return $null }
                $res = $task.Result
                [void]$sb.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $res.Count))
            } while (-not $res.EndOfMessage)
            $text = $sb.ToString()
            try { $obj = $text | ConvertFrom-Json } catch { continue }
            if ($obj.id -eq 1) {
                if ($obj.result -and $obj.result.result) { return $obj.result.result.value }
                return $null
            }
        }
        return $null
    } catch { return $null }
    finally { $ws.Dispose() }
}

function Get-NexusAuthState {
    $listUrl = ($cfg.qaBrowser.cdpHttpEndpoint.TrimEnd('/')) + '/json'
    try { $targets = Invoke-RestMethod -Uri $listUrl -TimeoutSec 6 } catch { return 'UNKNOWN' }
    if (-not $targets) { return 'UNKNOWN' }
    $page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -and ($_.url -match [regex]::Escape($cfg.nexus.appHost)) } | Select-Object -First 1
    if (-not $page) { $page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -match 'nexus' } | Select-Object -First 1 }
    if (-not $page -or -not $page.webSocketDebuggerUrl) { return 'UNKNOWN' }
    $expr = '(() => { try { const e = document.querySelector(''input[type=password]''); const h = location.href; const t = document.title; return JSON.stringify({ href: h, title: t, pw: !!e }); } catch (x) { return JSON.stringify({ href: '''', title: '''', pw: true }); } })()'
    $val = Invoke-CdpEvaluate -WsUrl $page.webSocketDebuggerUrl -Expression $expr -TimeoutSec 10
    if (-not $val) { return 'UNKNOWN' }
    try { $o = $val | ConvertFrom-Json } catch { return 'UNKNOWN' }
    if ($o.pw) { return 'NOT_AUTHENTICATED' }
    if ($o.href -match [regex]::Escape($cfg.nexus.appHost)) { return 'AUTHENTICATED' }
    return 'UNKNOWN'
}

function Ensure-NexusAuth {
    $state = Get-NexusAuthState
    if ($state -eq 'AUTHENTICATED') { Write-Log 'PASS' 'Nexus session authenticated (QA browser CDP DOM signal)'; return @{ State = 'PASS'; Detail = 'authenticated' } }
    if ($state -eq 'NOT_AUTHENTICATED') { Write-Log 'ACTION REQUIRED' 'Login Nexus DEV'; return @{ State = 'ACTION REQUIRED'; Detail = 'not_authenticated' } }
    Write-Log 'ACTION REQUIRED' 'Login Nexus DEV (session state unconfirmed)'
    return @{ State = 'ACTION REQUIRED'; Detail = 'unconfirmed' }
}
function Get-Workspace {
    $p = $cfg.workspace.path
    if (-not (Test-Path -LiteralPath $p)) { Write-Log 'BLOCKED' ('Automation workspace not found: {0}' -f $p); return @{ State = 'BLOCKED'; Branch = ''; Head = ''; CleanText = 'missing' } }
    $branch = ((& git -C $p rev-parse --abbrev-ref HEAD 2>$null) -join '').Trim()
    $head = ((& git -C $p rev-parse --short HEAD 2>$null) -join '').Trim()
    $porcelain = (& git -C $p status --porcelain 2>$null)
    $clean = -not [bool]$porcelain
    $cleanText = 'clean'
    if (-not $clean) { $cleanText = 'dirty' }
    Write-Log 'PASS' ('Workspace {0} branch={1} head={2} status={3}' -f $p, $branch, $head, $cleanText)
    return @{ State = 'PASS'; Branch = $branch; Head = $head; CleanText = $cleanText }
}

function Invoke-Preflight {
    Write-Log 'INFO' '=== ONE QA Agent V1 preflight start ==='
    Remove-OldLogs
    $r = [ordered]@{}
    $r['Docker'] = Ensure-Docker
    $r['Hermes'] = Ensure-Hermes
    $r['9Router'] = Ensure-Service -Name '9Router' -HealthUrl $cfg.nineRouter.healthUrl -Port ([int]$cfg.nineRouter.port) -Starter { Start-NineRouter } -StartTimeoutSeconds ([int]$cfg.nineRouter.startTimeoutSeconds)
    $r['Paperclip'] = Ensure-Service -Name 'Paperclip' -HealthUrl $cfg.paperclip.healthUrl -Port ([int]$cfg.paperclip.port) -Starter { Start-Paperclip } -StartTimeoutSeconds ([int]$cfg.paperclip.startTimeoutSeconds)
    $r['QA Browser/CDP'] = Ensure-Service -Name 'QA Browser/CDP' -HealthUrl $cfg.qaBrowser.cdpVersionUrl -Port ([int]$cfg.qaBrowser.port) -Starter { Start-QaBrowser } -StartTimeoutSeconds ([int]$cfg.qaBrowser.startTimeoutSeconds)
    $r['Nexus auth'] = Ensure-NexusAuth
    $r['Workspace'] = Get-Workspace
    $states = @($r.Values | ForEach-Object { $_.State })
    $overall = 'READY'
    if ($states -contains 'FAILED') { $overall = 'FAILED' }
    elseif ($states -contains 'BLOCKED') { $overall = 'BLOCKED' }
    elseif ($states -contains 'ACTION REQUIRED') { $overall = 'ACTION REQUIRED' }
    Write-Log 'INFO' ('=== preflight result: {0} ===' -f $overall)
    return @{ Results = $r; Overall = $overall }
}

function Show-Summary {
    param($Run)
    Write-Host ''
    Write-Host '================ ONE QA AGENT V1 ================' -ForegroundColor White
    foreach ($k in $Run.Results.Keys) {
        $st = $Run.Results[$k].State
        $color = 'Gray'
        if ($st -eq 'PASS') { $color = 'Green' }
        elseif ($st -eq 'STARTED') { $color = 'Cyan' }
        elseif ($st -eq 'ACTION REQUIRED') { $color = 'Yellow' }
        elseif ($st -eq 'BLOCKED' -or $st -eq 'FAILED') { $color = 'Red' }
        Write-Host ('  [{0}] {1}' -f $st, $k) -ForegroundColor $color
    }
    $ws = $Run.Results['Workspace']
    Write-Host ('  Workspace: {0} @ {1} ({2})' -f $ws.Branch, $ws.Head, $ws.CleanText) -ForegroundColor Gray
    Write-Host '------------------------------------------------'
    $oc = 'Green'
    if ($Run.Overall -eq 'ACTION REQUIRED') { $oc = 'Yellow' }
    elseif ($Run.Overall -ne 'READY') { $oc = 'Red' }
    if ($Run.Overall -eq 'READY') { Write-Host '  FINAL: READY' -ForegroundColor $oc }
    elseif ($Run.Overall -eq 'ACTION REQUIRED') { Write-Host '  FINAL: ACTION REQUIRED: Login Nexus DEV' -ForegroundColor $oc }
    else { Write-Host ('  FINAL: {0}' -f $Run.Overall) -ForegroundColor $oc }
    Write-Host '================================================'
    Write-Host ''
}

$interactive = -not $NoPause
$run = $null
do {
    $run = Invoke-Preflight
    Show-Summary -Run $run
    if (-not $interactive) { break }
    if ($run.Overall -eq 'ACTION REQUIRED') {
        $k = Read-Host 'ACTION REQUIRED: Login Nexus DEV in the QA Browser. Press R then Enter to recheck, or Enter to exit'
        if ($k -match '^\s*[Rr]\s*$') { continue } else { break }
    } else {
        [void](Read-Host 'Press Enter to close')
        break
    }
} while ($true)

if ($run.Overall -eq 'READY') { exit 0 }
elseif ($run.Overall -eq 'ACTION REQUIRED') { exit 2 }
elseif ($run.Overall -eq 'BLOCKED') { exit 3 }
else { exit 4 }
