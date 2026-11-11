#requires -Version 5.1
<#
  Builds dist/TeleProxyBridge-Setup-<version>-native.exe — the native Tauri setup.

  Build machine requirements:
    * Rust (rustup) with the MSVC toolchain — the default on Windows and what CI uses.
    * Only if MSVC / Windows SDK is unavailable, pass -Gnu -Linker <gcc.exe> to pin the
      GNU target and a MinGW-w64 linker instead.
    * -Mirror <url> optionally swaps the crates registry (regional mirrors).
    * Nothing else: WebView2 runtime ships with Windows 10/11.
#>
param(
  [string]$Version = '1.0.0',
  [switch]$Gnu,                 # 用 GNU 工具链 + MinGW 链接器（没有 MSVC/Windows SDK 的机器）
  [string]$Linker = '',         # -Gnu 时的 gcc.exe 路径
  [string]$Mirror = '',         # 可选 crates 镜像，例：https://rsproxy.cn/index/
  [switch]$SkipNode
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$build = Join-Path $root 'build'
$stage = Join-Path $build 'payload'
$zip = Join-Path $build 'payload.zip'
$proj = Join-Path $root 'tauri-setup'
$dist = Join-Path $root 'dist'

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'cargo not found; install Rust first' }
if ($Gnu) {
  if (-not $Linker) { throw '-Gnu 需要同时给 -Linker <gcc.exe 路径>' }
  if (-not (Test-Path $Linker)) { throw ('linker not found: ' + $Linker) }
}

Write-Host '[1/5] staging payload'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
foreach ($item in @('src', 'package.json', 'bridge.config.json', 'bridge.config.example.json', 'README.md', 'TeleProxyBridge.cmd')) {
  $from = Join-Path $root $item
  if (-not (Test-Path $from)) { throw ('missing: ' + $item) }
  Copy-Item $from (Join-Path $stage $item) -Recurse
}
if (-not $SkipNode) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw 'node.exe not found on PATH; cannot bundle a runtime' }
  Copy-Item $node (Join-Path $stage 'node.exe')
  Write-Host ('      node.exe bundled from ' + $node)
}
Copy-Item (Join-Path $proj 'icons/icon.ico') (Join-Path $stage 'icon.ico') -Force
Get-ChildItem $stage -Recurse -Include '*.log','*.pid','.tpb*','.signin*' -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $stage -Recurse -Directory -Filter 'captures' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Write-Host '[2/5] compressing payload'
if (Test-Path $zip) { Remove-Item $zip -Force }
# .NET Framework needs this assembly registered; PowerShell 7 (.NET) already has the type.
try { Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop } catch { }
# includeBaseDirectory must stay false: the Rust side extracts entries as-is.
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Copy-Item $zip (Join-Path $proj 'payload.zip') -Force
Write-Host ('      payload.zip {0:N1} MB' -f ((Get-Item $zip).Length / 1MB))

Write-Host '[3/5] pinning toolchain + version'
Push-Location $proj
try {
  $cargoDir = Join-Path $proj '.cargo'
  $cfg = Join-Path $cargoDir 'config.toml'
  # 只有显式 -Gnu / -Mirror 时才生成本机配置；默认什么都不写，让 cargo 用本机的 MSVC 与官方源。
  if ($Gnu -or $Mirror) {
    New-Item -ItemType Directory -Path $cargoDir -Force | Out-Null
    $lines = @()
    if ($Gnu) {
      & cmd /c "rustup override set stable-x86_64-pc-windows-gnu >nul 2>&1"
      $lines += @(
        '[build]',
        'target = "x86_64-pc-windows-gnu"',
        '',
        '[target.x86_64-pc-windows-gnu]',
        ('linker = "' + ($Linker -replace '\\', '/') + '"'),
        ''
      )
    }
    if ($Mirror) {
      $lines += @(
        '[source.crates-io]',
        'replace-with = "mirror"',
        '',
        '[source.mirror]',
        ('registry = "sparse+' + $Mirror + '"'),
        ''
      )
    }
    [System.IO.File]::WriteAllText($cfg, ($lines -join [Environment]::NewLine))
  } elseif (Test-Path $cfg) {
    # 上一次本机构建留下的配置会污染别人的构建
    Remove-Item $cfg -Force
  }
  $conf = Join-Path $proj 'tauri.conf.json'
  $json = [System.IO.File]::ReadAllText($conf)
  $json = [regex]::Replace($json, '"version": "[^"]*"', ('"version": "' + $Version + '"'))
  [System.IO.File]::WriteAllText($conf, $json)

  Write-Host '[4/5] cargo build --release (first run compiles ~400 crates)'
  # cargo writes progress to stderr; going through cmd keeps PS 5.1 from turning that
  # into a NativeCommandError under $ErrorActionPreference = 'Stop'.
  cmd /c "cargo build --release 2>&1"
  if ($LASTEXITCODE -ne 0) { throw ('cargo build failed with exit code ' + $LASTEXITCODE) }
}
finally { Pop-Location }

Write-Host '[5/5] copying to dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$src = Join-Path $proj 'target/x86_64-pc-windows-gnu/release/teleproxybridge-setup.exe'
if (-not (Test-Path $src)) { throw ('build output missing: ' + $src) }
$out = Join-Path $dist ('TeleProxyBridge-Setup-' + $Version + '-native.exe')
Copy-Item $src $out -Force
$exe = Get-Item $out
Write-Host ('      {0}  ({1:N1} MB)' -f $exe.FullName, ($exe.Length / 1MB))
