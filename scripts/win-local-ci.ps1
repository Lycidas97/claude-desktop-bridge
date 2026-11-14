param(
  [Parameter(Mandatory = $true)][string]$Revision,
  [Parameter(Mandatory = $true)][string]$BundlePath,
  [switch]$SkipWslLinux
)

$ErrorActionPreference = "Stop"
chcp 65001 > $null
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)

# Keep Windows out of Modern Standby (S0 Low Power Idle) for the lifetime of this CI process
Add-Type -Namespace BridgeCi -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
[BridgeCi.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null

$workRoot = "D:\work"
$anchorRepo = "$workRoot\claude-desktop-bridge"
$toolsRoot = "$workRoot\tools"
$cacheRoot = "$workRoot\cache"

$nodeBin = "$toolsRoot\node-26"
$jdkRoot = "$toolsRoot\jdk-21"
$pythonRoot = "$toolsRoot\python"
$sdkRoot = "$toolsRoot\android-sdk"

$ownsTempRoot = -not $env:BRIDGE_TEST_TEMP_ROOT
$tempDir = if ($ownsTempRoot) { Join-Path $cacheRoot ("test-temp-" + [Guid]::NewGuid().ToString("N")) } else { $env:BRIDGE_TEST_TEMP_ROOT }
$npmCache = "$cacheRoot\npm"
$electronCache = "$cacheRoot\electron"
$electronBuilderCache = "$cacheRoot\electron-builder"
$gradleHome = "$cacheRoot\gradle"
$androidUserHome = "$cacheRoot\android-user"
$avdHome = "$cacheRoot\android-avd"

New-Item -ItemType Directory -Force -Path `
  $npmCache, $electronCache, $electronBuilderCache, $gradleHome, $androidUserHome, $avdHome | Out-Null
if ($ownsTempRoot) { New-Item -ItemType Directory -Path $tempDir | Out-Null }

$env:BRIDGE_TEST_TEMP_ROOT = $tempDir
$env:TEMP = $tempDir
$env:TMP = $tempDir
$env:TMPDIR = $tempDir
$env:npm_config_cache = $npmCache
$env:ELECTRON_CACHE = $electronCache
$env:ELECTRON_BUILDER_CACHE = $electronBuilderCache
$env:JAVA_HOME = $jdkRoot
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:ANDROID_USER_HOME = $androidUserHome
$env:ANDROID_AVD_HOME = $avdHome
$env:GRADLE_USER_HOME = $gradleHome
$env:GRADLE_OPTS = "-Dhttp.proxyHost=192.168.1.100 -Dhttp.proxyPort=10808 -Dhttps.proxyHost=192.168.1.100 -Dhttps.proxyPort=10808"
$env:HTTP_PROXY = "http://192.168.1.100:10808"
$env:HTTPS_PROXY = "http://192.168.1.100:10808"
$env:NO_PROXY = "127.0.0.1,localhost"
$env:PATH = "$nodeBin;$jdkRoot\bin;$pythonRoot;$sdkRoot\platform-tools;$sdkRoot\emulator;$sdkRoot\cmdline-tools\latest\bin;$env:PATH"

$gradlePropertiesPath = "$gradleHome\gradle.properties"
if (-not (Test-Path $gradlePropertiesPath)) {
  $gradleProps = @(
    "systemProp.http.proxyHost=192.168.1.100",
    "systemProp.http.proxyPort=10808",
    "systemProp.https.proxyHost=192.168.1.100",
    "systemProp.https.proxyPort=10808",
    "systemProp.http.nonProxyHosts=localhost|127.0.0.1"
  ) -join "`n"
  [IO.File]::WriteAllText($gradlePropertiesPath, "$gradleProps`n", [Text.Encoding]::ASCII)
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Write-Output ">>> [WIN] $Label"
  $global:LASTEXITCODE = 0
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "[WIN] $Label failed with exit code $LASTEXITCODE"
  }
  $sw.Stop()
  Write-Output ("<<< [WIN] $Label OK ({0:N1}s)" -f $sw.Elapsed.TotalSeconds)
}

$wslProc = $null
$wslOutTask = $null
$wslErrTask = $null
$nsisProc = $null

# Up to 4 concurrent ci:local runs; each slot owns its worktree + bundle ref, AVD + ADB port, and WSL2 checkout
$slotCount = 4
$slotMutexes = @(0..($slotCount - 1) | ForEach-Object { [System.Threading.Mutex]::new($false, "Local\ClaudeDesktopBridgeWinCi-$_") })
$slot = -1
try {
  foreach ($index in 0..($slotCount - 1)) {
    try {
      if ($slotMutexes[$index].WaitOne(0)) { $slot = $index; break }
    } catch [System.Threading.AbandonedMutexException] {
      $slot = $index; break
    }
  }
  if ($slot -lt 0) {
    Write-Output ">>> [WIN] All $slotCount win-local-ci slots busy (Local\ClaudeDesktopBridgeWinCi-*); waiting for one to finish..."
    try {
      $slot = [System.Threading.WaitHandle]::WaitAny($slotMutexes)
    } catch [System.Threading.AbandonedMutexException] {
      $slot = $_.Exception.MutexIndex
    }
  }
  Write-Output ">>> [WIN] Acquired win-local-ci slot $slot"

$ciWorktree = "$workRoot\ci-slot-$slot"
$avdName = "bridge-ci-api36-$slot"
$emulatorPort = 5560 + 2 * $slot
$env:ANDROID_SERIAL = "emulator-$emulatorPort"
$recycleStaging = Join-Path $tempDir "qa-staging"

# 1. Fetch exact commit bundle into the anchor repo under this slot's ref and check out D:\work\ci-slot-<n>
Invoke-Checked "Sync git bundle ($Revision)" {
  git -C $anchorRepo bundle verify $BundlePath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "git bundle verify failed ($LASTEXITCODE)" }
  git -C $anchorRepo fetch --force $BundlePath "HEAD:refs/ci/slot-$slot"
}

if (-not (Test-Path "$ciWorktree\.git")) {
  Invoke-Checked "Create $ciWorktree" {
    git -C $anchorRepo worktree add --force --detach $ciWorktree $Revision
  }
} else {
  Invoke-Checked "Checkout $Revision in $ciWorktree" {
    git -C $ciWorktree reset --hard
    if ($LASTEXITCODE -ne 0) { throw "git reset failed ($LASTEXITCODE)" }
    git -C $ciWorktree checkout --force --detach $Revision
  }
}

Set-Location $ciWorktree
$actualSha = (git rev-parse HEAD).Trim()
if ($actualSha -ne $Revision) {
  throw "Worktree HEAD mismatch: expected $Revision, got $actualSha"
}

# 2. Compile STA native SHFileOperation(0x0454) Recycle-Bin helper to avoid cold PowerShell CLR startup per test
$recycleCs = "$ciWorktree\scripts\win-recycle.cs"
$recycleExe = "$cacheRoot\bridge-recycle.exe"
$recycleStamp = "$cacheRoot\bridge-recycle.sha256"
$recycleHash = (Get-FileHash -Algorithm SHA256 $recycleCs).Hash
$cachedRecycleHash = if (Test-Path $recycleStamp) { (Get-Content $recycleStamp -Raw).Trim() } else { "" }
if ($recycleHash -ne $cachedRecycleHash -or -not (Test-Path $recycleExe)) {
  Invoke-Checked "Compile win-recycle.cs -> bridge-recycle.exe" {
    & "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /optimize+ /target:exe "/out:$recycleExe" $recycleCs
  }
  Set-Content -Path $recycleStamp -Value $recycleHash -NoNewline
}
$env:BRIDGE_WIN_RECYCLE_EXE = $recycleExe
# QA scratch lives inside this run's private root; Node never stages arbitrary user files or old artifacts here.
New-Item -ItemType Directory -Path $recycleStaging | Out-Null
$env:BRIDGE_RECYCLE_STAGING = $recycleStaging

# 3. Install npm dependencies when package-lock.json changes
$lockHash = (Get-FileHash -Algorithm SHA256 "package-lock.json").Hash
$stampFile = "node_modules\.bridge-lock-sha256"
$cachedHash = if (Test-Path $stampFile) { (Get-Content $stampFile -Raw).Trim() } else { "" }
if ($lockHash -ne $cachedHash -or -not (Test-Path "node_modules\electron\package.json")) {
  Invoke-Checked "npm ci" {
    & "$nodeBin\npm.cmd" ci
  }
  Set-Content -Path $stampFile -Value $lockHash -NoNewline
}

# 4. Windows infra + unit tests (typecheck is platform-independent and runs once in macOS verify) (runs before QEMU cold boot so Vitest gets uncontended CPU/IO)
Invoke-Checked "npm run test:infra" { & "$nodeBin\npm.cmd" run test:infra }
Invoke-Checked "npm test (Windows)" { & "$nodeBin\npm.cmd" test }

# 5. Boot headless WHPX Android Emulator in background while shared prerequisites, NSIS, and Gradle APK build run
$adb = "$sdkRoot\platform-tools\adb.exe"
$emulatorExe = "$sdkRoot\emulator\emulator.exe"
$startedEmulator = $false
# OpenSSH kills every process in a session's job when the session ends, so an adb server spawned by one
# slot would take down the adb forwards of the other slots. Start the shared server through WMI instead.
$adbServer = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$adb`" start-server" }
if ($adbServer.ReturnValue -ne 0) { throw "Failed to launch adb start-server via WMI ($($adbServer.ReturnValue))" }
Wait-Process -Id $adbServer.ProcessId -ErrorAction SilentlyContinue
$avdIni = "$avdHome\$avdName.ini"
if (-not (Test-Path $avdIni)) {
  Invoke-Checked "Clone AVD bridge-ci-api36 -> $avdName" {
    $avdDir = "$avdHome\$avdName.avd"
    New-Item -ItemType Directory -Force -Path $avdDir | Out-Null
    Copy-Item "$avdHome\bridge-ci-api36.avd\config.ini" "$avdDir\config.ini"
    $ini = (Get-Content "$avdHome\bridge-ci-api36.ini") -replace "^path=.*", "path=$avdDir"
    [IO.File]::WriteAllLines($avdIni, $ini, [Text.Encoding]::ASCII)
  }
}
$onlineEmulator = (& $adb devices) | Select-String -Pattern "^$env:ANDROID_SERIAL\s+device$"
if (-not $onlineEmulator) {
  Write-Output ">>> [WIN] Starting headless WHPX AVD $avdName on $env:ANDROID_SERIAL in background"
  Start-Process -FilePath $emulatorExe `
    -ArgumentList @("-avd", $avdName, "-port", "$emulatorPort", "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save", "-gpu", "swiftshader_indirect") `
    -WindowStyle Hidden | Out-Null
  $startedEmulator = $true
}

try {
  # 6. Build shared prerequisites (@bridge/protocol, @bridge/relay, @bridge/client)
  Invoke-Checked "Build @bridge/protocol, @bridge/relay & @bridge/client" {
    & "$nodeBin\npm.cmd" run ci:run -- run build -w @bridge/protocol
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & "$nodeBin\npm.cmd" run ci:run -- run build -w @bridge/relay
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $prevViteRelay = $env:VITE_BRIDGE_PUBLIC_RELAY_URL
    $prevViteOrigin = $env:VITE_BRIDGE_SERVICE_ORIGIN
    $prevViteIce = $env:VITE_BRIDGE_ICE_SERVERS
    try {
      $env:VITE_BRIDGE_PUBLIC_RELAY_URL = "wss://bis.zju.edu.cn/bridge-relay/ws"
      $env:VITE_BRIDGE_SERVICE_ORIGIN = "https://bis.zju.edu.cn/bridge-relay"
      $env:VITE_BRIDGE_ICE_SERVERS = '[{"urls":"stun:stun.cloudflare.com:3478"}]'
      & "$nodeBin\npm.cmd" run ci:run -- run build -w @bridge/client
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
      $env:VITE_BRIDGE_PUBLIC_RELAY_URL = $prevViteRelay
      $env:VITE_BRIDGE_SERVICE_ORIGIN = $prevViteOrigin
      $env:VITE_BRIDGE_ICE_SERVERS = $prevViteIce
    }
  }

  # 7. Build Windows NSIS installer (make:windows:from-client) in parallel with Android debug APK
  Write-Output ">>> [WIN] Starting Windows NSIS installer (make:windows:from-client) in background"
  $nsisSw = [Diagnostics.Stopwatch]::StartNew()
  $nsisPsi = [System.Diagnostics.ProcessStartInfo]::new("cmd.exe")
  $nsisPsi.Arguments = "/d /s /c `"`"$nodeBin\npm.cmd`" run ci:run -- run make:windows:from-client -w @bridge/desktop`""
  $nsisPsi.WorkingDirectory = $ciWorktree
  $nsisPsi.UseShellExecute = $false
  $nsisPsi.RedirectStandardOutput = $true
  $nsisPsi.RedirectStandardError = $true
  $nsisPsi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $nsisPsi.StandardErrorEncoding = [Text.Encoding]::UTF8
  $nsisPsi.EnvironmentVariables["BRIDGE_FAST_INSTALLER"] = "1"
  $nsisPsi.EnvironmentVariables["BRIDGE_RELAY_URL"] = "wss://bis.zju.edu.cn/bridge-relay/ws"
  $nsisPsi.EnvironmentVariables["BRIDGE_PUBLIC_RELAY_URL"] = "wss://bis.zju.edu.cn/bridge-relay/ws"
  $nsisPsi.EnvironmentVariables["BRIDGE_PAIRING_BASE_URL"] = "https://bis.zju.edu.cn"
  $nsisPsi.EnvironmentVariables["BRIDGE_SERVICE_ORIGIN"] = "https://bis.zju.edu.cn"
  $nsisPsi.EnvironmentVariables["BRIDGE_ICE_SERVERS"] = '[{"urls":"stun:stun.cloudflare.com:3478"}]'
  $nsisProc = [System.Diagnostics.Process]::Start($nsisPsi)
  $nsisOutTask = $nsisProc.StandardOutput.ReadToEndAsync()
  $nsisErrTask = $nsisProc.StandardError.ReadToEndAsync()

  Invoke-Checked "Sync Capacitor Android (@bridge/mobile)" {
    & "$nodeBin\npm.cmd" run ci:run -- run sync:from-client -w @bridge/mobile
  }

  Invoke-Checked "Gradle assembleDebug (Android SDK 36)" {
    Push-Location "apps/mobile/android"
    try {
      # Keep --no-daemon for now: shared Gradle daemon lifecycle across concurrent ssh win slots is deferred (not yet empirically verified).
      & ".\gradlew.bat" assembleDebug --no-daemon
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
      Pop-Location
    }
  }

  $apkPath = "apps\mobile\android\app\build\outputs\apk\debug\app-debug.apk"
  Invoke-Checked "Verify Android DEX bytecode" {
    & "$pythonRoot\python.exe" -I scripts/verify-android-dex.py $apkPath
  }

  $apksigner = Get-ChildItem "$sdkRoot\build-tools\*\apksigner.bat" | Sort-Object FullName | Select-Object -Last 1
  if ($null -eq $apksigner) { throw "apksigner.bat not found under $sdkRoot\build-tools" }
  $expectedCert = "8b4e8a0ed8e506dde6ff65f92b9bd526d2fcaf10d35089d381a02d9ed23a18db"
  $certOut = & {
    $ErrorActionPreference = "Continue"
    (& $apksigner.FullName verify --print-certs $apkPath 2>&1) -join "`n"
  }
  if ($certOut -notmatch "certificate SHA-256 digest:\s*([0-9a-fA-F]+)") {
    throw "Failed to parse APK certificate digest: $certOut"
  }
  $actualCert = $Matches[1].ToLowerInvariant()
  if ($actualCert -ne $expectedCert) {
    throw "Debug APK signature drifted: [$actualCert] (expected $expectedCert)"
  }
  Write-Output "<<< [WIN] Android APK debug signature OK: $actualCert"

  $nsisProc.WaitForExit()
  $nsisOut = $nsisOutTask.GetAwaiter().GetResult()
  $nsisErr = $nsisErrTask.GetAwaiter().GetResult()
  $nsisSw.Stop()
  if ($nsisOut) { Write-Output $nsisOut.TrimEnd() }
  if ($nsisErr) { [Console]::Error.WriteLine($nsisErr.TrimEnd()) }
  if ($nsisProc.ExitCode -ne 0) {
    throw "[WIN] Build Windows NSIS installer (make:windows:from-client) failed with exit code $($nsisProc.ExitCode)"
  }
  $setupExe = Get-ChildItem -Path "apps/desktop/out/make" -Recurse -Filter "*Setup.exe" | Select-Object -First 1
  if ($null -eq $setupExe) { throw "Assisted NSIS Setup.exe was not produced" }
  Write-Output ("<<< [WIN] Build Windows NSIS installer (make:windows:from-client) OK ({0:N1}s)" -f $nsisSw.Elapsed.TotalSeconds)

  # 8. Wait for Android Emulator boot completion and guest network readiness, then run packaged Windows QA + Android WebView pairing smoke
  $bootDeadline = (Get-Date).AddSeconds(180)
  $booted = $false
  while ((Get-Date) -lt $bootDeadline) {
    $prop = (& cmd.exe /c "`"$adb`" shell getprop sys.boot_completed 2>nul") -join ""
    if ($prop.Trim() -eq "1") {
      $route = (& cmd.exe /c "`"$adb`" shell ip route 2>nul") -join "`n"
      $connectivity = (& cmd.exe /c "`"$adb`" shell dumpsys connectivity 2>nul") -join "`n"
      if ($route -match "10\.0\.2\.0/24" -and $connectivity -match "Active default network:\s*\d+") {
        $booted = $true
        break
      }
    }
    Start-Sleep -Seconds 2
  }
  if (-not $booted) {
    throw "Timed out waiting for Android Emulator $avdName ($env:ANDROID_SERIAL) boot and guest network readiness"
  }
  Write-Output "<<< [WIN] Android Emulator sys.boot_completed=1, guest network ready"

  Invoke-Checked "Packaged Windows QA + Android Emulator WebView Pairing Smoke" {
    $prevSmoke = $env:BRIDGE_WITH_ANDROID_SMOKE
    $prevNoProxy = $env:NO_PROXY
    $prevHttpProxy = $env:HTTP_PROXY
    $prevHttpsProxy = $env:HTTPS_PROXY
    try {
      $env:BRIDGE_WITH_ANDROID_SMOKE = "1"
      $env:HTTP_PROXY = ""
      $env:HTTPS_PROXY = ""
      $env:NO_PROXY = "127.0.0.1,localhost,10.0.2.2"
      & "$nodeBin\npm.cmd" run ci:run -- run test:desktop:packaged:windows
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
      $env:BRIDGE_WITH_ANDROID_SMOKE = $prevSmoke
      $env:NO_PROXY = $prevNoProxy
      $env:HTTP_PROXY = $prevHttpProxy
      $env:HTTPS_PROXY = $prevHttpsProxy
    }
  }
} finally {
  if ($null -ne $nsisProc) {
    try {
      if (-not $nsisProc.HasExited) {
        & cmd.exe /c "taskkill.exe /PID $($nsisProc.Id) /T /F >nul 2>nul"
      }
    } finally {
      $nsisProc.Dispose()
    }
  }
  if ($startedEmulator) {
    & cmd.exe /c "`"$adb`" emu kill >nul 2>nul"
  }
}

if (-not $SkipWslLinux) {
  $wslBundlePath = "/mnt/" + $BundlePath.Substring(0, 1).ToLowerInvariant() + $BundlePath.Substring(2).Replace("\", "/")
  $wslScript = @"
set -euo pipefail
export PATH="/usr/local/bin:`$PATH"
CI_DIR="/var/tmp/bridge-linux-ci-slot-$slot"
if [ ! -d "`$CI_DIR/.git" ]; then
  mkdir -p "`$CI_DIR"
  git init -q "`$CI_DIR"
fi
git -C "`$CI_DIR" fetch --force "$wslBundlePath" "HEAD:refs/ci/slot-$slot"
git -C "`$CI_DIR" reset --hard -q
git -C "`$CI_DIR" checkout --force --detach -q "$Revision"
cd "`$CI_DIR"
export HTTP_PROXY="$env:HTTP_PROXY"
export HTTPS_PROXY="$env:HTTPS_PROXY"
export NO_PROXY="$env:NO_PROXY"
export npm_config_proxy="`$HTTP_PROXY"
export npm_config_https_proxy="`$HTTPS_PROXY"
export ELECTRON_GET_USE_PROXY=1
LOCK_HASH=`$(sha256sum package-lock.json | awk '{print `$1}')
STAMP="node_modules/.bridge-lock-sha256"
if [ ! -f "`$STAMP" ] || [ "`$(cat "`$STAMP")" != "`$LOCK_HASH" ] || [ ! -f "node_modules/electron/package.json" ]; then
  npm ci
  printf '%s' "`$LOCK_HASH" > "`$STAMP"
fi
npm run test:infra
npm test
echo "<<< [WSL Ubuntu-24.04] Linux infra + unit tests verified"
"@
  $wslEncoded = [Convert]::ToBase64String((New-Object Text.UTF8Encoding($false)).GetBytes(($wslScript -replace "`r`n", "`n")))
  Write-Output ">>> [WIN] Starting WSL2 Ubuntu-24.04 Linux tests in background"
  $wslPsi = [System.Diagnostics.ProcessStartInfo]::new("wsl.exe")
  $wslPsi.Arguments = "-d Ubuntu-24.04 --exec setsid --wait bash -c `"exec 3<&0 </dev/null; (exec >/dev/null 2>&1; cat <&3; kill -TERM 0 || true) & W=`$!; exec 3<&-; trap 'kill -TERM `$W 2>/dev/null || true; pkill -TERM -P `$W 2>/dev/null || true; wait `$W 2>/dev/null || true' EXIT; printf '%s' $wslEncoded | base64 -d | bash`""
  $wslPsi.UseShellExecute = $false
  $wslPsi.RedirectStandardInput = $true
  $wslPsi.RedirectStandardOutput = $true
  $wslPsi.RedirectStandardError = $true
  $wslPsi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $wslPsi.StandardErrorEncoding = [Text.Encoding]::UTF8
  $wslProc = [System.Diagnostics.Process]::Start($wslPsi)
  $wslOutTask = $wslProc.StandardOutput.ReadToEndAsync()
  $wslErrTask = $wslProc.StandardError.ReadToEndAsync()
}

# 9. Join parallel WSL2 Ubuntu-24.04 Linux infra + unit tests
if ($null -ne $wslProc) {
  $wslProc.WaitForExit()
  try { $wslProc.StandardInput.Close() } catch {}
  $wslOut = $wslOutTask.GetAwaiter().GetResult()
  $wslErr = $wslErrTask.GetAwaiter().GetResult()
  if ($wslOut) { Write-Output $wslOut.TrimEnd() }
  if ($wslErr) { [Console]::Error.WriteLine($wslErr.TrimEnd()) }
  if ($wslProc.ExitCode -ne 0) {
    throw "[WIN] WSL2 Ubuntu-24.04 Linux tests failed with exit code $($wslProc.ExitCode)"
  }
  Write-Output ("<<< [WIN] WSL2 Ubuntu-24.04 Linux tests OK ({0:N1}s)" -f ($wslProc.ExitTime - $wslProc.StartTime).TotalSeconds)
}

Write-Output "=== [WIN] ALL WINDOWS + ANDROID + WSL LINUX CHECKS PASSED ($Revision) ==="
} finally {
  try {
    if ($null -ne $wslProc) {
      try {
        try { $wslProc.StandardInput.Close() } catch {}
        if (-not $wslProc.HasExited) {
          [void]$wslProc.WaitForExit(5000)
        }
        if (-not $wslProc.HasExited) {
          & cmd.exe /c "taskkill.exe /PID $($wslProc.Id) /T /F >nul 2>nul"
        }
      } finally {
        $wslProc.Dispose()
      }
    }
    if (Test-Path -LiteralPath $BundlePath) {
      Invoke-Checked "Clean uploaded git bundle" {
        & "$nodeBin\node.exe" --require "$ciWorktree\scripts\recycle-cleanup.cjs" "$ciWorktree\scripts\clean.mjs" $BundlePath
      }
    }
    if ($ownsTempRoot) {
      Invoke-Checked "Delete owned test temporary root" { Remove-Item -LiteralPath $tempDir -Recurse -Force }
    }
  } finally {
    if ($slot -ge 0) {
      $slotMutexes[$slot].ReleaseMutex()
    }
    foreach ($slotMutex in $slotMutexes) { $slotMutex.Dispose() }
  }
}
