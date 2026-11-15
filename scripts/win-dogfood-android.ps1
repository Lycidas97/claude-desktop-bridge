$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$tools = 'D:\work\tools'
$cache = 'D:\work\cache\android-dogfood'
$env:PATH = "$tools\node-26;$tools\jdk-21\bin;$tools\python;$env:PATH"
$env:JAVA_HOME = "$tools\jdk-21"
$env:ANDROID_HOME = "$tools\android-sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:npm_config_cache = "$cache\npm"
$env:GRADLE_USER_HOME = "$cache\gradle"
$env:GRADLE_OPTS = '-Dhttp.proxyHost=192.168.1.100 -Dhttp.proxyPort=10808 -Dhttps.proxyHost=192.168.1.100 -Dhttps.proxyPort=10808'
$env:ANDROID_USER_HOME = "$cache\android"
$env:HTTP_PROXY = 'http://192.168.1.100:10808'
$env:HTTPS_PROXY = $env:HTTP_PROXY
$env:NO_PROXY = '127.0.0.1,localhost'
$env:VITE_BRIDGE_PUBLIC_RELAY_URL = 'wss://bis.zju.edu.cn/bridge-relay/ws'
$env:VITE_BRIDGE_SERVICE_ORIGIN = 'https://bis.zju.edu.cn/bridge-relay'
$env:VITE_BRIDGE_ICE_SERVERS = '[{"urls":"stun:stun.cloudflare.com:3478"}]'
New-Item -ItemType Directory -Force -Path $env:npm_config_cache, $env:GRADLE_USER_HOME, $env:ANDROID_USER_HOME | Out-Null

function Invoke-Checked([scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "Android dogfood command failed (exit $LASTEXITCODE): $Command" }
}

$source = Join-Path $PSScriptRoot 'source'
Expand-Archive -LiteralPath (Join-Path $PSScriptRoot 'source.zip') -DestinationPath $source
Push-Location $source
try {
  Invoke-Checked { & npm.cmd ci }
  Invoke-Checked { & npm.cmd run ci:run -- run sync -w '@bridge/mobile' }
  Push-Location 'apps/mobile/android'
  try {
    Invoke-Checked { & .\gradlew.bat assembleDebug --no-daemon --max-workers=2 }
  } finally { Pop-Location }

  $apk = 'apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk'
  Invoke-Checked { & "$tools\python\python.exe" -I scripts/verify-android-dex.py $apk }
  $apksigner = "$env:ANDROID_HOME\build-tools\36.0.0\apksigner.bat"
  $cert = & $apksigner verify --print-certs $apk
  if ($LASTEXITCODE -ne 0) { throw "APK signature verification failed: $cert" }
  if (($cert -join "`n") -notmatch 'certificate SHA-256 digest:\s*([0-9a-fA-F]+)' -or
      $Matches[1].ToLowerInvariant() -ne '8b4e8a0ed8e506dde6ff65f92b9bd526d2fcaf10d35089d381a02d9ed23a18db') {
    throw "Debug APK certificate drifted: $cert"
  }
  Write-Output ($cert -join "`n")
  Copy-Item -LiteralPath $apk -Destination (Join-Path $PSScriptRoot 'app-debug.apk')
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'sha256.txt'), (Get-FileHash -Algorithm SHA256 $apk).Hash.ToLowerInvariant())
} finally { Pop-Location }
