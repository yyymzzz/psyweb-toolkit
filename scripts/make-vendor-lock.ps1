#requires -Version 5.1
<#
  生成 / 刷新 vendor.lock.json
  ------------------------------------------------------------------
  第三方依赖的唯一真相源：URL + SHA256 + 字节数。
  vendor/ 不入库，任何人执行 scripts/fetch-vendor.ps1 都能拉回同样的字节。
  改动过 vendor 内容（例如换版本）后重新跑本脚本刷新指纹。
#>
[CmdletBinding()]
param(
    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

# 依赖清单：key = 落盘文件名，dest 相对 spike/m0/
$sources = [ordered]@{
    # --- PsychoJS 运行时及其依赖（MIT）---
    'psychojs-2020.2.js'     = @{ dest='vendor'; url='https://lib.pavlovia.org/psychojs-2020.2.js'; role='runtime'; note='PsychoJS 运行时；lib.pavlovia.org 只挂历史版本，必须冻结' }
    'pixi-5.3.3.min.js'      = @{ dest='vendor'; url='https://cdnjs.cloudflare.com/ajax/libs/pixi.js/5.3.3/pixi.min.js'; role='runtime'; note='PsychoJS 的渲染后端（WebGL/Canvas）' }
    'preloadjs.min.js'       = @{ dest='vendor'; url='https://cdnjs.cloudflare.com/ajax/libs/PreloadJS/1.0.1/preloadjs.min.js'; role='runtime'; note='createjs.LoadQueue：资源下载器（将被 shim 改道）' }
    'howler.min.js'          = @{ dest='vendor'; url='https://cdnjs.cloudflare.com/ajax/libs/howler/2.1.2/howler.min.js'; role='runtime'; note='音频后端' }
    'Tone.js'                = @{ dest='vendor'; url='https://cdnjs.cloudflare.com/ajax/libs/tone/14.7.61/Tone.js'; role='runtime'; note='音频后端' }
    'moment.min.js'          = @{ dest='vendor'; url='https://cdnjs.cloudflare.com/ajax/libs/moment.js/2.24.0/moment.min.js'; role='runtime'; note='时间格式化' }
    'pako.min.js'            = @{ dest='vendor'; url='https://cdnjs.cloudflare.com/ajax/libs/pako/1.0.10/pako.min.js'; role='runtime'; note='zlib：数据压缩' }
    'xlsx.full.min.js'       = @{ dest='vendor'; url='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.14.2/xlsx.full.min.js'; role='runtime'; note='xlsx 条件文件 / 导出' }
    'log4javascript.min.js'  = @{ dest='vendor'; url='https://cdnjs.cloudflare.com/ajax/libs/log4javascript/1.4.9/log4javascript.min.js'; role='runtime'; note='日志' }
    'seedrandom.min.js'      = @{ dest='vendor'; url='https://cdnjs.cloudflare.com/ajax/libs/seedrandom/3.0.1/seedrandom.min.js'; role='runtime'; note='可复现随机（条件随机化）' }
    'jquery.min.js'          = @{ dest='vendor'; url='https://cdnjs.cloudflare.com/ajax/libs/jquery/2.2.0/jquery.min.js'; role='runtime'; note='PsychoJS GUI 依赖' }
    'jquery-ui.min.js'       = @{ dest='vendor'; url='https://cdnjs.cloudflare.com/ajax/libs/jqueryui/1.12.1/jquery-ui.min.js'; role='runtime'; note='对话框 UI' }
    'jquery-ui.min.css'      = @{ dest='vendor'; url='https://cdnjs.cloudflare.com/ajax/libs/jqueryui/1.12.1/jquery-ui.min.css'; role='runtime'; note='对话框样式' }
    'polyfill.min.js'        = @{ dest='vendor'; url='https://cdnjs.cloudflare.com/ajax/libs/babel-polyfill/7.6.0/polyfill.min.js'; role='runtime'; note='legacy 浏览器兼容' }
    'url-search-params.js'   = @{ dest='vendor'; url='https://cdnjs.cloudflare.com/ajax/libs/url-search-params/1.1.0/url-search-params.js'; role='runtime'; note='legacy 浏览器兼容' }

    # --- PsychoJS 2026 系列（实验导出目录 lib/ 里应带的运行时）---
    'psychojs-2026.2.3.iife.js' = @{ dest='vendor'; url='https://lib.pavlovia.org/psychojs-2026.2.3.iife.js'; role='runtime'; note='PsychoJS 经典脚本(IIFE)运行时；官方导出物 index.html 里以 nomodule 引入' }
    'psychojs-2026.2.3.css'     = @{ dest='vendor'; url='https://lib.pavlovia.org/psychojs-2026.2.3.css'; role='runtime'; note='PsychoJS 样式表' }

    # --- 2026 导出物 index.html 里引用的 CDN 依赖（版本必须与官方一致）---
    'jquery-3.6.0.min.js'      = @{ dest='vendor'; url='https://cdn.jsdelivr.net/npm/jquery@3.6.0/dist/jquery.min.js'; role='runtime'; note='psychojs 2026 GUI 依赖（官方 index.html 锁定 3.6.0）' }
    'jquery-ui-1.12.1.min.js'  = @{ dest='vendor'; url='https://cdn.jsdelivr.net/npm/jquery-ui-dist@1.12.1/jquery-ui.min.js'; role='runtime'; note='对话框 UI' }
    'jquery-ui-1.12.1.min.css' = @{ dest='vendor'; url='https://cdn.jsdelivr.net/npm/jquery-ui-dist@1.12.1/jquery-ui.min.css'; role='runtime'; note='对话框样式' }
    'preloadjs-1.0.1.min.js'   = @{ dest='vendor'; url='https://cdn.jsdelivr.net/npm/preloadjs@1.0.1/lib/preloadjs.min.js'; role='runtime'; note='createjs 预加载器（psychojs 2026 资源管线会用）' }

    # --- 官方 demo 对照产物（不入库，仅本地参考）---
    'demo-legacy.js'         = @{ dest='ref'; url='https://run.pavlovia.org/demos/staircase-demo/orientation_staircase-legacy-browsers.js'; role='reference'; note='官方导出物样本（legacy 版），用于对照 API 用法' }

    # --- 穿刺用资源 ---
    'grating_cropped.png'    = @{ dest='resources'; url='https://run.pavlovia.org/demos/staircase-demo/Stimuli/grating_cropped.png'; role='asset'; note='官方 demo 的刺激图，用于验证资源内联' }
}

$entries = [ordered]@{}
foreach ($name in $sources.Keys) {
    $meta = $sources[$name]
    $path = Join-Path $Root ("spike/m0/{0}/{1}" -f $meta.dest, $name)
    if (Test-Path -LiteralPath $path) {
        $fi   = Get-Item -LiteralPath $path
        $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
        $entries[$name] = [ordered]@{
            path   = "spike/m0/$($meta.dest)/$name"
            url    = $meta.url
            sha256 = $hash
            bytes  = $fi.Length
            role   = $meta.role
            note   = $meta.note
            state  = 'present'
        }
    } else {
        $entries[$name] = [ordered]@{
            path   = "spike/m0/$($meta.dest)/$name"
            url    = $meta.url
            sha256 = $null
            bytes  = $null
            role   = $meta.role
            note   = $meta.note
            state  = 'missing'
        }
    }
}

$lock = [ordered]@{
    generatedAt = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')
    generator   = 'scripts/make-vendor-lock.ps1'
    policy      = '第三方依赖不入库；按本文件 URL + SHA256 拉取，保证可复现'
    count       = $entries.Count
    entries     = $entries
}

$out = Join-Path $Root 'vendor.lock.json'
$lock | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $out -Encoding UTF8

$present = ($entries.Values | Where-Object { $_.state -eq 'present' }).Count
Write-Host "vendor.lock.json 已写入: $out"
Write-Host ("条目 {0} 个（present {1} / missing {2}）" -f $entries.Count, $present, ($entries.Count - $present))
$entries.GetEnumerator() | ForEach-Object {
    $v = $_.Value
    $s = if ($v.state -eq 'present') { ('{0,9:N0} B  {1}' -f $v.bytes, $v.sha256.Substring(0,16)) } else { '   MISSING' }
    Write-Host ("  {0,-24} {1}" -f $_.Key, $s)
}
