#requires -Version 5.1
<#
  组装"免安装分发包"
  ------------------------------------------------------------------
  产出一个压缩包，对方解压后双击 启动psyweb工具.cmd 即可使用，
  **不需要安装 Node.js**（Node 内嵌在包里）。

  关于 Python：**不内嵌**。
    实测 PsychoPy standalone 安装后 1,520 MB —— 内嵌不现实；
    而且目标用户（做实验的人）本来就有 PsychoPy。
    对方确实没有时走兜底路径：让他用 PsychoPy Builder 点一次 Export HTML，
    把导出文件夹交给工具，此时**完全不需要 Python**。

  用法: pwsh -File src/make-dist.ps1 [-NodeExe <node.exe 路径>] [-SkipZip]
#>
[CmdletBinding()]
param(
    [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
    [switch]$SkipZip
)
$ErrorActionPreference = 'Stop'
$ROOT = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$PKG  = Join-Path $ROOT 'dist\psyweb-工具包'

if (-not (Test-Path -LiteralPath $NodeExe)) { throw "找不到 node.exe：$NodeExe（可用 -NodeExe 指定）" }
foreach ($need in @('src\tool-server.js','src\build-portable.js','src\pack-portable.js','vendor\psychojs-2026.2.3.iife.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ROOT $need))) { throw "缺少必要文件：$need" }
}

# collector.html 的真实产物位置由 src/build-collector.js 决定（当前是 tools/）。
# 踩过的坑：scripts/fix-audit-findings.ps1 里"统一到 site/collector.html"的补丁
# 模式写的是 `tools/collector.html`（带斜杠），而代码里其实是
# `path.join(ROOT, 'tools', 'collector.html')`（带逗号引号）—— **模式没命中，
# 补丁静默返回**，于是 site/collector.html 从未生成，而本脚本一直要它 →
# 打包脚本从 2026-09-24 起就一上来就抛异常，且没人发现。
# 现在改成：候选位置任一命中即可；都没有就现场生成；再没有才报错并列出试过哪些。
$collectorSrc = $null
foreach ($c in @('tools\collector.html', 'site\collector.html')) {
    if (Test-Path -LiteralPath (Join-Path $ROOT $c)) { $collectorSrc = $c; break }
}
if (-not $collectorSrc) {
    Write-Host '   未找到 collector.html，现场生成…'
    & node (Join-Path $ROOT 'src\build-collector.js')
    if ($LASTEXITCODE -ne 0) { throw "生成 collector.html 失败（exit $LASTEXITCODE）" }
    foreach ($c in @('tools\collector.html', 'site\collector.html')) {
        if (Test-Path -LiteralPath (Join-Path $ROOT $c)) { $collectorSrc = $c; break }
    }
}
if (-not $collectorSrc) { throw "找不到 collector.html（试过 tools\collector.html 与 site\collector.html）" }
Write-Host "   collector 来源: $collectorSrc"

if (Test-Path -LiteralPath $PKG) { Remove-Item -LiteralPath $PKG -Recurse -Force }
New-Item -ItemType Directory -Force -Path $PKG, "$PKG\node", "$PKG\src", "$PKG\tools" | Out-Null

Write-Host '== 1/5 内嵌 Node =='
Copy-Item -LiteralPath $NodeExe -Destination "$PKG\node\node.exe" -Force
Write-Host ("   node.exe  {0:N1} MB" -f ((Get-Item "$PKG\node\node.exe").Length / 1MB))

Write-Host '== 2/5 转换端代码 =='
# 只带转换真正需要的文件（collector-core/page、build-collector 是"生成回收器"用的，包内已有成品）
$srcFiles = @('tool-server.js','build-portable.js','pack-portable.js','psyexp-audit.js','support-matrix.js','js-codeblock-fix.js','psyweb-shim-2026.js')

# ⚠️ 手工维护的文件列表**必然有一天落后于代码** —— 2026-09-30 实测踩到：
#    tool-server.js 改成"发页面时内联 src/ref-closure.js + src/tool-page.js"后，
#    这个列表没跟着改。后果有两层：
#      ① 用旧列表打出来的包仍带旧 tool-server.js（含内嵌黑名单）→ 用户拿到的还是旧行为；
#      ② 若手工只更新 tool-server.js，新包一启动就 readInline 抛异常 → 页面 HTTP 500，工具全废。
#    所以这里**从代码里反查**：凡是 tool-server.js 里 readInline('x') 的目标，一律自动带上。
$serverSrc = Get-Content -LiteralPath (Join-Path $ROOT 'src\tool-server.js') -Raw -Encoding UTF8
$inlineNeeds = [regex]::Matches($serverSrc, "readInline\('([^']+)'\)") |
    ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
foreach ($f in $inlineNeeds) {
    if ($srcFiles -notcontains $f) { $srcFiles += $f; Write-Host "   自动补入（被 readInline 引用）: $f" }
}
foreach ($f in $srcFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $ROOT "src\$f"))) { throw "缺少必要文件：src\$f" }
}
foreach ($f in $srcFiles) { Copy-Item -LiteralPath (Join-Path $ROOT "src\$f") -Destination "$PKG\src\" -Force }
Write-Host ("   {0} 个 js  {1:N2} MB" -f $srcFiles.Count, ((Get-ChildItem "$PKG\src" -File | Measure-Object -Property Length -Sum).Sum / 1MB))

Write-Host '== 3/5 第三方运行时（按 vendor.lock 已锁定版本）=='
# pack-portable.js 会从 <root>\vendor 读取，故保持同样的相对结构
Copy-Item -LiteralPath (Join-Path $ROOT 'vendor') -Destination "$PKG\vendor" -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ROOT 'vendor.lock.json') -Destination "$PKG\vendor.lock.json" -Force
Write-Host ("   vendor  {0:N1} MB" -f ((Get-ChildItem "$PKG\vendor" -File | Measure-Object -Property Length -Sum).Sum / 1MB))

Write-Host '== 4/5 npm 依赖（只带运行期需要的两个）=='
foreach ($m in @('fast-xml-parser','qrcode-generator')) {
    $from = Join-Path $ROOT "node_modules\$m"
    if (-not (Test-Path -LiteralPath $from)) { throw "缺少 npm 依赖 $m（先在本仓库 npm install）" }
    New-Item -ItemType Directory -Force -Path "$PKG\node_modules" | Out-Null
    Copy-Item -LiteralPath $from -Destination "$PKG\node_modules\$m" -Recurse -Force
}
Write-Host ("   node_modules  {0:N2} MB" -f ((Get-ChildItem "$PKG\node_modules" -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB))

Write-Host '== 5/6 入口、回收器与说明 =='
Copy-Item -LiteralPath (Join-Path $ROOT '启动psyweb工具.cmd') -Destination $PKG -Force
Copy-Item -LiteralPath (Join-Path $ROOT $collectorSrc) -Destination "$PKG\tools\collector.html" -Force
if (Test-Path (Join-Path $ROOT 'docs\使用说明.md')) { Copy-Item (Join-Path $ROOT 'docs\使用说明.md') -Destination $PKG -Force }
if (Test-Path (Join-Path $ROOT 'docs\分发包.md')) { Copy-Item (Join-Path $ROOT 'docs\分发包.md') -Destination $PKG -Force }

Write-Host '== 6/6 第三方许可证 =='
# Node 的安装目录里**没有** LICENSE 文件（实测），所以仓库里存了一份原文
$nodeLic = Join-Path $ROOT 'third_party\node-LICENSE.txt'
if (Test-Path -LiteralPath $nodeLic) {
    Copy-Item -LiteralPath $nodeLic -Destination "$PKG\node\LICENSE.txt" -Force
    Write-Host ("   node\LICENSE.txt  {0:N0} B" -f (Get-Item "$PKG\node\LICENSE.txt").Length)
} else {
    Write-Warning "缺少 third_party\node-LICENSE.txt —— 分发包将不含 Node 许可证原文（公开分发前必须补上）"
}
# 依据 vendor.lock.json 生成第三方许可清单（只列来源与指纹，不代替许可证原文）
$lock = Get-Content -LiteralPath (Join-Path $ROOT 'vendor.lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$rows = @(foreach ($p in $lock.entries.PSObject.Properties) {
    $e = $p.Value
    "| ``{0}`` | {1} | ``{2}`` |" -f $p.Name, $e.url, $e.sha256.Substring(0, 16)
})
$licLines = @()
$licLines += '# 第三方组件与许可'
$licLines += ''
$licLines += '本工具随包分发下列第三方组件。**本清单只提供来源与指纹，不代替许可证原文。**'
$licLines += ''
$licLines += '## 内嵌的 Node.js'
$licLines += 'MIT 许可证（含其捆绑依赖的声明）——原文见 `node\LICENSE.txt`。'
$licLines += ''
$licLines += '## npm 运行期依赖'
$licLines += ''
$licLines += '| 包 | 许可 |'
$licLines += '|---|---|'
$licLines += '| fast-xml-parser | MIT |'
$licLines += '| qrcode-generator | MIT |'
$licLines += ''
$licLines += '## 浏览器端运行时（版本由 vendor.lock.json 锁定）'
$licLines += ''
$licLines += '| 组件 | 来源 | SHA256(前16位) |'
$licLines += '|---|---|---|'
$licLines += $rows
$licLines += ''
$licLines += '## 说明'
$licLines += '- 若要**公开分发**本工具，请先补齐上表各组件的许可证原文。'
$licLines += '- 本工具自身代码：MIT（见仓库 LICENSE）。'
$licLines += ('- 生成时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
$licLines | Out-File -FilePath "$PKG\第三方许可.md" -Encoding UTF8
Write-Host ("   第三方许可.md  {0} 个组件" -f $lock.count)

@'
psyweb 转换工具 · 免安装包
================================================

【怎么用】
双击「启动psyweb工具.cmd」，浏览器会自己打开。
把整个实验文件夹拖进去（或点「选择文件夹」），点「开始转换」。
转换好的 html 出现在 输出\ 里，页面上也有下载链接。

不需要安装 Node.js（已内嵌在 node\ 里）。

【关于 PsychoPy】
- 如果这台电脑装了 PsychoPy（Windows standalone 版），工具会自动找到，
  可以直接把 .psyexp 转成单文件实验包。
- 如果没装，也有办法：让对方在 PsychoPy Builder 里点一次 Export HTML，
  把导出的文件夹拖进本工具即可（走兜底路径，不需要 Python）。

【做好之后怎么用】
① 把生成的 html 发给被试（电脑上双击打开；手机和平板做不了）
② 被试做完 → 结果页给出 摘要截图 / 下载 CSV / 数据二维码
③ 他们把截图或 CSV 发回来 → 双击 tools\collector.html，把截图拖进去，
   自动还原成表格，可累积多人后一键导出合并 CSV

【数据安全】
全程在本机运行，不上传、不联网。被试数据不会离开这台电脑。

详细说明见 使用说明.md。
'@ | Out-File -FilePath "$PKG\首次使用.txt" -Encoding UTF8

$totalMB = (Get-ChildItem $PKG -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host ("`n包目录: {0}" -f $PKG)
Write-Host ("包大小: {0:N1} MB" -f $totalMB)

if (-not $SkipZip) {
    $zip = Join-Path $ROOT 'dist\psyweb-工具包.zip'
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    Compress-Archive -Path "$PKG\*" -DestinationPath $zip -CompressionLevel Optimal
    Write-Host ("压缩包: {0}  ({1:N1} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))
}
