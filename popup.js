/* popup 逻辑:读取/设置当前速度、编辑参数与快捷键 */

const DEFAULTS = {
  enabled: true,
  step: 2,
  fastSpeed: 4,
  seekStep: 5,
  minSpeed: 0.1,
  maxSpeed: 16,
  rememberSpeed: false,
  showIndicator: true,
  autoMute: true,
  autoMuteHosts: ["115vod.com"],
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

let settings = JSON.parse(JSON.stringify(DEFAULTS));
const $ = (id) => document.getElementById(id);

/* -------- e.code -> 友好名 -------- */
function codeLabel(code) {
  if (!code) return "—";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num" + code.slice(6);
  const map = {
    ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
    Space: "Space", Comma: ",", Period: ".", Slash: "/",
    BracketLeft: "[", BracketRight: "]", Backquote: "`",
    Semicolon: ";", Quote: "'", Minus: "-", Equal: "="
  };
  return map[code] || code;
}

/* -------- 当前激活标签 -------- */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/* -------- 读取页面当前速度(读所有 frame 的 video) -------- */
async function refreshCurrentRate() {
  try {
    const tab = await activeTab();
    if (!tab || !tab.id) return;
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const v = document.querySelector("video, audio");
        return v ? v.playbackRate : null;
      }
    });
    const rate = results.map((r) => r.result).find((r) => r != null);
    if (rate != null) {
      $("curRate").textContent = (Math.round(rate * 100) / 100) + "x";
      $("rateInput").value = Math.round(rate * 100) / 100;
      markActivePreset(rate);
    } else {
      $("curRate").textContent = "无视频";
    }
  } catch (_) {
    $("curRate").textContent = "—";
  }
}

function markActivePreset(rate) {
  document.querySelectorAll(".presets button").forEach((b) => {
    b.classList.toggle("active", Math.abs(parseFloat(b.dataset.rate) - rate) < 0.001);
  });
}

/* -------- 设置速度 -> 发给页面 -------- */
async function setRate(rate) {
  rate = Math.min(16, Math.max(0.1, rate));
  const tab = await activeTab();
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { __vscCmd: true, type: "setRate", value: rate });
  } catch (_) {
    // 内容脚本未注入(如刚装好未刷新):兜底直接注入设置
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: (r) => { document.querySelectorAll("video, audio").forEach((v) => v.playbackRate = r); },
        args: [rate]
      });
    } catch (_) {}
  }
  $("curRate").textContent = (Math.round(rate * 100) / 100) + "x";
  $("rateInput").value = Math.round(rate * 100) / 100;
  markActivePreset(rate);
}

/* -------- 存储(配置走 sync 跨设备同步) -------- */
function save() {
  chrome.storage.sync.set({ vsc_settings: settings }, () => {
    if (chrome.runtime.lastError) {
      // 同步配额/不可用时退回本地,至少本机生效
      chrome.storage.local.set({ vsc_settings: settings });
      status("已保存(本地)");
    }
  });
}

function load(cb) {
  chrome.storage.sync.get("vsc_settings", (res) => {
    let data = res && res.vsc_settings;
    const finish = () => {
      if (data) {
        settings = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), data);
        settings.keys = Object.assign({}, DEFAULTS.keys, data.keys || {});
      }
      cb();
    };
    if (!data) {
      // 兼容旧版本存在 local 的配置
      chrome.storage.local.get("vsc_settings", (r2) => {
        if (r2 && r2.vsc_settings) data = r2.vsc_settings;
        finish();
      });
    } else {
      finish();
    }
  });
}

/* -------- 状态提示 -------- */
let statusTimer = 0;
function status(text) {
  const el = $("status");
  if (!el) return;
  el.textContent = text;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ""; }, 2500);
}

/* -------- 导出 / 导入配置 -------- */
function exportConfig() {
  const data = JSON.stringify({ vsc_settings: settings }, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "video-speed-config.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status("已导出配置文件");
}

function importConfig(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const obj = JSON.parse(reader.result);
      const incoming = obj.vsc_settings || obj; // 兼容直接是 settings 的文件
      if (!incoming || typeof incoming !== "object") throw new Error("bad");
      settings = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), incoming);
      settings.keys = Object.assign({}, DEFAULTS.keys, incoming.keys || {});
      save();
      render();
      status("配置已导入");
    } catch (e) {
      status("导入失败:文件格式不对");
    }
  };
  reader.readAsText(file);
}

/* -------- 把 settings 反映到 UI -------- */
function render() {
  $("enabled").checked = settings.enabled;
  $("step").value = settings.step;
  $("fastSpeed").value = settings.fastSpeed;
  $("seekStep").value = settings.seekStep;
  $("rememberSpeed").checked = settings.rememberSpeed;
  $("showIndicator").checked = settings.showIndicator;
  $("autoMute").checked = settings.autoMute;
  $("autoMuteHosts").value = (settings.autoMuteHosts || []).join("\n");
  document.querySelectorAll("[data-key]").forEach((inp) => {
    inp.value = codeLabel(settings.keys[inp.dataset.key]);
    inp.dataset.code = settings.keys[inp.dataset.key];
  });
}

/* -------- 事件绑定 -------- */
function bind() {
  // 预设
  document.querySelectorAll(".presets button").forEach((b) => {
    b.addEventListener("click", () => setRate(parseFloat(b.dataset.rate)));
  });
  // 微调
  $("plus").addEventListener("click", () =>
    setRate((parseFloat($("rateInput").value) || 1) + settings.step));
  $("minus").addEventListener("click", () =>
    setRate((parseFloat($("rateInput").value) || 1) - settings.step));
  $("rateInput").addEventListener("change", () =>
    setRate(parseFloat($("rateInput").value) || 1));

  // 开关 / 参数
  $("enabled").addEventListener("change", (e) => { settings.enabled = e.target.checked; save(); });
  $("rememberSpeed").addEventListener("change", (e) => { settings.rememberSpeed = e.target.checked; save(); });
  $("showIndicator").addEventListener("change", (e) => { settings.showIndicator = e.target.checked; save(); });
  $("autoMute").addEventListener("change", (e) => { settings.autoMute = e.target.checked; save(); });
  $("autoMuteHosts").addEventListener("change", (e) => {
    settings.autoMuteHosts = e.target.value
      .split(/[\s,，]+/)              // 换行 / 空格 / 中英文逗号分隔
      .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
      .filter(Boolean);
    save();
  });
  $("step").addEventListener("change", (e) => { settings.step = parseFloat(e.target.value) || 2; save(); });
  $("fastSpeed").addEventListener("change", (e) => { settings.fastSpeed = parseFloat(e.target.value) || 4; save(); });
  $("seekStep").addEventListener("change", (e) => { settings.seekStep = parseInt(e.target.value) || 5; save(); });

  // 快捷键录入
  document.querySelectorAll("[data-key]").forEach((inp) => {
    inp.addEventListener("keydown", (e) => {
      e.preventDefault();
      if (e.code === "Escape") { inp.blur(); return; }
      settings.keys[inp.dataset.key] = e.code;
      inp.value = codeLabel(e.code);
      inp.dataset.code = e.code;
      save();
      inp.blur();
    });
  });

  // 导出 / 导入
  $("export").addEventListener("click", exportConfig);
  $("import").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) importConfig(f);
    e.target.value = "";
  });

  // 恢复默认
  $("reset").addEventListener("click", () => {
    settings = JSON.parse(JSON.stringify(DEFAULTS));
    save();
    render();
    status("已恢复默认设置");
  });
}

document.addEventListener("DOMContentLoaded", () => {
  load(() => {
    render();
    bind();
    refreshCurrentRate();
  });
});
