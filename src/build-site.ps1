#requires -Version 5.1
<#
  构建在线工具站点（site\）—— 供 GitHub Pages / Cloudflare Pages 等静态托管发布
  ------------------------------------------------------------------
  做三件事：
    ① 把第三方运行时素材（psychojs / jquery / pako / qrcode…）拷进 site\assets\
       —— 站点要能独立发布，不能依赖"本机先跑过 fetch-vendor.ps1"
    ② 把 psyweb-shim-2026.js 作为**文本素材**拷进去（在线打包器要把它内联进产物）
    ③ 校验素材齐全 + 体积，并给出本机预览方式

  用法: pwsh -File src/build-site.ps1 [-CopyIntoRepo]
        -CopyIntoRepo  把素材真正写入 site\assets\（默认也会写；
                       加此开关只是显式确认"这些文件会进仓库/会被发布"）
#>
[CmdletBinding()]
param([switch]$CopyIntoRepo)
$ErrorActionPreference = 'Stop'
$ROOT = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$SITE = Join-Path $ROOT 'site'
$ASSETS = Join-Path $SITE 'assets'
$VENDOR = Join-Path $ROOT 'spike\m0\vendor'

if (-not (Test-Path (Join-Path $SITE 'index.html'))) { throw "缺少 site\index.html" }
if (-not (Test-Path (Join-Path $SITE 'pack-core.js'))) { throw "缺少 site\pack-core.js" }

New-Item -ItemType Directory -Force -Path $ASSETS | Out-Null

$map = @(
    @{ from = (Join-Path $VENDOR 'psychojs-2026.2.3.iife.js'); to = 'psychojs-2026.2.3.iife.js' },
    @{ from = (Join-Path $VENDOR 'psychojs-2026.2.3.css');     to = 'psychojs-2026.2.3.css' },
    @{ from = (Join-Path $VENDOR 'jquery-3.6.0.min.js');       to = 'jquery-3.6.0.min.js' },
    @{ from = (Join-Path $VENDOR 'jquery-ui-1.12.1.min.js');   to = 'jquery-ui-1.12.1.min.js' },
    @{ from = (Join-Path $VENDOR 'jquery-ui-1.12.1.min.css');  to = 'jquery-ui-1.12.1.min.css' },
    @{ from = (Join-Path $VENDOR 'preloadjs-1.0.1.min.js');    to = 'preloadjs-1.0.1.min.js' },
    @{ from = (Join-Path $VENDOR 'pako.min.js');               to = 'pako.min.js' },
    @{ from = (Join-Path $ROOT 'node_modules\qrcode-generator\dist\qrcode.js'); to = 'qrcode.js' },
    @{ from = (Join-Path $ROOT 'src\psyweb-shim-2026.js');     to = 'psyweb-shim-2026.js' }
)

Write-Host '== 拷贝站点素材 =='
$total = 0
foreach ($m in $map) {
    if (-not (Test-Path -LiteralPath $m.from)) {
        throw ("缺少素材: {0}`n  → 先运行 pwsh -File scripts/setup.ps1 与 npm install" -f $m.from)
    }
    Copy-Item -LiteralPath $m.from -Destination (Join-Path $ASSETS $m.to) -Force
    $len = (Get-Item -LiteralPath (Join-Path $ASSETS $m.to)).Length
    $total += $len
    Write-Host ("   {0,-32} {1,10:N0} B" -f $m.to, $len)
}
Write-Host ("   合计 {0:N2} MB" -f ($total / 1MB))

# 站点自检：index.html 里引用的每个素材都必须存在
Write-Host "`n== 自检：index.html 引用的素材是否齐全 =="
$html = Get-Content -LiteralPath (Join-Path $SITE 'index.html') -Raw -Encoding UTF8
$refs = [regex]::Matches($html, "'\./assets/([^']+)'") | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
$missing = @()
foreach ($r in $refs) {
    if (Test-Path -LiteralPath (Join-Path $ASSETS $r)) { Write-Host ("   [OK]   {0}" -f $r) -ForegroundColor Green }
    else { Write-Host ("   [缺失] {0}" -f $r) -ForegroundColor Red; $missing += $r }
}
if ($missing.Count) { throw ("站点缺少素材: " + ($missing -join ', ')) }

$siteMB = (Get-ChildItem $SITE -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host ("`n站点总大小: {0:N2} MB（可直接作为静态站点发布）" -f $siteMB)
Write-Host "`n本机预览："
Write-Host "  node src/serve-site.js            然后打开 http://127.0.0.1:7790/" -ForegroundColor Yellow
Write-Host "`n发布到 GitHub Pages（需公开仓库或付费计划的私有 Pages）："
Write-Host "  gh api -X POST repos/{owner}/{repo}/pages -f 'source[branch]=main' -f 'source[path]=/site'" -ForegroundColor Gray
