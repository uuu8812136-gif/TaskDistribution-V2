[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$RecoveryRoot = 'C:\TaskDistribution-V2\Recovery',
  [string]$AppId = 'wxd8f18985dfd63b89',
  [string]$TemplateId = '8_Z_s5GtNddhMm3SfH0R6pyR4oeoTJMKaPKcRCtjVv8',
  [string]$Page = 'pages/message/index',
  [ValidateRange(1000, 3600000)][int]$WorkerIntervalMs = 30000,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

$script:WechatEnvironmentKeys = @(
  'WECHAT_SERVICE_NOTIFICATION_ENABLED',
  'WECHAT_MINIPROGRAM_APP_ID',
  'WECHAT_MINIPROGRAM_APP_SECRET',
  'WECHAT_SERVICE_NOTIFICATION_TEMPLATE_ID',
  'WECHAT_SERVICE_NOTIFICATION_PAGE',
  'WECHAT_SERVICE_NOTIFICATION_ACTIVATED_AT',
  'WECHAT_SERVICE_NOTIFICATION_WORKER_INTERVAL_MS'
)

function Get-NormalizedFullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Assert-NoReparsePointPath {
  param(
    [Parameter(Mandatory = $true)][string]$TrustedRoot,
    [Parameter(Mandatory = $true)][string]$Candidate
  )

  $rootFull = Get-NormalizedFullPath $TrustedRoot
  $candidateFull = Get-NormalizedFullPath $Candidate
  if (-not $candidateFull.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase) -and
      -not $candidateFull.StartsWith("$rootFull\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Configuration path must stay below recovery root: $rootFull"
  }

  $current = $rootFull
  if (Test-Path -LiteralPath $current) {
    if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Recovery path contains a reparse point: $current"
    }
  }
  if ($candidateFull.Length -gt $rootFull.Length) {
    foreach ($component in $candidateFull.Substring($rootFull.Length).TrimStart('\').Split('\')) {
      $current = Join-Path $current $component
      if (Test-Path -LiteralPath $current) {
        if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
          throw "Recovery path contains a reparse point: $current"
        }
      }
    }
  }
  return $candidateFull
}

function Assert-WechatConfigurationValue {
  param(
    [Parameter(Mandatory = $true)][string]$AppId,
    [Parameter(Mandatory = $true)][string]$AppSecret,
    [Parameter(Mandatory = $true)][string]$TemplateId,
    [Parameter(Mandatory = $true)][string]$Page
  )

  if ($AppId -notmatch '^wx[0-9a-f]{16}$') {
    throw 'The WeChat Mini Program AppID is invalid'
  }
  if ($AppSecret -notmatch '^[A-Za-z0-9_-]{16,128}$') {
    throw 'The WeChat Mini Program AppSecret is invalid'
  }
  if ($AppSecret.ToLowerInvariant().Contains('replace-me') -or
      $AppSecret.ToLowerInvariant().Contains('change-me') -or
      $AppSecret.ToLowerInvariant().Contains('your-secret-key')) {
    throw 'The WeChat Mini Program AppSecret is a placeholder'
  }
  if ($TemplateId -notmatch '^[A-Za-z0-9_-]{20,128}$') {
    throw 'The WeChat service notification template ID is invalid'
  }
  if ($Page -notmatch '^[A-Za-z0-9_/?=&.-]{1,128}$' -or $Page.StartsWith('/')) {
    throw 'The WeChat service notification page is invalid'
  }
}

function ConvertFrom-ProtectedInput {
  param([Parameter(Mandatory = $true)][Security.SecureString]$Value)

  $pointer = [IntPtr]::Zero
  try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    if ($pointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
  }
}

function Read-ConfirmedAppSecret {
  $firstProtected = Read-Host 'Enter the new WeChat Mini Program AppSecret (hidden)' -AsSecureString
  $secondProtected = Read-Host 'Enter the AppSecret again (hidden)' -AsSecureString
  $first = ConvertFrom-ProtectedInput $firstProtected
  $second = ConvertFrom-ProtectedInput $secondProtected
  try {
    if (-not [string]::Equals($first, $second, [StringComparison]::Ordinal)) {
      throw 'The two AppSecret entries do not match'
    }
    return $first
  }
  finally {
    $second = $null
    $firstProtected.Dispose()
    $secondProtected.Dispose()
  }
}

function ConvertTo-UpdatedEnvironmentContent {
  param(
    [Parameter(Mandatory = $true)][string]$ExistingContent,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Updates
  )

  $newLine = if ($ExistingContent.Contains("`r`n")) { "`r`n" } else { "`n" }
  $lines = @($ExistingContent -split "`r?`n", -1)
  if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') {
    $lines = @($lines | Select-Object -First ($lines.Count - 1))
  }
  $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  $result = New-Object 'Collections.Generic.List[string]'
  foreach ($line in $lines) {
    $match = [regex]::Match($line, '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=')
    if (-not $match.Success -or -not $Updates.Contains($match.Groups[1].Value)) {
      $result.Add($line)
      continue
    }
    $key = $match.Groups[1].Value
    if ($seen.Add($key)) {
      $result.Add("$key=$($Updates[$key])")
    }
  }
  foreach ($key in $script:WechatEnvironmentKeys) {
    if ($Updates.Contains($key) -and $seen.Add($key)) {
      $result.Add("$key=$($Updates[$key])")
    }
  }
  return "$($result -join $newLine)$newLine"
}

function Write-ExistingFileWithoutTemporaryCopy {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )

  $encoding = New-Object Text.UTF8Encoding($false)
  $replacementBytes = $encoding.GetBytes($Content)
  $originalBytes = [IO.File]::ReadAllBytes($Path)
  $stream = $null
  try {
    $stream = New-Object IO.FileStream(
      $Path,
      [IO.FileMode]::Open,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None,
      4096,
      [IO.FileOptions]::WriteThrough
    )
    try {
      $stream.SetLength(0)
      $stream.Write($replacementBytes, 0, $replacementBytes.Length)
      $stream.Flush($true)
    }
    catch {
      try {
        $stream.SetLength(0)
        $stream.Write($originalBytes, 0, $originalBytes.Length)
        $stream.Flush($true)
      }
      catch { }
      throw
    }
    finally {
      $stream.Dispose()
      $stream = $null
    }

    $writtenBytes = [IO.File]::ReadAllBytes($Path)
    try {
      if (-not [Linq.Enumerable]::SequenceEqual(
        [byte[]]$replacementBytes,
        [byte[]]$writtenBytes
      )) {
        [IO.File]::WriteAllBytes($Path, $originalBytes)
        throw 'Environment file verification failed; the original content was restored'
      }
    }
    finally { [Array]::Clear($writtenBytes, 0, $writtenBytes.Length) }
  }
  finally {
    if ($stream) { $stream.Dispose() }
    [Array]::Clear($replacementBytes, 0, $replacementBytes.Length)
    [Array]::Clear($originalBytes, 0, $originalBytes.Length)
  }
}

function Set-RestrictedEnvironmentFileAcl {
  param([Parameter(Mandatory = $true)][string]$Path)

  $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  $administrators = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($administrators)
  foreach ($identity in @($system, $administrators)) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
      $identity,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.AccessControlType]::Allow
    )))
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Test-IsElevatedAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($MyInvocation.InvocationName -eq '.') { return }

$RecoveryRoot = Get-NormalizedFullPath $RecoveryRoot
$configDirectory = Join-Path $RecoveryRoot 'config'
$environmentFile = Join-Path $configDirectory 'app.env'
$environmentFile = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot -Candidate $environmentFile
if (-not (Test-Path -LiteralPath $RecoveryRoot -PathType Container)) {
  throw "Recovery root is missing: $RecoveryRoot"
}
if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
  throw "Recovery environment file is missing: $environmentFile"
}

$plan = [ordered]@{
  status = 'WECHAT_SERVICE_NOTIFICATION_CONFIGURATION_PLAN_READY'
  recoveryRoot = $RecoveryRoot
  environmentFile = $environmentFile
  appId = $AppId
  templateId = $TemplateId
  page = $Page
  workerIntervalMs = $WorkerIntervalMs
  secretSource = 'interactive-hidden-input'
  secretInCommandLine = $false
  temporarySecretFileCreated = $false
  writesRequested = [bool]$Apply
}
if (-not $Apply) {
  $plan | ConvertTo-Json -Depth 4
  return
}
if (-not (Test-IsElevatedAdministrator)) {
  throw 'Run this script from an elevated Command Prompt'
}
if (-not $PSCmdlet.ShouldProcess($environmentFile, 'Enable WeChat Mini Program service notifications')) {
  return
}

$appSecret = Read-ConfirmedAppSecret
try {
  Assert-WechatConfigurationValue -AppId $AppId -AppSecret $appSecret `
    -TemplateId $TemplateId -Page $Page
  $activatedAt = [DateTimeOffset]::UtcNow.ToString(
    'yyyy-MM-ddTHH:mm:ss.fffZ',
    [Globalization.CultureInfo]::InvariantCulture
  )
  $updates = [ordered]@{
    WECHAT_SERVICE_NOTIFICATION_ENABLED = 'true'
    WECHAT_MINIPROGRAM_APP_ID = $AppId
    WECHAT_MINIPROGRAM_APP_SECRET = $appSecret
    WECHAT_SERVICE_NOTIFICATION_TEMPLATE_ID = $TemplateId
    WECHAT_SERVICE_NOTIFICATION_PAGE = $Page
    WECHAT_SERVICE_NOTIFICATION_ACTIVATED_AT = $activatedAt
    WECHAT_SERVICE_NOTIFICATION_WORKER_INTERVAL_MS = [string]$WorkerIntervalMs
  }
  $existingContent = [IO.File]::ReadAllText($environmentFile)
  $updatedContent = ConvertTo-UpdatedEnvironmentContent `
    -ExistingContent $existingContent -Updates $updates
  Set-RestrictedEnvironmentFileAcl -Path $environmentFile
  Write-ExistingFileWithoutTemporaryCopy -Path $environmentFile -Content $updatedContent

  [ordered]@{
    status = 'WECHAT_SERVICE_NOTIFICATION_CONFIGURATION_UPDATED'
    environmentFile = $environmentFile
    appId = $AppId
    templateId = $TemplateId
    page = $Page
    activatedAt = $activatedAt
    workerIntervalMs = $WorkerIntervalMs
    secretStored = $true
    secretDisclosed = $false
    temporarySecretFileCreated = $false
    apiRestartRequired = $true
  } | ConvertTo-Json -Depth 4
}
finally {
  $appSecret = $null
  $existingContent = $null
  $updatedContent = $null
  $updates = $null
}
