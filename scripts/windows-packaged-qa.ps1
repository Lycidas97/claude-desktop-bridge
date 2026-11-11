$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repositoryRoot

function Wait-HttpEndpoint {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  throw "Timed out waiting for $Url"
}

function Invoke-NpmScript {
  param([Parameter(Mandatory = $true)][string]$Name)
  & npm.cmd run $Name
  if ($LASTEXITCODE -ne 0) { throw "npm run $Name failed with exit code $LASTEXITCODE" }
}

function Set-QaProfile {
  param([Parameter(Mandatory = $true)][string]$Root)

  # --user-data-dir does not isolate os.homedir(), connectorPaths(), or the
  # detached service's BRIDGE_* data-path overrides.
  $profileRoot = Join-Path $Root "home"
  $appData = Join-Path $profileRoot "AppData/Roaming"
  $localAppData = Join-Path $profileRoot "AppData/Local"
  New-Item -ItemType Directory -Path $appData, $localAppData -Force | Out-Null
  $profileDrive = [IO.Path]::GetPathRoot($profileRoot).TrimEnd('\')
  [Environment]::SetEnvironmentVariable("USERPROFILE", $profileRoot, "Process")
  [Environment]::SetEnvironmentVariable("HOME", $profileRoot, "Process")
  [Environment]::SetEnvironmentVariable("HOMEDRIVE", $profileDrive, "Process")
  [Environment]::SetEnvironmentVariable("HOMEPATH", $profileRoot.Substring($profileDrive.Length), "Process")
  [Environment]::SetEnvironmentVariable("APPDATA", $appData, "Process")
  [Environment]::SetEnvironmentVariable("LOCALAPPDATA", $localAppData, "Process")
  [Environment]::SetEnvironmentVariable("CODEX_HOME", (Join-Path $profileRoot ".codex"), "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_USER_DATA", $Root, "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_SERVICE_DATA_PATH", $Root, "Process")
  # ClaudeDesktopBridge reads this exact name. Port 1 fails discovery without
  # attaching to a developer's real Native inspector on 9229.
  [Environment]::SetEnvironmentVariable("BRIDGE_CLAUDE_INSPECTOR_URL", "http://127.0.0.1:1", "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_CODEX_APP_SERVER_PATH", (Join-Path $profileRoot "missing-codex.exe"), "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_HERMES_GATEWAY_URL", "ws://127.0.0.1:1", "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_DSH_GATEWAY_URL", "http://127.0.0.1:1", "Process")
}

$installer = Get-ChildItem -Path "apps/desktop/out/make" -Recurse -Filter "*Setup.exe" |
  Select-Object -First 1
if ($null -eq $installer) {
  throw "Windows NSIS installer was not found. Run npm run make:windows first."
}

$qaRoot = Join-Path $env:TEMP ("bridge-packaged-qa-" + [Guid]::NewGuid().ToString("N"))
$smokeRoot = Join-Path $env:TEMP ("bridge-packaged-smoke-" + [Guid]::NewGuid().ToString("N"))
$installRoot = Join-Path $env:TEMP ("bridge-custom-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $qaRoot | Out-Null
New-Item -ItemType Directory -Path $smokeRoot | Out-Null

$environmentKeys = @(
  "BRIDGE_RELAY_HOST",
  "BRIDGE_RELAY_URL",
  "BRIDGE_PUBLIC_RELAY_URL",
  "BRIDGE_PAIRING_BASE_URL",
  "BRIDGE_SERVICE_ORIGIN",
  "BRIDGE_RELAY_DATA",
  "BRIDGE_DESKTOP_CDP",
  "BRIDGE_E2E_FORCE_RELAY",
  "BRIDGE_E2E_RELAY_URL",
  "BRIDGE_DEV_SERVER_URL",
  "ELECTRON_RUN_AS_NODE",
  "USERPROFILE",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "CODEX_HOME",
  "BRIDGE_USER_DATA",
  "BRIDGE_SERVICE_DATA_PATH",
  "BRIDGE_CLAUDE_INSPECTOR_URL",
  "BRIDGE_CODEX_APP_SERVER_PATH",
  "BRIDGE_HERMES_GATEWAY_URL",
  "BRIDGE_DSH_GATEWAY_URL"
)
$originalEnvironment = @{}
foreach ($key in $environmentKeys) {
  $originalEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
}

$relayProcess = $null
$desktopProcess = $null
$smokeProcess = $null
$desktopExecutable = $null
try {
  $installResult = Start-Process -FilePath $installer.FullName `
    -ArgumentList @("/S", "/D=$installRoot") `
    -Wait `
    -PassThru
  if ($installResult.ExitCode -ne 0) {
    throw "Windows installer failed with exit code $($installResult.ExitCode)."
  }

  $desktopExecutable = Get-ChildItem -Path $installRoot -Recurse -Filter "bridge.exe" |
    Select-Object -First 1
  if ($null -eq $desktopExecutable) {
    throw "Bridge executable was not installed into the selected directory: $installRoot"
  }
  if (-not $desktopExecutable.FullName.StartsWith(
    [IO.Path]::GetFullPath($installRoot),
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Bridge executable did not honor the selected installation directory."
  }

  foreach ($key in $environmentKeys) {
    [Environment]::SetEnvironmentVariable($key, $null, "Process")
  }
  Set-QaProfile -Root $smokeRoot
  $smokeStart = @{
    FilePath = $desktopExecutable.FullName
    ArgumentList = @(
      "--bridge-packaged-qa",
      "--user-data-dir=`"$smokeRoot`"",
      "--remote-debugging-port=9224"
    )
    WorkingDirectory = $desktopExecutable.DirectoryName
    PassThru = $true
  }
  $smokeProcess = Start-Process @smokeStart
  Wait-HttpEndpoint -Url "http://127.0.0.1:9224/json/version" -TimeoutSeconds 45
  if ($smokeProcess.HasExited) {
    throw "Packaged Windows app exited during the default-configuration startup smoke test."
  }
  & taskkill.exe /PID $smokeProcess.Id /T /F 2>$null | Out-Null
  $smokeProcess = $null

  Set-QaProfile -Root $qaRoot
  $relayUrl = "ws://127.0.0.1:8788/ws"
  [Environment]::SetEnvironmentVariable("BRIDGE_RELAY_HOST", "0.0.0.0", "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_RELAY_URL", $relayUrl, "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_PUBLIC_RELAY_URL", $relayUrl, "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_PAIRING_BASE_URL", "http://127.0.0.1:8788", "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_SERVICE_ORIGIN", "http://127.0.0.1:8788", "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_RELAY_DATA", (Join-Path $qaRoot "relay.sqlite"), "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_DESKTOP_CDP", "http://127.0.0.1:9223", "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_E2E_FORCE_RELAY", "1", "Process")

  $nodeExecutable = (Get-Command node.exe).Source
  $relayStart = @{
    FilePath = $nodeExecutable
    ArgumentList = (Join-Path $repositoryRoot "apps/relay/dist/index.js")
    WorkingDirectory = $repositoryRoot
    WindowStyle = "Hidden"
    PassThru = $true
  }
  $relayProcess = Start-Process @relayStart
  Wait-HttpEndpoint -Url "http://127.0.0.1:8788/health"

  $desktopStart = @{
    FilePath = $desktopExecutable.FullName
    ArgumentList = @(
      "--bridge-packaged-qa",
      "--user-data-dir=`"$qaRoot`"",
      "--remote-debugging-port=9223"
    )
    WorkingDirectory = $desktopExecutable.DirectoryName
    PassThru = $true
  }
  $desktopProcess = Start-Process @desktopStart
  Wait-HttpEndpoint -Url "http://127.0.0.1:9223/json/version" -TimeoutSeconds 45

  Invoke-NpmScript -Name "test:desktop:packaged"
  Invoke-NpmScript -Name "test:desktop:pairing"
} finally {
  if ($null -ne $smokeProcess -and -not $smokeProcess.HasExited) {
    & taskkill.exe /PID $smokeProcess.Id /T /F 2>$null | Out-Null
  }
  if ($null -ne $desktopProcess -and -not $desktopProcess.HasExited) {
    & taskkill.exe /PID $desktopProcess.Id /T /F 2>$null | Out-Null
  }
  if ($null -ne $relayProcess -and -not $relayProcess.HasExited) {
    Stop-Process -Id $relayProcess.Id -Force -ErrorAction SilentlyContinue
  }
  foreach ($key in $environmentKeys) {
    [Environment]::SetEnvironmentVariable($key, $originalEnvironment[$key], "Process")
  }
  $uninstaller = if (Test-Path -LiteralPath $installRoot) {
    Get-ChildItem -LiteralPath $installRoot -Filter "Uninstall*.exe" -File -ErrorAction SilentlyContinue |
      Select-Object -First 1
  } else {
    $null
  }
  if ($null -ne $uninstaller) {
    $uninstallResult = Start-Process -FilePath $uninstaller.FullName `
      -ArgumentList @("/currentuser", "/S") `
      -Wait `
      -PassThru
    if ($uninstallResult.ExitCode -ne 0) {
      throw "Windows uninstaller failed with exit code $($uninstallResult.ExitCode)."
    }
  }
  if ($env:RUNNER_ENVIRONMENT -eq "github-hosted") {
    # Hosted Windows runners can reject recycle-bin directory operations.
    # Retain isolated QA data rather than substitute permanent deletion.
    Write-Warning "Packaged QA data retained (hosted Windows recycle-bin cleanup is unsupported on some runners): $qaRoot; $smokeRoot; $installRoot"
  } else {
    & node.exe --require (Join-Path $PSScriptRoot "recycle-cleanup.cjs") `
      (Join-Path $PSScriptRoot "clean.mjs") $qaRoot $smokeRoot $installRoot
    if ($LASTEXITCODE -ne 0) {
      throw "Packaged QA recycle-bin cleanup failed with exit code $LASTEXITCODE. Inspect remaining paths: $qaRoot; $smokeRoot; $installRoot"
    }
  }
}
