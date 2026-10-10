$ErrorActionPreference = 'Stop'
$root = 'C:\TaskDistribution-V2\Recovery'
$mongod = Join-Path $root 'runtime\mongodb\bin\mongod.exe'
$dbPath = Join-Path $root 'data\db'
$logPath = Join-Path $root 'logs\mongod.log'
New-Item -ItemType Directory -Force -Path $dbPath, (Split-Path $logPath) | Out-Null
& $mongod --dbpath $dbPath --port 27150 --bind_ip 127.0.0.1 --replSet customer_acceptance_v2_rs --logpath $logPath --logappend
exit $LASTEXITCODE
