param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [Parameter(Mandatory = $true)][string]$EnvFile,
  [string]$NodePath = "node.exe"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$envPath = (Resolve-Path -LiteralPath $EnvFile).Path
$healthScript = Join-Path $repo "ops\health-terminal.js"
if (-not (Test-Path -LiteralPath $healthScript -PathType Leaf)) {
  throw "Health terminal script not found: $healthScript"
}

$host.UI.RawUI.WindowTitle = "TaskDistribution V2 Operations Health"
Set-Location -LiteralPath $repo
& $NodePath $healthScript --env-file $envPath --watch
exit $LASTEXITCODE
