/* ============================================================================
 * PsychoJS/PsychoPy 在线支持矩阵
 * ----------------------------------------------------------------------------
 * 来源（一手，2026-09-23 抓取）：
 *   https://psychopy.org/online/status.html        「Status of online options」
 *   https://psychopy.org/online/prepare-experiment-online.html
 *   https://psychopy.org/online/check-online-compatibility.html
 *
 * 用途：把 .psyexp 里的组件名映射成"能不能上网"的三级结论。
 * 维护规则：官方状态页变动时，改这一张表即可，别把判断散落在代码里。
 * ========================================================================== */
'use strict';

const OK = 'builtin';        // 🟢 官方 Built-in，可直接上线
const PROTOTYPE = 'prototype'; // 🟡 官方 Prototype / 需改造
const NO = 'unsupported';    // 🔴 官方明确不支持 / 物理上做不到

/** 组件 → 状态。键为 .psyexp 里的元素名（去掉 Component 后缀前的原名）。 */
const COMPONENTS = {
  TextComponent: { status: OK, note: '静态文本建议用 Text（TextBox 仍属 beta）' },
  TextboxComponent: { status: OK, note: '2022.1 之前需在 Begin Routine 里 textbox.refresh()' },
  ImageComponent: { status: OK, note: '引用图片务必带扩展名，否则易报 Unknown Resource' },
  PolygonComponent: { status: OK, note: '在线画圆请用 100 顶点的 regular polygon，不要用 circle 选项' },
  GratingComponent: { status: OK, note: '' },
  MovieComponent: { status: OK, note: '注意编码格式：推荐 MP4/H.264 + MP3' },
  SoundComponent: { status: OK, note: '推荐 MP3；浏览器自动播放策略要求首次交互后才能播' },
  SliderComponent: { status: OK, note: '在线请用 Slider，不要用 RatingScale' },
  FormComponent: { status: OK, note: '' },
  KeyboardComponent: { status: OK, note: '' },
  MouseComponent: { status: OK, note: '在触屏上会转成触摸反应' },
  BrushComponent: { status: OK, note: '' },
  MicrophoneComponent: { status: OK, note: '2021.2 起支持；需 HTTPS + 用户授权' },
  CodeComponent: { status: OK, note: 'Python 代码需有对应的 JS 版本，详见体检项' },
  ResourceManagerComponent: { status: OK, note: '' },
  StaticComponent: { status: NO, note: '官方未支持在线按帧取资源' },
  DotsComponent: { status: PROTOTYPE, note: 'RDK 未进 PsychoJS；官方建议改用预制影片或代码组件变通' },
  ApertureComponent: { status: NO, note: '' },
  NoiseStimComponent: { status: NO, note: '' },
  EnvelopeGratingComponent: { status: NO, note: '' },
  RatingScaleComponent: { status: NO, note: '已在桌面端弃用，在线请改用 Slider' },
  JoystickComponent: { status: NO, note: '手柄不支持' },
  ButtonBoxComponent: { status: NO, note: 'Cedrus / IO Labs 按钮盒不支持' },
  ParallelOutComponent: { status: NO, note: '并口触发不支持（EEG 打标需另想办法）' },
  SerialOutComponent: { status: NO, note: '串口不支持' },
  EyetrackerComponent: { status: NO, note: '硬件眼动不可用；可考虑 WebGazer 等网页方案' },
  CameraComponent: { status: NO, note: '摄像头组件在线不可用' },
  IohubComponent: { status: NO, note: 'ioHub 在线不可用（桌面打包时也需换 Psychtoolbox）' },
  VlcMovieComponent: { status: NO, note: 'VLC 后端在线不可用' },
  UnknownComponent: { status: PROTOTYPE, note: '未知组件类型，需人工确认' }
};

/** 循环类型 */
const LOOPS = {
  TrialHandler: { status: OK, note: '条件文件请用 CSV（XLSX 在线不支持）' },
  StairHandler: { status: PROTOTYPE, note: '在线支持有限，性能敏感请复核' },
  QuestHandler: { status: OK, note: '经 jsQUEST 支持' },
  MultiStairHandler: { status: OK, note: '可在线使用，但官方建议只跑单个 staircase' },
  UnknownLoop: { status: PROTOTYPE, note: '' }
};

/** 条件文件扩展名 → 在线可用性
 *  ⚠️ 2026-09-23 修正（原规则误报）：
 *    我原先写"XLSX 在线不支持，必须转 CSV"——**错了**。实测 psychojs-2026.2.3 的
 *    TrialHandler 源码：
 *        let resourceExtension = resourceName.split(".").pop();
 *        if (["csv","odp","xls","xlsx"].indexOf(resourceExtension) > -1) { …内置 SheetJS 解析… }
 *        else throw "extension: " + resourceExtension + " currently not supported."
 *    官方文档里的"XLSX not supported"指的是**数据输出格式**（保存成 xlsx），
 *    不是条件文件输入。两者被我混为一谈，导致误报。此处按实测修正。
 */
const CONDITION_FILE = {
  '.csv': { ok: true, note: '' },
  '.tsv': { ok: true, note: '按分隔符解析，注意与实际分隔符一致' },
  '.xlsx': { ok: true, note: 'psychojs 2026 内置 SheetJS 可解析（csv/odp/xls/xlsx 四类），无需转换' },
  '.xls': { ok: true, note: '同上，psychojs 2026 可直接解析' },
  '.odp': { ok: true, note: 'psychojs 2026 可解析' },
  '.txt': { ok: true, note: '按 CSV 解析，注意分隔符' }
};

/** 资源解析支持的扩展名（实测自 psychojs-2026.2.3 TrialHandler） */
const SUPPORTED_CONDITION_EXT = ['csv', 'odp', 'xls', 'xlsx'];

/** 数据输出格式 → 在线可用性（这里才是官方"XLSX not supported"的适用范围） */
const DATA_OUTPUT = {
  'Save csv file': { ok: true, note: '' },
  'Save wide csv file': { ok: true, note: '' },
  'Save excel file': { ok: false, note: '官方明确在线不支持 XLSX 输出，需改用 CSV' },
  'Save hdf5 file': { ok: false, note: '在线不支持 HDF5' },
  'Save psydat file': { ok: false, note: '在线不支持 psydat（Python pickle 格式）' },
  'Save log file': { ok: true, note: '在线可输出 log，但体积较大' }
};

/** 代码里出现即"Python 专属、搬不上网"的特征 */
const PYTHON_ONLY_PATTERNS = [
  { re: /\bimport\s+os\b|\bos\.path\b|\bos\.getcwd\b/, why: '文件系统访问（在线无本地文件系统）' },
  { re: /\bopen\s*\(/, why: '读写本地文件' },
  { re: /\bserial\.|\bparallel\.|parallel\.ParallelPort/, why: '串口/并口硬件' },
  { re: /\biohub\b|\bpsychopy\.hardware\b/, why: 'ioHub / 硬件层' },
  { re: /\beyetracker\b|EyeLink|Tobii|GazePoint/, why: '眼动硬件 SDK' },
  { re: /\bsubprocess\b|\bsys\.exit\b/, why: '进程控制' },
  { re: /\bnp\.|\bnumpy\b|\bpandas\b|\bscipy\b/, why: 'Python 科学计算栈（浏览器无对应实现）' },
  { re: /\bwin32\b|\bctypes\b/, why: 'Windows API / 外部库调用' }
];

/** JS 代码块里出现即"会直接报错/语义可疑"的特征 */
const JS_RED_FLAGS = [
  { id: 'es-import', re: /^\s*import\s/m, level: 'error', why: '含 ES import 语句：单文件经典脚本模式下会语法报错（打包器必须改写为内联实现）' },
  { id: 'math-random-random', re: /Math\.random\.random\s*\(/, level: 'error', why: 'PsychoPy 自动翻译缺陷：Math.random 不是对象，调 .random() 会抛 TypeError' },
  { id: 'bare-module', re: /from\s+'(?!\.)[a-z@][^']*'/, level: 'warn', why: '引用了裸模块名（非相对路径）：浏览器里无法解析，需打包器注入实现' },
  { id: 'save-call', re: /psychoJS\.experiment\.save\s*\(/, level: 'info', why: '调用了数据保存：便携包需把服务器上传改道为本地导出（psyweb 已接管）' },
  { id: 'wall-clock', re: /new\s+Date\s*\(\s*\)/, level: 'info', why: '依赖本地时钟：跨设备数据比对时注意' }
];

module.exports = { COMPONENTS, LOOPS, CONDITION_FILE, DATA_OUTPUT, SUPPORTED_CONDITION_EXT, PYTHON_ONLY_PATTERNS, JS_RED_FLAGS, OK, PROTOTYPE, NO };
