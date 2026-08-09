[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)][string]$SourceDirectory,
  [string]$InstallDirectory = 'C:\ProgramData\LinuxBackup',
  [string]$DestinationRoot = 'C:\ServerBackups\TaskDistribution-V2-Test',
  [string]$SourceVmRoot = 'E:\ServerVM',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$sourceFull = [IO.Path]::GetFullPath($SourceDirectory)
$installFull = [IO.Path]::GetFullPath($InstallDirectory)
$files = @(
  'Copy-V2TestBackupOffHost.ps1',
  'Sync-V2TestBackupOffHost.ps1',
  'Invoke-V2TestBackupOffHostSync.ps1',
  'Test-V2TestOperations.ps1'
)
foreach ($file in $files) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceFull $file) -PathType Leaf)) {
    throw "Scheduled-operations source file is missing: $file"
  }
}
foreach ($required in @(
  'C:\ProgramData\LinuxBackup\linux-backup-key-system',
  'C:\ProgramData\LinuxBackup\known_hosts'
)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required SSH asset is missing: $required" }
}

$plan = [ordered]@{
  Status = 'DRY_RUN_READY'
  InstallDirectory = $installFull
  DestinationRoot = $DestinationRoot
  SourceVmRoot = $SourceVmRoot
  Tasks = @('TaskDistribution-V2-Daily-Offhost-Backup', 'TaskDistribution-V2-Health-Alert')
  SyncIntervalMinutes = 60
  HealthIntervalMinutes = 15
}
if (-not $Apply) { $plan | ConvertTo-Json -Depth 4; return }
if (-not $PSCmdlet.ShouldProcess($InstallDirectory, 'Install V2 scheduled operations and register SYSTEM tasks')) { return }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Administrator privileges are required'
}
New-Item -ItemType Directory -Force -Path $installFull | Out-Null
foreach ($file in $files) {
  Copy-Item -LiteralPath (Join-Path $sourceFull $file) -Destination (Join-Path $installFull $file) -Force
}

$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$syncRunner = Join-Path $installFull 'Invoke-V2TestBackupOffHostSync.ps1'
$healthScript = Join-Path $installFull 'Test-V2TestOperations.ps1'
$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 45) -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)
$syncAction = New-ScheduledTaskAction -Execute $powerShell `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$syncRunner`" -DestinationRoot `"$DestinationRoot`" -SourceVmRoot `"$SourceVmRoot`""
$syncTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Hours 1)
$healthAction = New-ScheduledTaskAction -Execute $powerShell `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$healthScript`" -DestinationRoot `"$DestinationRoot`" -SourceVmRoot `"$SourceVmRoot`""
$healthTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3) `
  -RepetitionInterval (New-TimeSpan -Minutes 15)

Register-ScheduledTask -TaskName 'TaskDistribution-V2-Daily-Offhost-Backup' `
  -Action $syncAction -Trigger $syncTrigger -Settings $settings -Principal $taskPrincipal -Force | Out-Null
Register-ScheduledTask -TaskName 'TaskDistribution-V2-Health-Alert' `
  -Action $healthAction -Trigger $healthTrigger -Settings $settings -Principal $taskPrincipal -Force | Out-Null

[pscustomobject]@{
  Status = 'SCHEDULED_OPERATIONS_INSTALLED'
  InstallDirectory = $installFull
  Tasks = @(
    Get-ScheduledTask -TaskName 'TaskDistribution-V2-Daily-Offhost-Backup'
    Get-ScheduledTask -TaskName 'TaskDistribution-V2-Health-Alert'
  ) | ForEach-Object { [pscustomobject]@{ Name = $_.TaskName; State = [string]$_.State; User = $_.Principal.UserId } }
} | ConvertTo-Json -Depth 5
