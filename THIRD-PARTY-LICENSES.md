# 第三方组件与许可

本仓库随附下列第三方组件。**清单只提供来源、指纹与许可证原文位置，不代替许可证原文本身。**

## 一、浏览器端运行时（`site/assets/`）

| 组件 | 版本 | 许可 | 来源 | 许可证原文 |
|---|---|---|---|---|
| **PsychoJS**（`psychojs-2026.2.3.iife.js` + `.css`） | 2026.2.3 | **MIT** | `https://lib.pavlovia.org/` | [`psychojs-2026.2.3.js.LEGAL.txt`](psychojs-2026.2.3.js.LEGAL.txt)（**必须随附**——bundle 首行明确要求） |
| jQuery | 3.6.0 | MIT | jsDelivr `jquery@3.6.0` | [`licenses/jquery-MIT.txt`](licenses/jquery-MIT.txt) |
| jQuery UI | 1.12.1 | MIT | jsDelivr `jquery-ui-dist@1.12.1` | [`licenses/jquery-ui-MIT.txt`](licenses/jquery-ui-MIT.txt) |
| PreloadJS | 1.0.1 | MIT | jsDelivr `preloadjs@1.0.1` | [`licenses/preloadjs-MIT.txt`](licenses/preloadjs-MIT.txt) |
| pako | 1.0.10 | MIT | cdnjs `pako/1.0.10` | [`licenses/pako-MIT.txt`](licenses/pako-MIT.txt) |
| qrcode-generator | 2.0.4 | MIT | npm `qrcode-generator` | [`licenses/qrcode-generator-MIT.txt`](licenses/qrcode-generator-MIT.txt) |
| **jsQR**（内联进 site/collector.html，二维码解码） | 1.4.0 | **Apache-2.0** | https://github.com/cozmo/jsQR | [licenses/jsqr-Apache2.0.txt](licenses/jsqr-Apache2.0.txt) |

> **关于 PsychoJS 的许可**：PsychoJS（浏览器端 JS 运行时）是 **MIT**，
> 与桌面版 PsychoPy 的 **GPL-3.0** 是**两套不同的许可**，请不要混淆。
> 依据：`psychojs-2026.2.3.js.LEGAL.txt` 中每个源文件头部均标注
> `@license Distributed under the terms of the MIT License`，
> 版权方为 Ilixa Ltd. / Open Science Tools Ltd.
> 该 LEGAL.txt 还一并覆盖了 bundle 内嵌的 pixi.js、howler.js、Tone.js（均 MIT），
> 以及 Microsoft tslib（MIT 或 Apache-2.0）、SheetJS、showdown、punycode。

### 为什么必须单独提供这些文本

`site/assets/` 里是**压缩过的发行文件**，大多**不含完整许可原文**（实测）：

- `jquery-3.6.0.min.js` 头部只写 `jquery.org/license`，没有内嵌 MIT 全文；
- `pako.min.js` **完全没有头注释**；
- `psychojs-2026.2.3.iife.js` 首行是
  `/*! For license information please see psychojs-2026.2.3.js.LEGAL.txt */` —— 许可原文在**另一个文件**里。

所以 MIT 的「保留版权声明与许可声明」这一条，靠发行文件本身是满足不了的，必须像本仓库这样随附原文。

## 二、Node 运行期依赖（`package.json` → `dependencies`）

| 包 | 许可 |
|---|---|
| fast-xml-parser | MIT |
| jsQR（collector 重建依赖） | **Apache-2.0** |
| qrcode-generator | MIT |

## 三、指纹

`site/assets/` 每个文件的 SHA256、以及本目录下许可证原文的 SHA256，
见构建脚本生成的 `文件清单.txt`；版本锁定见仓库根目录 [`vendor.lock.json`](../vendor.lock.json)。

## 四、本仓库自身代码

**MIT** —— 见 [`../LICENSE`](../LICENSE)。再分发时请一并保留本节所列的第三方许可证原文。
