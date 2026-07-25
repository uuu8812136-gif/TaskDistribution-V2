[CmdletBinding()]
param(
  [string]$SyncScript = 'C:\ProgramData\LinuxBackup\Sync-V2TestBackupOffHost.ps1',
  [string]$LogRoot = 'C:\ProgramData\LinuxBackup\logs'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
if (-not (Test-Path -LiteralPath $SyncScript -PathType Leaf)) {
  throw "Off-host sync script is missing: $SyncScript"
}
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$stdout = Join-Path $LogRoot "v2-offhost-sync-$timestamp.stdout.log"
$stderr = Join-Path $LogRoot "v2-offhost-sync-$timestamp.stderr.log"
$arguments = @(
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-File', $SyncScript,
  '-Apply'
)
$process = Start-Process -FilePath $powerShell -ArgumentList $arguments -Wait -PassThru -NoNewWindow `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$result = [ordered]@{
  RanAt = [DateTimeOffset]::UtcNow.ToString('o')
  ExitCode = $process.ExitCode
  Stdout = $stdout
  Stderr = $stderr
}
[IO.File]::AppendAllText(
  (Join-Path $LogRoot 'v2-offhost-sync-runner.jsonl'),
  "$(($result | ConvertTo-Json -Compress))`n",
  (New-Object Text.UTF8Encoding($false))
)
if ($process.ExitCode -ne 0) {
  if (Test-Path -LiteralPath $stderr -PathType Leaf) { Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue }
  exit $process.ExitCode
}
Get-Content -LiteralPath $stdout -Raw
