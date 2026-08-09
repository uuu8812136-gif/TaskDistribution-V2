$scriptPath = Join-Path $PSScriptRoot '..\windows\Sync-V2TestBackupOffHost.ps1'

function Write-Utf8NoBom {
  param([string]$Path, [string]$Value)
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false)))
}
Describe 'V2 test off-host scheduled retention' {
  It 'keeps the newest seven recovery points plus four older weekly points' {
    $root = Join-Path $TestDrive 'offhost'
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'receipts') | Out-Null
    . $scriptPath -DestinationRoot $root -DailyKeep 7 -WeeklyKeep 4

    $records = @()
    for ($index = 0; $index -lt 12; $index++) {
      $completed = [DateTimeOffset]::Parse('2026-07-25T12:00:00Z').AddHours(-$index)
      $backupId = 'backup-{0}-{1:x8}' -f $completed.ToString('yyyyMMddTHHmmssZ'), ($index + 1)
      $directory = Join-Path $root $backupId
      New-Item -ItemType Directory -Force -Path $directory | Out-Null
      $tags = if ($index -ge 8) { @('daily', 'weekly') } else { @('daily') }
      $manifest = [ordered]@{
        format = 'task-distribution-v2-backup/v1'
        backupId = $backupId
        completedAt = $completed.ToString('o')
        retentionTags = $tags
        database = [ordered]@{ name = 'customer_acceptance_v2_test' }
        files = @()
      }
      $manifestPath = Join-Path $directory 'manifest.json'
      Write-Utf8NoBom -Path $manifestPath -Value "$(($manifest | ConvertTo-Json -Depth 5))`n"
      $sha = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
      Write-Utf8NoBom -Path (Join-Path $directory 'manifest.sha256') -Value "$sha  manifest.json`n"
      $destinationVolume = [IO.Path]::GetPathRoot($directory).TrimEnd('\')
      $sourceVolume = if ($destinationVolume -eq 'C:') { 'E:' } else { 'C:' }
      $receipt = [ordered]@{
        format = 'task-distribution-v2-offhost-backup-receipt/v1'
        instance = 'task-distribution-v2-customer-test'
        database = 'customer_acceptance_v2_test'
        backupId = $backupId
        manifestSha256 = $sha
        destinationVolume = $destinationVolume
        destinationDirectory = $directory
        destinationDiskNumber = 1
        sourceVmVolume = $sourceVolume
        sourceVmDiskNumber = 0
        physicalDiskSeparated = $true
      }
      Write-Utf8NoBom -Path (Join-Path (Join-Path $root 'receipts') "$backupId.json") `
        -Value "$(($receipt | ConvertTo-Json -Depth 4))`n"
      $records += $backupId
    }

    $result = Invoke-OffHostRetention
    $remaining = @(Get-ChildItem -LiteralPath $root -Directory -Filter 'backup-*' | Select-Object -ExpandProperty Name)
    $remaining.Count | Should Be 11
    $result.Deleted.Count | Should Be 1
    $result.Deleted[0] | Should Be $records[7]
    foreach ($backupId in @($records[0..6] + $records[8..11])) {
      ($remaining -contains $backupId) | Should Be $true
    }
  }
}

Describe 'V2 test backup reboot recovery' {
  It 'restores off-host traversal ACLs and creates a fresh backup after boot' {
    $repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $volumeScript = [IO.File]::ReadAllText(
      (Join-Path $repositoryRoot 'ops\linux\ensure-v2-test-backup-volume.sh')
    )
    $timer = [IO.File]::ReadAllText(
      (Join-Path $repositoryRoot 'ops\linux\taskdistribution-v2-test-backup.timer')
    )
    $volumeScript | Should Match 'setfacl -m u:serveradmin:--x "\$volume_root"'
    $volumeScript | Should Match 'setfacl -m u:serveradmin:rX "\$volume_root/backups" "\$volume_root/handoffs"'
    $timer | Should Match 'OnBootSec=10m'
  }
}
