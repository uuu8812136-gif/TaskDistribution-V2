$ErrorActionPreference = 'Stop'
$nginxRoot = 'C:\nginx'
$nginx = Join-Path $nginxRoot 'nginx.exe'
$config = Join-Path $nginxRoot 'conf\nginx.conf'
$backupDir = Join-Path $nginxRoot 'backups'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $backupDir ("nginx.conf.pre-sidebar-assets-cache-$stamp")

$raw = [System.IO.File]::ReadAllText($config)
$wwwStart = $raw.IndexOf('server_name www.horselink.cn;')
if ($wwwStart -lt 0) { throw 'www.horselink.cn server block not found' }
$wwwEnd = $raw.IndexOf("`n    }", $wwwStart)
if ($wwwEnd -lt 0) { throw 'www.horselink.cn server block end not found' }
$wwwBlock = $raw.Substring($wwwStart, $wwwEnd - $wwwStart)
if ($wwwBlock -notmatch 'proxy_pass http://127\.0\.0\.1:18130') { throw 'www.horselink.cn is not proxied to 18130' }
if ($wwwBlock -notmatch 'location \^~ /assets/') { throw 'www.horselink.cn assets location not found' }

$old = @'
            proxy_cache task_assets;
            proxy_cache_valid 200 30d;
            proxy_cache_lock on;
            proxy_cache_lock_timeout 10s;
            proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
'@
$new = @'
            # Hashed frontend assets must never reuse a cached SPA fallback page.
            # Keep this location uncached so a new release is visible immediately.
            proxy_cache off;
            proxy_no_cache 1;
            proxy_cache_bypass 1;
            add_header Cache-Control "no-cache, no-store, must-revalidate" always;
'@
if (-not $wwwBlock.Contains($old)) { throw 'expected stale asset-cache block not found' }
$updatedWww = $wwwBlock.Replace($old, $new)
$updated = $raw.Substring(0, $wwwStart) + $updatedWww + $raw.Substring($wwwStart + $wwwBlock.Length)

New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
Copy-Item -LiteralPath $config -Destination $backup -Force
[System.IO.File]::WriteAllText($config, $updated, [System.Text.UTF8Encoding]::new($false))

try {
    & $nginx -t -p $nginxRoot -c conf\nginx.conf
    if ($LASTEXITCODE -ne 0) { throw "nginx config test failed: $LASTEXITCODE" }
    & $nginx -s reload -p $nginxRoot -c conf\nginx.conf
    if ($LASTEXITCODE -ne 0) { throw "nginx reload failed: $LASTEXITCODE" }
    Start-Sleep -Seconds 2

    $urls = @(
        'https://www.horselink.cn/assets/MainLayout-Sicamq_Z.css',
        'https://www.horselink.cn/assets/MainLayout-BRZbsybT.js'
    )
    foreach ($url in $urls) {
        $name = [IO.Path]::GetFileName($url)
        $headers = Join-Path $backupDir ("sidebar-$name.headers")
        $body = Join-Path $backupDir ("sidebar-$name.body")
        & curl.exe -k -sS --max-time 30 --resolve 'www.horselink.cn:443:127.0.0.1' -H 'Accept-Encoding: identity' -D $headers -o $body $url
        if ($LASTEXITCODE -ne 0) { throw "request failed: $url" }
        $h = [IO.File]::ReadAllText($headers)
        $status = [regex]::Match($h, '(?im)^HTTP/\S+\s+(\d{3})').Groups[1].Value
        $type = [regex]::Match($h, '(?im)^Content-Type:\s*([^\r\n]+)').Groups[1].Value.Trim()
        $length = (Get-Item -LiteralPath $body).Length
        if ($status -ne '200') { throw "$name returned HTTP $status" }
        if ($name.EndsWith('.css') -and $type -notmatch 'text/css') { throw "$name content type is $type" }
        if ($name.EndsWith('.js') -and $type -notmatch 'javascript') { throw "$name content type is $type" }
        if ($length -le 1000) { throw "$name is suspiciously small: $length bytes" }
        Write-Output ("ASSET_OK name={0} status={1} type={2} bytes={3}" -f $name,$status,$type,$length)
    }
    Write-Output ("CONFIG_BACKUP={0}" -f $backup)
    Write-Output 'NGINX_ASSET_CACHE_DISABLED_OK'
} catch {
    Copy-Item -LiteralPath $backup -Destination $config -Force
    & $nginx -t -p $nginxRoot -c conf\nginx.conf | Out-Null
    & $nginx -s reload -p $nginxRoot -c conf\nginx.conf | Out-Null
    throw
}
