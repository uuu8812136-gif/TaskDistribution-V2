$ErrorActionPreference = 'Continue'
$log = 'C:\TaskDistribution-V2\Recovery\logs\watchdog.log'
$services = @(
    @{ Port = 27150; Task = 'V2RescueMongo' },
    @{ Port = 18120; Task = 'V2RescueAPI' },
    @{ Port = 18130; Task = 'V2RescueWeb' }
)
foreach ($s in $services) {
    $listening = (netstat -an | Select-String (':' + $s.Port + ' .*LISTENING') | Measure-Object).Count
    if ($listening -eq 0) {
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -Path $log -Value "[$stamp] port $($s.Port) DOWN, starting task $($s.Task)"
        schtasks /end /tn $s.Task 2>$null | Out-Null
        Start-Sleep -Seconds 2
        schtasks /run /tn $s.Task | Out-Null
    }
}
