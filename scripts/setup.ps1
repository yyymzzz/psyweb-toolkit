#requires -Version 5.1
<#
  psyweb 环境检查 / 一键引导
  --------------------------------------------------------------------
  用法（可直接复制到 PowerShell 运行）：

      pwsh -File scripts/setup.ps1              # 检查 + 缺什么自动补什么
      pwsh -File scripts/setup.ps1 -CheckOnly   # 只看状态，不动任何东西

  检查四件事：
    ① Node.js（≥18；分发包里自带则用包内的）
    ② npm 运行期依赖（fast-xml-parser / qrcode-generator）
    ③ 第三方运行时库（psychojs 等，按 vendor.lock.json 锁定版本）
    ④ PsychoPy（转换 .psyexp 必需；没有也能用"已导出 js"的兜底路径）
  最后给出"下一步该敲什么命令"，并把检测到的真实路径填进去。
#>
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$SkipNpm,
    [string]$PsychoPyPython
)
$ErrorActionPreference = 'Stop'
$ROOT = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:blockers = 0

function Ok   ($msg) { Write-Host ("  [OK]   " + $msg) -ForegroundColor Green }
function Warn ($msg) { Write-Host ("  [注意] " + $msg) -ForegroundColor Yellow }
function Bad  ($msg) { Write-Host ("  [缺失] " + $msg) -ForegroundColor Red; $script:blockers++ }
function Head ($msg) { Write-Host ("`n" + $msg) -ForegroundColor Cyan }

Write-Host "==================================================" -ForegroundColor White
Write-Host "  psyweb 环境检查" -ForegroundColor White
Write-Host "  项目目录: $ROOT" -ForegroundColor White
Write-Host "==================================================" -ForegroundColor White

# ---------------------------------------------------------------- ① Node
Head "① Node.js"
$nodeExe = $null
$bundled = Join-Path $ROOT 'node\node.exe'          # 分发包里自带的
if (Test-Path -LiteralPath $bundled) {
    $nodeExe = $bundled
    Ok ("使用随包自带的 Node：" + $bundled)
} else {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $nodeExe = $cmd.Source } else {
        foreach ($c in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
            if (Test-Path -LiteralPath $c) { $nodeExe = $c; break }
        }
    }
}
if (-not $nodeExe) {
    Bad "没找到 Node.js。安装 LTS 版即可：https://nodejs.org （或用免安装分发包，它自带 Node）"
} else {
    $ver = (& $nodeExe --version) -replace '^v', ''
    $major = [int]($ver -split '\.')[0]
    if ($major -ge 18) { Ok "Node.js v$ver  ($nodeExe)" }
    else { Bad "Node.js 版本过低：v$ver（需要 ≥ 18）" }
}

# ---------------------------------------------------------------- ② npm 依赖
Head "② npm 运行期依赖"
$npmDeps = @('fast-xml-parser', 'qrcode-generator')
$missingNpm = @($npmDeps | Where-Object { -not (Test-Path -LiteralPath (Join-Path $ROOT "node_modules\$_")) })
if (-not $missingNpm.Count) {
    Ok ("已安装：" + ($npmDeps -join ', '))
} elseif ($CheckOnly) {
    Bad ("缺少：" + ($missingNpm -join ', ') + "  → 运行 npm install")
} else {
    Warn ("缺少：" + ($missingNpm -join ', ') + "，正在执行 npm install …")
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Bad "没找到 npm（随 Node 一起安装）。请重装 Node.js LTS"
    } else {
        Push-Location $ROOT
        try { & npm install --no-audit --no-fund | Out-Host } finally { Pop-Location }
        $still = @($npmDeps | Where-Object { -not (Test-Path -LiteralPath (Join-Path $ROOT "node_modules\$_")) })
        if ($still.Count) { Bad ("npm install 后仍缺少：" + ($still -join ', ')) }
        else { Ok "已安装：" + ($npmDeps -join ', ') }
    }
}

# ---------------------------------------------------------------- ③ 第三方运行时
Head "③ 第三方运行时库（按 vendor.lock.json 锁定）"
$lock = Join-Path $ROOT 'vendor.lock.json'
$probe = Join-Path $ROOT 'spike\m0\vendor\psychojs-2026.2.3.iife.js'
if (-not (Test-Path -LiteralPath $lock)) {
    Bad "缺少 vendor.lock.json（依赖真相源），无法校验"
} elseif (Test-Path -LiteralPath $probe) {
    $n = (Get-ChildItem (Join-Path $ROOT 'spike\m0\vendor') -File -ErrorAction SilentlyContinue | Measure-Object).Count
    Ok "已就位（vendor 目录 $n 个文件）"
} elseif ($CheckOnly) {
    Bad "未拉取 → 运行 pwsh -File scripts/fetch-vendor.ps1"
} else {
    Warn "未拉取，正在按 lock 拉取并校验 SHA256 …"
    & pwsh -NoProfile -File (Join-Path $ROOT 'scripts\fetch-vendor.ps1') | Out-Host
    if (Test-Path -LiteralPath $probe) { Ok "已拉取并校验通过" } else { Bad "拉取失败，请检查网络后重试" }
}

# ---------------------------------------------------------------- ④ PsychoPy
Head "④ PsychoPy（转换 .psyexp 必需）"
$py = $null
$cands = @()
if ($PsychoPyPython) { $cands += $PsychoPyPython }
if ($env:PSYWEB_PSYCHOPY_PYTHON) { $cands += $env:PSYWEB_PSYCHOPY_PYTHON }
foreach ($d in 'C', 'D', 'E', 'F') {
    $cands += "${d}:\PsychoPy\python.exe"
    $cands += "${d}:\Program Files\PsychoPy\python.exe"
}
foreach ($c in $cands) {
    if (-not $c -or -not (Test-Path -LiteralPath $c)) { continue }
    $out = & $c -c "import psychopy,sys;sys.stdout.write(psychopy.__version__)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $out) { $py = @{ exe = $c; ver = $out.Trim() }; break }
}
if ($py) {
    Ok ("PsychoPy " + $py.ver + "  (" + $py.exe + ")")
    Ok "官方 headless 编译器可用 → 可以直接把 .psyexp 转成单文件便携包"
} else {
    Warn "本机没有找到 PsychoPy。两条路都行："
    Write-Host "         ① 安装 PsychoPy（官网下载 standalone 版，自带 Python）：https://www.psychopy.org/download.html" -ForegroundColor Gray
    Write-Host "         ② 不装：用别人的 Builder 点一次 Export HTML，再走兜底路径打包：" -ForegroundColor Gray
    Write-Host "            node src\pack-portable.js --dir <实验目录> --js <导出目录>\xxx-legacy-browsers.js --out <输出.html>" -ForegroundColor Gray
}

# ---------------------------------------------------------------- 结论
Write-Host ""
Write-Host "==================================================" -ForegroundColor White
if ($script:blockers -eq 0) {
    Write-Host "  环境就绪，可以开始转换" -ForegroundColor Green
    Write-Host "==================================================" -ForegroundColor White
    Write-Host "`n下一步（把路径换成你自己的 .psyexp）：`n" -ForegroundColor White
    $sample = 'D:\实验\选择实验\untitled.psyexp'
    if ($py) {
        Write-Host "  node src\build-portable.js --psyexp `"$sample`" --out `"D:\实验\选择实验\便携包.html`" --title `"我的实验`"" -ForegroundColor Yellow
    } else {
        Write-Host "  （先装 PsychoPy，或用上面 ② 的兜底命令）" -ForegroundColor Yellow
    }
    Write-Host "`n也可以双击 启动psyweb工具.cmd 用图形界面。`n" -ForegroundColor Gray
    exit 0
} else {
    Write-Host ("  有 " + $script:blockers + " 项需要处理（见上面 [缺失]）") -ForegroundColor Red
    Write-Host "==================================================" -ForegroundColor White
    exit 1
}
