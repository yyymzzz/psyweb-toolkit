#requires -Version 5.1
<#
  按 vendor.lock.json 拉取并校验第三方依赖
  ------------------------------------------------------------------
  用法：
    pwsh -File scripts/fetch-vendor.ps1              # 只补缺失/校验失败
    pwsh -File scripts/fetch-vendor.ps1 -Force       # 全部重新下载
    pwsh -File scripts/fetch-vendor.ps1 -VerifyOnly  # 只校验，不下载
  行为：
    下载 → 计算 SHA256 → 与 lock 比对；不一致则删除并报错（绝不静默接受坏字节）。
#>
[CmdletBinding()]
param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [switch]$Force,
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$lockPath = Join-Path $Root 'vendor.lock.json'
if (-not (Test-Path -LiteralPath $lockPath)) {
    throw "找不到 $lockPath —— 请先运行 scripts/make-vendor-lock.ps1（需先存在 vendor 文件）或从仓库恢复该文件。"
}
$lock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json

$ok = 0; $skip = 0; $fixed = 0; $fail = 0
Write-Host ("开始校验 {0} 个依赖 ..." -f $lock.count)

foreach ($prop in $lock.entries.PSObject.Properties) {
    $name = $prop.Name
    $e    = $prop.Value
    $dest = Join-Path $Root $e.path
    $dir  = Split-Path $dest -Parent
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    $needDownload = $Force.IsPresent -or (-not (Test-Path -LiteralPath $dest))
    if ((-not $needDownload) -and (-not $VerifyOnly.IsPresent)) {
        $h = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
        if ($h -ne $e.sha256) {
            Write-Warning "  {0} 指纹不匹配（本地 {1} ≠ lock {2}），重新下载" -f $name, $h.Substring(0,16), $e.sha256.Substring(0,16)
            $needDownload = $true
        }
    }

    if ($needDownload) {
        if ($VerifyOnly.IsPresent) {
            Write-Host ("  {0,-24} MISSING（-VerifyOnly 不下载）" -f $name) -ForegroundColor Yellow
            $fail++; continue
        }
        try {
            Invoke-WebRequest -Uri $e.url -OutFile $dest -TimeoutSec 120
        } catch {
            Write-Host ("  {0,-24} 下载失败: {1}" -f $name, $_.Exception.Message) -ForegroundColor Red
            $fail++; continue
        }
    }

    $got = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
    if ($got -eq $e.sha256) {
        $state = if ($needDownload) { 'fixed' } else { 'ok' }
        switch ($state) { 'fixed' { $fixed++ } default { $ok++ } }
        Write-Host ("  {0,-24} {1}  {2}" -f $name, $state.ToUpper(), $got.Substring(0,16)) -ForegroundColor Green
    } else {
        Write-Host ("  {0,-24} 校验失败：{1} ≠ {2}" -f $name, $got.Substring(0,16), $e.sha256.Substring(0,16)) -ForegroundColor Red
        Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
        $fail++
    }
}

Write-Host ""
Write-Host ("结果：ok={0}  重新下载={1}  失败={2}" -f $ok, $fixed, $fail)
if ($fail -gt 0) { exit 1 }
