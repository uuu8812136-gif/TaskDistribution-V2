$ErrorActionPreference = 'Continue'
$root = 'C:\TaskDistribution-V2\Recovery'
$releaseRoot = Join-Path $root 'releases\v2-20260901-c9c9762'
$env:WEB_ROOT = Join-Path $releaseRoot 'app\frontend\dist'
$env:WEB_PORT = '18130'
$env:API_UPSTREAM = 'http://127.0.0.1:18120'
Set-Location $releaseRoot
$log = Join-Path $root 'logs\web-proxy.log'
while ($true) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $log -Value "[$stamp] web proxy starting"
    & (Join-Path $root 'runtime\node\node.exe') (Join-Path $releaseRoot 'serve-v2-recovery.cjs') *>> $log
    $stamp2 = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $log -Value "[$stamp2] web proxy exited with code $LASTEXITCODE, restart in 5s"
    Start-Sleep -Seconds 5
}
