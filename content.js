/* 视频倍速控制 — content script
 * 在每一个 frame(包括跨域 iframe)中运行。
 * - 发现页面里所有 <video>/<audio>(含动态插入、shadow DOM)
 * - 快捷键调整 playbackRate
 * - "强制保持":站点把速度改回 1.0 时自动复位到目标速度
 * - 按键在整棵 frame 树内路由(先上送顶层,再由顶层广播到所有子 frame)
 * - 修复 Chrome 原生控件的"键盘黑洞"(点过进度条后快捷键彻底失灵)
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
    clickToggle: true,    // 单击视频画面播放/暂停
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

  const RESET_GUARD_MS = 10000;  // 显式复位到 1.0 之后,强制保持 1.0 的时长

  let settings = Object.assign({}, DEFAULTS);
  let targetRate = 1.0;          // 当前希望保持的速度
  let resetGuardUntil = 0;       // 用户显式按了"复位"之后的强制窗口(见 enforce)
  let userTouched = false;       // 本 frame 里用户是否已经显式调过速度
  let pinIndicator = false;      // 是否常驻显示速度

  const media = new Set();       // 本 frame 内已发现的媒体元素
  const forced = new WeakSet();  // 已挂上"强制保持"监听的元素
  const muteHooked = new WeakSet(); // 已挂上"自动静音"监听的元素
  const mutedByUs = new WeakSet();  // 由本扩展静音的元素(便于取消时还原)
  let autoMuteActive = false;    // 本 frame 是否命中自动静音域名

  /* ------------------------- 工具 ------------------------- */
  const clamp = (v) => Math.min(settings.maxSpeed, Math.max(settings.minSpeed, v));
  const round2 = (v) => Math.round(v * 100) / 100;
  const isMedia = (el) => !!el && (el.tagName === "VIDEO" || el.tagName === "AUDIO");

  /* 同时写 playbackRate 和 defaultPlaybackRate。
   * 站点换 src / 调 load() 时会走"媒体加载算法",把 playbackRate 静默重置成
   * defaultPlaybackRate 且不触发 ratechange —— 只改 playbackRate 会被无声吃掉
   * (DMM 预览视频就是这种:点播放才赋 src,速度提示显示了但实际按 1x 播)。
   * 带阈值判断,避免自己触发的 ratechange 造成回环。 */
  function setRate(el, rate) {
    try {
      if (Math.abs(el.defaultPlaybackRate - rate) > 0.005) el.defaultPlaybackRate = rate;
      if (Math.abs(el.playbackRate - rate) > 0.005) el.playbackRate = rate;
    } catch (_) {}
  }

  /* 给"用户已经亲手调过速度"的媒体打个标记(属性写在共享 DOM 上,页面里的
   * 油猴脚本也读得到)。同一个页面上常常还有别的脚本在自动变速,看到这个标记
   * 就该让位 —— 手动优先。 */
  function markUserControlled(el, rate) {
    const v = String(rate);
    // 值没变就别重写:看门狗每秒跑 4 次,每次 setAttribute 都会产生一条 mutation 记录,
    // 站点自己的 MutationObserver 会被这个噪音打爆。
    try { if (el.getAttribute("data-vsc-user") !== v) el.setAttribute("data-vsc-user", v); } catch (_) {}
  }

  // 对单个元素重新施加当前的速度/静音状态。
  // 目标是 1.0 时平时不主动写入,免得跟站点自带的倍速菜单打架;
  // 但用户刚刚显式按过"复位"的十秒内要强制,否则站点/其它脚本会立刻把它顶回去。
  function enforce(el) {
    if (targetRate !== 1.0) setRate(el, targetRate);
    else if (Date.now() < resetGuardUntil) setRate(el, 1.0);
    if (userTouched) markUserControlled(el, targetRate);
    if (autoMuteActive) muteEl(el);
  }

  /* 输入框判定:只有真正能打字的地方才让路。
   * 原来把所有 <input> 都算成"正在打字",于是播放器用 <input type="range"> 做的
   * 进度条/音量条一旦拿到焦点,快捷键就全废了 —— 那不是打字,是播放器控件。 */
  const TEXT_INPUT_EXCLUDE = new Set([
    "button", "checkbox", "radio", "range", "submit", "reset", "file", "color", "image"
  ]);
  function isTypingTarget(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      let t = "text";
      try { t = String(el.type || "text").toLowerCase(); } catch (_) {}
      return !TEXT_INPUT_EXCLUDE.has(t);
    }
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
    syncWatchdog();
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
        if (s && s !== 1.0) applyLocal(clamp(s), false, false);
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
    if (!isMedia(el)) return;
    // 已登记过的元素也要重新施加一次:play/canplay 等事件正是站点刚换完 src 的时机
    if (media.has(el)) { enforce(el); return; }
    media.add(el);
    startFocusFix();   // 本 frame 有媒体了,开"焦点黑洞"轮询(见下面那段注释)

    // 套用当前目标速度
    enforce(el);

    // 强制保持:站点把速度改回去时复位
    if (!forced.has(el)) {
      forced.add(el);
      el.addEventListener("ratechange", () => {
        if (targetRate !== 1.0 && Math.abs(el.playbackRate - targetRate) > 0.01) {
          setRate(el, targetRate);
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
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    let list;
    try { list = root.querySelectorAll("video, audio"); } catch (_) { return; }
    list.forEach(register);
    // 遍历 shadow DOM。媒体事件不是 composed 的,跨不出 shadow 边界,
    // 所以这里除了扫描还要给每个 shadow root 单独挂 MutationObserver。
    let all;
    try { all = root.querySelectorAll("*"); } catch (_) { return; }
    for (const el of all) {
      if (el.shadowRoot) { observeRoot(el.shadowRoot); scan(el.shadowRoot); }
    }
  }

  // 已经从 DOM 上摘掉的元素别再留在集合里(SPA 站点会反复重建播放器)
  function pruneMedia() {
    media.forEach((el) => { if (!el.isConnected) media.delete(el); });
  }

  function rescan() { pruneMedia(); scan(document); }

  /* 捕获媒体生命周期事件:动态创建的媒体一旦活动就能抓到(最可靠)。
   * loadstart/loadedmetadata 尤其关键 —— 站点换 src 时 playbackRate 已被
   * 静默清成 1.0,必须在这些时机重新写回去。 */
  [
    "loadstart", "loadedmetadata", "loadeddata", "canplay",
    "play", "playing", "seeked", "durationchange", "ratechange"
  ].forEach((evt) => {
    document.addEventListener(evt, (e) => {
      if (isMedia(e.target)) register(e.target);
    }, true);
  });

  // MutationObserver 捕获插入到 DOM 的媒体
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (isMedia(node)) register(node);
        else if (node.querySelectorAll) scan(node);
      }
    }
  });
  const observedRoots = new WeakSet();
  function observeRoot(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);
    try { mo.observe(root, { childList: true, subtree: true }); } catch (_) {}
  }
  function startObserver() {
    if (document.documentElement) observeRoot(document.documentElement);
  }

  /* 兜底轮询:有些播放器既不发 ratechange 也不发可捕获的事件就把速度清掉
   * (换 src、切清晰度、重建 <video>)。仅在需要保持非 1x、自动静音、
   * 或处于"复位强制窗口"时运行。 */
  let watchdogTimer = 0;
  function watchdogNeeded() {
    return targetRate !== 1.0 || autoMuteActive || Date.now() < resetGuardUntil;
  }
  function watchdogTick() {
    if (!watchdogNeeded()) { syncWatchdog(); return; }
    media.forEach((el) => {
      if (!el.isConnected) { media.delete(el); return; } // 已卸载,重新插入时会被再次登记
      enforce(el);
    });
  }
  function syncWatchdog() {
    if (watchdogNeeded()) {
      if (!watchdogTimer) watchdogTimer = setInterval(watchdogTick, 250);
    } else if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = 0;
    }
  }

  /* ------------------- 原生控件的"键盘黑洞" -------------------
   * Chrome 自带的 <video controls> 控件条整个活在 UA shadow DOM 里。
   * 焦点一旦落进去(点进度条、播放键、音量、全屏按钮),这条控件会把键盘和
   * 鼠标事件全吞在内部:页面上连 window 捕获阶段都收不到任何 keydown ——
   * 表现就是"在播放的视频上点了一下进度条,倍速快捷键就再也不管用了"。
   * 页面唯一能收到的信号,是焦点第一次进入时那一个 focusin(target 被重定向
   * 成 <video> 本身);之后在控件里怎么点都没有任何事件送出来。
   *
   * 办法:只要某个媒体元素是 document.activeElement,就定期把焦点重新
   * focus() 到宿主元素上。焦点从 UA shadow DOM 内部回到 <video>,键盘事件
   * 立刻恢复,而 <video> 依然是焦点元素 —— 空格/方向键这些原生快捷键也还在。
   * 焦点没有真正变化时 focus() 不派发任何事件,所以不会和站点的焦点管理打架。
   *
   * 注意这里必须是轮询,不能只靠 focusin 触发一次:焦点从 <video> 本身移进
   * 控件条内部时,页面看到的 activeElement 前后都是同一个 <video>,连
   * focusin 都不会再发一次。也就是"先点画面再点进度条"这条最常见的路径,
   * 恰恰是一个事件都收不到的。所以本 frame 一旦发现过媒体元素就把这个
   * 轮询开起来(每 frame 一个 120ms 定时器,只读一次 activeElement)。
   */
  let focusFixTimer = 0;
  function reclaimFocus() {
    const el = document.activeElement;
    if (!isMedia(el)) return;
    try { el.focus({ preventScroll: true }); } catch (_) {}
  }
  function startFocusFix() {
    if (focusFixTimer) return;
    focusFixTimer = setInterval(reclaimFocus, 120);
  }
  document.addEventListener("focusin", (e) => {
    if (isMedia(e.target)) { reclaimFocus(); startFocusFix(); }
  }, true);
  // 后台标签页里定时器会被浏览器压到 1 秒甚至更慢,切回来时立刻补一次,别让用户干等
  document.addEventListener("visibilitychange", () => { if (!document.hidden) reclaimFocus(); });

  /* ------------------------- 活动视频 ------------------------- */
  // 记住鼠标位置:优先把"鼠标底下"的那个视频当成当前视频
  let mouseX = -1, mouseY = -1;
  window.addEventListener("mousemove", (e) => {
    mouseX = e.clientX; mouseY = e.clientY;
  }, { capture: true, passive: true });

  function fullscreenEl() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  // 选出本 frame 里"最该被当成当前视频"的那个:
  // 全屏的 > 鼠标底下的 > 正在播的 > 在视口内的 > 面积大的
  function pickActiveVideo() {
    const fs = fullscreenEl();
    let best = null, bestScore = -1;
    media.forEach((v) => {
      if (v.tagName !== "VIDEO") return;
      let rect;
      try { rect = v.getBoundingClientRect(); } catch (_) { return; }
      if (rect.width < 2 || rect.height < 2) return;
      const vw = window.innerWidth, vh = window.innerHeight;
      const inView = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
      const underMouse = mouseX >= 0 &&
        mouseX >= rect.left && mouseX <= rect.right &&
        mouseY >= rect.top && mouseY <= rect.bottom;
      let score = rect.width * rect.height;
      if (fs && (v === fs || fs.contains(v))) score += 1e15;
      if (underMouse) score += 1e13;
      if (!v.paused) score += 1e12;
      if (inView) score += 1e9;
      if (score > bestScore) { bestScore = score; best = { v, rect }; }
    });
    return best;
  }

  /* ------------------------- 速度 / 跳转 ------------------------- */
  // explicit=true 表示这是用户主动下的指令(键盘/popup),而不是"记住上次速度"之类的自动套用
  function applyLocal(rate, showUI = true, explicit = true) {
    targetRate = clamp(round2(rate));
    if (explicit) userTouched = true;
    if (explicit && targetRate === 1.0) resetGuardUntil = Date.now() + RESET_GUARD_MS;
    else if (targetRate !== 1.0) resetGuardUntil = 0;
    // 用户显式操作,即使目标是 1.0 也直接写(顺带把 defaultPlaybackRate 复位)
    media.forEach((m) => {
      setRate(m, targetRate);
      if (userTouched) markUserControlled(m, targetRate);
    });
    syncWatchdog();
    if (showUI) showIndicator();
    persistLastSpeed(targetRate);
  }

  /* 只跳转"当前这个"视频。
   * 原来是本 frame 里所有媒体一起跳 —— 页面上那些悬停预览、广告小视频
   * 会被一起拖动;而且顶层广播下来时子 frame 还会再跳一次,等于跳了两步。 */
  function seekLocal(delta) {
    const targets = [];
    const best = pickActiveVideo();      // 全屏的 > 鼠标底下的 > 正在播的 > 视口里最大的
    if (best && !best.v.paused) targets.push(best.v);
    else media.forEach((m) => { if (!m.paused && m.isConnected) targets.push(m); });
    if (!targets.length && best) targets.push(best.v);   // 全都暂停着:跳当前这一个
    if (!targets.length) return;
    targets.forEach((m) => {
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

  function setPinLocal(on) {
    pinIndicator = !!on;
    if (pinIndicator) showIndicator();
    else hideIndicator();
  }

  /* ------------------------- frame 路由 -------------------------
   * 键盘事件只会送到"当前有焦点"的那个 frame。原来只往子 frame 广播,
   * 所以焦点在别的 iframe(广告位、评论框、播放器外壳)里时按键就全丢了 ——
   * 这也是"鼠标明明指着视频却控制不了"的一大来源。
   * 现在:本 frame 先立刻响应,然后把指令上送到顶层,由顶层再向整棵 frame 树
   * 广播下去。每条指令带唯一 id,收到重复 id 只转发不重复执行(否则快进会跳两步)。
   */
  const FRAME_TAG = Math.random().toString(36).slice(2);
  let msgSeq = 0;
  const seenMsgs = new Set();
  function newMsgId() { return FRAME_TAG + ":" + (++msgSeq); }
  function markSeen(id) {
    if (!id) return false;
    if (seenMsgs.has(id)) return true;
    seenMsgs.add(id);
    if (seenMsgs.size > 400) {
      const it = seenMsgs.values();
      for (let i = 0; i < 200; i++) seenMsgs.delete(it.next().value);
    }
    return false;
  }

  function runCommand(d) {
    if (d.action === "rate") applyLocal(d.value);
    else if (d.action === "seek") seekLocal(d.value);
    else if (d.action === "pin") setPinLocal(d.value);
  }

  // 直接遍历子浏览上下文,而不是 querySelectorAll("iframe"):
  // 后者漏掉 shadow DOM 里的 iframe 和 <frame>
  function sendDown(d) {
    const msg = Object.assign({}, d, { __vsc: true, dir: "down" });
    for (let i = 0; i < window.length; i++) {
      try { window[i].postMessage(msg, "*"); } catch (_) {}
    }
  }
  function sendUp(d) {
    if (window.top === window) { sendDown(d); return; }
    try { window.parent.postMessage(Object.assign({}, d, { __vsc: true, dir: "up" }), "*"); }
    catch (_) {}
  }

  function dispatch(action, value) {
    const d = { action, value, id: newMsgId() };
    markSeen(d.id);
    runCommand(d);                              // 本 frame 立刻响应,不等消息绕一圈
    if (window.top !== window) sendDown(d);     // 先覆盖自己的子树(万一顶层注入不进去时的兜底)
    sendUp(d);                                  // 再上送顶层;本身就是顶层时 sendUp 内部即广播
  }

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.__vsc !== true) return;
    if (d.dir === "up") {
      if (window.top === window) {
        if (!markSeen(d.id)) runCommand(d);
        sendDown(d);
      } else {
        sendUp(d);
      }
    } else {
      if (!markSeen(d.id)) runCommand(d);
      sendDown(d);
    }
  });

  /* ------------------------- 键盘 ------------------------- */
  function keyTarget(e) {
    // shadow DOM 里的事件到了外层会被重定向成宿主元素,composedPath()[0] 才是真正的落点
    let deep = null;
    try { const p = e.composedPath && e.composedPath(); if (p && p.length) deep = p[0]; } catch (_) {}
    return deep || e.target;
  }

  function onKeydown(e) {
    if (!settings.enabled) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.isComposing || e.keyCode === 229) return;   // 输入法组字中
    if (isTypingTarget(keyTarget(e)) || isTypingTarget(document.activeElement)) return;

    const k = settings.keys;
    let handled = true;
    switch (e.code) {
      case k.faster: dispatch("rate", clamp(round2(targetRate + settings.step))); break;
      case k.slower: dispatch("rate", clamp(round2(targetRate - settings.step))); break;
      case k.reset: dispatch("rate", 1.0); break;
      case k.toggleFast:
        dispatch("rate", Math.abs(targetRate - 1.0) < 0.01 ? settings.fastSpeed : 1.0);
        break;
      case k.rewind: dispatch("seek", -settings.seekStep); break;
      case k.forward: dispatch("seek", settings.seekStep); break;
      case k.display: dispatch("pin", !pinIndicator); break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
  window.addEventListener("keydown", onKeydown, true);

  /* ------------------------- 点击画面播放/暂停 -------------------------
   * 很多自定义播放器点画面没反应,非得去点那个小小的播放键。这里补上:单击画面切换播放/暂停。
   * 难点是别跟站点自己的"点击切换"打架(一次点击被切两次 = 看起来没反应):
   *   · pointerdown 时先记下视频当时的 paused;
   *   · click 之后稍等一下(给站点的同步处理器、微任务、rAF 里的切换留出时间),
   *     状态已经变了 → 站点自己处理了,什么都不做;没变 → 由我们来切。
   *   · 有的播放器为了区分双击,单击要延迟 200~300ms 才切。这时我们先切了、站点随后又
   *     切回去 —— 看到"没有新的输入却被翻了回去",就再切一次把这次点击的本意补回来,
   *     并记住本 frame 的站点会自己处理,之后不再插手。
   * 只认画面本身,或者盖在画面上的大面积遮罩层;点到按钮、链接、进度条、菜单这些控件不管。
   * 带原生 controls 的 <video> 也要接手:Chrome 只有在视频已经加载出数据后才会自己"点画面切换",
   * preload="none" 还没加载的(DMM 系的样片站就是这样)点画面毫无反应。Chrome 自己切了的话,
   * 上面那条"状态已经变了就不管"会让路。原生控件条上的点击(进度条、静音、⋮)实测页面根本
   * 收不到 click;底部那一溜仍按位置排除兜底(比如播放中控件条自动隐藏时点下去)。
   */
  const CLICK_DECIDE_MS = 60;    // click 之后等这么久再看站点有没有自己切
  const CLICK_WATCH_MS = 600;    // 我们切完之后这段时间里被翻回去 = 站点也在切(延迟单击)
  const CLICK_MAX_MS = 600;      // 按下到松开超过这么久算长按,不算单击
  const CLICK_SLOP_PX = 6;       // 按下到松开移动超过这么多算拖动
  const NATIVE_BAR_PX = 80;      // 原生控件条(按钮行 + 进度条)的高度,Chrome 实测约 72px,略放宽
  const CONTROL_SEL = [
    "button", "input", "select", "textarea", "label", "summary",
    "[contenteditable]:not([contenteditable='false'])",
    "[role='button']", "[role='link']", "[role='slider']", "[role='scrollbar']",
    "[role='progressbar']", "[role='menu']", "[role='menuitem']", "[role='menuitemradio']",
    "[role='menuitemcheckbox']", "[role='checkbox']", "[role='radio']", "[role='switch']",
    "[role='tab']", "[role='option']", "[role='listbox']", "[role='combobox']", "[role='textbox']"
  ].join(",");

  let siteTogglesOnClick = false; // 本 frame 的站点已被证实会自己处理点击切换
  let pendingPress = null;        // 最近一次落在视频上的 pointerdown:{ v, paused, x, y, t }
  let decideTimer = 0;            // 还没到点的那次判定
  let lastInputAt = 0;           // 最近一次用户输入,用来区分"站点翻回去"和"用户自己又操作了"

  // 点下去的位置对应哪个视频:事件路径里有 <video> 就是它,否则按坐标找(多个重叠取面积最小的)
  function videoAtPoint(e) {
    let path = [];
    try { path = e.composedPath(); } catch (_) {}
    for (const n of path) {
      if (n && n.tagName === "VIDEO") { if (!media.has(n)) register(n); return n; }
    }
    let best = null, bestArea = Infinity;
    media.forEach((v) => {
      if (v.tagName !== "VIDEO") return;
      let r;
      try { r = v.getBoundingClientRect(); } catch (_) { return; }
      if (r.width < 2 || r.height < 2) return;
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      const area = r.width * r.height;
      if (area < bestArea) { bestArea = area; best = v; }
    });
    return best;
  }

  // 点在原生控件条那一溜上了吗
  function onNativeBar(e, v) {
    try { return e.clientY > v.getBoundingClientRect().bottom - NATIVE_BAR_PX; } catch (_) { return true; }
  }

  // 这次点击算不算"点在画面上"
  function clickOnPicture(e, v) {
    if (v.controls && onNativeBar(e, v)) return false;
    if (v.loop && v.muted && !mutedByUs.has(v)) return false;  // 背景视频 / 动图式视频
    let path = [];
    try { path = e.composedPath(); } catch (_) {}
    if (!path.length) return false;
    // 套在链接里的(缩略图悬停预览之类),点下去是要跳转的
    for (const n of path) {
      try { if (n.nodeType === 1 && n.matches("a[href]")) return false; } catch (_) {}
    }
    // 视频的祖先链(跨 shadow 边界)。事件路径走到这条链上就出了"盖在画面上的那一层",
    // 再往上是整个播放器/页面的容器,不归控件判断管(否则放在弹窗、卡片里的播放器全被误杀)
    const anc = new Set();
    for (let n = v; n; n = n.parentNode || n.host) anc.add(n);
    for (const n of path) {
      if (n === v) return true;                                // 直接点在 <video> 上
      if (anc.has(n)) break;
      try { if (n.nodeType === 1 && n.matches(CONTROL_SEL)) return false; } catch (_) {}
    }
    // 点在遮罩层上:最深的那个元素得盖住画面的一大半才算 ——
    // 进度条、控件条、标题文字这些小东西不算
    const t = path[0];
    if (!t || t.nodeType !== 1) return false;
    let tr, vr;
    try { tr = t.getBoundingClientRect(); vr = v.getBoundingClientRect(); } catch (_) { return false; }
    const w = Math.min(tr.right, vr.right) - Math.max(tr.left, vr.left);
    const h = Math.min(tr.bottom, vr.bottom) - Math.max(tr.top, vr.top);
    return w > 0 && h > 0 && (w * h) / (vr.width * vr.height) >= 0.4;
  }

  function setPlaying(v, play) {
    try {
      if (play) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      else v.pause();
    } catch (_) {}
    showIndicator(play ? "▶ 播放" : "⏸ 暂停");
  }

  function decideClickToggle(press) {
    const v = press.v;
    if (siteTogglesOnClick || !v.isConnected) return;
    if (v.paused !== press.paused) return;                     // 站点自己切过了
    const play = v.paused;
    const at = Date.now();
    setPlaying(v, play);
    // 盯一会儿:没有新的输入却被翻回去,说明站点也在切(只是比我们晚)
    let timer = 0;
    const onFlip = () => {
      if (lastInputAt > at) { stop(); return; }                // 用户自己又操作了,不算
      if (v.paused === !play) return;                          // 我们自己那次切换派发的事件
      stop();
      siteTogglesOnClick = true;
      setPlaying(v, play);                                     // 把这次点击的本意补回来
    };
    const stop = () => {
      clearTimeout(timer);
      v.removeEventListener("play", onFlip);
      v.removeEventListener("pause", onFlip);
    };
    v.addEventListener("play", onFlip);
    v.addEventListener("pause", onFlip);
    timer = setTimeout(stop, CLICK_WATCH_MS);
  }

  window.addEventListener("keydown", () => { lastInputAt = Date.now(); }, true);
  window.addEventListener("pointerdown", (e) => {
    lastInputAt = Date.now();
    pendingPress = null;
    // 上一次单击还没判定就又按下了 = 双击(多半是要全屏):两下都不算,播放状态不动
    if (decideTimer) { clearTimeout(decideTimer); decideTimer = 0; return; }
    if (!settings.clickToggle || siteTogglesOnClick || media.size === 0) return;
    if (!e.isTrusted || e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const v = videoAtPoint(e);
    if (v) pendingPress = { v, paused: v.paused, x: e.clientX, y: e.clientY, t: Date.now() };
  }, true);
  window.addEventListener("click", (e) => {
    const press = pendingPress;
    pendingPress = null;
    if (!press || !e.isTrusted || e.button !== 0) return;
    if (Date.now() - press.t > CLICK_MAX_MS) return;
    if (Math.abs(e.clientX - press.x) > CLICK_SLOP_PX || Math.abs(e.clientY - press.y) > CLICK_SLOP_PX) return;
    if (!clickOnPicture(e, press.v)) return;
    decideTimer = setTimeout(() => { decideTimer = 0; decideClickToggle(press); }, CLICK_DECIDE_MS);
  }, true);

  /* ------------------------- popup 消息(设置/读取速度) ------------------------- */
  try {
    chrome.runtime?.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.__vscCmd) return;
      if (msg.type === "setRate" || msg.type === "seek") {
        // tabs.sendMessage 会送到每一个 frame。只让顶层当入口、再由它路由到整棵树,
        // 否则每个 frame 各发一轮 —— 快进会被执行 N 次。
        if (window.top !== window) return;
        dispatch(msg.type === "setRate" ? "rate" : "seek", msg.value);
        sendResponse({ ok: true, rate: targetRate });
      } else if (msg.type === "getRate") {
        // 只有含媒体的 frame 才回应,避免空 frame 抢答
        if (media.size > 0) {
          const best = pickActiveVideo();
          let r = best ? best.v.playbackRate : 1.0;
          if (!best) media.forEach((m) => { if (m.playbackRate) r = m.playbackRate; });
          sendResponse({ rate: round2(r), hasMedia: true });
        } else {
          sendResponse({ hasMedia: false });
        }
      }
      return true;
    });
  } catch (_) {}

  /* ------------------------- 速度提示 UI ------------------------- */
  let indicatorEl = null;
  let hideTimer = null;
  let popoverTimer = 0;
  let pinRAF = 0;

  /* 浏览器支持 popover 时把提示放进 top layer:
   * 这样即使 <video> 自己进入全屏(全屏时页面其余内容根本不参与渲染),提示依然看得见;
   * 顺带也不再怕站点祖先元素上的 transform/filter/overflow 把 position:fixed 圈住。 */
  const POPOVER_OK = (() => {
    try {
      return typeof HTMLElement !== "undefined" &&
        Object.prototype.hasOwnProperty.call(HTMLElement.prototype, "popover");
    } catch (_) { return false; }
  })();

  function ensureIndicator(host) {
    if (!indicatorEl) {
      indicatorEl = document.createElement("div");
      indicatorEl.className = "__vsc-indicator";
      if (POPOVER_OK) { try { indicatorEl.setAttribute("popover", "manual"); } catch (_) {} }
    }
    host = host || document.body || document.documentElement;
    if (host && indicatorEl.parentNode !== host) host.appendChild(indicatorEl);
    return indicatorEl;
  }

  function popoverOpen() {
    try { return !!indicatorEl && indicatorEl.matches(":popover-open"); } catch (_) { return false; }
  }
  /* restack=true:重新往 top layer 里插一次。
   * top layer 按加入顺序叠放,视频是在提示之后才进的全屏,不重插就会被全屏层盖住。 */
  function openIndicator(restack) {
    if (!POPOVER_OK || !indicatorEl || !indicatorEl.isConnected) return;
    try {
      if (popoverOpen()) {
        if (!restack) return;
        indicatorEl.hidePopover();
      }
      indicatorEl.showPopover();
    } catch (_) {}
  }
  function closeIndicator() {
    if (!POPOVER_OK || !indicatorEl) return;
    try { if (popoverOpen()) indicatorEl.hidePopover(); } catch (_) {}
  }

  // 把提示定位到活动视频的左上角(随视频位置走)
  function positionIndicator() {
    const fsRaw = fullscreenEl();
    // 不支持 popover 时的老办法:全屏元素若是容器就把提示挂进去;
    // 直接全屏 <video> 则无处可挂(这正是 popover 要解决的那种情况)。
    const fsHost = !POPOVER_OK && fsRaw && !isMedia(fsRaw) ? fsRaw : null;
    const target = pickActiveVideo();
    ensureIndicator(fsHost || document.body || document.documentElement);
    if (!indicatorEl) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = 14, top = 14;
    if (target) {
      const r = target.rect;
      left = Math.max(0, r.left) + 10;
      top = Math.max(0, r.top) + 10;
    }
    // 视频滚出视口时别把提示甩到屏幕外
    indicatorEl.style.left = Math.max(0, Math.min(left, vw - 60)) + "px";
    indicatorEl.style.top = Math.max(0, Math.min(top, vh - 40)) + "px";
  }

  function showIndicator(text) {
    if (!settings.showIndicator) return;
    if (media.size === 0) return; // 没媒体的 frame 一律不显示,常驻模式下也不显示
                                  // (否则页面里每个空 iframe 都会挂一个角标)
    if (popoverTimer) { clearTimeout(popoverTimer); popoverTimer = 0; }
    positionIndicator();
    if (!indicatorEl) return;
    openIndicator(false);
    indicatorEl.textContent = text || `${round2(targetRate)}x`;
    indicatorEl.classList.add("__vsc-show");
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (pinIndicator) {
      startPinTracking();
      // 常驻模式下临时文字("▶ 播放""⏩ +5s")过一会儿换回速度,别一直挂着
      if (text) hideTimer = setTimeout(() => { hideTimer = null; showIndicator(); }, 1400);
    } else {
      stopPinTracking();
      hideTimer = setTimeout(hideIndicator, 1400);
    }
  }

  function hideIndicator() {
    stopPinTracking();
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (!indicatorEl) return;
    indicatorEl.classList.remove("__vsc-show");
    if (popoverTimer) clearTimeout(popoverTimer);
    popoverTimer = setTimeout(() => { popoverTimer = 0; closeIndicator(); }, 260); // 等淡出动画走完
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

  function onFullscreenChange() {
    rescan();                       // 有些播放器进全屏时会重建 <video>
    if (!indicatorEl) return;
    positionIndicator();
    // 重新加入 top layer,否则会被刚进全屏的元素压在下面
    if (indicatorEl.classList.contains("__vsc-show")) openIndicator(true);
  }
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  /* ------------------------- 启动 ------------------------- */
  refreshAutoMute(); // 先用默认配置判定,缩短"有声"窗口;storage 读完后再校正
  loadSettings();
  startObserver();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => rescan(), { once: true });
  }
  scan(document);
  // 兜底:延迟再扫几次,catch 晚加载的播放器和后挂上的 shadow root
  [500, 1500, 4000, 8000].forEach((ms) => setTimeout(rescan, ms));
  // 切回前台时补一次:站点常在标签页被看到时才真正建播放器
  document.addEventListener("visibilitychange", () => { if (!document.hidden) rescan(); });
})();
