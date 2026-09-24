/* 预览区轮播：把**真实产物**放进 iframe 里跑，两页之间滑动切换
 * ---------------------------------------------------------------------------
 * 页 ①「开始页」     : 产物原样加载 -> 被试打开文件看到的第一眼
 * 页 ②「实验第 1 页」 : 同一产物，加载后自动点一下 #psyweb-start -> 实验第一屏
 *
 * 关键实测前提（写代码前已用原型验证，不是假设）：
 *   · file:// 页面里 iframe 可以用 srcdoc 加载产物；
 *   · 无 sandbox 时 iframe 与父页同源，能拿到 contentDocument 并触发按钮 click；
 *   · iframe 内 WebGL 可用（探针报 true）。
 *   blob: URL 那条路当时没验到真实加载，所以**不用它**。
 *
 * 刻意不用 fitPreview 那套 transform 缩放：iframe 按 CSS 撑满即可，
 * 缩放会让画面发虚，且那套机制（1600 字符）已随模拟稿一起删掉。
 */
(function () {
  'use strict';
  var GATE_POLL_MS = 200;      // 轮询「开始」按钮的间隔
  var GATE_MAX_WAIT = 25000;   // 最多等多久（产物要加载 3.6 MB）
  var START_SETTLE = 1400;     // 点击开始后留多久让第一屏渲染出来

  var empty = document.getElementById('previewEmpty');
  var carousel = document.getElementById('previewCarousel');
  var badge = document.getElementById('previewBadge');
  var foot = document.getElementById('previewFoot');
  var title = document.getElementById('pvSlideTitle');
  var index = document.getElementById('pvSlideIndex');
  var dots = document.getElementById('pvDots');
  var prev = document.getElementById('pvPrev');
  var next = document.getElementById('pvNext');
  var frame0 = document.getElementById('pvFrame0');
  var frame1 = document.getElementById('pvFrame1');
  if (!empty || !carousel || !frame0 || !frame1) return;

  var html = null;       // 产物 HTML
  var slide = 0;
  var frame1Ready = false;

  var TITLES = ['被试打开文件后第一眼', '点「▶ 点击开始」之后'];
  var CAPS = ['① 开始页', '② 实验第 1 页'];

  function render() {
    var last = 1;
    prev.disabled = slide === 0;
    next.disabled = slide === last;
    title.textContent = TITLES[slide];
    index.textContent = (slide + 1) + ' / 2';
    var kids = dots.children;
    for (var i = 0; i < kids.length; i++) kids[i].className = i === slide ? 'on' : '';
    frame0.hidden = slide !== 0;
    frame1.hidden = slide !== 1;
    foot.textContent = '预览窗口 · ' + CAPS[slide] + ' · 这里显示的是真实产物在本浏览器里的运行结果';
  }

  function go(n) {
    if (n < 0 || n > 1 || n === slide) return;
    slide = n;
    if (n === 1 && !frame1Ready) {
      frame1Ready = true;
      frame1.srcdoc = html;                       // 懒加载：只有真的切到第 2 页才解析这 3.6 MB
      autoStart(frame1);
    }
    render();
  }

  // 点掉产物的开始页（知情同意那一步），露出实验第一屏。
  // 全屏请求在 iframe 里会被拒绝 —— 产物自己的 .catch 兜住了，不影响后续。
  function autoStart(frame) {
    var t0 = Date.now();
    (function poll() {
      if (Date.now() - t0 > GATE_MAX_WAIT) return;
      var btn = null;
      try {
        var d = frame.contentDocument;
        if (d && d.getElementById('psyweb-start')) btn = d.getElementById('psyweb-start');
      } catch (e) { /* 文档还没就绪 */ }
      if (btn) {
        // ⚠️ 实测风险：产物在开始页会请求全屏。iframe 没加 allow="fullscreen"，
        //    但无头环境下该请求**成功了** —— 预览会抢占用户整屏（探针回报
        //    document.fullscreenElement 非空）。所以点之前先把全屏入口掐掉：
        //    只作用于预览里的这个窗口，绝不碰被试真实打开文件时的那条路径。
        try {
          var w = frame.contentWindow;
          var noFs = function () { return Promise.reject(new Error('psyweb-preview: fullscreen disabled')); };
          if (w && w.Element && w.Element.prototype) {
            w.Element.prototype.requestFullscreen = noFs;
            w.Element.prototype.webkitRequestFullscreen = noFs;
            w.Element.prototype.webkitRequestFullScreen = noFs;
          }
        } catch (e) { /* 拿不到窗口就算了，下面照点 */ }
        // 预览里跑的是**真产物**，而产物会往 localStorage 写自动存盘
        // （psyweb.autosave.v1）。iframe 与工具页同源 -> 预览会把实验数据
        // 写进工具站的存储里，并让下一次预览弹出"恢复上次数据"的提示。
        // 预览不该产生任何持久化副作用：这里先清掉旧键，再把该键的写入掐掉。
        // （只作用于预览窗口，不影响被试真实打开文件时的自动存盘。）
        try {
          var lw = frame.contentWindow;
          if (lw && lw.Storage && lw.Storage.prototype) {
            var origSet = lw.Storage.prototype.setItem;
            lw.Storage.prototype.setItem = function (k, v) {
              if (k === 'psyweb.autosave.v1') return undefined;
              return origSet.call(this, k, v);
            };
            try { lw.localStorage.removeItem('psyweb.autosave.v1'); } catch (e2) {}
          }
        } catch (e) { /* 拿不到窗口就算了 */ }
        try { btn.click(); } catch (e) { /* ignore */ }
        setTimeout(function () {
          try {
            var d2 = frame.contentDocument;
            if (d2) d2.title = '实验第 1 页';       // 便于自动化探针确认"真的进去了"
          } catch (e) { /* ignore */ }
        }, START_SETTLE);
        return;
      }
      window.setTimeout(poll, GATE_POLL_MS);
    })();
  }

  prev.addEventListener('click', function () { go(slide - 1); });
  next.addEventListener('click', function () { go(slide + 1); });
  Array.prototype.forEach.call(dots.children, function (dot, i) {
    dot.style.cursor = 'pointer';
    dot.addEventListener('click', function () { go(i); });
  });

  // 打包完成 -> 拿到真产物 -> 切到预览
  document.addEventListener('psyweb:packed', function (ev) {
    var detail = ev && ev.detail;
    if (!detail || typeof detail.html !== 'string' || !detail.html) return;
    html = detail.html;
    empty.hidden = true;
    carousel.hidden = false;
    badge.textContent = '实时预览';
    frame0.srcdoc = html;                          // 第 1 页立即出
    slide = 0;
    frame1Ready = false;
    frame1.removeAttribute('srcdoc');
    render();
  });
})();
