#requires -Version 5.1
<#
  生成"单文件离线版工具"（双击即用，无需任何服务器/托管）
  ------------------------------------------------------------------
  产物: dist\psyweb打包工具.html —— 约 4 MB，内含
        · 完整界面（拖拽 → 打包 → 下载）
        · pack-core.js（浏览器版打包器）
        · 全部运行时素材（PsychoJS / jquery / pako / 二维码编码 / shim）内联为 JS 字符串

  为什么做这个而不是"必须托管在线"：
    · 在线工具本质是**纯浏览器计算**，把它内联成一个 html，能力完全一样
    · 于是不需要服务器、不需要备案、不需要 GitHub Pages
    · **跨平台**：Mac / Linux 用户也能用（启动psyweb工具.cmd 永远只能 Windows）
    · 双击本地 html 也能跑（素材已内联，不依赖同源 fetch）

  ⚠️ 内联的致命坑（实测踩过，2 个 SyntaxError）：
    内联进 <script> 的代码里若含字面量 `</script>`，HTML 分词器会提前闭合标签。
    site\pack-core.js 的 292-301 行正是拼输出 HTML 的模板串，天然含 `</script>`。
    对策见下方 Protect-Inline()：只把 `</` 和 `<!--` 换成取值等价的 JS 转义。

  ⚠️ 产物必须过门禁才算完成：
    src\verify-single-tool.js 会逐个脚本块强制解析、扫描危险序列、
    并把内联素材与 site\assets 源文件逐字符比对。不过就 throw。

  用法: pwsh -File src/build-single-tool.ps1
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$ROOT = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$SITE = Join-Path $ROOT 'site'
$OUTDIR = Join-Path $ROOT 'dist'
$OUT = Join-Path $OUTDIR 'psyweb打包工具.html'

# 先确保素材齐全（build-site.ps1 会校验 index.html 里引用的每个素材）
Write-Host '== 1/3 准备素材 =='
& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'build-site.ps1') | Out-Host

function Read-Text($p, $what) {
    if (-not (Test-Path -LiteralPath $p)) { throw "缺少 $what : $p" }
    return [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
}

Write-Host '== 2/3 读取页面与素材 =='
$html = Read-Text (Join-Path $SITE 'index.html') 'site\index.html'
$core = Read-Text (Join-Path $SITE 'pack-core.js') 'site\pack-core.js'
$assets = [ordered]@{
    psychoJs    = 'assets\psychojs-2026.2.3.iife.js'
    css         = 'assets\psychojs-2026.2.3.css'
    jquery      = 'assets\jquery-3.6.0.min.js'
    jqueryUi    = 'assets\jquery-ui-1.12.1.min.js'
    jqueryUiCss = 'assets\jquery-ui-1.12.1.min.css'
    preload     = 'assets\preloadjs-1.0.1.min.js'
    pako        = 'assets\pako.min.js'
    qrcode      = 'assets\qrcode.js'
    shim        = 'assets\psyweb-shim-2026.js'
}
# 用 JSON 传递最安全（转义、引号、换行都由 JSON 负责；不能手工拼字符串）
$payload = [ordered]@{}
foreach ($k in $assets.Keys) {
    $payload[$k] = Read-Text (Join-Path $SITE $assets[$k]) ("素材 " + $assets[$k])
    Write-Host ("   {0,-14} {1,10:N0} 字符" -f $k, $payload[$k].Length)
}
$json = $payload | ConvertTo-Json -Compress -Depth 3

Write-Host '== 3/3 组装单文件工具 =='

# ---------------------------------------------------------------------------
# 安全内联：把**对 HTML 分词器有意义**的两类序列换成**取值等价**的 JS 转义。
#
#   </   → <\/      避免提前闭合 </script>；JS 里 \/ 就是 /（字符串/模板/正则同义）
#   <!-- → \x3C!--  避免进入 script-data-escaped 状态（该状态下 </script> 会失效）；
#                   JS 里 \x3C 就是 <
#
# 为什么必需（实测踩过，2 个 SyntaxError）：
#   site\pack-core.js 第 292-301 行是**拼输出 HTML 的模板串**，里面就有字面量
#   `</script>`。早先只对 JSON 素材做了 `</`→`<\/`，对 $core 没做 → pack-core
#   在第一个 `</script>` 处被提前闭合截断（只剩 14613 字符），尾部碎片成为
#   第 2 个脚本块，浏览器报 2 个 "Invalid or unexpected token"。
#
# 只动这两类序列是安全的：它们在 JS 里只可能出现在字符串/模板/正则/注释中，
# 替换后取值不变。等价性由 src\verify-single-tool.js 的 ③ 逐步比对证明。
# ---------------------------------------------------------------------------
function Protect-Inline([string]$s) {
    # 顺序固定：先 </ 再 <!--，两个序列互不重叠
    return $s.Replace('</', '<\/').Replace('<!--', '\x3C!--')
}
$jsonSafe = Protect-Inline $json
$coreSafe = Protect-Inline $core
$inlineCore = "<script>`n" + $coreSafe + "`n</script>`n" +
              "<script>window.PSYWEB_ASSETS = " + $jsonSafe + ";</script>"
# ⚠️ 必须用 [string]::Replace（字面量替换），**不能用 -replace**：
#    -replace 的替换串把 $1/$&/$' 当特殊符号，而被内联的代码里含 $ 字符
#    （与早先 String.replace(fn) 回调签名那次是同一类转义坑，实测踩过两次了）
$marker = '<script src="./pack-core.js"></script>'
if (-not $html.Contains($marker)) { throw '没找到 <script src="./pack-core.js"></script>，无法内联' }
$html = $html.Replace($marker, $inlineCore)
if ($html.IndexOf('PsywebPack') -lt 0) { throw '内联 pack-core.js 失败（页面里没出现 PsywebPack）' }
if ($html.IndexOf('window.PSYWEB_ASSETS') -lt 0) { throw '注入内联素材失败' }
if ($html.IndexOf('src="./pack-core.js"') -ge 0) { throw '外链 script 仍存在（替换不完整）' }

New-Item -ItemType Directory -Force -Path $OUTDIR | Out-Null
[System.IO.File]::WriteAllText($OUT, $html, (New-Object System.Text.UTF8Encoding($false)))

# ---- 构建期硬门禁：不过就是没过，不产出"看起来成功"的假象 ----
Write-Host "`n== 门禁：src\verify-single-tool.js =="
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw ' 找不到 node，无法跑门禁。单文件工具的等价性必须验证后才算完成。' }
& $node (Join-Path $PSScriptRoot 'verify-single-tool.js') $OUT --site $SITE
if ($LASTEXITCODE -ne 0) { throw "门禁未通过（exit $LASTEXITCODE），产物不可用：$OUT" }

$size = (Get-Item -LiteralPath $OUT).Length
Write-Host ("`n✅ 单文件工具已生成并通过门禁")
Write-Host ("   {0}" -f $OUT)
Write-Host ("   {0:N2} MB" -f ($size / 1MB))

# 同步进站点：托管页的「离线单文件版」下载按钮指向 ./offline.html
# （只在 http/https 下显示 —— 单文件工具自己被双击打开时源是 file://，旁边没有这个文件）
$SITE_COPY = Join-Path $SITE 'offline.html'
Copy-Item -LiteralPath $OUT -Destination $SITE_COPY -Force
Write-Host ("   已同步到站点（供托管页下载）：{0}" -f $SITE_COPY)

Write-Host "`n使用方式：双击打开（任何操作系统、任何浏览器），把 Export HTML 生成的文件夹拖进去即可。"
Write-Host "（不需要服务器、不需要联网、不需要安装任何东西）"
