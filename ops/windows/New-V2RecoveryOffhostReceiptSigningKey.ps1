[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)][string]$IndependentKeyRoot,
  [Parameter(Mandatory = $true)][string]$PrivateKeyPath,
  [Parameter(Mandatory = $true)][string]$PublicKeyPath,
  [Parameter(Mandatory = $true)][string]$ConfirmIndependentHost,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

function Get-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  if ($full.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { return $root }
  return $full.TrimEnd('\')
}

function Find-RepositoryRoot {
  param([Parameter(Mandatory = $true)][string]$StartPath)

  $current = Get-FullPath $StartPath
  if (-not (Test-Path -LiteralPath $current -PathType Container)) {
    $current = Split-Path -Parent $current
  }
  while ($true) {
    if (Test-Path -LiteralPath (Join-Path $current '.git')) {
      return $current
    }
    $parent = Split-Path -Parent $current
    if ([string]::IsNullOrEmpty($parent) -or
        $parent.Equals($current, [StringComparison]::OrdinalIgnoreCase)) {
      return $null
    }
    $current = $parent
  }
}

function Assert-PathBelow {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $rootFull = Get-FullPath $Root
  $candidateFull = Get-FullPath $Candidate
  $rootPrefix = if ($rootFull.EndsWith('\')) { $rootFull } else { "$rootFull\" }
  if (-not $candidateFull.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be below $rootFull"
  }
  return $candidateFull
}

function Assert-NoReparsePointPath {
  param(
    [Parameter(Mandatory = $true)][string]$TrustedRoot,
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $rootFull = Get-FullPath $TrustedRoot
  $candidateFull = Get-FullPath $Candidate
  $rootPrefix = if ($rootFull.EndsWith('\')) { $rootFull } else { "$rootFull\" }
  if (
    $candidateFull -ne $rootFull -and
    -not $candidateFull.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)
  ) { throw "$Label must be at or below trusted root $rootFull" }

  $current = $rootFull
  $components = @()
  if ($candidateFull.Length -gt $rootFull.Length) {
    $components = @($candidateFull.Substring($rootFull.Length).TrimStart('\').Split('\'))
  }
  if (Test-Path -LiteralPath $current) {
    $rootItem = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "$Label path contains a reparse point: $current"
    }
  }
  foreach ($component in $components) {
    $current = Join-Path $current $component
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "$Label path contains a reparse point: $current"
      }
    }
  }
  return $candidateFull
}

function Write-Utf8NoBomCreateNew {
  param([string]$TrustedRoot, [string]$Path, [string]$Value)
  $null = Assert-NoReparsePointPath -TrustedRoot $TrustedRoot -Candidate $Path -Label 'Signing key output'
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Value)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  }
  finally { $stream.Dispose() }
}

$IndependentKeyRoot = Get-FullPath $IndependentKeyRoot
if ([IO.Path]::GetPathRoot($IndependentKeyRoot).TrimEnd('\') -ne 'E:') {
  throw 'IndependentKeyRoot must be on the independent workstation E: drive'
}
$repositoryRoot = Find-RepositoryRoot -StartPath $PSScriptRoot
if ($repositoryRoot) {
  $repositoryPrefix = if ($repositoryRoot.EndsWith('\')) { $repositoryRoot } else { "$repositoryRoot\" }
  if ($IndependentKeyRoot.Equals($repositoryRoot, [StringComparison]::OrdinalIgnoreCase) -or
      $IndependentKeyRoot.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "IndependentKeyRoot must be outside the Git repository: $repositoryRoot"
  }
}
if (-not (Test-Path -LiteralPath $IndependentKeyRoot -PathType Container)) {
  throw "IndependentKeyRoot is missing: $IndependentKeyRoot"
}
$independentDriveRoot = [IO.Path]::GetPathRoot($IndependentKeyRoot)
$null = Assert-NoReparsePointPath -TrustedRoot $independentDriveRoot `
  -Candidate $IndependentKeyRoot -Label 'IndependentKeyRoot'
$PrivateKeyPath = Assert-PathBelow $IndependentKeyRoot $PrivateKeyPath 'PrivateKeyPath'
$PublicKeyPath = Assert-PathBelow $IndependentKeyRoot $PublicKeyPath 'PublicKeyPath'
if ([IO.Path]::GetExtension($PrivateKeyPath) -ne '.xml' -or [IO.Path]::GetExtension($PublicKeyPath) -ne '.xml') {
  throw 'Signing key paths must use the .xml extension'
}
if ($PrivateKeyPath -eq $PublicKeyPath) { throw 'Private and public key paths must differ' }
if ($ConfirmIndependentHost -ne [string]$env:COMPUTERNAME) {
  throw 'ConfirmIndependentHost must exactly equal COMPUTERNAME'
}
foreach ($path in @($PrivateKeyPath, $PublicKeyPath)) {
  $null = Assert-NoReparsePointPath -TrustedRoot $IndependentKeyRoot -Candidate $path -Label 'Signing key output'
  if (Test-Path -LiteralPath $path) { throw "Signing key output already exists: $path" }
}

$plan = [ordered]@{
  status = 'OFFHOST_RECEIPT_SIGNING_KEY_PLAN_READY'
  independentHost = [string]$env:COMPUTERNAME
  privateKeyPath = $PrivateKeyPath
  publicKeyPath = $PublicKeyPath
  algorithm = 'RSA-3072-SHA256-PKCS1-v1_5'
  writesRequested = [bool]$Apply
}
if (-not $Apply) {
  $plan | ConvertTo-Json -Depth 5
  return
}
if (-not $PSCmdlet.ShouldProcess($PrivateKeyPath, 'Create an independent RSA receipt-signing key pair')) {
  return
}

foreach ($path in @($PrivateKeyPath, $PublicKeyPath)) {
  $parent = Split-Path -Parent $path
  $null = Assert-NoReparsePointPath -TrustedRoot $IndependentKeyRoot -Candidate $parent -Label 'Signing key parent'
  [void][IO.Directory]::CreateDirectory($parent)
  $null = Assert-NoReparsePointPath -TrustedRoot $IndependentKeyRoot -Candidate $parent -Label 'Signing key parent'
}
$rsa = New-Object Security.Cryptography.RSACryptoServiceProvider(3072)
$rsa.PersistKeyInCsp = $false
try {
  Write-Utf8NoBomCreateNew -TrustedRoot $IndependentKeyRoot `
    -Path $PrivateKeyPath -Value "$($rsa.ToXmlString($true))`n"
  Write-Utf8NoBomCreateNew -TrustedRoot $IndependentKeyRoot `
    -Path $PublicKeyPath -Value "$($rsa.ToXmlString($false))`n"
}
finally { $rsa.Dispose() }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($identity)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
  $identity,
  [Security.AccessControl.FileSystemRights]::FullControl,
  [Security.AccessControl.AccessControlType]::Allow
)))
Set-Acl -LiteralPath $PrivateKeyPath -AclObject $acl

[ordered]@{
  status = 'OFFHOST_RECEIPT_SIGNING_KEY_CREATED'
  independentHost = [string]$env:COMPUTERNAME
  publicKeyPath = $PublicKeyPath
  publicKeySha256 = (Get-FileHash -LiteralPath $PublicKeyPath -Algorithm SHA256).Hash.ToLowerInvariant()
  privateKeyPath = $PrivateKeyPath
  privateKeySha256 = (Get-FileHash -LiteralPath $PrivateKeyPath -Algorithm SHA256).Hash.ToLowerInvariant()
  privateKeyAclProtected = (Get-Acl -LiteralPath $PrivateKeyPath).AreAccessRulesProtected
} | ConvertTo-Json -Depth 5
