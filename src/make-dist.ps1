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
foreach ($need in @('src\tool-server.js','src\build-portable.js','src\pack-portable.js','spike\m0\vendor\psychojs-2026.2.3.iife.js','site\collector.html')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ROOT $need))) { throw "缺少必要文件：$need" }
}

if (Test-Path -LiteralPath $PKG) { Remove-Item -LiteralPath $PKG -Recurse -Force }
New-Item -ItemType Directory -Force -Path $PKG, "$PKG\node", "$PKG\src", "$PKG\tools" | Out-Null

Write-Host '== 1/5 内嵌 Node =='
Copy-Item -LiteralPath $NodeExe -Destination "$PKG\node\node.exe" -Force
Write-Host ("   node.exe  {0:N1} MB" -f ((Get-Item "$PKG\node\node.exe").Length / 1MB))

Write-Host '== 2/5 转换端代码 =='
# 只带转换真正需要的文件（collector-core/page、build-collector 是"生成回收器"用的，包内已有成品）
$srcFiles = @('tool-server.js','build-portable.js','pack-portable.js','psyexp-audit.js','support-matrix.js','js-codeblock-fix.js','psyweb-shim-2026.js')
foreach ($f in $srcFiles) { Copy-Item -LiteralPath (Join-Path $ROOT "src\$f") -Destination "$PKG\src\" -Force }
Write-Host ("   {0} 个 js  {1:N2} MB" -f $srcFiles.Count, ((Get-ChildItem "$PKG\src" -File | Measure-Object -Property Length -Sum).Sum / 1MB))

Write-Host '== 3/5 第三方运行时（按 vendor.lock 已锁定版本）=='
# pack-portable.js 会从 <root>\spike\m0\vendor 读取，故保持同样的相对结构
New-Item -ItemType Directory -Force -Path "$PKG\spike\m0" | Out-Null
Copy-Item -LiteralPath (Join-Path $ROOT 'spike\m0\vendor') -Destination "$PKG\spike\m0\vendor" -Recurse -Force
Copy-Item -LiteralPath (Join-Path $ROOT 'vendor.lock.json') -Destination "$PKG\vendor.lock.json" -Force
Write-Host ("   vendor  {0:N1} MB" -f ((Get-ChildItem "$PKG\spike\m0\vendor" -File | Measure-Object -Property Length -Sum).Sum / 1MB))

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
Copy-Item -LiteralPath (Join-Path $ROOT 'site\collector.html') -Destination "$PKG\tools\" -Force
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
本工具自身代码：MIT（见仓库 LICENSE）。
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
③ 他们把截图或 CSV 发回来 → 双击 site\collector.html，把截图拖进去，
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
