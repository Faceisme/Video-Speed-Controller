/* 视频倍速控制 — content script
 * 在每一个 frame(包括跨域 iframe)中运行。
 * - 发现页面里所有 <video>/<audio>(含动态插入、shadow DOM)
 * - 快捷键调整 playbackRate
 * - "强制保持":站点把速度改回 1.0 时自动复位到目标速度
 * - 顶层 frame 的按键会通过 postMessage 中继到所有子 iframe
 */
(() => {
  "use strict";

  // 避免在同一 window 重复注入
  if (window.__vscInjected) return;
  window.__vscInjected = true;

  const DEFAULTS = {
    enabled: true,
    step: 2,           // 加/减速步长
    fastSpeed: 4,      // 一键倍速的目标速度
    seekStep: 5,       // 快进/快退秒数
    minSpeed: 0.1,
    maxSpeed: 16,
    rememberSpeed: false, // 记住上次速度并自动套用到新视频
    showIndicator: true,
    autoMute: true,                  // 命中下面的域名时自动静音
    autoMuteHosts: ["115vod.com"],   // 需要自动静音的域名(支持子域)
    keys: {
      faster: "KeyD",
      slower: "KeyS",
      reset: "KeyZ",
      toggleFast: "KeyA",
      rewind: "KeyR",
      forward: "KeyX",
      display: "KeyV"
    }
  };

  let settings = Object.assign({}, DEFAULTS);
  let targetRate = 1.0;          // 当前希望保持的速度
  let pinIndicator = false;      // 是否常驻显示速度

  const media = new Set();       // 本 frame 内已发现的媒体元素
  const forced = new WeakSet();  // 已挂上"强制保持"监听的元素
  const muteHooked = new WeakSet(); // 已挂上"自动静音"监听的元素
  const mutedByUs = new WeakSet();  // 由本扩展静音的元素(便于取消时还原)
  let autoMuteActive = false;    // 本 frame 是否命中自动静音域名

  /* ------------------------- 工具 ------------------------- */
  const clamp = (v) => Math.min(settings.maxSpeed, Math.max(settings.minSpeed, v));
  const round2 = (v) => Math.round(v * 100) / 100;

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  /* ------------------------- 自动静音 -------------------------
   * 命中配置域名的页面里所有视频自动静音并强制保持。
   * 视频常嵌在跨域 iframe 里,所以除本 frame 域名外,
   * 还会用 location.ancestorOrigins 检查祖先 frame 的域名。
   */
  function hostMatches(host, pattern) {
    if (!host || !pattern) return false;
    host = String(host).toLowerCase();
    pattern = String(pattern).trim().toLowerCase().replace(/^\*\./, "");
    if (!pattern) return false;
    return host === pattern || host.endsWith("." + pattern);
  }

  function autoMuteShouldApply() {
    if (!settings.autoMute) return false;
    const list = settings.autoMuteHosts || [];
    if (!list.length) return false;
    const hosts = [];
    try { if (location.hostname) hosts.push(location.hostname); } catch (_) {}
    try {
      const ao = location.ancestorOrigins;
      if (ao) for (let i = 0; i < ao.length; i++) {
        try { hosts.push(new URL(ao[i]).hostname); } catch (_) {}
      }
    } catch (_) {}
    return hosts.some((h) => list.some((p) => hostMatches(h, p)));
  }

  function muteEl(el) {
    try {
      if (!el.muted) el.muted = true;
      mutedByUs.add(el);
    } catch (_) {}
  }

  function refreshAutoMute() {
    const want = autoMuteShouldApply();
    if (want) {
      autoMuteActive = true;
      media.forEach(muteEl);
    } else if (autoMuteActive) {
      // 取消自动静音:仅还原由本扩展静音过的元素
      autoMuteActive = false;
      media.forEach((el) => {
        if (mutedByUs.has(el)) {
          try { el.muted = false; } catch (_) {}
          mutedByUs.delete(el);
        }
      });
    }
  }

  /* ------------------------- 设置加载 -------------------------
   * 配置项(vsc_settings)走 chrome.storage.sync 跨设备同步;
   * 易变的"上次速度"(vsc_lastSpeed)走 local,避免触发 sync 写入配额。
   */
  function applyLoaded(data) {
    if (data) {
      settings = Object.assign({}, DEFAULTS, data);
      settings.keys = Object.assign({}, DEFAULTS.keys, data.keys || {});
    }
    refreshAutoMute();
    maybeApplyRemembered();
  }

  function loadSettings() {
    try {
      chrome.storage?.sync.get("vsc_settings", (res) => {
        const data = res && res.vsc_settings;
        if (data) { applyLoaded(data); return; }
        // sync 无数据 → 回退本地(旧版本或同步降级写入)
        chrome.storage?.local.get("vsc_settings", (r2) => applyLoaded(r2 && r2.vsc_settings));
      });
    } catch (_) { maybeApplyRemembered(); }
  }

  function maybeApplyRemembered() {
    if (!settings.rememberSpeed) return;
    try {
      chrome.storage?.local.get("vsc_lastSpeed", (res) => {
        const s = res && res.vsc_lastSpeed;
        if (s && s !== 1.0) {
          targetRate = clamp(s);
          applyLocal(targetRate, false);
        }
      });
    } catch (_) {}
  }

  try {
    chrome.storage?.onChanged.addListener((changes, area) => {
      if ((area === "sync" || area === "local") && changes.vsc_settings) {
        const v = changes.vsc_settings.newValue || {};
        settings = Object.assign({}, DEFAULTS, v);
        settings.keys = Object.assign({}, DEFAULTS.keys, v.keys || {});
        refreshAutoMute();
      }
    });
  } catch (_) {}

  let lastSpeedTimer = 0;
  function persistLastSpeed(rate) {
    if (!settings.rememberSpeed) return;
    if (lastSpeedTimer) clearTimeout(lastSpeedTimer);
    lastSpeedTimer = setTimeout(() => {
      try { chrome.storage?.local.set({ vsc_lastSpeed: rate }); } catch (_) {}
    }, 400);
  }

  /* ------------------------- 媒体发现 ------------------------- */
  function register(el) {
    if (!el || media.has(el)) return;
    if (el.tagName !== "VIDEO" && el.tagName !== "AUDIO") return;
    media.add(el);

    // 套用当前目标速度
    if (targetRate !== 1.0) {
      try { el.playbackRate = targetRate; } catch (_) {}
    }

    // 强制保持:站点把速度改回去时复位
    if (!forced.has(el)) {
      forced.add(el);
      el.addEventListener("ratechange", () => {
        if (targetRate !== 1.0 && Math.abs(el.playbackRate - targetRate) > 0.01) {
          try { el.playbackRate = targetRate; } catch (_) {}
        }
      });
    }

    // 自动静音:命中域名时静音,并在被取消静音/播放时强制复位
    if (!muteHooked.has(el)) {
      muteHooked.add(el);
      const enforceMute = () => { if (autoMuteActive && !el.muted) muteEl(el); };
      el.addEventListener("volumechange", enforceMute);
      el.addEventListener("play", enforceMute, true);
    }
    if (autoMuteActive) muteEl(el);
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    let list;
    try { list = root.querySelectorAll("video, audio"); } catch (_) { return; }
    list.forEach(register);
    // 遍历 shadow DOM
    let all;
    try { all = root.querySelectorAll("*"); } catch (_) { return; }
    for (const el of all) {
      if (el.shadowRoot) scan(el.shadowRoot);
    }
  }

  // 捕获 play/loadeddata:动态创建的媒体一旦活动就能抓到(最可靠)
  ["play", "loadeddata", "canplay", "loadedmetadata"].forEach((evt) => {
    document.addEventListener(evt, (e) => {
      const t = e.target;
      if (t && (t.tagName === "VIDEO" || t.tagName === "AUDIO")) register(t);
    }, true);
  });

  // MutationObserver 捕获插入到 DOM 的媒体
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "VIDEO" || node.tagName === "AUDIO") register(node);
        else if (node.querySelectorAll) scan(node);
      }
    }
  });
  function startObserver() {
    if (document.documentElement) {
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  /* ------------------------- 速度 / 跳转 ------------------------- */
  function applyLocal(rate, showUI = true) {
    targetRate = clamp(round2(rate));
    media.forEach((m) => { try { m.playbackRate = targetRate; } catch (_) {} });
    if (showUI) showIndicator();
    persistLastSpeed(targetRate);
  }

  function seekLocal(delta) {
    media.forEach((m) => {
      if (m.tagName !== "VIDEO" && m.tagName !== "AUDIO") return;
      try {
        if (isFinite(m.duration)) {
          m.currentTime = Math.min(m.duration, Math.max(0, m.currentTime + delta));
        } else {
          m.currentTime = Math.max(0, m.currentTime + delta);
        }
      } catch (_) {}
    });
    showIndicator(delta > 0 ? `⏩ +${delta}s` : `⏪ ${delta}s`);
  }

  /* ------------------------- iframe 中继 ------------------------- */
  function broadcast(payload) {
    const frames = document.querySelectorAll("iframe");
    frames.forEach((f) => {
      try { f.contentWindow.postMessage(Object.assign({ __vsc: true }, payload), "*"); } catch (_) {}
    });
  }

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.__vsc !== true) return;
    if (d.action === "rate") {
      applyLocal(d.value);
      broadcast(d); // 继续往更深的子 frame 传
    } else if (d.action === "seek") {
      seekLocal(d.value);
      broadcast(d);
    }
  });

  function changeRate(rate) {
    applyLocal(rate);
    broadcast({ action: "rate", value: targetRate });
  }
  function seek(delta) {
    seekLocal(delta);
    broadcast({ action: "seek", value: delta });
  }

  /* ------------------------- 键盘 ------------------------- */
  function onKeydown(e) {
    if (!settings.enabled) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;

    const k = settings.keys;
    let handled = true;
    switch (e.code) {
      case k.faster: changeRate(targetRate + settings.step); break;
      case k.slower: changeRate(targetRate - settings.step); break;
      case k.reset: changeRate(1.0); break;
      case k.toggleFast:
        changeRate(Math.abs(targetRate - 1.0) < 0.01 ? settings.fastSpeed : 1.0);
        break;
      case k.rewind: seek(-settings.seekStep); break;
      case k.forward: seek(settings.seekStep); break;
      case k.display:
        pinIndicator = !pinIndicator;
        showIndicator();
        break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
  window.addEventListener("keydown", onKeydown, true);

  /* ------------------------- popup 消息(设置/读取速度) ------------------------- */
  try {
    chrome.runtime?.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.__vscCmd) return;
      if (msg.type === "setRate") {
        changeRate(msg.value);
        sendResponse({ ok: true, rate: targetRate });
      } else if (msg.type === "getRate") {
        // 只有含媒体的 frame 才回应,避免空 frame 抢答
        if (media.size > 0) {
          let r = 1.0;
          media.forEach((m) => { if (m.playbackRate) r = m.playbackRate; });
          sendResponse({ rate: round2(r), hasMedia: true });
        } else {
          sendResponse({ hasMedia: false });
        }
      } else if (msg.type === "seek") {
        seek(msg.value);
        sendResponse({ ok: true });
      }
      return true;
    });
  } catch (_) {}

  /* ------------------------- 速度提示 UI ------------------------- */
  let indicatorEl = null;
  let hideTimer = null;
  let pinRAF = 0;

  // 选出"最该贴提示"的视频:优先正在播放的、其次面积最大且在视口内的
  function pickActiveVideo() {
    let best = null, bestScore = -1;
    media.forEach((v) => {
      if (v.tagName !== "VIDEO") return;
      let rect;
      try { rect = v.getBoundingClientRect(); } catch (_) { return; }
      if (rect.width < 2 || rect.height < 2) return;
      const vw = window.innerWidth, vh = window.innerHeight;
      const inView = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
      let score = rect.width * rect.height;
      if (!v.paused) score += 1e12;
      if (inView) score += 1e9;
      if (score > bestScore) { bestScore = score; best = { v, rect }; }
    });
    return best;
  }

  function ensureIndicator(host) {
    if (!indicatorEl) {
      indicatorEl = document.createElement("div");
      indicatorEl.className = "__vsc-indicator";
    }
    host = host || document.body || document.documentElement;
    if (host && indicatorEl.parentNode !== host) host.appendChild(indicatorEl);
    return indicatorEl;
  }

  // 把提示定位到活动视频的左上角(随视频位置走)
  function positionIndicator() {
    const fsRaw = document.fullscreenElement || document.webkitFullscreenElement;
    // 全屏元素若是容器,就把提示挂进去(否则会被全屏层遮住);若直接全屏 <video> 则无法叠加
    const fsHost = fsRaw && fsRaw.tagName !== "VIDEO" && fsRaw.tagName !== "AUDIO" ? fsRaw : null;
    const target = pickActiveVideo();
    if (target) {
      ensureIndicator(fsHost || document.body || document.documentElement);
      const r = target.rect;
      indicatorEl.style.left = (Math.max(0, r.left) + 10) + "px";
      indicatorEl.style.top = (Math.max(0, r.top) + 10) + "px";
    } else {
      // 没有可定位的视频(纯音频等):回退到页面左上角
      ensureIndicator(document.body || document.documentElement);
      indicatorEl.style.left = "14px";
      indicatorEl.style.top = "14px";
    }
  }

  function showIndicator(text) {
    if (!settings.showIndicator) return;
    if (media.size === 0 && !pinIndicator) return; // 没媒体的 frame 不闪
    positionIndicator();
    if (!indicatorEl) return;
    indicatorEl.textContent = text || `${round2(targetRate)}x`;
    indicatorEl.classList.add("__vsc-show");
    if (hideTimer) clearTimeout(hideTimer);
    if (pinIndicator) {
      startPinTracking();
    } else {
      stopPinTracking();
      hideTimer = setTimeout(() => indicatorEl.classList.remove("__vsc-show"), 1400);
    }
  }

  // 常驻模式下持续跟随视频位置(滚动/全屏切换/布局变化)
  function startPinTracking() {
    if (pinRAF) return;
    const loop = () => {
      if (!pinIndicator) { pinRAF = 0; return; }
      positionIndicator();
      pinRAF = requestAnimationFrame(loop);
    };
    pinRAF = requestAnimationFrame(loop);
  }
  function stopPinTracking() {
    if (pinRAF) { cancelAnimationFrame(pinRAF); pinRAF = 0; }
  }

  document.addEventListener("fullscreenchange", () => { if (indicatorEl) positionIndicator(); });
  document.addEventListener("webkitfullscreenchange", () => { if (indicatorEl) positionIndicator(); });

  /* ------------------------- 启动 ------------------------- */
  refreshAutoMute(); // 先用默认配置判定,缩短"有声"窗口;storage 读完后再校正
  loadSettings();
  startObserver();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => scan(document), { once: true });
  }
  scan(document);
  // 兜底:延迟再扫一次,catch 晚加载的播放器
  setTimeout(() => scan(document), 1500);
})();
