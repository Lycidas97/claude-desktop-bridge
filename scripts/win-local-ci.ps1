param(
  [Parameter(Mandatory = $true)][string]$Revision,
  [Parameter(Mandatory = $true)][string]$BundlePath,
  [switch]$SkipWslLinux
)

$ErrorActionPreference = "Stop"
chcp 65001 > $null
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# Keep Windows out of Modern Standby (S0 Low Power Idle) for the lifetime of this CI process
Add-Type -Namespace BridgeCi -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
[BridgeCi.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null

$workRoot = "D:\work"
$anchorRepo = "$workRoot\claude-desktop-bridge"
$ciWorktree = "$workRoot\ci-worktree"
$toolsRoot = "$workRoot\tools"
$cacheRoot = "$workRoot\cache"

$nodeBin = "$toolsRoot\node-26"
$jdkRoot = "$toolsRoot\jdk-21"
$pythonRoot = "$toolsRoot\python"
$sdkRoot = "$toolsRoot\android-sdk"

$tempDir = "$cacheRoot\temp"
$npmCache = "$cacheRoot\npm"
$electronCache = "$cacheRoot\electron"
$electronBuilderCache = "$cacheRoot\electron-builder"
$gradleHome = "$cacheRoot\gradle"
$androidUserHome = "$cacheRoot\android-user"
$avdHome = "$cacheRoot\android-avd"

New-Item -ItemType Directory -Force -Path `
  $tempDir, $npmCache, $electronCache, $electronBuilderCache, $gradleHome, $androidUserHome, $avdHome | Out-Null

$env:TEMP = $tempDir
$env:TMP = $tempDir
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

# 1. Fetch exact commit bundle into anchor repo and attach/checkout D:\work\ci-worktree
Invoke-Checked "Sync git bundle ($Revision)" {
  git -C $anchorRepo bundle verify $BundlePath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "git bundle verify failed ($LASTEXITCODE)" }
  git -C $anchorRepo fetch --force $BundlePath "HEAD:refs/ci/current"
}

if (-not (Test-Path "$ciWorktree\.git")) {
  Invoke-Checked "Create D:\work\ci-worktree" {
    git -C $anchorRepo worktree add --force --detach $ciWorktree $Revision
  }
} else {
  Invoke-Checked "Checkout $Revision in D:\work\ci-worktree" {
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

# 4. Windows infra + typecheck + unit tests (runs before QEMU cold boot so Vitest gets uncontended CPU/IO)
Invoke-Checked "npm run test:infra" { & "$nodeBin\npm.cmd" run test:infra }
Invoke-Checked "npm run typecheck" { & "$nodeBin\npm.cmd" run ci:run -- run typecheck }
Invoke-Checked "npm test (Windows)" { & "$nodeBin\npm.cmd" test }

# 5. Boot headless WHPX Android Emulator in background while Windows NSIS + Gradle APK build run
$adb = "$sdkRoot\platform-tools\adb.exe"
$emulatorExe = "$sdkRoot\emulator\emulator.exe"
$startedEmulator = $false
& $adb start-server | Out-Null
$onlineEmulator = (& $adb devices) | Select-String -Pattern "^emulator-\d+\s+device$"
if (-not $onlineEmulator) {
  Write-Output ">>> [WIN] Starting headless WHPX AVD bridge-ci-api36 in background"
  Start-Process -FilePath $emulatorExe `
    -ArgumentList @("-avd", "bridge-ci-api36", "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save", "-gpu", "swiftshader_indirect") `
    -WindowStyle Hidden | Out-Null
  $startedEmulator = $true
}

try {
  # 6. Build protocol, relay, and Windows NSIS installer
  Invoke-Checked "Build @bridge/protocol & @bridge/relay" {
    & "$nodeBin\npm.cmd" run ci:run -- run build -w @bridge/protocol
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & "$nodeBin\npm.cmd" run ci:run -- run build -w @bridge/relay
  }

  Invoke-Checked "Build Windows NSIS installer (make:windows)" {
    $prevRelay = $env:BRIDGE_RELAY_URL
    $prevPubRelay = $env:BRIDGE_PUBLIC_RELAY_URL
    $prevPairing = $env:BRIDGE_PAIRING_BASE_URL
    $prevOrigin = $env:BRIDGE_SERVICE_ORIGIN
    $prevIce = $env:BRIDGE_ICE_SERVERS
    try {
      $env:BRIDGE_RELAY_URL = ""
      $env:BRIDGE_PUBLIC_RELAY_URL = ""
      $env:BRIDGE_PAIRING_BASE_URL = ""
      $env:BRIDGE_SERVICE_ORIGIN = ""
      $env:BRIDGE_ICE_SERVERS = ""
      & "$nodeBin\npm.cmd" run ci:run -- run make:windows -w @bridge/desktop
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
      $env:BRIDGE_RELAY_URL = $prevRelay
      $env:BRIDGE_PUBLIC_RELAY_URL = $prevPubRelay
      $env:BRIDGE_PAIRING_BASE_URL = $prevPairing
      $env:BRIDGE_SERVICE_ORIGIN = $prevOrigin
      $env:BRIDGE_ICE_SERVERS = $prevIce
    }
  }

  $setupExe = Get-ChildItem -Path "apps/desktop/out/make" -Recurse -Filter "*Setup.exe" | Select-Object -First 1
  if ($null -eq $setupExe) { throw "Assisted NSIS Setup.exe was not produced" }

  # 7. Build Android debug APK + verify DEX + verify pinned debug signature
  Invoke-Checked "Sync Capacitor Android (@bridge/mobile)" {
    & "$nodeBin\npm.cmd" run ci:run -- run sync -w @bridge/mobile
  }

  Invoke-Checked "Gradle assembleDebug (Android SDK 36)" {
    Push-Location "apps/mobile/android"
    try {
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
  $certOut = (& $apksigner.FullName verify --print-certs $apkPath 2>&1) -join "`n"
  if ($certOut -notmatch "certificate SHA-256 digest:\s*([0-9a-fA-F]+)") {
    throw "Failed to parse APK certificate digest: $certOut"
  }
  $actualCert = $Matches[1].ToLowerInvariant()
  if ($actualCert -ne $expectedCert) {
    throw "Debug APK signature drifted: [$actualCert] (expected $expectedCert)"
  }
  Write-Output "<<< [WIN] Android APK debug signature OK: $actualCert"

  # 8. Wait for Android Emulator boot completion, then run packaged Windows QA + Android WebView pairing smoke
  $bootDeadline = (Get-Date).AddSeconds(180)
  $booted = $false
  while ((Get-Date) -lt $bootDeadline) {
    $prop = (& $adb shell getprop sys.boot_completed 2>$null) -join ""
    if ($prop.Trim() -eq "1") {
      $booted = $true
      break
    }
    Start-Sleep -Seconds 2
  }
  if (-not $booted) {
    throw "Timed out waiting for Android Emulator bridge-ci-api36 to finish booting"
  }
  Write-Output "<<< [WIN] Android Emulator sys.boot_completed=1"

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
  if ($startedEmulator) {
    & $adb emu kill 2>$null | Out-Null
  }
}

# 9. WSL2 Ubuntu-24.04 Linux .deb / .rpm / .zip packaging
if (-not $SkipWslLinux) {
  $wslBundlePath = "/mnt/d/work/cache/temp/" + [IO.Path]::GetFileName($BundlePath)
  $wslScript = @"
set -euo pipefail
export PATH="/usr/local/bin:`$PATH"
CI_DIR="/var/tmp/bridge-linux-ci"
if [ ! -d "`$CI_DIR/.git" ]; then
  mkdir -p "`$CI_DIR"
  git init -q "`$CI_DIR"
fi
git -C "`$CI_DIR" fetch --force "$wslBundlePath" "HEAD:refs/ci/current"
git -C "`$CI_DIR" reset --hard -q
git -C "`$CI_DIR" checkout --force --detach -q "$Revision"
cd "`$CI_DIR"
LOCK_HASH=`$(sha256sum package-lock.json | awk '{print `$1}')
STAMP="node_modules/.bridge-lock-sha256"
if [ ! -f "`$STAMP" ] || [ "`$(cat "`$STAMP")" != "`$LOCK_HASH" ] || [ ! -f "node_modules/electron/package.json" ]; then
  npm ci
  printf '%s' "`$LOCK_HASH" > "`$STAMP"
fi
npm run ci:run -- run build -w @bridge/protocol
BRIDGE_RELAY_URL="" BRIDGE_PUBLIC_RELAY_URL="" BRIDGE_PAIRING_BASE_URL="" BRIDGE_SERVICE_ORIGIN="" BRIDGE_ICE_SERVERS="" \
  npm run ci:run -- run make:linux -w @bridge/desktop
find apps/desktop/out/make -name "*.deb" -print -quit | grep -q . || { echo "Missing .deb output"; exit 1; }
find apps/desktop/out/make -name "*.rpm" -print -quit | grep -q . || { echo "Missing .rpm output"; exit 1; }
find apps/desktop/out/make -name "*.zip" -print -quit | grep -q . || { echo "Missing .zip output"; exit 1; }
echo "<<< [WSL Ubuntu-24.04] Linux .deb / .rpm / .zip outputs verified"
"@
  Invoke-Checked "WSL2 Ubuntu-24.04 Linux installers (.deb/.rpm/.zip)" {
    ($wslScript -replace "`r`n", "`n") | wsl.exe -d Ubuntu-24.04 -- bash -s
  }
}

# Move uploaded git bundle to Windows Recycle Bin
Invoke-Checked "Recycle uploaded git bundle" {
  & "$nodeBin\node.exe" --require "$ciWorktree\scripts\recycle-cleanup.cjs" `
    "$ciWorktree\scripts\clean.mjs" $BundlePath
}

Write-Output "=== [WIN] ALL WINDOWS + ANDROID + WSL LINUX CHECKS PASSED ($Revision) ==="
