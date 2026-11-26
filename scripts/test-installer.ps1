param([string]$Installer)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if (-not $Installer) { $Installer = Join-Path $root "artifacts\VLC-Drive-Watch-Party-Setup-$version.exe" }
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$registryKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{2A44A9BA-E848-4CB2-B6C6-01C4519BDD14}_is1'
if (Test-Path -LiteralPath $registryKey) { throw 'A real copy is already installed. Run verification under a separate Windows user instead of replacing it.' }
$testRoot = Join-Path $env:TEMP ('WatchParty-Installer-Check-' + [guid]::NewGuid().ToString('N'))
$installed = Join-Path $testRoot 'installed'
$capture = Join-Path $testRoot 'browser-url.txt'
$launcher = $null
$oldEnvironment = @{}

function Assert-That($Value, [string]$Message) {
    if (-not $Value) { throw $Message }
}
function Until([scriptblock]$Condition, [string]$Message) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    throw $Message
}
function Run-Checked([string]$File, [string]$Arguments) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru
    if (-not $process.WaitForExit(120000)) {
        Stop-Process -Id $process.Id -Force
        throw 'Verification command timed out.'
    }
    Assert-That ($process.ExitCode -eq 0) "Verification command failed with exit code $($process.ExitCode)."
}
function Free-Port {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    return $port
}
function Read-Launch {
    Until { Test-Path -LiteralPath $capture } 'The launcher did not open its authorized browser URL.'
    $url = [Uri](Get-Content -LiteralPath $capture -Raw)
    Assert-That ($url.Host -eq '127.0.0.1' -and $url.Scheme -eq 'http') 'The launcher opened a nonlocal URL.'
    return @{
        Origin = $url.GetLeftPart([UriPartial]::Authority)
        Headers = @{ Authorization = 'Bearer ' + $url.Fragment.Substring('#key='.Length) }
    }
}
try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    $browser = Join-Path $testRoot 'BrowserFixture.exe'
    Add-Type -TypeDefinition @'
using System;
using System.IO;
internal static class BrowserFixture {
    [STAThread] private static void Main(string[] args) {
        File.WriteAllText(Environment.GetEnvironmentVariable("WATCH_PARTY_TEST_CAPTURE"), args[0]);
    }
}
'@ -OutputAssembly $browser -OutputType WindowsApplication
    $overrides = @{
        WATCH_PARTY_DATA_DIR = (Join-Path $testRoot 'data')
        WATCH_PARTY_PORT = [string](Free-Port)
        WATCH_PARTY_SYNC_PORT = [string](Free-Port)
        WATCH_PARTY_BROWSER = $browser
        WATCH_PARTY_NO_BROWSER = ''
        WATCH_PARTY_TEST_CAPTURE = $capture
    }
    foreach ($name in $overrides.Keys) {
        $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $overrides[$name], 'Process')
    }
    Run-Checked $Installer "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /DIR=`"$installed`""
    $inventory = Get-Content -LiteralPath (Join-Path $root 'artifacts\payload-manifest.json') -Raw | ConvertFrom-Json
    foreach ($file in $inventory.files) {
        $stream = [IO.File]::OpenRead((Join-Path $installed $file.path))
        $hasher = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
        finally { $stream.Dispose(); $hasher.Dispose() }
        Assert-That ($actual -eq $file.sha256) "Installed payload mismatch: $($file.path)"
    }
    Write-Output 'Installed payload matches the release inventory.'
    $executable = Join-Path $installed 'WatchParty.exe'
    $launcher = Start-Process -FilePath $executable -PassThru
    $local = Read-Launch
    $state = Invoke-RestMethod ($local.Origin + '/api/state') -Headers $local.Headers
    Assert-That ($state.configured -and $state.canQuit -and -not $state.signedIn) 'Installed configuration or isolated Google session is incorrect.'
    Assert-That (-not (Test-Path (Join-Path $overrides.WATCH_PARTY_DATA_DIR 'tools'))) 'Guest startup unexpectedly downloaded hosting tools.'
    try {
        Invoke-WebRequest ($local.Origin + '/api/state') -UseBasicParsing | Out-Null
        throw 'The installed local API did not require authorization.'
    } catch [System.Net.WebException] {
        Assert-That ([int]$_.Exception.Response.StatusCode -eq 403) 'Unexpected unauthenticated response.'
    }
    $login = Invoke-RestMethod ($local.Origin + '/api/login') -Method Post -Body '{}' -ContentType 'application/json' -Headers $local.Headers
    Assert-That (([Uri]$login.url).Host -eq 'accounts.google.com') 'Google login did not use the system-browser OAuth flow.'
    $nodes = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($launcher.Id)" | Where-Object Name -eq 'node.exe')
    Assert-That ($nodes.Count -eq 1 -and $nodes[0].ExecutablePath -eq (Join-Path $installed 'runtime\node.exe')) 'The launcher did not use exactly one bundled Node runtime.'
    $nodeId = $nodes[0].ProcessId
    Remove-Item -LiteralPath $capture
    Run-Checked $executable ' '
    $reopened = Read-Launch
    Assert-That ($reopened.Origin -eq $local.Origin -and $reopened.Headers.Authorization -eq $local.Headers.Authorization) 'Reopening replaced the running instance.'
    Assert-That (Get-Process -Id $nodeId -ErrorAction SilentlyContinue) 'The original runtime did not survive reopening.'
    Invoke-RestMethod ($local.Origin + '/api/quit') -Method Post -Body '{}' -ContentType 'application/json' -Headers $local.Headers | Out-Null
    Until { $launcher.Refresh(); $launcher.HasExited } 'Quit from the UI did not close the launcher.'
    Until { -not (Get-Process -Id $nodeId -ErrorAction SilentlyContinue) } 'Quit left its Node runtime running.'
    Write-Output 'Bundled-runtime startup, Google authorization URL, local API protection, single-instance reopen and UI quit passed.'

    Remove-Item -LiteralPath $capture
    $launcher = Start-Process -FilePath $executable -PassThru
    $null = Read-Launch
    $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($launcher.Id)" | Where-Object Name -eq 'node.exe'
    Assert-That $child 'The crash-cleanup fixture did not start.'
    Stop-Process -Id $launcher.Id -Force
    Until { -not (Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue) } 'Launcher termination left an orphaned runtime.'
    Write-Output 'Windows job ownership cleaned up the runtime after launcher termination.'

    Remove-Item -LiteralPath $capture
    $launcher = Start-Process -FilePath $executable -PassThru
    $null = Read-Launch
    Run-Checked (Join-Path $installed 'unins000.exe') '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART'
    Until { $launcher.Refresh(); $launcher.HasExited } 'Uninstall did not shut down the running application.'
    Assert-That (-not (Test-Path -LiteralPath $executable)) 'Uninstall left the application executable.'
    Assert-That (-not (Test-Path -LiteralPath $registryKey)) 'Uninstall left its registration.'
    Write-Output 'Uninstall while running removed the installed application and registration.'
    Write-Output 'Installer verification passed. Existing host/guest companion sessions were not touched.'
} finally {
    if ($launcher) {
        $launcher.Refresh()
        if (-not $launcher.HasExited) { Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue }
    }
    $uninstaller = Join-Path $installed 'unins000.exe'
    if (Test-Path -LiteralPath $uninstaller) {
        Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -Wait
    }
    foreach ($name in $oldEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process') }
    if (Test-Path -LiteralPath $capture) { Remove-Item -LiteralPath $capture }
    if ((Split-Path -Leaf $testRoot) -match '^WatchParty-Installer-Check-[a-f0-9]{32}$' -and (Split-Path -Parent $testRoot) -eq $env:TEMP) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
