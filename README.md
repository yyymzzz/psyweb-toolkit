# psyweb · 把 PsychoPy 实验变成"发给谁都能做"的单个网页

**一句话**：你在 PsychoPy Builder 里设计好的实验，转成一个 **3–4 MB 的 `.html` 文件**，用微信发给被试 → 对方**在电脑上双击**就能做 → 做完页面给出**结果摘要 + CSV 下载 + 数据二维码**，被试截图发回来即可收数。

全程不需要服务器、不需要备案、不需要被试安装任何东西、**不上传任何数据**。

---

## ⚠️ 先分清两种 HTML —— 它们不是一回事

这是最容易搞混、也最容易踩坑的一点。请先看这张表再往下读：

| | **PsychoPy Builder 导出的 HTML** | **本工具产出的 HTML** |
|---|---|---|
| 形态 | 一堆文件：`index.html` + `xxx.js` + `xxx-legacy-browsers.js` + `lib\` + 图片/条件表 | **一个** `.html` 文件（自包含） |
| 能直接发被试吗 | ❌ **不能** | ✅ 能 |
| 为什么 | 它靠**相对路径**找运行时库、默认把数据往 **Pavlovia 服务器**上传；没有开始页、没有数据出口，直接双击打开多半空白或报错 | 运行时与素材已内联；有开始页（含知情同意）、有数据出口 |
| 数据去哪 | 上传到 Pavlovia 云端（需要账号 + 网络） | 只留在被试电脑上，由被试发回给你 |
| 在本工具里的角色 | **输入**（中间产物） | **最终产物**（发给被试的那个） |

> 换句话说：**Builder 的「Export HTML」只是原料，不是成品。** 原料要经过本工具打包，才能发出去。

---

## 怎么用（三选一）

### ① 在线工具（最省事，需联网）

打开 **https://yyymzzz.github.io/psyweb-toolkit/** →

1. 在 PsychoPy Builder 里菜单 `File → Export HTML…`（或往 Pavlovia 同步一次），得到一个文件夹；
2. 把**整个文件夹拖进网页**；
3. 下载生成的单个 `.html`，发给被试。

纯浏览器计算，文件不上传（素材加载完全部在本地完成）。

### ② 离线单文件版（对方网络不稳 / 你要脱网操作）

下载 **[离线单文件版](https://yyymzzz.github.io/psyweb-toolkit/offline.html)**（约 3.2 MB），**双击打开**即可 ——
它是①的离线内联版，功能完全相同，不需要服务器、不需要联网、Windows / macOS / Linux 通用。
（源码见 [`site/offline.html`](site/offline.html)，由 `src/build-single-tool.ps1` 生成。）

### ③ 本地工具（唯一能直接吃 `.psyexp` 的方式）

把 `.psyexp` 编译成 `.js` 的是 **PsychoPy 本体**（Python 程序）。它的依赖里有 `wx`、`pyglet` 这类
**原生桌面库**，浏览器里跑不起来（实测编译链上有 158 个模块），所以**这一步无法搬进网页**。
想"直接拖 `.psyexp` 一步到位"，就在自己电脑上跑本地工具：

```powershell
git clone <本仓库>; cd <本仓库>
pwsh -File scripts/setup.ps1     # 环境体检：Node / 依赖 / 素材 / PsychoPy，并打印下一条命令
# 然后双击 启动psyweb工具.cmd（需要本机已装 Node.js）
```

本地工具会**调用你已装的 PsychoPy** 编译 `.psyexp`，再走与网页完全相同的打包链路。

---

## 数据怎么回来（三通道，任选其一）

被试做完看到结果页，有三条出口：

| 通道 | 用途 | 注意 |
|---|---|---|
| **数据二维码** | 最快。被试截图二维码发你（微信/QQ） | 微信务必勾选**原图**，否则压缩会糊掉 |
| **下载 CSV** | 最稳。点一下得到 `psyweb_'01'.csv` | 适合文件能传的场景 |
| **结果摘要截图** | 兜底。写明被试编号/行数/字段数 | 只能核对，不能当数据用 |

主试端把二维码截图**拖进** [collector.html](https://yyymzzz.github.io/psyweb-toolkit/collector.html)（也可下载后双击，纯本地）
→ 自动解码分组 → 一键**导出合并 CSV**。
多名被试的截图可以一起拖，按数据集自动分组，不会混。若提示「缺 2」= 对方少发了第 2 张，让他补发。

---

## 边界（请如实告知合作者）

- **计时精度**：`requestAnimationFrame` + `performance.now()`，跨设备抖动通常 **5–20 ms**，**不能与实验室光电管 / EEG 触发相比**。需要毫秒级严格对齐的范式不要搬上网。
- **硬件**：脑电、眼动、串口/并口触发、按钮盒 —— 在线一律不可用。
- **设备差异**：屏幕尺寸、刷新率、操作系统会被记录进数据（`frameRate` / `OS` 等列），分析时应作为协变量检查。
- **伦理**：知情同意书是模板；**伦理审查与数据保管责任由研究者本人承担**，工具不代劳。
- **浏览器**：需要较新的 Chrome / Edge（依赖 WebGL）；手机和平板无法完成实验。
- **本仓库文件操作的命令**（`.cmd` / `.ps1`）目前**仅 Windows**；网页版与离线单文件版跨平台。

---

## 仓库结构

```
site/            在线工具（GitHub Pages 直接托管这个目录）
  index.html       在线打包页
  pack-core.js     浏览器版打包器
  offline.html     离线单文件版（由 src/build-single-tool.ps1 生成）
  collector.html   主试端：二维码截图 → 合并 CSV
  assets/          运行时素材（PsychoJS / jQuery / pako / 二维码编码 / psyweb shim）
src/             转换引擎
  pack-portable.js      单文件便携包打包器（Node）
  build-portable.js     .psyexp → 便携包（一步到位，需本机 PsychoPy）
  psyweb-shim-2026.js   运行时补丁层：内联资源 / 开始页 / 数据出口 / 结果页
  js-codeblock-fix.js   修复官方导出 JS 里的两类缺陷
  psyexp-audit.js       .psyexp 静态体检
  support-matrix.js     组件支持矩阵
  verify-single-tool.js 单文件工具的构建期硬门禁
docs/            使用说明 / 命令行 / 分发包
third_party/     第三方许可证原文（PsychoJS 的 LEGAL.txt 必须随附）
```

---

## 已知的坑（都已用构建期门禁挡住）

- **导出 JS 里的 `import`**：官方 legacy 版可能残留 ES `import`，浏览器直接报错 → `js-codeblock-fix.js` 内联替换。
- **`Math.random.random()`**：官方导出的一处翻译缺陷 → 同上修复。
- **资源未声明**：`.psyexp` 里没写进 resources 的图片/条件表，导出物不会带 → 打包器会扫条件表内容反查文件名并补登记。
- **把打包器自己内联进 HTML**：`pack-core.js` 里含**字面量 `</script>`**（它要拼输出 HTML），
  原样内联会被 HTML 分词器提前闭合标签，页面报 `SyntaxError: Invalid or unexpected token`。
  对策：只把 `</` 与 `<!--` 换成**取值等价**的 JS 转义（`<\/`、`\x3C!--`），并由
  `src/verify-single-tool.js` 逐字符比对全部内联素材 + 逐块强制解析，不通过就不出包。

---

## 许可

本仓库自身代码：**MIT**（见 [`LICENSE`](LICENSE)）—— 可自由使用、修改、再分发。

随附第三方组件**全部是 MIT**（PsychoJS、jQuery、jQuery UI、PreloadJS、pako、qrcode-generator），
没有被传染成 copyleft 的风险；其中 PsychoJS 的许可证原文**必须随附**，见
[`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md)。

> 注意：桌面版 **PsychoPy 是 GPL-3.0**，但浏览器端的 **PsychoJS 是 MIT** —— 两套独立许可。
> 本仓库只随附 PsychoJS。依据与再分发义务见 [`许可说明.md`](许可说明.md)。
