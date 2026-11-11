#requires -Version 5.1
<#
  Builds dist/TeleProxyBridge-Setup-<version>.exe

  The installer is a single WinForms exe (compiled with the .NET Framework compiler that ships
  with Windows) with payload.zip embedded as a resource. Payload = the Node sources + a bundled
  node.exe, so the installed app needs nothing else on the machine.
#>
param(
  [string]$Version = '1.0.0',
  [switch]$SkipNode
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$build = Join-Path $root 'build'
$stage = Join-Path $build 'payload'
$zip = Join-Path $build 'payload.zip'
$dist = Join-Path $root 'dist'

Write-Host "[1/5] staging payload"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

foreach ($item in @('src', 'package.json', 'bridge.config.json', 'bridge.config.example.json', 'README.md', 'TeleProxyBridge.cmd')) {
  $from = Join-Path $root $item
  if (-not (Test-Path $from)) { throw "missing: $item" }
  Copy-Item $from (Join-Path $stage $item) -Recurse
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $SkipNode) {
  if (-not $node) { throw 'node.exe not found on PATH; cannot bundle a runtime' }
  Copy-Item $node (Join-Path $stage 'node.exe')
  Write-Host "      node.exe bundled from $node"
}

# never ship local state
Get-ChildItem $stage -Recurse -Include '*.log', '*.pid', '.tpb*', '.signin*' -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $stage -Recurse -Directory -Filter 'captures' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[2/5] compressing payload"
if (Test-Path $zip) { Remove-Item $zip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

Write-Host "[3/5] preparing installer source"
$cs = Join-Path $PSScriptRoot 'Setup.cs'
$work = Join-Path $build 'Setup.build.cs'
$src = [System.IO.File]::ReadAllText($cs)
$src = [regex]::Replace($src, 'const string AppVersion = "[^"]*";', 'const string AppVersion = "' + $Version + '";')
[System.IO.File]::WriteAllText($work, $src, (New-Object System.Text.UTF8Encoding($true)))

Write-Host "[4/5] compiling installer"
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'csc.exe (.NET Framework 4) not found' }
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$out = Join-Path $dist ("TeleProxyBridge-Setup-$Version.exe")
if (Test-Path $out) { Remove-Item $out -Force }

$args = @(
  '/nologo', '/target:exe', '/optimize+', '/codepage:65001',
  ('/out:"' + $out + '"'),
  ('/resource:"' + $zip + '",payload.zip'),
  '/r:System.IO.Compression.dll',
  '/r:System.IO.Compression.FileSystem.dll',
  '/r:System.Drawing.dll',
  '/r:System.Windows.Forms.dll',
  ('"' + $work + '"')
)
& $csc $args | Write-Host
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

Write-Host "[5/5] done"
$exe = Get-Item $out
Write-Host ("      {0}  ({1:N1} MB)" -f $exe.FullName, ($exe.Length / 1MB))
