[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [Parameter(Mandatory = $true)][string]$EnvFile,
  [string]$NodePath = "C:\Program Files\nodejs\node.exe",
  [string]$BackupTime = "02:00",
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$envPath = (Resolve-Path -LiteralPath $EnvFile).Path
$node = (Resolve-Path -LiteralPath $NodePath).Path
$backupScript = Join-Path $repo "ops\backup.js"
$terminalScript = Join-Path $repo "ops\windows\Start-OperationsTerminal.ps1"
foreach ($file in @($backupScript, $terminalScript)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required file not found: $file" }
}
if (-not $Apply) {
  Write-Host "Dry run only. Re-run with -Apply after reviewing these values:"
  [pscustomobject]@{ RepoRoot = $repo; EnvFile = $envPath; NodePath = $node; BackupTime = $BackupTime }
  exit 0
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$backupAction = New-ScheduledTaskAction -Execute $node -Argument (
  '"{0}" --env-file "{1}"' -f $backupScript, $envPath
) -WorkingDirectory $repo
$backupTrigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($BackupTime, "HH:mm", $null))
$backupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 6) -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 15)
$backupPrincipal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType S4U -RunLevel Limited

$terminalAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument (
  '-NoProfile -ExecutionPolicy Bypass -File "{0}" -RepoRoot "{1}" -EnvFile "{2}" -NodePath "{3}"' -f `
    $terminalScript, $repo, $envPath, $node
)
$terminalTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$terminalSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)
$terminalPrincipal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

if ($PSCmdlet.ShouldProcess("TaskDistribution-V2-Backup and TaskDistribution-V2-Health", "Register scheduled tasks")) {
  Register-ScheduledTask -TaskName "TaskDistribution-V2-Backup" -Action $backupAction `
    -Trigger $backupTrigger -Settings $backupSettings -Principal $backupPrincipal -Force | Out-Null
  Register-ScheduledTask -TaskName "TaskDistribution-V2-Health" -Action $terminalAction `
    -Trigger $terminalTrigger -Settings $terminalSettings -Principal $terminalPrincipal -Force | Out-Null
  Get-ScheduledTask -TaskName "TaskDistribution-V2-Backup", "TaskDistribution-V2-Health" |
    Select-Object TaskName, State
}
