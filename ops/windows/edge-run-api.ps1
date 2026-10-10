$ErrorActionPreference = 'Continue'
$root = 'C:\TaskDistribution-V2\Recovery'
$releaseRoot = Join-Path $root 'releases\v2-20260901-c9c9762'
$env:ENV_FILE = Join-Path $root 'config\app.env'
$env:EQUIPMENT_ROUTINE_WORKER_ENABLED = 'true'
Set-Location (Join-Path $releaseRoot 'app')
$log = Join-Path $root 'logs\api.log'
while ($true) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $log -Value "[$stamp] api starting"
    & (Join-Path $root 'runtime\node\node.exe') (Join-Path $releaseRoot 'app\server.js') *>> $log
    $stamp2 = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $log -Value "[$stamp2] api exited with code $LASTEXITCODE, restart in 5s"
    Start-Sleep -Seconds 5
}
