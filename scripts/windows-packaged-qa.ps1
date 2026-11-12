$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repositoryRoot

function Wait-HttpEndpoint {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [int]$TimeoutSeconds = 30,
    [Diagnostics.Process]$Process = $null
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($null -ne $Process -and $Process.HasExited) {
      throw "Process $($Process.Id) exited with code $($Process.ExitCode) while waiting for $Url"
    }
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  throw "Timed out waiting for $Url"
}

function Get-FreeLoopbackPort {
  $listener = [Net.Sockets.TcpListener]::new([IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  return $port
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
  "BRIDGE_RELAY_PORT",
  "BRIDGE_RELAY_URL",
  "BRIDGE_PUBLIC_RELAY_URL",
  "BRIDGE_PAIRING_BASE_URL",
  "BRIDGE_SERVICE_ORIGIN",
  "BRIDGE_RELAY_DATA",
  "BRIDGE_DESKTOP_CDP",
  "BRIDGE_ANDROID_CDP",
  "BRIDGE_ANDROID_RELAY",
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
  if ($env:RUNNER_ENVIRONMENT -eq "github-hosted") {
    $installResult = Start-Process -FilePath $installer.FullName `
      -ArgumentList @("/S", "/D=$installRoot") `
      -Wait `
      -PassThru
    if ($installResult.ExitCode -ne 0) {
      throw "Windows installer failed with exit code $($installResult.ExitCode)."
    }
  } else {
    $unpackedDir = Join-Path $installer.DirectoryName "win-unpacked"
    if (-not (Test-Path -LiteralPath $unpackedDir)) {
      throw "Unpacked Windows build was not found alongside $($installer.FullName): $unpackedDir"
    }
    Copy-Item -LiteralPath $unpackedDir -Destination $installRoot -Recurse
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
  $smokePort = Get-FreeLoopbackPort
  $smokeStart = @{
    FilePath = $desktopExecutable.FullName
    ArgumentList = @(
      "--bridge-packaged-qa",
      "--user-data-dir=`"$smokeRoot`"",
      "--remote-debugging-port=$smokePort"
    )
    WorkingDirectory = $desktopExecutable.DirectoryName
    PassThru = $true
  }
  $smokeProcess = Start-Process @smokeStart
  Wait-HttpEndpoint -Url "http://127.0.0.1:$smokePort/json/version" -TimeoutSeconds 45 -Process $smokeProcess
  if ($smokeProcess.HasExited) {
    throw "Packaged Windows app exited during the default-configuration startup smoke test."
  }
  & cmd.exe /c "taskkill.exe /PID $($smokeProcess.Id) /T /F >nul 2>nul"
  $smokeProcess = $null

  Set-QaProfile -Root $qaRoot
  $relayPort = Get-FreeLoopbackPort
  $desktopCdpPort = Get-FreeLoopbackPort
  $relayUrl = "ws://127.0.0.1:$relayPort/ws"
  [Environment]::SetEnvironmentVariable("BRIDGE_RELAY_HOST", "0.0.0.0", "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_RELAY_PORT", "$relayPort", "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_RELAY_URL", $relayUrl, "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_PUBLIC_RELAY_URL", $relayUrl, "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_PAIRING_BASE_URL", "http://127.0.0.1:$relayPort", "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_SERVICE_ORIGIN", "http://127.0.0.1:$relayPort", "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_RELAY_DATA", (Join-Path $qaRoot "relay.sqlite"), "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_DESKTOP_CDP", "http://127.0.0.1:$desktopCdpPort", "Process")
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
  Wait-HttpEndpoint -Url "http://127.0.0.1:$relayPort/health" -Process $relayProcess

  $desktopStart = @{
    FilePath = $desktopExecutable.FullName
    ArgumentList = @(
      "--bridge-packaged-qa",
      "--user-data-dir=`"$qaRoot`"",
      "--remote-debugging-port=$desktopCdpPort"
    )
    WorkingDirectory = $desktopExecutable.DirectoryName
    PassThru = $true
  }
  $desktopProcess = Start-Process @desktopStart
  Wait-HttpEndpoint -Url "http://127.0.0.1:$desktopCdpPort/json/version" -TimeoutSeconds 45 -Process $desktopProcess

  Invoke-NpmScript -Name "test:desktop:packaged"
  Invoke-NpmScript -Name "test:desktop:pairing"

  if ($env:BRIDGE_WITH_ANDROID_SMOKE -eq "1") {
    $sdkRoot = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { $env:ANDROID_HOME }
    if (-not $sdkRoot) { throw "ANDROID_SDK_ROOT is required when BRIDGE_WITH_ANDROID_SMOKE=1" }
    $adb = Join-Path $sdkRoot "platform-tools/adb.exe"
    $apk = Join-Path $repositoryRoot "apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
    if (-not (Test-Path -LiteralPath $apk)) { throw "Android debug APK was not found at $apk" }

    & $adb wait-for-device
    if ($LASTEXITCODE -ne 0) { throw "adb wait-for-device failed with exit code $LASTEXITCODE" }
    & $adb install -r $apk
    if ($LASTEXITCODE -ne 0) { throw "adb install failed with exit code $LASTEXITCODE" }
    & $adb shell pm clear com.localbridge.mobile | Out-Null
    & $adb shell am start -W -n com.localbridge.mobile/.MainActivity | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to launch com.localbridge.mobile/.MainActivity" }

    $webviewSocket = $null
    $socketDeadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $socketDeadline -and -not $webviewSocket) {
      $unixSockets = & cmd.exe /c "`"$adb`" shell cat /proc/net/unix 2>nul"
      $match = ($unixSockets | Select-String -Pattern "@(webview_devtools_remote_\d+)" | Select-Object -First 1)
      if ($match) {
        $webviewSocket = $match.Matches[0].Groups[1].Value
      } else {
        Start-Sleep -Milliseconds 300
      }
    }
    if (-not $webviewSocket) { throw "Timed out waiting for Android WebView DevTools socket" }

    $androidPort = ((& $adb forward tcp:0 "localabstract:$webviewSocket") -join "").Trim()
    if ($LASTEXITCODE -ne 0 -or $androidPort -notmatch "^\d+$") {
      throw "adb forward tcp:0 failed with exit code $LASTEXITCODE ($androidPort)"
    }
    try {
      Wait-HttpEndpoint -Url "http://127.0.0.1:$androidPort/json" -TimeoutSeconds 20
      [Environment]::SetEnvironmentVariable("BRIDGE_ANDROID_CDP", "http://127.0.0.1:$androidPort", "Process")
      [Environment]::SetEnvironmentVariable("BRIDGE_ANDROID_RELAY", "ws://10.0.2.2:$relayPort/ws", "Process")
      [Environment]::SetEnvironmentVariable("BRIDGE_ANDROID_SMOKE_PAIRING_ONLY", "1", "Process")
      try {
        & $nodeExecutable --require (Join-Path $PSScriptRoot "recycle-cleanup.cjs") `
          (Join-Path $PSScriptRoot "android-installed-e2e.mjs")
        if ($LASTEXITCODE -ne 0) {
          throw "Android installed pairing smoke failed with exit code $LASTEXITCODE"
        }
      } finally {
        [Environment]::SetEnvironmentVariable("BRIDGE_ANDROID_CDP", $null, "Process")
        [Environment]::SetEnvironmentVariable("BRIDGE_ANDROID_RELAY", $null, "Process")
        [Environment]::SetEnvironmentVariable("BRIDGE_ANDROID_SMOKE_PAIRING_ONLY", $null, "Process")
      }
    } finally {
      & cmd.exe /c "`"$adb`" forward --remove tcp:$androidPort >nul 2>nul"
    }
  }
} finally {
  if ($null -ne $smokeProcess -and -not $smokeProcess.HasExited) {
    & cmd.exe /c "taskkill.exe /PID $($smokeProcess.Id) /T /F >nul 2>nul"
  }
  if ($null -ne $desktopProcess -and -not $desktopProcess.HasExited) {
    & cmd.exe /c "taskkill.exe /PID $($desktopProcess.Id) /T /F >nul 2>nul"
  }
  if ($null -ne $relayProcess -and -not $relayProcess.HasExited) {
    Stop-Process -Id $relayProcess.Id -Force -ErrorAction SilentlyContinue
  }
  foreach ($key in $environmentKeys) {
    [Environment]::SetEnvironmentVariable($key, $originalEnvironment[$key], "Process")
  }
  if (Test-Path -LiteralPath $installRoot) {
    $installPrefix = [IO.Path]::GetFullPath($installRoot).TrimEnd('\') + '\'
    $installPids = @(
      Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
          $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)
        } |
        Select-Object -ExpandProperty ProcessId
    )
    foreach ($procId in $installPids) {
      & cmd.exe /c "taskkill.exe /PID $procId /T /F >nul 2>nul"
    }
    if ($installPids.Count -gt 0) {
      Wait-Process -Id $installPids -Timeout 5 -ErrorAction SilentlyContinue
    }
    $global:LASTEXITCODE = 0
  }
  if ($env:RUNNER_ENVIRONMENT -eq "github-hosted") {
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
