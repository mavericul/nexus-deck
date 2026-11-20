let games = [];
let availableRunners = [];
let editingGameId = null;
let isBigPicture = false;
let bpIndex = 0;
let bpTab = "installed";
let activeTab = "installed";
let activeSource = "all";
let runningGames = {};
let installingGames = {};
let pausedEpicDownload = JSON.parse(localStorage.getItem("nexus_paused_epic") || "null");
let selectedSourceCtx = null;
let viewMode = "grid";
let selectedGenre = "all";
let selectedSort = "name-asc";
let selectedTagFilter = "all";
let selectedCtxGame = null;
let selectedPrefixGame = null;
let currentTheme = localStorage.getItem("nexus_theme") || "dark";
let searchDebounceTimeout = null;

import { t, setLanguage, getLanguage, applyTranslationsToDom } from "./i18n.js";

const IGNORED_TOOLS = [
  "steamworks",
"steam linux runtime",
"proton",
"shared",
"redistributable",
"easyanticheat",
"battleye",
"steamvr",
"soundtrack"
];

function isToolOrRuntime(title) {
  if (!title) return true;
  const lower = title.toLowerCase();

  if (lower.startsWith("steam game ")) {
    return true;
  }

  const ignoreKeywords = [
    "steamworks",
    "source sdk",
    "spacewar",
    "steam community",
    "steamvr",
    "proton",
    "steam linux runtime",
    "dedicated server",
    "soundtrack",
    "bonus content",
    "benchmark",
    "editor",
    "redistributables",
    "steam client"
  ];

  return ignoreKeywords.some(keyword => lower.includes(keyword));
}

// Detectare platformă (Windows vs Linux)
const isWindows = navigator.userAgent.toLowerCase().includes("win") || navigator.platform.toLowerCase().includes("win");

if (isWindows) {
  document.body.classList.add("platform-windows");
}

const getInvoke = () => window.__TAURI__?.core?.invoke || window.__TAURI__?.tauri?.invoke || window.__TAURI__?.invoke;

if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event.listen("game-status-changed", (event) => {
    const { game_id, status, playtime_seconds } = event.payload;

    if (status === "stopped") {
      delete runningGames[game_id];

      const game = games.find(g => g.id === game_id);
      if (game && playtime_seconds > 2) {
        const addedMinutes = Math.max(1, Math.round(playtime_seconds / 60));
        game.playtime_minutes = (game.playtime_minutes || 0) + addedMinutes;
        saveGamesToDisk();
      }

      showToast(t("toast.game_closed", { sec: playtime_seconds || 0 }), "info");
    } else {
      runningGames[game_id] = status;
    }

    renderGames();
    if (isBigPicture) renderBigPicture();
  });

    window.__TAURI__.event.listen("epic-install-progress", async (event) => {
      const data = event.payload;
      const gameId = `epic_${data.app_name}`;
      const badge = document.getElementById("dl-status-badge");
      const panel = document.getElementById("dl-active-panel");
      const titleEl = document.getElementById("dl-game-title");
      const barEl = document.getElementById("dl-progress-bar");
      const pctEl = document.getElementById("dl-percent");
      const speedEl = document.getElementById("dl-speed");
      const pauseBtn = document.getElementById("btn-pause-download");

      if (data.status === "starting" || data.status === "downloading") {
        const wasInstalling = installingGames[gameId] !== undefined;
        installingGames[gameId] = data.percent || 0;

        if (pausedEpicDownload && pausedEpicDownload.gameId === gameId) {
          pausedEpicDownload.percent = data.percent || 0;
          pausedEpicDownload.paused = false;
          localStorage.setItem("nexus_paused_epic", JSON.stringify(pausedEpicDownload));
        }

        if (badge) {
          badge.textContent = t("sidebar.active");
          badge.className = "text-cyan-400 font-semibold";
        }
        if (pauseBtn) {
          pauseBtn.title = t("sidebar.pause_dl_title");
          pauseBtn.className = "w-6 h-6 flex items-center justify-center rounded bg-amber-950/80 text-amber-400 hover:bg-amber-900 transition shrink-0";
          pauseBtn.innerHTML = PAUSE_ICON_SVG;
        }
        if (panel) panel.classList.remove("hidden");
        if (titleEl) titleEl.textContent = data.title;
        if (barEl) barEl.style.width = `${Math.min(100, Math.max(0, data.percent))}%`;
        if (pctEl) pctEl.textContent = `${data.percent.toFixed(1)}%`;
        if (speedEl) {
          const etaText = data.eta && data.eta !== "--:--" ? ` • ETA ${data.eta}` : "";
          speedEl.textContent = `${data.speed || "0.0 MiB/s"}${etaText}`;
        }
        if (!wasInstalling) {
          renderGames();
          if (isBigPicture) renderBigPicture();
        } else {
          updateInstallingCardProgress(gameId, data.percent || 0);
        }
      } else if (data.status === "paused") {
        delete installingGames[gameId];
        if (pausedEpicDownload) {
          pausedEpicDownload.paused = true;
          pausedEpicDownload.percent = data.percent || pausedEpicDownload.percent || 0;
          localStorage.setItem("nexus_paused_epic", JSON.stringify(pausedEpicDownload));
        }

        if (badge) {
          badge.textContent = t("sidebar.paused");
          badge.className = "text-amber-400 font-semibold";
        }
        if (pauseBtn) {
          pauseBtn.title = t("sidebar.resume_dl_title");
          pauseBtn.className = "w-6 h-6 flex items-center justify-center rounded bg-emerald-950/80 text-emerald-400 hover:bg-emerald-900 transition shrink-0";
          pauseBtn.innerHTML = PLAY_ICON_SVG;
        }
        if (speedEl) speedEl.textContent = t("sidebar.paused");
        renderGames();
        if (isBigPicture) renderBigPicture();
        showToast(t("toast.epic_paused", { title: data.title }), "info");
      } else if (data.status === "completed") {
        delete installingGames[gameId];
        pausedEpicDownload = null;
        localStorage.removeItem("nexus_paused_epic");

        if (badge) {
          badge.textContent = t("sidebar.idle");
          badge.className = "text-slate-500 font-medium";
        }
        if (panel) panel.classList.add("hidden");

        const target = games.find(
          (g) => g.id === gameId || g.id === data.app_name
        );
        if (target) {
          target.is_installed = true;
          if (data.exe_path) target.exe_path = data.exe_path;
          if (data.wine_prefix) target.wine_prefix = data.wine_prefix;
          if (data.runner_path) target.runner_path = data.runner_path;
          await saveGamesToDisk();
        }
        renderGames();
        if (isBigPicture) renderBigPicture();
        showToast(t("toast.epic_installed", { title: data.title }), "success");
      } else if (data.status === "error" || data.status === "cancelled") {
        delete installingGames[gameId];
        if (data.status === "cancelled") {
          pausedEpicDownload = null;
          localStorage.removeItem("nexus_paused_epic");
        }
        if (badge) {
          badge.textContent = t("sidebar.idle");
          badge.className = "text-slate-500 font-medium";
        }
        if (panel) panel.classList.add("hidden");
        renderGames();
        if (isBigPicture) renderBigPicture();
        showToast(data.message, data.status === "error" ? "error" : "info");
      }
    });
}

let pendingAppUpdate = null;

async function checkForAppUpdates(silent = false) {
  const statusEl = document.getElementById("updater-status-text");
  const panelEl = document.getElementById("updater-panel");
  const newVerEl = document.getElementById("updater-new-version");
  const notesEl = document.getElementById("updater-release-notes");
  const checkBtn = document.getElementById("btn-check-updates");

  const updater = window.__TAURI__?.updater;
  if (!updater?.check) {
    if (!silent && statusEl) statusEl.textContent = t("modal.cfg.updater_unavailable");
    return;
  }

  if (checkBtn) {
    checkBtn.disabled = true;
    checkBtn.textContent = t("modal.cfg.checking_updates");
  }
  if (!silent && statusEl) {
    statusEl.textContent = t("modal.cfg.checking_github");
  }

  try {
    const update = await updater.check();
    if (update) {
      pendingAppUpdate = update;
      if (statusEl) {
        statusEl.innerHTML = t("modal.cfg.update_available_html", { version: escapeHtml(update.version) });
      }
      if (newVerEl) newVerEl.textContent = t("modal.cfg.update_ready", { version: update.version });
      if (notesEl) notesEl.textContent = update.body || t("modal.cfg.default_notes");
      panelEl?.classList.remove("hidden");

      if (silent && typeof showToast === "function") {
        showToast(t("toast.update_available", { version: update.version }), "info");
      }
    } else {
      pendingAppUpdate = null;
      panelEl?.classList.add("hidden");
      if (statusEl) {
        statusEl.textContent = t("modal.cfg.latest_version");
      }
    }
  } catch (err) {
    console.error("Updater check failed:", err);
    if (!silent && statusEl) {
      statusEl.textContent = t("modal.cfg.check_failed");
    }
  } finally {
    if (checkBtn) {
      checkBtn.disabled = false;
      checkBtn.textContent = t("modal.cfg.check_updates");
    }
  }
}

async function installPendingAppUpdate() {
  if (!pendingAppUpdate) return;

  const installBtn = document.getElementById("btn-install-update");
  const progressWrap = document.getElementById("updater-progress-wrap");
  const progressBar = document.getElementById("updater-progress-bar");
  const progressLabel = document.getElementById("updater-progress-label");
  const statusEl = document.getElementById("updater-status-text");

  if (installBtn) {
    installBtn.disabled = true;
    installBtn.textContent = t("modal.cfg.downloading_update");
  }
  progressWrap?.classList.remove("hidden");

  let downloadedBytes = 0;
  let totalBytes = 0;

  try {
    await pendingAppUpdate.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          totalBytes = event.data.contentLength || 0;
          break;
        case "Progress":
          downloadedBytes += event.data.chunkLength || 0;
          if (totalBytes > 0) {
            const pct = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
            if (progressBar) progressBar.style.width = `${pct}%`;
            if (progressLabel) progressLabel.textContent = `${pct}%`;
          } else if (progressLabel) {
            const mb = (downloadedBytes / (1024 * 1024)).toFixed(1);
            progressLabel.textContent = t("modal.cfg.mb_downloaded", { mb });
          }
          break;
        case "Finished":
          if (progressBar) progressBar.style.width = "100%";
          if (progressLabel) progressLabel.textContent = t("modal.cfg.installing_pct");
          break;
      }
    });

    if (statusEl) statusEl.textContent = t("modal.cfg.update_restarting");
    const relaunch = window.__TAURI__?.process?.relaunch;
    if (relaunch) {
      await relaunch();
    } else if (installBtn) {
      installBtn.textContent = t("modal.cfg.restart_required");
    }
  } catch (err) {
    console.error("Update install failed:", err);
    if (statusEl) statusEl.textContent = t("modal.cfg.update_failed", { err });
    if (installBtn) {
      installBtn.disabled = false;
      installBtn.textContent = t("modal.cfg.retry_install");
    }
  }
}

function updateInstallingCardProgress(gameId, percent) {
  const pctLabel = percent > 0 ? `${percent.toFixed(0)}%` : "...";

  document.querySelectorAll(`[data-installing-cover="${gameId}"]`).forEach((el) => {
    el.textContent = pctLabel;
  });
  document.querySelectorAll(`[data-installing-pill="${gameId}"]`).forEach((el) => {
    el.textContent = percent > 0 ? t("game.status.installing_pct", { pct: percent.toFixed(0) }) : t("game.status.installing");
  });
  document.querySelectorAll(`[data-installing-badge="${gameId}"]`).forEach((el) => {
    el.textContent = percent > 0 ? t("game.status.installing_pct", { pct: percent.toFixed(0) }) : t("game.status.installing");
  });
  document.querySelectorAll(`[data-installing-list="${gameId}"]`).forEach((el) => {
    el.textContent = percent > 0 ? t("game.status.installing_list_pct", { pct: percent.toFixed(0) }) : t("game.status.installing");
  });

  if (isBigPicture) {
    const bpGames = getBpGamesFiltered();
    if (bpGames[bpIndex]?.id === gameId) {
      const bpSpan = document.querySelector("#bp-btn-play span");
      if (bpSpan) {
        bpSpan.textContent = percent > 0 ? t("bp.installing_pct", { pct: percent.toFixed(0) }) : t("bp.installing");
      }
    }
  }
}

function startSteamInstallTracking(game) {
  const appId = game.id.replace("steam_", "");
  installingGames[game.id] = 0;
  renderGames();
  if (isBigPicture) renderBigPicture();

  let sawManifest = false;
  let notFoundChecks = 0;

  const timer = setInterval(async () => {
    const invoke = getInvoke();
    if (!invoke) {
      clearInterval(timer);
      return;
    }

    try {
      const res = await invoke("check_steam_install_status", { appId });

      if (res.state === "installed") {
        clearInterval(timer);
        delete installingGames[game.id];
        game.is_installed = true;
        game.exe_path = `steam://rungameid/${appId}`;
        await saveGamesToDisk();
        renderGames();
        if (isBigPicture) renderBigPicture();
        showToast(t("toast.steam_installed", { title: game.title }), "success");
      } else if (res.state === "downloading") {
        sawManifest = true;
        installingGames[game.id] = res.percent || 0;
        updateInstallingCardProgress(game.id, res.percent || 0);
      } else {
        notFoundChecks++;
        if (sawManifest || notFoundChecks >= 20) {
          clearInterval(timer);
          delete installingGames[game.id];
          renderGames();
          if (isBigPicture) renderBigPicture();
        }
      }
    } catch (err) {
      console.error("Eroare verificare instalare Steam:", err);
    }
  }, 3000);
}

async function waitForTauriInvoke(maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const inv = getInvoke();
    if (inv) return inv;
    await new Promise(r => setTimeout(r, 25));
  }
  return getInvoke();
}

document.addEventListener("DOMContentLoaded", async () => {
  applyTheme(currentTheme);
  applyTranslationsToDom();
  loadSavedUiSettings();
  setupEventListeners();
  setupUiSettingsListeners();
  setupSourceSidebarListeners();
  initGamesContainerEvents();
  setTimeout(() => {
    checkForAppUpdates(true);
  }, 4000);

  const container = document.getElementById("games-container");
  if (container) {
    container.innerHTML = `
    <div class="col-span-full py-24 flex flex-col items-center justify-center text-slate-400">
    <div class="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3"></div>
    <p class="text-sm font-semibold">${t("lib.loading")}</p>
    </div>
    `;
  }

  if (pausedEpicDownload && pausedEpicDownload.paused) {
    const badge = document.getElementById("dl-status-badge");
    const panel = document.getElementById("dl-active-panel");
    const titleEl = document.getElementById("dl-game-title");
    const barEl = document.getElementById("dl-progress-bar");
    const pctEl = document.getElementById("dl-percent");
    const speedEl = document.getElementById("dl-speed");
    const pauseBtn = document.getElementById("btn-pause-download");

    if (badge) {
      badge.textContent = t("sidebar.paused");
      badge.className = "text-amber-400 font-semibold";
    }
    if (panel) panel.classList.remove("hidden");
    if (titleEl) titleEl.textContent = pausedEpicDownload.title;
    if (barEl) barEl.style.width = `${pausedEpicDownload.percent || 0}%`;
    if (pctEl) pctEl.textContent = `${(pausedEpicDownload.percent || 0).toFixed(1)}%`;
    if (speedEl) speedEl.textContent = t("sidebar.paused");
    if (pauseBtn) {
      pauseBtn.title = t("sidebar.resume_dl_title");
      pauseBtn.className = "w-6 h-6 flex items-center justify-center rounded bg-emerald-950/80 text-emerald-400 hover:bg-emerald-900 transition shrink-0";
      pauseBtn.innerHTML = PLAY_ICON_SVG;
    }
  }

  await waitForTauriInvoke();

  if (window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen('runner-install-progress', (event) => {
      const msg = document.getElementById('runner-install-msg');
      if (msg && event.payload?.message) {
        msg.textContent = event.payload.message;
      }
    });
  }

  document.getElementById('default-runner-select')?.addEventListener('change', (e) => {
    setDefaultRunner(e.target.value);
    loadRunners();
  });

  document.getElementById('refresh-runners-btn')?.addEventListener('click', () => {
    const onlineVisible = !document.getElementById('runners-online-view')?.classList.contains('hidden');
    if (onlineVisible) {
      loadOnlineRunners(true);
    } else {
      loadRunners();
    }
  });

  document.getElementById('close-runners-footer-btn')?.addEventListener('click', () => {
    closeModalAnimated('runners-modal');
  });

  await loadGames();
  renderGames();
  renderSidebarTags();
  updateSourceSidebarUi();

  loadRunners().catch(e => console.error(e));
  startClock();
  startBpStatusMonitor();
  setTimeout(() => startSysMonitor(), 800);

  setTimeout(() => {
    enrichSteamTitles();
    enrichProtonDbRatings();
  }, 1500);

  try {
    const savedConfig = localStorage.getItem("nexusdeck_ui_config");
    if (savedConfig) {
      const config = JSON.parse(savedConfig);
      if (config.startInBp) {
        setTimeout(() => {
          document.getElementById("btn-toggle-mode")?.click();
        }, 100);
      }
    }
  } catch (e) { console.error(e); }
});


function addDllOverrideRow(dll = "", mode = "n,b") {
  const container = document.getElementById("dll-overrides-list");
  if (!container) return;

  const row = document.createElement("div");
  row.className = "flex items-center gap-2 dll-row";
  row.innerHTML = `
  <input type="text" placeholder="${t("modal.game.dll_name_ph")}" value="${dll}" class="dll-name flex-1 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono">

  <input type="text" placeholder="${t("modal.game.dll_mode_ph")}" value="${mode}" class="dll-mode w-32 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono" title="${t("modal.game.dll_mode_title")}">

  <button type="button" class="btn-remove-row p-1.5 bg-red-950/60 hover:bg-red-900 text-red-400 rounded-lg transition">
  <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
  </button>
  `;

  row.querySelector(".btn-remove-row").addEventListener("click", () => row.remove());
  container.appendChild(row);
  if (window.lucide) window.lucide.createIcons();
}

function addEnvVarRow(key = "", val = "") {
  const container = document.getElementById("env-vars-list");
  if (!container) return;

  const row = document.createElement("div");
  row.className = "flex items-center gap-2 env-row";
  row.innerHTML = `
  <input type="text" placeholder="${t("modal.game.env_key_ph")}" value="${key}" class="env-key flex-1 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono">
  <input type="text" placeholder="${t("modal.game.env_val_ph")}" value="${val}" class="env-val flex-1 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono">
  <button type="button" class="btn-remove-row p-1.5 bg-red-950/60 hover:bg-red-900 text-red-400 rounded-lg transition">
  <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
  </button>
  `;

  row.querySelector(".btn-remove-row").addEventListener("click", () => row.remove());
  container.appendChild(row);
  if (window.lucide) window.lucide.createIcons();
}

// ==========================================
// THEME ENGINE & TOASTS
// ==========================================
function applyTheme(theme) {
  currentTheme = theme;
  localStorage.setItem("nexus_theme", theme);
  const root = document.documentElement;
  const themeText = document.getElementById("theme-text");

  if (theme === "light") {
    root.classList.add("theme-light");
    if (themeText) themeText.innerText = t("top.dark_mode");
  } else {
    root.classList.remove("theme-light");
    if (themeText) themeText.innerText = t("top.light_mode");
  }
}

function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");

  let borderColor = "border-indigo-500/50";
  let iconName = "info";
  let iconColor = "text-indigo-400";

  if (type === "success") {
    borderColor = "border-emerald-500/50";
    iconName = "check-circle";
    iconColor = "text-emerald-400";
  } else if (type === "error") {
    borderColor = "border-red-500/50";
    iconName = "alert-circle";
    iconColor = "text-red-400";
  }

  toast.className = `pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl glass-panel border ${borderColor} text-xs font-semibold text-slate-100 shadow-2xl transition-all duration-300 transform translate-y-4 opacity-0`;

  toast.innerHTML = `
  <i data-lucide="${iconName}" class="w-4 h-4 ${iconColor} shrink-0"></i>
  <span>${message}</span>
  `;

  container.appendChild(toast);
  if (window.lucide) window.lucide.createIcons();

  requestAnimationFrame(() => {
    toast.classList.remove("translate-y-4", "opacity-0");
  });

  setTimeout(() => {
    toast.classList.add("translate-y-4", "opacity-0");
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function openModalAnimated(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.remove("hidden");
  requestAnimationFrame(() => {
    modal.classList.add("open");
  });
}

function closeModalAnimated(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.remove("open");
  setTimeout(() => {
    modal.classList.add("hidden");
  }, 250);
}

let selectedRemoveGame = null;

function openRemoveConfirmModal(game) {
  if (!game) return;
  selectedRemoveGame = game;
  const textEl = document.getElementById("remove-modal-text");
  if (textEl) {
    textEl.innerHTML = t("modal.remove.confirm_html", { title: escapeHtml(game.title) });
  }
  const chkUninstall = document.getElementById("chk-uninstall-files");
  if (chkUninstall) chkUninstall.checked = false;
  openModalAnimated("remove-confirm-modal");
}

function loadSavedUiSettings() {
  const savedConfig = localStorage.getItem("nexusdeck_ui_config");
  if (!savedConfig) return;

  try {
    const config = JSON.parse(savedConfig);

    const chkGlass = document.getElementById("cfg-glass-effects");
    if (chkGlass && typeof config.glassmorphism === "boolean") {
      chkGlass.checked = config.glassmorphism;
      if (!config.glassmorphism) document.body.classList.add("no-glass");
      else document.body.classList.remove("no-glass");
    }

    const chkMonitor = document.getElementById("cfg-resource-monitor");
    const resMonitorContainer = document.getElementById("top-resource-monitor");
    if (chkMonitor && typeof config.resourceMonitor === "boolean") {
      chkMonitor.checked = config.resourceMonitor;
      if (resMonitorContainer) {
        if (!config.resourceMonitor) resMonitorContainer.classList.add("hidden");
        else resMonitorContainer.classList.remove("hidden");
      }
    }

    const selectFontSize = document.getElementById("cfg-font-size");
    if (selectFontSize && config.fontSize) {
      selectFontSize.value = config.fontSize;
      document.body.classList.remove("text-xs", "text-sm", "text-base", "text-lg", "text-xl");
      document.body.classList.add(`text-${config.fontSize}`);
    }

    const selectUiScale = document.getElementById("cfg-ui-scale");
    if (selectUiScale && config.uiScale) {
      selectUiScale.value = config.uiScale;
      const appContainer = document.getElementById("app");
      if (appContainer) {
        appContainer.style.zoom = parseInt(config.uiScale, 10) / 100;
      }
    }

    const chkStartBp = document.getElementById("cfg-start-bp");
    if (chkStartBp && typeof config.startInBp === "boolean") {
      chkStartBp.checked = config.startInBp;
    }

  } catch (e) {
    console.error("Error loading UI settings from localStorage:", e);
  }
}

function saveUiSettings() {
  const chkGlass = document.getElementById("cfg-glass-effects");
  const chkMonitor = document.getElementById("cfg-resource-monitor");
  const selectFontSize = document.getElementById("cfg-font-size");
  const selectUiScale = document.getElementById("cfg-ui-scale");
  const chkStartBp = document.getElementById("cfg-start-bp");

  const config = {
    glassmorphism: chkGlass ? chkGlass.checked : true,
    resourceMonitor: chkMonitor ? chkMonitor.checked : true,
    fontSize: selectFontSize ? selectFontSize.value : "base",
    uiScale: selectUiScale ? selectUiScale.value : "100",
    startInBp: chkStartBp ? chkStartBp.checked : false
  };

  localStorage.setItem("nexusdeck_ui_config", JSON.stringify(config));
}

function setupUiSettingsListeners() {
  const chkGlass = document.getElementById("cfg-glass-effects");
  const chkMonitor = document.getElementById("cfg-resource-monitor");
  const resMonitorContainer = document.getElementById("top-resource-monitor");
  const selectFontSize = document.getElementById("cfg-font-size");
  const selectUiScale = document.getElementById("cfg-ui-scale");
  const chkStartBp = document.getElementById("cfg-start-bp");
  const selectLang = document.getElementById("cfg-lang");
  if (selectLang) {
    selectLang.value = getLanguage();
    selectLang.addEventListener("change", (e) => {
      setLanguage(e.target.value);
      applyTheme(currentTheme);
      gameNodeCache.clear();
      renderGames();
      renderSidebarTags();
      updateSourceSidebarUi();
      if (isBigPicture) {
        renderBigPicture();
        if (bpMenuState.open) renderBpGameDetails();
        if (bpPropsState.open) renderBpProperties();
      }
      showToast(t("toast.lang_changed"), "success");
    });
  }

  chkGlass?.addEventListener("change", (e) => {
    if (e.target.checked) document.body.classList.remove("no-glass");
    else document.body.classList.add("no-glass");
    saveUiSettings();
  });

  chkMonitor?.addEventListener("change", (e) => {
    if (resMonitorContainer) {
      if (e.target.checked) resMonitorContainer.classList.remove("hidden");
      else resMonitorContainer.classList.add("hidden");
    }
    saveUiSettings();
  });

  selectFontSize?.addEventListener("change", (e) => {
    document.body.classList.remove("text-xs", "text-sm", "text-base", "text-lg", "text-xl");
    document.body.classList.add(`text-${e.target.value}`);
    saveUiSettings();
  });

  selectUiScale?.addEventListener("change", (e) => {
    const scaleVal = parseInt(e.target.value, 10) / 100;
    const appContainer = document.getElementById("app");
    if (appContainer) appContainer.style.zoom = scaleVal;
    saveUiSettings();
  });

  chkStartBp?.addEventListener("change", () => {
    saveUiSettings();
  });
}

function isGameRunning() {
  for (const id in runningGames) {
    if (runningGames[id] === "playing") return true;
  }
  return false;
}

function shouldPoll() {
  if (document.hidden) return false;
  if (isGameRunning() && !document.hasFocus()) return false;
  return true;
}

function startClock() {
  const clockFormat = new Intl.DateTimeFormat([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const updateClock = () => {
    if (!shouldPoll()) return;
    const clockEl = document.getElementById("bp-clock");
    if (clockEl) {
      clockEl.textContent = clockFormat.format(new Date());
    }
  };
  updateClock();
  setInterval(updateClock, 1000);
}

async function startSysMonitor() {
  let statsBusy = false;
  const updateStats = async () => {
    if (!shouldPoll() || statsBusy) return;
    const invoke = getInvoke();
    if (!invoke) return;
    statsBusy = true;
    try {
      const stats = await invoke("get_system_stats");
      if (stats) {
        const cpuEl = document.getElementById("stat-cpu");
        const ramEl = document.getElementById("stat-ram");
        if (cpuEl) cpuEl.textContent = `${stats.cpu_usage}%`;
        if (ramEl) ramEl.textContent = `${stats.ram_used_gb} / ${stats.ram_total_gb}GB`;
      }
    } catch (e) {
      console.error(e);
    } finally {
      statsBusy = false;
    }
  };
  await updateStats();
  setInterval(updateStats, 2000);
}

let installedRunnersCache = [];
let onlineReleasesCache = [];
let installingRunnerTag = null;

function getDefaultRunner() {
  return localStorage.getItem('nexus_default_runner') || '';
}

function setDefaultRunner(runnerPath) {
  localStorage.setItem('nexus_default_runner', runnerPath);
  showToast(runnerPath ? t('toast.default_runner_saved') : t('toast.default_runner_auto'), 'success');
}

function escapeHtml(str) {
  return String(str ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");
}

function switchRunnersTab(tab) {
  const installedView = document.getElementById('runners-installed-view');
  const onlineView = document.getElementById('runners-online-view');
  const tabInst = document.getElementById('tab-runners-installed');
  const tabOnl = document.getElementById('tab-runners-online');

  const activeCls = "px-3.5 py-2 rounded-xl text-xs font-bold text-indigo-400 bg-indigo-950/60 border border-indigo-800/50 transition";
  const inactiveCls = "px-3.5 py-2 rounded-xl text-xs font-bold text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 border border-transparent transition";

  if (tab === 'installed') {
    installedView?.classList.remove('hidden');
    onlineView?.classList.add('hidden');
    if (tabInst) tabInst.className = activeCls;
    if (tabOnl) tabOnl.className = inactiveCls;
    loadRunners();
  } else {
    installedView?.classList.add('hidden');
    onlineView?.classList.remove('hidden');
    if (tabInst) tabInst.className = inactiveCls;
    if (tabOnl) tabOnl.className = activeCls;
    loadOnlineRunners();
  }
}

async function loadRunners() {
  const container = document.getElementById('runners-list-container');
  const select = document.getElementById('default-runner-select');
  const invoke = getInvoke();
  if (!invoke) return;

  if (container) {
    container.innerHTML = `<div class="text-slate-400 text-xs py-6 text-center">${t("modal.runners.scanning")}</div>`;
  }

  try {
    const runners = await invoke('get_available_runners');
    installedRunnersCache = runners || [];
    availableRunners = installedRunnersCache;

    if (select) {
      const currentDefault = getDefaultRunner();
      select.innerHTML = `<option value="">${t("modal.runners.auto_option")}</option>` +
      installedRunnersCache.map(r =>
      `<option value="${escapeHtml(r.path)}" ${r.path === currentDefault ? 'selected' : ''}>${escapeHtml(r.name)}</option>`
      ).join('');
    }

    if (!container) return;

    if (!installedRunnersCache.length) {
      container.innerHTML = `
      <div class="p-6 text-center bg-slate-900/60 rounded-xl border border-slate-800 space-y-3">
      <p class="text-xs text-slate-400">${t("modal.runners.none_found")}</p>
      <button class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition" onclick="switchRunnersTab('online')">
      ${t("modal.runners.download_now")}
      </button>
      </div>`;
      return;
    }

    container.innerHTML = installedRunnersCache.map(r => {
      const isCustom = r.path.includes('/.nexusdeck/runners/');
      const isDefault = getDefaultRunner() === r.path;
      const runnerType = (r.name.toLowerCase().includes('proton') || r.path.includes('compatibilitytools.d') || isCustom)
      ? 'Proton'
      : 'Wine';
      const escapedPath = r.path.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

      return `
      <div class="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-900/80 border ${isDefault ? 'border-cyan-500/60' : 'border-slate-800'}">
      <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2 flex-wrap">
      <strong class="text-sm font-bold text-white">${escapeHtml(r.name)}</strong>
      <span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-800 text-slate-300 border border-slate-700">${runnerType}</span>
      ${isCustom ? '<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-cyan-950/80 text-cyan-400 border border-cyan-500/30">NexusDeck</span>' : ''}
      ${isDefault ? `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-950/80 text-emerald-400 border border-emerald-500/30">${t("modal.runners.default_badge")}</span>` : ''}
      </div>
      <div class="text-[11px] font-mono text-slate-400 truncate mt-1" title="${escapeHtml(r.path)}">
      ${escapeHtml(r.path)}
      </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
      ${!isDefault ? `<button class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition" onclick="setDefaultRunner('${escapedPath}'); loadRunners();">${t("modal.runners.set_default")}</button>` : ''}
      ${isCustom ? `<button class="px-3 py-1.5 rounded-lg bg-red-950/80 hover:bg-red-900 text-red-400 border border-red-800/50 text-xs font-semibold transition" onclick="removeCustomRunner('${escapedPath}')">${t("modal.runners.delete")}</button>` : ''}
      </div>
      </div>
      `;
    }).join('');
  } catch (err) {
    if (container) {
      container.innerHTML = `<div class="text-xs text-red-400 p-4">${t("modal.runners.detect_error", { err: escapeHtml(String(err)) })}</div>`;
    }
  }
}

async function loadOnlineRunners(forceRefresh = false) {
  const container = document.getElementById('runners-online-container');
  const invoke = getInvoke();
  if (!container || !invoke) return;

  if (onlineReleasesCache.length && !forceRefresh) {
    renderOnlineRunners();
    return;
  }

  container.innerHTML = `<div class="text-slate-400 text-xs py-6 text-center">${t("modal.runners.loading_online")}</div>`;

  try {
    onlineReleasesCache = await invoke('fetch_available_runners');
    renderOnlineRunners();
  } catch (err) {
    container.innerHTML = `<div class="text-xs text-red-400 p-4">${t("modal.runners.online_error", { err: escapeHtml(String(err)) })}</div>`;
  }
}

function renderOnlineRunners() {
  const container = document.getElementById('runners-online-container');
  if (!container) return;

  if (!onlineReleasesCache.length) {
    container.innerHTML = `<div class="text-slate-400 text-xs py-6 text-center">${t("modal.runners.none_online")}</div>`;
    return;
  }

  container.innerHTML = onlineReleasesCache.map(rel => {
    const isBusy = installingRunnerTag === rel.tag_name;
    const anyBusy = installingRunnerTag !== null;
    return `
    <div class="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-900/80 border border-slate-800">
    <div class="min-w-0">
    <div class="flex items-center gap-2 flex-wrap">
    <strong class="text-sm font-bold text-white">${escapeHtml(rel.tag_name)}</strong>
    <span class="text-[11px] text-slate-400">• ${escapeHtml(rel.published_at)}</span>
    <span class="text-[11px] font-mono text-cyan-400">• ~${rel.size_mb} MB</span>
    </div>
    <div class="text-[11px] font-mono text-slate-400 truncate mt-1">${escapeHtml(rel.asset_name)}</div>
    </div>
    <div class="shrink-0">
    ${rel.installed
      ? `<span class="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-950/80 text-emerald-400 border border-emerald-500/30">${t("modal.runners.installed_badge")}</span>`
      : `<button class="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold transition" ${anyBusy ? 'disabled' : ''} onclick="downloadAndInstallRunner('${escapeHtml(rel.tag_name)}', '${escapeHtml(rel.download_url)}', '${escapeHtml(rel.asset_name)}')">
      ${isBusy ? t("modal.runners.installing_btn") : t("modal.runners.install_btn")}
      </button>`
    }
    </div>
    </div>
    `;
  }).join('');
}

async function downloadAndInstallRunner(tagName, downloadUrl, assetName) {
  const invoke = getInvoke();
  if (installingRunnerTag || !invoke) return;
  installingRunnerTag = tagName;

  const banner = document.getElementById('runner-install-banner');
  const msg = document.getElementById('runner-install-msg');
  if (banner && msg) {
    banner.classList.remove('hidden');
    msg.textContent = t("modal.runners.downloading_tag", { tag: tagName });
  }

  renderOnlineRunners();

  try {
    const resMsg = await invoke('install_runner_release', {
      tagName,
      downloadUrl,
      assetName
    });

    showToast(resMsg, 'success');
    const item = onlineReleasesCache.find(r => r.tag_name === tagName);
    if (item) item.installed = true;
    await loadRunners();
  } catch (err) {
    showToast(t('toast.runner_install_error', { tag: tagName, err }), 'error');
  } finally {
    installingRunnerTag = null;
    if (banner) banner.classList.add('hidden');
    renderOnlineRunners();
  }
}

async function removeCustomRunner(runnerPath) {
  const invoke = getInvoke();
  if (!invoke) return;
  try {
    await invoke('delete_custom_runner', { runnerPath });
    if (getDefaultRunner() === runnerPath) {
      localStorage.removeItem('nexus_default_runner');
    }
    onlineReleasesCache = [];
    showToast(t('toast.runner_deleted'), 'info');
    await loadRunners();
  } catch (err) {
    showToast(String(err), 'error');
  }
}

window.switchRunnersTab = switchRunnersTab;
window.setDefaultRunner = setDefaultRunner;
window.loadRunners = loadRunners;
window.downloadAndInstallRunner = downloadAndInstallRunner;
window.removeCustomRunner = removeCustomRunner;

async function loadGames() {
  const invoke = getInvoke();
  if (!invoke) return;
  try {
    games = await invoke("load_saved_games");
  } catch (e) {
    console.error("Error loading games:", e);
  }
}

async function saveGamesToDisk() {
  const invoke = getInvoke();
  if (!invoke) return;
  try {
    await invoke("save_games", { games });
  } catch (e) {
    showToast(t("toast.error_generic", { err: e }), "error");
  }
}

async function fetchCoverForGame(game) {
  if (!game) return;

  showToast(t("toast.searching_cover", { title: game.title }), "info");

  const invoke = getInvoke();
  if (!invoke) return;

  try {
    const foundUrl = await invoke("search_cover_art", { title: game.title });

    if (foundUrl) {
      game.cover_url = foundUrl;
      await saveGamesToDisk();
      renderGames();
      showToast(t("toast.cover_found", { title: game.title }), "success");
    } else {
      showToast(t("toast.cover_not_found", { title: game.title }), "info");
    }
  } catch (e) {
    showToast(t("toast.error_generic", { err: e }), "error");
  }
}

async function syncExternalGames() {
  const invoke = getInvoke();
  if (!invoke) return;

  try {
    const scannedGames = await invoke("scan_external_launchers");
    let addedCount = 0;
    let updatedCount = 0;

    scannedGames.forEach(scanned => {
      const existingGame = games.find(g => g.id === scanned.id || g.title.toLowerCase() === scanned.title.toLowerCase());

      if (!existingGame) {
        games.push(scanned);
        addedCount++;
      } else {
        const wasInstalled = checkInstalled(existingGame);
        const isNowInstalled = scanned.is_installed || (scanned.exe_path && !scanned.exe_path.includes("steam://install/"));

        if (!wasInstalled && isNowInstalled) {
          existingGame.is_installed = true;
          if (scanned.exe_path) existingGame.exe_path = scanned.exe_path;
          updatedCount++;
        }
      }
    });

    if (addedCount > 0 || updatedCount > 0) {
      await saveGamesToDisk();
      renderGames();
      renderSidebarTags();
      showToast(t("toast.sync_complete", { added: addedCount, updated: updatedCount }), "success");
    } else {
      showToast(t("toast.sync_uptodate"), "info");
    }
  } catch (e) {
    showToast(t("toast.error_generic", { err: e }), "error");
  }
  enrichSteamTitles();
  enrichProtonDbRatings();
}

function getRunnerDisplayName(path) {
  if (!path || path === "/usr/bin/wine") return "System Wine";
  if (path.includes("lutris")) return "Lutris Wine";
  if (path.includes("Proton") || path.includes("compatibilitytools")) return "Proton GE";
  return "Custom Runner";
}

function getSourceTag(game) {
  if (game.source) {
    const src = game.source.toLowerCase();
    if (src === "steam" || game.exe_path?.startsWith("steam://")) return "STEAM";
      if (src === "epic") return "EPIC";
      if (src === "gog") return "GOG";
      if (src === "heroic" || game.exe_path?.startsWith("heroic://")) return "HEROIC";
        if (src === "lutris" || game.exe_path?.startsWith("lutris:")) return "LUTRIS";
        if (src === "custom") return "CUSTOM";
  }

  if (game.runner_path === "/usr/bin/wine") return "WINE";
  if (game.runner_path?.includes("lutris")) return "LUTRIS";
  if (game.runner_path?.includes("Proton")) return "PROTON";

  return "NATIVE";
}

function getSourceBadgeClass(sourceTag) {
  switch (sourceTag) {
    case "STEAM":
      return "text-cyan-400 border-cyan-500/30";
    case "HEROIC":
    case "EPIC":
      return "text-purple-400 border-purple-500/30";
    case "LUTRIS":
      return "text-amber-400 border-amber-500/30";
    default:
      return "text-emerald-400 border-emerald-500/30";
  }
}

function getAllUniqueTags() {
  const tagSet = new Set();
  games.forEach(g => {
    if (g.tags && Array.isArray(g.tags)) {
      g.tags.forEach(tag => tagSet.add(tag.trim()));
    }
  });
  return Array.from(tagSet);
}

function renderSidebarTags() {
  const container = document.getElementById("sidebar-tags-container");
  if (!container) return;

  const tags = getAllUniqueTags();
  if (tags.length === 0) {
    container.innerHTML = `<span class="text-[11px] text-slate-500 px-3 italic">${t("sidebar.no_collections")}</span>`;
    return;
  }

  container.innerHTML = tags.map(tag => `
  <div data-tag-filter="${escapeHtml(tag)}" class="sidebar-tag-item group flex items-center justify-between px-3 py-1.5 rounded-lg hover:bg-slate-800/40 cursor-pointer ${selectedTagFilter === tag ? "bg-indigo-950/60 text-indigo-400 font-bold" : ""}">
  <span class="flex items-center gap-2 truncate">
  <i data-lucide="tag" class="w-3.5 h-3.5 text-pink-400 shrink-0"></i>
  <span class="truncate">${escapeHtml(tag)}</span>
  </span>
  <div class="flex items-center gap-1">
  <span class="text-[10px] font-mono bg-slate-800 px-1.5 py-0.5 rounded text-slate-400">${games.filter(g => g.tags && g.tags.includes(tag)).length}</span>
  <button class="btn-edit-tag p-1 text-slate-500 hover:text-indigo-300 opacity-0 group-hover:opacity-100 transition" data-tag="${escapeHtml(tag)}" title="${t("lib.edit_tag_title")}">
  <i data-lucide="pencil" class="w-3 h-3"></i>
  </button>
  <button class="btn-delete-tag p-1 text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition" data-tag="${escapeHtml(tag)}" title="${t("lib.delete_tag_title")}">
  <i data-lucide="trash-2" class="w-3 h-3"></i>
  </button>
  </div>
  </div>
  `).join("");

  container.querySelectorAll(".sidebar-tag-item").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".btn-edit-tag") || e.target.closest(".btn-delete-tag")) return;
      const tag = el.dataset.tagFilter;
      selectedTagFilter = selectedTagFilter === tag ? "all" : tag;
      renderSidebarTags();
      renderGames();
    });
  });

  container.querySelectorAll(".btn-edit-tag").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      renameGlobalTag(btn.dataset.tag);
    });
  });

  container.querySelectorAll(".btn-delete-tag").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteGlobalTag(btn.dataset.tag);
    });
  });

  if (window.lucide) window.lucide.createIcons();
}

function showContextMenu(e, game) {
  e.preventDefault();
  e.stopPropagation();
  selectedCtxGame = game;

  const hideTextEl = document.getElementById("ctx-hide-text");
  if (hideTextEl) {
    hideTextEl.textContent = game.hidden ? t("ctx.unhide") : t("ctx.hide");
  }

  const ctxMenu = document.getElementById("custom-context-menu");
  if (!ctxMenu) return;

  if (ctxMenu.parentElement !== document.body) {
    document.body.appendChild(ctxMenu);
  }

  ctxMenu.style.position = "fixed";
  ctxMenu.style.zIndex = "999999";
  ctxMenu.classList.remove("hidden");

  const rect = ctxMenu.getBoundingClientRect();
  const menuWidth = rect.width || 220;
  const menuHeight = rect.height || 320;

  const windowWidth = window.innerWidth;
  const windowHeight = window.innerHeight;

  let posX = e.clientX;
  let posY = e.clientY;

  if (posX + menuWidth > windowWidth - 12) {
    posX = posX - menuWidth;
  }

  if (posY + menuHeight > windowHeight - 12) {
    posY = posY - menuHeight;
  }

  posX = Math.max(10, posX);
  posY = Math.max(10, posY);

  ctxMenu.style.left = `${posX}px`;
  ctxMenu.style.top = `${posY}px`;

  const wineWrapper = document.getElementById("ctx-wine-tools-wrapper");
  const wineSubmenu = document.getElementById("ctx-wine-tools-submenu");

  if (wineWrapper) {
    const src = getSourceTag(game);
    const isNonNativeLinux = !isWindows && src !== "STEAM" && src !== "NATIVE";
    wineWrapper.classList.toggle("hidden", !isNonNativeLinux);
  }

  if (wineSubmenu) {
    wineSubmenu.classList.add("hidden");
    const submenuWidth = 215;
    const submenuHeight = 250;

    if (posX + menuWidth + submenuWidth > windowWidth - 12) {
      wineSubmenu.classList.remove("left-full", "ml-1.5");
      wineSubmenu.classList.add("right-full", "mr-1.5");
    } else {
      wineSubmenu.classList.remove("right-full", "mr-1.5");
      wineSubmenu.classList.add("left-full", "ml-1.5");
    }

    if (posY + submenuHeight > windowHeight - 12) {
      wineSubmenu.classList.remove("top-0");
      wineSubmenu.classList.add("bottom-0");
    } else {
      wineSubmenu.classList.remove("bottom-0");
      wineSubmenu.classList.add("top-0");
    }
  }

  if (window.lucide) window.lucide.createIcons();
}

function initGamesContainerEvents() {
  const container = document.getElementById("games-container");
  if (!container || container.dataset.listenerAttached) return;

  container.addEventListener("click", async (e) => {
    const protonBtn = e.target.closest(".btn-protondb");
    if (protonBtn) {
      e.stopPropagation();
      const appId = protonBtn.dataset.protonAppid;
      if (appId) {
        const invoke = getInvoke();
        if (invoke) {
          invoke("open_external_url", { url: `https://www.protondb.com/app/${appId}` });
        }
      }
      return;
    }
    const card = e.target.closest("[data-game-id]");
    if (!card) return;

    const gameId = card.dataset.gameId;
    const game = games.find(g => g.id === gameId);
    if (!game) return;

    if (e.target.closest(".btn-stop")) {
      e.stopPropagation();
      const invoke = getInvoke();
      if (invoke) {
        await invoke("kill_game_process", { gameId: game.id });
        showToast(t("toast.force_stop", { title: game.title }), "info");
      }
    } else if (e.target.closest(".btn-play")) {
      e.stopPropagation();
      if (runningGames[game.id]) return;
      launchGame(game);
    } else if (e.target.closest(".btn-install")) {
      e.stopPropagation();

      if (getSourceTag(game) === "STEAM" || game.id.startsWith("steam_")) {
        if (installingGames[game.id] !== undefined) return;
        const appId = game.id.replace("steam_", "");
        const invoke = getInvoke();
        if (invoke) {
          invoke("launch_game", { game: { ...game, exe_path: `steam://install/${appId}` } })
          .then(() => {
            showToast(t("toast.steam_installing", { title: game.title }), "info");
            startSteamInstallTracking(game);
          })
          .catch((err) => showToast(t("toast.error_generic", { err }), "error"));
        }
      } else if (getSourceTag(game) === "EPIC" || game.id.startsWith("epic_")) {
        if (installingGames[game.id] !== undefined) return;
        openEpicInstallModal(game);
      } else {
        openEditModal(game);
      }
    } else if (e.target.closest(".btn-fav")) {
      e.stopPropagation();
      game.favorite = !game.favorite;
      await saveGamesToDisk();
      renderGames();
    } else if (e.target.closest(".btn-edit")) {
      e.stopPropagation();
      openEditModal(game);
    } else if (e.target.closest(".btn-delete")) {
      e.stopPropagation();
      openRemoveConfirmModal(game);
    }
  });

  container.addEventListener("contextmenu", (e) => {
    const card = e.target.closest("[data-game-id]");
    if (!card) return;
    const gameId = card.dataset.gameId;
    const game = games.find(g => g.id === gameId);
    if (game) {
      showContextMenu(e, game);
    }
  });

  container.dataset.listenerAttached = "true";
}

function formatPlaytime(minutes) {
  if (!minutes || minutes <= 0) return null;
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hrs > 0) {
    return `${hrs}h ${mins}m`;
  }
  return `${mins}m`;
}

function checkInstalled(game) {
  if (!game) return false;
  if (game.is_installed !== undefined) return game.is_installed;
  if (game.installed !== undefined) return game.installed;
  if (game.source === "steam" && game.is_installed === false) return false;
  if (game.exe_path && game.exe_path.trim() !== "" && !game.exe_path.includes("steam://install/")) {
    return true;
  }
  return false;
}

// ==========================================
// RANDARE INCREMENTALĂ A BIBLIOTECII (desktop)
// ==========================================
const gameNodeCache = new Map();
const gameCollator = new Intl.Collator();
let iconStagingEl = null;

function createIconsForNodes(nodes) {
  if (!window.lucide || nodes.length === 0) return;
  if (!iconStagingEl) {
    iconStagingEl = document.createElement("div");
    iconStagingEl.hidden = true;
    iconStagingEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(iconStagingEl);
  }
  const frag = document.createDocumentFragment();
  nodes.forEach((n) => frag.appendChild(n));
  iconStagingEl.appendChild(frag);
  try {
    window.lucide.createIcons({ root: iconStagingEl });
  } catch (e) {
    window.lucide.createIcons();
  }
}

function reconcileChildren(container, nodes) {
  const keep = new Set(nodes);
  for (let child = container.firstChild; child; ) {
    const next = child.nextSibling;
    if (!keep.has(child)) container.removeChild(child);
    child = next;
  }
  let ref = container.firstChild;
  for (const node of nodes) {
    if (node === ref) {
      ref = ref.nextSibling;
    } else {
      container.insertBefore(node, ref);
    }
  }
}

function pruneGameNodeCache(mode) {
  const liveIds = new Set(games.map((g) => g.id));
  for (const [key, entry] of gameNodeCache) {
    if (entry.mode && entry.mode !== mode) {
      gameNodeCache.delete(key);
    } else if (entry.gameId && !liveIds.has(entry.gameId)) {
      gameNodeCache.delete(key);
    }
  }
}

function renderGames() {
  const container = document.getElementById("games-container");
  if (!container) return;

  const searchInput = document.getElementById("game-search-input");
  const rawSearchTerm = searchInput ? searchInput.value.trim() : "";
  const searchTerm = rawSearchTerm.toLowerCase();

  const instMemo = new Map();
  const isInst = (g) => {
    let v = instMemo.get(g);
    if (v === undefined) {
      v = checkInstalled(g);
      instMemo.set(g, v);
    }
    return v;
  };
  const tagMemo = new Map();
  const srcTag = (g) => {
    let v = tagMemo.get(g);
    if (v === undefined) {
      v = getSourceTag(g);
      tagMemo.set(g, v);
    }
    return v;
  };

  const validGames = games.filter(g => !isToolOrRuntime(g.title));

  const hiddenCount = validGames.filter(g => g.hidden === true).length;
  const visibleGames = validGames.filter(g => !g.hidden);
  const installedGames = visibleGames.filter(isInst);

  if (document.getElementById("count-installed")) {
    document.getElementById("count-installed").textContent = installedGames.length;
  }
  if (document.getElementById("count-favorites")) {
    document.getElementById("count-favorites").textContent = visibleGames.filter(g => g.favorite).length;
  }
  if (document.getElementById("count-hidden")) {
    document.getElementById("count-hidden").textContent = hiddenCount;
  }

  updateSourceSidebarUi();

  let displayGames = [...validGames];
  const libTitle = document.getElementById("library-title");

  if (searchTerm.length > 0) {
    displayGames = displayGames.filter(g => g.title.toLowerCase().includes(searchTerm));
    if (libTitle) libTitle.textContent = t("lib.search_results", { query: rawSearchTerm });
  } else {
    if (activeTab === "hidden") {
      displayGames = displayGames.filter(g => g.hidden === true);
      if (libTitle) libTitle.textContent = t("lib.hidden_games");
    } else {
      displayGames = displayGames.filter(g => !g.hidden);

      if (activeTab === "favorites") {
        displayGames = displayGames.filter(g => g.favorite);
        if (libTitle) libTitle.textContent = t("lib.favorite_games");
      }
    }

    if (selectedTagFilter !== "all") {
      displayGames = displayGames.filter(g => g.tags && g.tags.includes(selectedTagFilter));
      if (libTitle) libTitle.textContent = t("lib.collection_prefix", { name: selectedTagFilter });
    }

    if (activeSource !== "all") {
      const activeLower = activeSource.toLowerCase();
      displayGames = displayGames.filter(g => srcTag(g).toLowerCase() === activeLower);
      if (libTitle) libTitle.textContent = t("lib.source_prefix", { source: activeSource.toUpperCase() });
    } else if (activeTab === "installed") {
      displayGames = displayGames.filter(isInst);
      if (libTitle) libTitle.textContent = t("lib.installed_games");
    } else if (activeTab !== "hidden" && activeTab !== "favorites" && selectedTagFilter === "all") {
      if (libTitle) libTitle.textContent = t("lib.all_games");
    }
  }

  if (selectedSort === "name-asc") {
    displayGames.sort((a, b) => gameCollator.compare(a.title, b.title));
  } else if (selectedSort === "name-desc") {
    displayGames.sort((a, b) => gameCollator.compare(b.title, a.title));
  } else if (selectedSort === "source-asc") {
    displayGames.sort((a, b) => gameCollator.compare(srcTag(a), srcTag(b)));
  } else if (selectedSort === "source-desc") {
    displayGames.sort((a, b) => gameCollator.compare(srcTag(b), srcTag(a)));
  }

  const countBadge = document.getElementById("library-count-badge");
  if (countBadge) countBadge.textContent = t("lib.items_count", { count: displayGames.length });

  if (displayGames.length === 0) {
    const empty = document.createElement("div");
    empty.className = "col-span-full py-20 flex flex-col items-center justify-center text-slate-500";
    empty.innerHTML = `<i data-lucide="folder-open" class="w-10 h-10 mb-2 opacity-50"></i>
    <p class="text-sm font-medium">${t("lib.no_games")}</p>`;
    createIconsForNodes([empty]);
    reconcileChildren(container, [empty]);
    return;
  }

  const mode = viewMode === "grid" ? "grid" : "list";
  const freshNodes = [];
  const lang = getLanguage();

  const cachedNode = (key, sig, entryMode, gameId, build) => {
    const hit = gameNodeCache.get(key);
    if (hit && hit.sig === sig) return hit.el;
    const el = build();
    gameNodeCache.set(key, { sig, el, mode: entryMode, gameId });
    freshNodes.push(el);
    return el;
  };

  const gameSig = (game) => {
    const pct = installingGames[game.id];
    return [
      lang,
      isInst(game) ? 1 : 0,
      runningGames[game.id] || "",
      pct === undefined ? "" : Math.round(pct),
      game.cover_url || "",
      game.title,
      game.favorite ? 1 : 0,
      (game.tags || []).join("\u0001"),
      game.playtime_minutes || 0,
      getRunnerDisplayName(game.runner_path),
      srcTag(game),
      game.protondb_tier || "",
      game.steam_app_id || "",
    ].join("\u0000");
  };

  const createGameCard = (game) => {
    const inst = isInst(game);
    const gameStatus = runningGames[game.id];
    const isInstalling = installingGames[game.id] !== undefined;

    const card = document.createElement("div");
    card.className = `glass-card card-glow-hover group relative cursor-pointer w-full flex flex-col border border-slate-800/80 rounded-2xl overflow-hidden ${
      !inst && !isInstalling ? "grayscale opacity-60 hover:grayscale-0 hover:opacity-100 transition-all duration-300" : ""
    }`;
    card.dataset.gameId = game.id;

    let statusBadge = `<span class="text-emerald-400 font-bold flex items-center gap-1 shrink-0 ml-1"><i data-lucide="check-circle" class="w-3.5 h-3.5"></i> ${t("game.status.installed")}</span>`;
    if (gameStatus === "starting") {
      statusBadge = `<span class="text-amber-400 font-bold flex items-center gap-1 shrink-0 ml-1 animate-pulse"><i data-lucide="loader" class="w-3.5 h-3.5 animate-spin"></i> ${t("game.status.starting")}</span>`;
    } else if (gameStatus === "playing") {
      statusBadge = `<span class="text-emerald-400 font-bold flex items-center gap-1 shrink-0 ml-1 animate-pulse"><i data-lucide="play" class="w-3.5 h-3.5"></i> ${t("game.status.playing")}</span>`;
    } else if (isInstalling) {
      const pct = installingGames[game.id];
      const label = pct > 0 ? t("game.status.installing_pct", { pct: pct.toFixed(0) }) : t("game.status.installing");
      statusBadge = `<span class="text-cyan-400 font-bold flex items-center gap-1 shrink-0 ml-1 animate-pulse"><i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> <span data-installing-badge="${game.id}">${label}</span></span>`;
    } else if (!inst) {
      statusBadge = `<span class="text-slate-400 font-bold flex items-center gap-1 shrink-0 ml-1"><i data-lucide="download-cloud" class="w-3.5 h-3.5"></i> ${t("game.status.uninstalled")}</span>`;
    }

    let mainActionButton = `<button class="btn-play p-3.5 rounded-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition shadow-xl shadow-emerald-500/40"><i data-lucide="play" class="w-5 h-5 fill-current"></i></button>`;

    if (gameStatus === "playing") {
      mainActionButton = `<button class="btn-stop p-3.5 rounded-full bg-red-600 hover:bg-red-500 text-white transition shadow-xl shadow-red-600/40" title="${t("game.btn.force_stop_title")}"><i data-lucide="square" class="w-5 h-5 fill-current"></i></button>`;
    } else if (isInstalling) {
      const pct = installingGames[game.id];
      const label = pct > 0 ? t("game.status.installing_pct", { pct: pct.toFixed(0) }) : t("game.status.installing");
      mainActionButton = `<div class="px-4 py-2.5 rounded-full bg-cyan-500/20 border border-cyan-400/60 text-cyan-300 font-bold text-xs flex items-center gap-2 shadow-xl backdrop-blur-md cursor-default"><i data-lucide="loader-2" class="w-4 h-4 animate-spin text-cyan-400"></i><span data-installing-pill="${game.id}">${label}</span></div>`;
    } else if (!inst) {
      mainActionButton = `<button class="btn-install p-3.5 rounded-full bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition shadow-xl shadow-cyan-500/40" title="${t("game.btn.install_title")}"><i data-lucide="download" class="w-5 h-5"></i></button>`;
    }

    const coverImg = game.cover_url || "";
    const runnerName = getRunnerDisplayName(game.runner_path);
    const sourceTag = srcTag(game);
    const badgeClass = getSourceBadgeClass(sourceTag);

    const displayTags = (game.tags || []).filter(tag => {
      const lower = tag.toLowerCase();
      return lower !== "installed" && lower !== "lutris" && lower !== "epic games" && lower !== "steam" && lower !== "gog";
    });

    const tagsHtml = displayTags.length > 0
    ? displayTags.map(tag => `<span class="px-1.5 py-0.5 rounded text-[9px] bg-pink-950/80 text-pink-300 border border-pink-700/50">${escapeHtml(tag)}</span>`).join(" ")
    : "";

    const playtimeText = formatPlaytime(game.playtime_minutes);
    const playtimeBadge = playtimeText
    ? `<span class="text-[10px] text-cyan-400 font-mono font-semibold flex items-center gap-1" title="${t("game.playtime_title")}"><i data-lucide="clock" class="w-3 h-3 text-cyan-400"></i> ${playtimeText}</span>`
    : "";

    const imgElement = coverImg
    ? `<img src="${coverImg}" loading="lazy" decoding="async" class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">`
    : "";

    const fallbackPlaceholder = `
    <div class="w-full h-full bg-slate-900 flex flex-col items-center justify-center p-4 text-center ${coverImg ? 'hidden' : 'flex'}">
    <i data-lucide="gamepad-2" class="w-10 h-10 text-slate-700 mb-2"></i>
    <span class="text-xs font-bold text-slate-400 line-clamp-2">${escapeHtml(game.title)}</span>
    </div>
    `;

    card.innerHTML = `
    <div class="relative w-full aspect-[3/4] overflow-hidden bg-slate-900 rounded-t-2xl">
    ${imgElement}
    ${fallbackPlaceholder}
    <div class="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-transparent to-transparent"></div>

    <div class="absolute top-3 left-3 z-30 flex flex-col items-start gap-1.5">
    <span class="px-2.5 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-slate-950/80 ${badgeClass} border">
    ${sourceTag}
    </span>
    ${getProtonDbBadgeHtml(game)}
    </div>

    <button class="btn-fav absolute top-3 right-3 z-30 p-2 rounded-full bg-slate-950/80 hover:bg-slate-900 text-amber-400 transition" data-id="${game.id}">
    <i data-lucide="star" class="w-4 h-4 ${game.favorite ? "fill-current" : ""}"></i>
    </button>

    ${isInstalling ? `
      <div class="absolute bottom-3 left-3 right-3 z-10 px-3 py-1.5 rounded-xl bg-slate-950/90 border border-cyan-500/40 backdrop-blur-md flex items-center justify-between text-xs font-bold text-cyan-400 shadow-lg group-hover:opacity-0 transition-opacity">
      <span class="flex items-center gap-1.5"><i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> ${t("game.status.installing")}</span>
      <span class="font-mono text-[11px]" data-installing-cover="${game.id}">${installingGames[game.id] > 0 ? installingGames[game.id].toFixed(0) + "%" : "..."}</span>
      </div>
      ` : ""}

      <div class="absolute inset-0 bg-slate-950/80 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center gap-2.5 z-20 pointer-events-none group-hover:pointer-events-auto">
      ${mainActionButton}
      ${inst ? `
        <button class="btn-edit p-3 rounded-full bg-purple-950/90 text-purple-300 hover:bg-purple-900 transition">
        <i data-lucide="settings" class="w-4 h-4"></i>
        </button>
        <button class="btn-delete p-3 rounded-full bg-red-950/90 text-red-400 hover:bg-red-900 transition">
        <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
        ` : ""}
        </div>
        </div>

        <div class="p-3.5 bg-slate-900/90 flex-1 flex flex-col justify-between rounded-b-2xl">
        <div>
        <h3 class="font-extrabold text-sm text-slate-100 truncate group-hover:text-indigo-300 transition-colors">${escapeHtml(game.title)}</h3>
        <span class="text-xs text-slate-400 font-mono block mt-1">${runnerName}</span>
        </div>

        <div class="mt-3 flex items-center justify-between text-xs">
        <div class="flex items-center gap-1.5 flex-wrap">
        ${playtimeBadge}
        ${tagsHtml}
        </div>
        ${statusBadge}
        </div>
        </div>
        `;
        return card;
  };

  const createListRow = (game) => {
    const inst = isInst(game);
    const gameStatus = runningGames[game.id];
    const isInstalling = installingGames[game.id] !== undefined;

    const item = document.createElement("div");
    item.className = `glass-panel p-3 rounded-xl flex items-center justify-between hover:border-indigo-500/50 cursor-pointer ${
      !inst && !isInstalling ? "grayscale opacity-60 hover:grayscale-0 hover:opacity-100 transition-all duration-300" : "transition"
    }`;
    item.dataset.gameId = game.id;

    let mainActionButton = `<button class="btn-play px-4 py-2 bg-emerald-500 text-slate-950 font-bold rounded-lg hover:bg-emerald-400 transition text-xs flex items-center gap-1.5"><i data-lucide="play" class="w-4 h-4 fill-current"></i> ${t("game.btn.launch")}</button>`;

    if (gameStatus === "playing") {
      mainActionButton = `<button class="btn-stop px-4 py-2 bg-red-600 text-white font-bold rounded-lg hover:bg-red-500 transition text-xs flex items-center gap-1.5"><i data-lucide="square" class="w-4 h-4 fill-current"></i> ${t("game.btn.stop")}</button>`;
    } else if (isInstalling) {
      const pct = installingGames[game.id];
      const label = pct > 0 ? t("game.status.installing_list_pct", { pct: pct.toFixed(0) }) : t("game.status.installing");
      mainActionButton = `<span class="px-4 py-2 bg-cyan-500/15 border border-cyan-500/40 text-cyan-400 font-bold rounded-lg text-xs flex items-center gap-1.5"><i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> <span data-installing-list="${game.id}">${label}</span></span>`;
    } else if (!inst) {
      mainActionButton = `<button class="btn-install px-4 py-2 bg-cyan-500 text-slate-950 font-bold rounded-lg hover:bg-cyan-400 transition text-xs flex items-center gap-1.5"><i data-lucide="download" class="w-4 h-4"></i> ${t("game.btn.install")}</button>`;
    }

    const coverImg = game.cover_url || "";
    const imgElement = coverImg
    ? `<img src="${coverImg}" loading="lazy" decoding="async" class="w-12 h-16 object-cover rounded-lg shrink-0" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">`
    : "";

    const fallbackPlaceholder = `
    <div class="w-12 h-16 bg-slate-900 rounded-lg shrink-0 flex items-center justify-center ${coverImg ? 'hidden' : ''}">
    <i data-lucide="gamepad-2" class="w-6 h-6 text-slate-700"></i>
    </div>
    `;

    item.innerHTML = `
    <div class="flex items-center gap-4">
    ${imgElement}
    ${fallbackPlaceholder}
    <div>
    <h4 class="font-extrabold text-base text-white">${escapeHtml(game.title)}</h4>
    <div class="flex items-center gap-2 mt-0.5">
    <span class="text-xs text-cyan-400 font-mono">${getRunnerDisplayName(game.runner_path)}</span>
    ${getProtonDbBadgeHtml(game, true)}
    </div>
    </div>
    </div>
    <div class="flex items-center gap-3">
    ${mainActionButton}
    ${inst ? `
      <button class="btn-edit p-2 list-btn-settings rounded-lg transition"><i data-lucide="settings" class="w-4 h-4"></i></button>
      <button class="btn-delete p-2 list-btn-delete rounded-lg transition"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
      ` : ""}
      </div>
      `;
      return item;
  };

  const createSectionHeader = (key, title, count, iconName, colorClass) => {
    return cachedNode(`h|${key}`, `${lang}|${count}|${iconName}|${colorClass}`, null, null, () => {
      const div = document.createElement("div");
      div.className = "w-full col-span-full flex items-center gap-3 pt-4 pb-2 border-b border-slate-800/80 mt-2 mb-1";
      div.innerHTML = `
      <div class="flex items-center gap-2.5">
      <i data-lucide="${iconName}" class="w-5 h-5 ${colorClass}"></i>
      <h2 class="text-xs font-black text-slate-300 uppercase tracking-widest">${title}</h2>
      </div>
      <span class="px-2 py-0.5 rounded-full text-[10px] font-mono bg-slate-900 border border-slate-800 text-slate-400">${count}</span>
      `;
      return div;
    });
  };

  const gameNode = (game) =>
  cachedNode(
    `${mode}|${game.id}`,
    gameSig(game),
             mode,
             game.id,
             () => (mode === "grid" ? createGameCard(game) : createListRow(game))
  );

  const nodes = [];

  const containerClass = mode === "grid"
  ? "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 items-start"
  : "flex flex-col space-y-2.5 w-full";
  if (container.className !== containerClass) container.className = containerClass;

  if (activeSource !== "all" && searchTerm.length === 0) {
    const installedPart = displayGames.filter(isInst);
    const uninstalledPart = displayGames.filter(g => !isInst(g));

    if (installedPart.length > 0) {
      nodes.push(createSectionHeader("inst", t("lib.installed_games"), installedPart.length, "download-cloud", "text-emerald-400"));
      installedPart.forEach(g => nodes.push(gameNode(g)));
    }

    if (uninstalledPart.length > 0) {
      nodes.push(createSectionHeader("uninst", t("lib.uninstalled_cloud"), uninstalledPart.length, "cloud", "text-slate-400"));
      uninstalledPart.forEach(g => nodes.push(gameNode(g)));
    }
  } else {
    displayGames.forEach(g => nodes.push(gameNode(g)));
  }

  createIconsForNodes(freshNodes);
  reconcileChildren(container, nodes);
  pruneGameNodeCache(mode);
}

function openTagsModal(game) {
  if (!game) return;
  selectedCtxGame = game;
  const tagsModalTitle = document.getElementById("tags-modal-title");
  if (tagsModalTitle) tagsModalTitle.textContent = t("modal.tags.title_for", { title: game.title });
  const inpTags = document.getElementById("inp-tags-list");
  if (inpTags) inpTags.value = game.tags ? game.tags.join(", ") : "";
  openModalAnimated("tags-modal");
}

function populateGameRunnerSelect(selRunner, game) {
  selRunner.innerHTML = `<option value="/usr/bin/wine">${t("modal.game.system_wine")}</option>`;

  (availableRunners || []).forEach(r => {
    if (!r?.path || r.path === "/usr/bin/wine") return;
    const opt = document.createElement("option");
    opt.value = r.path;
    opt.textContent = r.name || getRunnerDisplayName(r.path);
    selRunner.appendChild(opt);
  });

  const targetPath = (game && game.runner_path) ? game.runner_path : (getDefaultRunner() || "/usr/bin/wine");

  if (targetPath && ![...selRunner.options].some(o => o.value === targetPath)) {
    const fallbackOpt = document.createElement("option");
    fallbackOpt.value = targetPath;
    fallbackOpt.textContent = getRunnerDisplayName(targetPath);
    selRunner.appendChild(fallbackOpt);
  }

  selRunner.value = targetPath;
}

function openEditModal(game = null) {
  editingGameId = game ? game.id : null;
  const modalTitle = document.getElementById("modal-title");
  if (modalTitle) {
    modalTitle.innerHTML = game
    ? `<i data-lucide="settings" class="w-5 h-5 text-purple-400"></i> ${t("modal.game.settings_title", { title: escapeHtml(game.title) })}`
    : `<i data-lucide="plus" class="w-5 h-5 text-indigo-400"></i> ${t("modal.game.add_title")}`;
  }

  const advContainer = document.getElementById("advanced-options-container");
  const advChevron = document.getElementById("advanced-chevron");
  if (advContainer) advContainer.classList.add("hidden");
  if (advChevron) advChevron.classList.remove("rotate-180");

  const inpTitle = document.getElementById("inp-title");
  if (inpTitle) inpTitle.value = game ? game.title : "";
  const inpExe = document.getElementById("inp-exepath");
  if (inpExe) inpExe.value = game ? game.exe_path : "";
  const inpPrefix = document.getElementById("inp-wineprefix");
  if (inpPrefix) inpPrefix.value = game ? (game.wine_prefix || "") : "";
  const inpArgs = document.getElementById("inp-args");
  if (inpArgs) inpArgs.value = game ? (game.launch_args || "") : "";
  const inpCover = document.getElementById("inp-cover");
  if (inpCover) inpCover.value = game ? (game.cover_url || "") : "";
  const inpSavePath = document.getElementById("edit-game-save-path");
  if (inpSavePath) inpSavePath.value = game ? (game.save_path || "") : "";

  const backupSection = document.querySelector(".backup-manager-section");
  if (backupSection) {
    if (game) {
      backupSection.classList.remove("hidden");
      renderGameBackups(game);
    } else {
      // Ascundem secțiunea de backup când adaugi un joc nou (încă nu are ID salvat)
      backupSection.classList.add("hidden");
    }
  }
  const chkGm = document.getElementById("chk-gamemode");
  if (chkGm) chkGm.checked = game ? (game.use_gamemode !== undefined ? game.use_gamemode : true) : true;
  const chkMh = document.getElementById("chk-mangohud");
  if (chkMh) chkMh.checked = game ? (game.use_mangohud !== undefined ? game.use_mangohud : true) : true;

  const selRunner = document.getElementById("select-runner");
  if (selRunner) {
    if (!availableRunners || availableRunners.length === 0) {
      loadRunners().then(() => {
        if (document.getElementById("game-modal") && !document.getElementById("game-modal").classList.contains("hidden")) {
          populateGameRunnerSelect(selRunner, game);
        }
      });
    } else {
      populateGameRunnerSelect(selRunner, game);
    }
  }

  const dllContainer = document.getElementById("dll-overrides-list");
  const envContainer = document.getElementById("env-vars-list");
  if (dllContainer) dllContainer.innerHTML = "";
  if (envContainer) envContainer.innerHTML = "";

  const envs = game && game.env_vars ? game.env_vars : {};

  const chkDxvk = document.getElementById("chk-dxvk");
  if (chkDxvk) chkDxvk.checked = envs["DXVK_ENABLE"] === "true" || envs["DXVK_ENABLED"] === "1";

  const chkEsync = document.getElementById("chk-esync");
  if (chkEsync) chkEsync.checked = envs["WINEESYNC"] === "1";

  const chkFsync = document.getElementById("chk-fsync");
  if (chkFsync) chkFsync.checked = envs["WINEFSYNC"] === "1";

  const chkFsr = document.getElementById("chk-fsr");
  if (chkFsr) chkFsr.checked = envs["WINE_FULLSCREEN_FSR"] === "1";

  const chkBattleye = document.getElementById("chk-battleye");
  if (chkBattleye) chkBattleye.checked = envs["BATTLEYE_RUNTIME"] === "1";

  const chkEac = document.getElementById("chk-eac");
  if (chkEac) chkEac.checked = envs["EASY_ANTI_CHEAT_RUNTIME"] === "1";

  if (envs["WINEDLLOVERRIDES"]) {
    envs["WINEDLLOVERRIDES"].split(";").forEach(item => {
      const parts = item.split("=");
      if (parts.length === 2) {
        addDllOverrideRow(parts[0].trim(), parts[1].trim());
      }
    });
  }

  const ignoredKeys = [
    "DXVK_ENABLE", "DXVK_ENABLED", "WINEESYNC", "WINEFSYNC",
    "WINE_FULLSCREEN_FSR", "BATTLEYE_RUNTIME", "EASY_ANTI_CHEAT_RUNTIME",
    "WINEDLLOVERRIDES", "MANGOHUD", "MANGOHUD_DLSYM", "MANGOHUD_VULKAN_DLSYM", "WINEPREFIX"
  ];

  Object.entries(envs).forEach(([k, v]) => {
    if (!ignoredKeys.includes(k)) {
      addEnvVarRow(k, v);
    }
  });

  openModalAnimated("game-modal");
  if (window.lucide) window.lucide.createIcons();
}

async function launchGame(game) {
  if (!game) return;
  const invoke = getInvoke();
  if (!invoke) return;

  runningGames[game.id] = "starting";
  renderGames();
  if (isBigPicture) renderBigPicture();
  enrichProtonDbRatings();

  try {
    const res = await invoke("launch_game", { game });
    console.log("Launched:", res);
  } catch (err) {
    delete runningGames[game.id];
    renderGames();
    if (isBigPicture) renderBigPicture();
    showToast(t("toast.error_generic", { err }), "error");
  }
}

async function setFullscreenMode(enable) {
  try {
    const invoke = getInvoke();
    if (invoke) {
      await invoke("set_fullscreen", { fullscreen: enable });
    }
  } catch (e) {
    console.warn("Fullscreen request error:", e);
  }
}

// ==========================================
// BIG PICTURE NAVIGATION & RENDERING
// ==========================================
const FOCUS_OFF = ["border-slate-800/80", "opacity-60", "hover:opacity-100"];

function setBpFocus(card, on) {
  if (!card) return;
  card.classList.toggle("bp-focused", on);
  card.classList.toggle("ring-4", on);
  card.classList.toggle("ring-purple-500", on);
  card.classList.toggle("scale-105", on);
  FOCUS_OFF.forEach(c => card.classList.toggle(c, !on));
}

function getBpGamesFiltered() {
  let bpGames = games.filter(g => !isToolOrRuntime(g.title) && !g.hidden);

  if (bpTab === "installed") {
    bpGames = bpGames.filter(checkInstalled);
    bpGames.sort((a, b) => a.title.localeCompare(b.title));
  } else if (bpTab === "favorites") {
    bpGames = bpGames.filter(g => g.favorite);
    bpGames.sort((a, b) => a.title.localeCompare(b.title));
  } else if (["steam", "epic", "gog", "lutris"].includes(bpTab)) {
    bpGames = bpGames.filter(g => getSourceTag(g).toLowerCase() === bpTab);

    bpGames.sort((a, b) => {
      const aInst = checkInstalled(a) ? 1 : 0;
      const bInst = checkInstalled(b) ? 1 : 0;
      if (aInst !== bInst) {
        return bInst - aInst;
      }
      return a.title.localeCompare(b.title);
    });
  } else {
    bpGames.sort((a, b) => a.title.localeCompare(b.title));
  }

  return bpGames;
}

function updateBpTabUi() {
  document.querySelectorAll(".bp-nav-tab").forEach(tab => {
    if (tab.dataset.bpTab === bpTab) {
      tab.classList.add("active", "bg-indigo-600", "text-white");
      tab.classList.remove("text-slate-400");
    } else {
      tab.classList.remove("active", "bg-indigo-600", "text-white");
      tab.classList.add("text-slate-400");
    }
  });
}

function updateBpHero() {
  let bpGames = getBpGamesFiltered();
  if (!bpGames.length || bpIndex >= bpGames.length) return;

  const game = bpGames[bpIndex];
  const heroTitle = document.getElementById("bp-hero-title");
  const heroRunner = document.getElementById("bp-hero-runner");
  const heroPlaytime = document.getElementById("bp-hero-playtime");
  const heroDesc = document.getElementById("bp-hero-desc");
  const bgAmbient = document.getElementById("bp-ambient-bg");
  const playBtn = document.getElementById("bp-btn-play");

  if (heroTitle) heroTitle.textContent = game.title;

  if (heroRunner) {
    const sourceTag = getSourceTag(game);
    heroRunner.textContent = sourceTag;
    heroRunner.className = `px-4 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider bg-slate-950/80 border ${getSourceBadgeClass(sourceTag)}`;
  }

  if (heroPlaytime) {
    const pt = formatPlaytime(game.playtime_minutes);
    heroPlaytime.className = "text-sm text-slate-300 font-medium flex items-center gap-1.5 bg-slate-900/80 px-4 py-1.5 rounded-lg border border-slate-800";
    if (pt) {
      heroPlaytime.innerHTML = `<i data-lucide="clock" class="w-4 h-4 text-cyan-400"></i> ${pt}`;
    } else {
      heroPlaytime.innerHTML = `<i data-lucide="clock" class="w-4 h-4 text-slate-500"></i> ${t("game.never_played")}`;
    }
  }

  if (heroDesc) {
    heroDesc.textContent = game.launch_args
    ? t("bp.args_desc", { args: game.launch_args })
    : t("bp.ready_desc");
  }

  if (bgAmbient) {
    const cover = game.banner_url || game.cover_url || "https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=1200&q=80";
    if (!bgAmbient.style.backgroundImage.includes(cover)) {
      bgAmbient.style.backgroundImage = `url('${cover}')`;
    }
  }

  if (playBtn) {
    const gameStatus = runningGames[game.id];

    if (gameStatus === "starting" || gameStatus === "playing") {
      playBtn.innerHTML = `<i data-lucide="loader" class="w-5 h-5 animate-spin"></i><span>${t("bp.playing")}</span>`;
      playBtn.className = "px-8 py-3.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-sm flex items-center gap-3 shadow-xl shadow-amber-500/25 transform hover:scale-105 transition";
    } else if (installingGames[game.id] !== undefined) {
      const pct = installingGames[game.id];
      const label = pct > 0 ? t("bp.installing_pct", { pct: pct.toFixed(0) }) : t("bp.installing");
      playBtn.innerHTML = `<i data-lucide="loader-2" class="w-5 h-5 animate-spin"></i><span>${label}</span>`;
      playBtn.className = "px-8 py-3.5 rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 font-black text-sm flex items-center gap-3 shadow-xl cursor-default";
    } else if (checkInstalled(game)) {
      playBtn.innerHTML = `<i data-lucide="play" class="w-6 h-6 fill-current"></i><span>${t("bp.play_game")}</span>`;
      playBtn.className = "px-10 py-4 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-base flex items-center gap-3 shadow-xl shadow-emerald-500/25 transform hover:scale-105 transition";
    } else {
      playBtn.innerHTML = `<i data-lucide="download-cloud" class="w-6 h-6"></i><span>${t("bp.install_game")}</span>`;
      playBtn.className = "px-10 py-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-white border border-slate-700 font-black text-base flex items-center gap-3 shadow-xl transform hover:scale-105 transition";
    }
  }

  if (window.lucide) window.lucide.createIcons();
}

function moveBpFocus(nextIndex) {
  const carousel = document.getElementById("bp-carousel");
  if (!carousel) return;
  const cards = carousel.querySelectorAll('.glass-card');
  if (!cards.length) return;
  let bpGames = getBpGamesFiltered();
  if (!bpGames.length) return;

  setBpFocus(cards[bpIndex], false);
  bpIndex = Math.max(0, Math.min(nextIndex, cards.length - 1));
  const targetCard = cards[bpIndex];
  setBpFocus(targetCard, true);

  const container = carousel.parentElement || carousel;
  if (container && targetCard) {
    const containerWidth = container.clientWidth;
    const cardLeft = targetCard.offsetLeft;
    const cardWidth = targetCard.clientWidth;

    let targetScroll = cardLeft - (containerWidth / 2) + (cardWidth / 2);

    const maxScroll = carousel.scrollWidth - container.clientWidth;
    targetScroll = Math.max(0, Math.min(targetScroll, maxScroll));

    container.scrollTo({
      left: targetScroll,
      behavior: "smooth"
    });
  }

  updateBpHero();
}

function renderBigPicture() {
  const carousel = document.getElementById("bp-carousel");
  if (!carousel) return;

  carousel.innerHTML = "";

  const playBtn = document.getElementById("bp-btn-play");
  const heroStatus = document.getElementById("bp-hero-status");

  let bpGames = getBpGamesFiltered();

  if (bpGames.length === 0) {
    document.getElementById("bp-hero-title").textContent = t("bp.no_games");
    document.getElementById("bp-hero-desc").textContent = bpTab === "favorites"
    ? t("bp.no_fav_desc")
    : t("bp.no_games_desc");

    if (playBtn) playBtn.classList.add("hidden");
    if (heroStatus) heroStatus.classList.add("hidden");
    return;
  }

  if (playBtn) playBtn.classList.remove("hidden");
  if (heroStatus) heroStatus.classList.remove("hidden");

  if (bpIndex >= bpGames.length) bpIndex = 0;

  const fragment = document.createDocumentFragment();

  bpGames.forEach((game, idx) => {
    const isInst = checkInstalled(game);

    const card = document.createElement("div");
    card.className = `shrink-0 w-72 rounded-3xl glass-card cursor-pointer border-2 overflow-hidden transition-transform duration-150 transform-gpu ${
      idx === bpIndex ? "bp-focused ring-4 ring-purple-500 scale-105" : "border-slate-800/80 opacity-60 hover:opacity-100"
    }`;

    const coverImg = game.cover_url || "";
    const sourceTag = getSourceTag(game);
    const badgeTextColor = getSourceBadgeClass(sourceTag).split(' ')[0];

    const imgElement = coverImg
    ? `<img src="${coverImg}" loading="lazy" decoding="async" class="w-full h-full object-cover transition-all duration-300 ${!isInst ? 'grayscale opacity-75' : ''}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">`
    : "";

    const fallbackPlaceholder = `
    <div class="w-full h-full bg-slate-900 flex flex-col items-center justify-center p-4 text-center ${coverImg ? 'hidden' : 'flex'}">
    <i data-lucide="gamepad-2" class="w-12 h-12 text-slate-700 mb-2"></i>
    <span class="text-sm font-bold text-slate-400 line-clamp-2">${escapeHtml(game.title)}</span>
    </div>
    `;

    card.innerHTML = `
    <div class="aspect-[3/4] relative overflow-hidden bg-slate-900 rounded-t-3xl">
    ${imgElement}
    ${fallbackPlaceholder}
    <div class="absolute inset-0 bg-gradient-to-t from-slate-950 via-transparent to-transparent"></div>
    ${game.favorite ? '<i data-lucide="star" class="w-5 h-5 text-amber-400 fill-current absolute top-4 right-4 shadow-lg"></i>' : ''}
    </div>
    <div class="p-4 bg-slate-900/90 rounded-b-3xl">
    <h4 class="font-extrabold text-lg text-white truncate">${escapeHtml(game.title)}</h4>
    <span class="text-xs font-black uppercase tracking-wider ${badgeTextColor}">${sourceTag}</span>
    </div>
    `;

    card.addEventListener("click", () => {
      moveBpFocus(idx);
    });

    fragment.appendChild(card);
  });

  const endSpacer = document.createElement("div");
  endSpacer.className = "shrink-0 pointer-events-none select-none text-transparent";
  endSpacer.style.width = "1.5rem";
  endSpacer.style.minWidth = "1.5rem";
  endSpacer.innerHTML = "&nbsp;";
  fragment.appendChild(endSpacer);

  carousel.appendChild(fragment);

  updateBpHero();

  const container = carousel.parentElement || carousel;

  const cards = carousel.querySelectorAll('.glass-card');
  const targetCard = cards[bpIndex];

  if (container && targetCard) {
    const containerWidth = container.clientWidth;
    const cardLeft = targetCard.offsetLeft;
    const cardWidth = targetCard.clientWidth;

    let targetScroll = cardLeft - (containerWidth / 2) + (cardWidth / 2);

    const maxScroll = carousel.scrollWidth - container.clientWidth;
    targetScroll = Math.max(0, Math.min(targetScroll, maxScroll));

    container.scrollTo({
      left: targetScroll,
      behavior: "instant"
    });
  }

  if (window.lucide) window.lucide.createIcons();
}

// ==========================================
// BIG PICTURE: STEAM-STYLE GAME DETAILS & CONTROLLER PROPERTIES
// ==========================================
let bpMenuState = {
  open: false,
  game: null,
  focusCol: "main",
  mainIdx: 0,
  manageIdx: 0
};

let bpPropsState = {
  open: false,
  game: null,
  focusIdx: 0,
  draft: null
};

function getBpMainMenuItems(game) {
  const isInst = checkInstalled(game);
  return [
    { id: "play", label: isInst ? t("bp.opt.play") : t("bp.opt.install"), icon: isInst ? "▸" : "↓" },
    { id: "favorite", label: game.favorite ? t("bp.opt.rem_fav") : t("bp.opt.add_fav") },
    { id: "manage", label: t("bp.opt.manage"), hasSubmenu: true },
    { id: "properties", label: t("bp.opt.properties") },
    { id: "cancel", label: t("bp.opt.cancel") }
  ];
}

function getBpManageSubmenuItems(game) {
  const isInst = checkInstalled(game);
  const items = [
    { id: "hide", label: game.hidden ? t("bp.opt.unhide") : t("bp.opt.hide") },
    { id: "browse", label: t("bp.opt.browse") }
  ];
  if (isInst) {
    items.push({ id: "uninstall", label: t("bp.opt.uninstall"), danger: true });
  }
  items.push({ id: "remove", label: t("bp.opt.remove"), danger: true });
  return items;
}

function ensureBpOverlaysExist() {
  const bpRoot = document.getElementById("big-picture-view") || document.body;

  if (!document.getElementById("bp-details-overlay")) {
    const detailsOverlay = document.createElement("div");
    detailsOverlay.id = "bp-details-overlay";
    detailsOverlay.style.zIndex = "99990";
    detailsOverlay.className = "fixed inset-0 hidden bg-slate-950/90 backdrop-blur-md flex flex-col justify-between p-10 select-none";
    detailsOverlay.innerHTML = `
    <div class="flex items-center justify-end text-sm text-slate-400 font-bold tracking-wider uppercase">
    <span id="bp-details-breadcrumb" class="px-3 py-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-300"></span>
    </div>

    <div class="flex-1 flex flex-col items-center justify-center gap-6">
    <div class="text-center max-w-3xl px-4">
    <p id="bp-details-opt-label" class="text-xs font-extrabold uppercase tracking-widest text-indigo-400 mb-1">${t("bp.opt.title")}</p>
    <h2 id="bp-details-game-title" class="text-3xl font-black text-white tracking-tight drop-shadow"></h2>
    </div>

    <div class="flex items-start gap-4">
    <div id="bp-details-main-list" style="width: 420px;" class="bg-slate-900/95 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col"></div>
    <div id="bp-details-manage-list" style="width: 380px;" class="hidden bg-slate-900/95 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col"></div>
    </div>
    </div>

    <div class="flex items-center justify-between pt-5 border-t border-slate-800">
    <div class="flex items-center gap-3 text-sm font-bold text-slate-300">
    <span class="px-3 py-1 rounded-lg bg-slate-800 text-white border border-slate-700">D-PAD</span>
    <span id="bp-details-hint-nav">${t("bp.hint.nav")}</span>
    </div>
    <div class="flex items-center gap-8 text-sm font-bold text-slate-200">
    <div class="flex items-center gap-2.5">
    <span class="w-8 h-8 rounded-full bg-white text-slate-950 font-black flex items-center justify-center text-sm shadow">A</span>
    <span id="bp-details-hint-select">${t("bp.hint.select")}</span>
    </div>
    <div class="flex items-center gap-2.5">
    <span class="w-8 h-8 rounded-full bg-white text-slate-950 font-black flex items-center justify-center text-sm shadow">B</span>
    <span id="bp-details-hint-back">${t("bp.hint.back")}</span>
    </div>
    </div>
    </div>
    `;
    bpRoot.appendChild(detailsOverlay);
  }

  if (!document.getElementById("bp-props-overlay")) {
    const propsOverlay = document.createElement("div");
    propsOverlay.id = "bp-props-overlay";
    propsOverlay.style.zIndex = "99995";
    propsOverlay.className = "fixed inset-0 hidden bg-slate-950/95 backdrop-blur-xl flex flex-col justify-between p-10 select-none";
    propsOverlay.innerHTML = `
    <div class="flex items-center justify-between pb-5 border-b border-slate-800">
    <div class="flex items-center gap-4">
    <span id="bp-props-badge" class="px-3 py-1.5 rounded-lg bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 text-sm font-black uppercase tracking-wider">${t("bp.props.title")}</span>
    <h2 id="bp-props-title" class="text-3xl font-black text-white"></h2>
    </div>
    <span class="text-sm text-slate-400 font-mono" id="bp-props-source"></span>
    </div>

    <div class="flex-1 overflow-y-auto py-6 flex justify-center">
    <div id="bp-props-list" class="w-full max-w-4xl space-y-3"></div>
    </div>

    <div class="flex items-center justify-between pt-5 border-t border-slate-800">
    <div class="flex items-center gap-3 text-sm font-bold text-slate-300">
    <span class="px-3 py-1 rounded-lg bg-slate-800 text-white border border-slate-700">◀ ▶</span>
    <span id="bp-props-hint-runner">${t("bp.hint.change_runner")}</span>
    </div>
    <div class="flex items-center gap-8 text-sm font-bold text-slate-200">
    <div class="flex items-center gap-2.5">
    <span class="w-8 h-8 rounded-full bg-white text-slate-950 font-black flex items-center justify-center text-sm shadow">A</span>
    <span id="bp-props-hint-toggle">${t("bp.hint.toggle_apply")}</span>
    </div>
    <div class="flex items-center gap-2.5">
    <span class="w-8 h-8 rounded-full bg-white text-slate-950 font-black flex items-center justify-center text-sm shadow">B</span>
    <span id="bp-props-hint-back">${t("bp.hint.back")}</span>
    </div>
    </div>
    </div>
    `;
    bpRoot.appendChild(propsOverlay);
  }
}

function openBpGameDetails(game) {
  if (!game) return;
  ensureBpOverlaysExist();
  bpMenuState = {
    open: true,
    game,
    focusCol: "main",
    mainIdx: 0,
    manageIdx: 0
  };
  document.getElementById("bp-details-overlay")?.classList.remove("hidden");
  renderBpGameDetails();
}

function closeBpGameDetails() {
  bpMenuState.open = false;
  bpMenuState.focusCol = "main";
  document.getElementById("bp-details-overlay")?.classList.add("hidden");
}

function renderBpGameDetails() {
  const game = bpMenuState.game;
  if (!game) return;

  const optLabelEl = document.getElementById("bp-details-opt-label");
  const hintNavEl = document.getElementById("bp-details-hint-nav");
  const hintSelEl = document.getElementById("bp-details-hint-select");
  const hintBackEl = document.getElementById("bp-details-hint-back");
  if (optLabelEl) optLabelEl.textContent = t("bp.opt.title");
  if (hintNavEl) hintNavEl.textContent = t("bp.hint.nav");
  if (hintSelEl) hintSelEl.textContent = t("bp.hint.select");
  if (hintBackEl) hintBackEl.textContent = t("bp.hint.back");

  const titleEl = document.getElementById("bp-details-game-title");
  const crumbEl = document.getElementById("bp-details-breadcrumb");
  const mainList = document.getElementById("bp-details-main-list");
  const manageList = document.getElementById("bp-details-manage-list");

  if (titleEl) titleEl.textContent = game.title;
  if (crumbEl) {
    crumbEl.textContent = bpMenuState.focusCol === "manage" ? t("bp.opt.breadcrumb_manage") : t("bp.opt.breadcrumb");
  }

  const focusGradientStyle = `style="background: linear-gradient(90deg, #4f46e5 0%, #06b6d4 100%);"`;

  const mainItems = getBpMainMenuItems(game);
  mainList.innerHTML = mainItems.map((item, idx) => {
    const isFocused = bpMenuState.focusCol === "main" && bpMenuState.mainIdx === idx;
    const isActiveParent = bpMenuState.focusCol === "manage" && item.id === "manage";
    const rowCls = isFocused
    ? "text-white font-extrabold shadow-lg"
    : isActiveParent
    ? "bg-slate-800 text-cyan-300 font-bold"
    : item.danger
    ? "text-rose-400 hover:bg-slate-800/70 font-semibold"
    : "text-slate-200 hover:bg-slate-800/70 font-semibold";

    return `
    <button type="button" data-bp-main-idx="${idx}" ${isFocused ? focusGradientStyle : ""}
    class="w-full px-6 py-4 text-left text-lg flex items-center justify-between border-b border-slate-800/80 transition-colors ${rowCls}">
    <span class="flex items-center gap-3.5">
    ${item.icon ? `<span class="w-6 text-center text-xl font-bold ${isFocused ? "text-white" : "text-cyan-400"}">${item.icon}</span>` : ""}
    <span>${item.label}</span>
    </span>
    ${item.hasSubmenu ? `<span class="text-xl font-bold ${isFocused ? "text-white" : "text-slate-400"}">›</span>` : ""}
    </button>
    `;
  }).join("");

  if (bpMenuState.focusCol === "manage") {
    const manageItems = getBpManageSubmenuItems(game);
    manageList.classList.remove("hidden");
    manageList.innerHTML = manageItems.map((item, idx) => {
      const isFocused = bpMenuState.manageIdx === idx;
      const rowCls = isFocused
      ? "text-white font-extrabold shadow-lg"
      : item.danger
      ? "text-rose-400 hover:bg-slate-800/70 font-semibold"
      : "text-slate-200 hover:bg-slate-800/70 font-semibold";
      return `
      <button type="button" data-bp-manage-idx="${idx}" ${isFocused ? focusGradientStyle : ""}
      class="w-full px-6 py-4 text-left text-lg flex items-center justify-between border-b border-slate-800/80 transition-colors ${rowCls}">
      <span>${item.label}</span>
      </button>
      `;
    }).join("");
  } else {
    manageList.classList.add("hidden");
  }

  mainList.querySelectorAll("[data-bp-main-idx]").forEach(btn => {
    btn.addEventListener("click", () => {
      bpMenuState.focusCol = "main";
      bpMenuState.mainIdx = Number(btn.dataset.bpMainIdx);
      confirmBpGameDetailsSelection();
    });
  });

  manageList.querySelectorAll("[data-bp-manage-idx]").forEach(btn => {
    btn.addEventListener("click", () => {
      bpMenuState.focusCol = "manage";
      bpMenuState.manageIdx = Number(btn.dataset.bpManageIdx);
      confirmBpGameDetailsSelection();
    });
  });
}

async function confirmBpGameDetailsSelection() {
  const game = bpMenuState.game;
  if (!game) return;

  if (bpMenuState.focusCol === "main") {
    const mainItems = getBpMainMenuItems(game);
    const selected = mainItems[bpMenuState.mainIdx];
    if (!selected) return;

    if (selected.id === "play") {
      closeBpGameDetails();
      if (checkInstalled(game)) {
        launchGame(game);
      } else if (getSourceTag(game) === "STEAM" || game.id.startsWith("steam_")) {
        const appId = game.id.replace("steam_", "");
        const invoke = getInvoke();
        if (invoke) {
          invoke("launch_game", { game: { ...game, exe_path: `steam://install/${appId}` } })
          .then(() => {
            showToast(t("toast.steam_installing", { title: game.title }), "info");
            startSteamInstallTracking(game);
          });
        }
      } else if (getSourceTag(game) === "EPIC" || game.id.startsWith("epic_")) {
        openEpicInstallModal(game);
      } else {
        openEditModal(game);
      }
    } else if (selected.id === "favorite") {
      game.favorite = !game.favorite;
      await saveGamesToDisk();
      renderGames();
      renderBigPicture();
      renderBpGameDetails();
      showToast(game.favorite ? t("toast.fav_added", { title: game.title }) : t("toast.fav_removed", { title: game.title }), "success");
    } else if (selected.id === "manage") {
      bpMenuState.focusCol = "manage";
      bpMenuState.manageIdx = 0;
      renderBpGameDetails();
    } else if (selected.id === "properties") {
      closeBpGameDetails();
      openBpPropertiesModal(game);
    } else if (selected.id === "cancel") {
      closeBpGameDetails();
    }
  } else if (bpMenuState.focusCol === "manage") {
    const manageItems = getBpManageSubmenuItems(game);
    const selected = manageItems[bpMenuState.manageIdx];
    if (!selected) return;

    if (selected.id === "hide") {
      game.hidden = !game.hidden;
      await saveGamesToDisk();
      closeBpGameDetails();
      renderGames();
      renderBigPicture();
      showToast(game.hidden ? t("toast.game_hidden", { title: game.title }) : t("toast.game_unhidden", { title: game.title }), "info");
    } else if (selected.id === "browse") {
      closeBpGameDetails();
      openGameFilesFolder(game);
    } else if (selected.id === "uninstall") {
      closeBpGameDetails();
      const invoke = getInvoke();
      const sourceTag = getSourceTag(game);
      if (invoke) {
        try {
          showToast(t("toast.game_uninstalling", { title: game.title }), "info");
          if (sourceTag === "EPIC" || game.id.startsWith("epic_")) {
            await invoke("uninstall_epic_game", { appName: game.id, exePath: game.exe_path || "" });
          } else {
            await invoke("uninstall_game_files", { exePath: game.exe_path || "", winePrefix: game.wine_prefix || null });
          }
          game.is_installed = false;
          game.exe_path = sourceTag === "STEAM" ? `steam://install/${game.id.replace("steam_", "")}` : "";
          await saveGamesToDisk();
          renderGames();
          renderBigPicture();
          showToast(t("toast.game_uninstalled", { title: game.title }), "success");
        } catch (err) {
          showToast(t("toast.error_generic", { err }), "error");
        }
      }
    } else if (selected.id === "remove") {
      closeBpGameDetails();
      const sourceTag = getSourceTag(game);
      const isExternalGame = sourceTag !== "CUSTOM" && sourceTag !== "NATIVE";
      if (isExternalGame) {
        game.is_installed = false;
        game.exe_path = sourceTag === "STEAM" ? `steam://install/${game.id.replace("steam_", "")}` : "";
      } else {
        games = games.filter(g => g.id !== game.id);
      }
      await saveGamesToDisk();
      renderGames();
      renderSidebarTags();
      renderBigPicture();
      showToast(t("toast.game_removed", { title: game.title }), "info");
    }
  }
}

// ==========================================
// BIG PICTURE: CONTROLLER-FRIENDLY PROPERTIES
// ==========================================
function openBpPropertiesModal(game) {
  if (!game) return;
  ensureBpOverlaysExist();
  const envs = game.env_vars || {};

  bpPropsState = {
    open: true,
    game,
    focusIdx: 0,
    draft: {
      runner_path: game.runner_path || (availableRunners[0]?.path || "/usr/bin/wine"),
      use_gamemode: game.use_gamemode !== undefined ? game.use_gamemode : true,
      use_mangohud: game.use_mangohud !== undefined ? game.use_mangohud : true,
      dxvk: envs["DXVK_ENABLE"] === "true" || envs["DXVK_ENABLED"] === "1",
      esync: envs["WINEESYNC"] === "1",
      fsync: envs["WINEFSYNC"] === "1",
      fsr: envs["WINE_FULLSCREEN_FSR"] === "1",
      battleye: envs["BATTLEYE_RUNTIME"] === "1",
      eac: envs["EASY_ANTI_CHEAT_RUNTIME"] === "1",
      launch_args: game.launch_args || ""
    }
  };

  document.getElementById("bp-props-title").textContent = game.title;
  document.getElementById("bp-props-source").textContent = `${getSourceTag(game)} • ${game.exe_path || t("bp.props.no_exe")}`;
  document.getElementById("bp-props-overlay")?.classList.remove("hidden");
  renderBpProperties();
}

function closeBpPropertiesModal() {
  bpPropsState.open = false;
  document.getElementById("bp-props-overlay")?.classList.add("hidden");
}

function getBpPropertyRows() {
  const d = bpPropsState.draft;
  const runnerObj = availableRunners.find(r => r.path === d.runner_path);
  const runnerLabel = runnerObj ? runnerObj.name : getRunnerDisplayName(d.runner_path);

  return [
    { key: "runner_path", type: "cycle", label: t("modal.game.runner"), valueText: `‹  ${runnerLabel}  ›` },
    { key: "use_gamemode", type: "toggle", label: t("modal.game.gamemode"), value: d.use_gamemode },
    { key: "use_mangohud", type: "toggle", label: t("modal.game.mangohud"), value: d.use_mangohud },
    { key: "dxvk", type: "toggle", label: t("bp.props.dxvk"), value: d.dxvk },
    { key: "esync", type: "toggle", label: t("bp.props.esync"), value: d.esync },
    { key: "fsync", type: "toggle", label: t("bp.props.fsync"), value: d.fsync },
    { key: "fsr", type: "toggle", label: t("bp.props.fsr"), value: d.fsr },
    { key: "battleye", type: "toggle", label: t("bp.props.battleye"), value: d.battleye },
    { key: "eac", type: "toggle", label: t("bp.props.eac"), value: d.eac },
    { key: "launch_args", type: "info", label: t("modal.game.args"), valueText: d.launch_args || t("bp.props.none") },
    { key: "save", type: "action", label: t("bp.props.save") }
  ];
}

function renderBpProperties() {
  if (!bpPropsState.open) return;
  const list = document.getElementById("bp-props-list");
  if (!list) return;

  const badgeEl = document.getElementById("bp-props-badge");
  const hintRunEl = document.getElementById("bp-props-hint-runner");
  const hintTogEl = document.getElementById("bp-props-hint-toggle");
  const hintBackEl = document.getElementById("bp-props-hint-back");
  if (badgeEl) badgeEl.textContent = t("bp.props.title");
  if (hintRunEl) hintRunEl.textContent = t("bp.hint.change_runner");
  if (hintTogEl) hintTogEl.textContent = t("bp.hint.toggle_apply");
  if (hintBackEl) hintBackEl.textContent = t("bp.hint.back");

  const focusGradientStyle = `style="background: linear-gradient(90deg, #4f46e5 0%, #06b6d4 100%);"`;
  const rows = getBpPropertyRows();

  list.innerHTML = rows.map((row, idx) => {
    const isFocused = idx === bpPropsState.focusIdx;

    if (row.type === "action") {
      return `
      <div data-bp-prop-idx="${idx}" ${isFocused ? focusGradientStyle : ""} class="mt-6 px-6 py-4 rounded-xl text-center font-black text-lg tracking-wide cursor-pointer transition ${
        isFocused
        ? "text-white ring-2 ring-cyan-300 shadow-xl"
        : "bg-slate-800/90 text-cyan-300 border border-indigo-500/40"
      }">
      ${row.label}
      </div>
      `;
    }

    const baseClass = isFocused
    ? "text-white font-extrabold shadow-xl border border-cyan-300/60"
    : "bg-slate-900/90 text-slate-200 font-semibold border border-slate-800";

    let rightControl = "";
    if (row.type === "toggle") {
      rightControl = row.value
      ? `<span class="px-4 py-1.5 rounded-full text-sm font-black ${isFocused ? "bg-slate-950/80 text-emerald-300" : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"}">${t("bp.props.on")}</span>`
      : `<span class="px-4 py-1.5 rounded-full text-sm font-black ${isFocused ? "bg-slate-950/60 text-slate-200" : "bg-slate-800 text-slate-400"}">${t("bp.props.off")}</span>`;
    } else {
      rightControl = `<span class="text-base font-mono ${isFocused ? "text-white font-extrabold" : "text-cyan-400"}">${escapeHtml(row.valueText)}</span>`;
    }

    return `
    <div data-bp-prop-idx="${idx}" ${isFocused ? focusGradientStyle : ""} class="px-6 py-4 rounded-xl flex items-center justify-between gap-4 cursor-pointer transition-colors ${baseClass}">
    <span class="text-lg">${row.label}</span>
    ${rightControl}
    </div>
    `;
  }).join("");

  const focusedEl = list.querySelector(`[data-bp-prop-idx="${bpPropsState.focusIdx}"]`);
  focusedEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });

  list.querySelectorAll("[data-bp-prop-idx]").forEach(el => {
    el.addEventListener("click", () => {
      bpPropsState.focusIdx = parseInt(el.dataset.bpPropIdx, 10);
      activateBpPropertyRow();
    });
  });
}

function cycleBpRunner(dir) {
  if (!availableRunners || availableRunners.length === 0) return;
  const curIdx = availableRunners.findIndex(r => r.path === bpPropsState.draft.runner_path);
  const nextIdx = curIdx === -1
  ? 0
  : (curIdx + dir + availableRunners.length) % availableRunners.length;
  bpPropsState.draft.runner_path = availableRunners[nextIdx].path;
  renderBpProperties();
}

async function activateBpPropertyRow(dir = 1) {
  const rows = getBpPropertyRows();
  const row = rows[bpPropsState.focusIdx];
  if (!row) return;

  if (row.type === "toggle") {
    bpPropsState.draft[row.key] = !bpPropsState.draft[row.key];
    renderBpProperties();
  } else if (row.type === "cycle") {
    cycleBpRunner(dir);
  } else if (row.type === "info") {
    const nextArgs = prompt(t("bp.props.args_prompt", { title: bpPropsState.game.title }), bpPropsState.draft.launch_args);
    if (nextArgs !== null) {
      bpPropsState.draft.launch_args = nextArgs.trim();
      renderBpProperties();
    }
  } else if (row.type === "action" && row.key === "save") {
    const g = bpPropsState.game;
    const d = bpPropsState.draft;
    g.runner_path = d.runner_path;
    g.use_gamemode = d.use_gamemode;
    g.use_mangohud = d.use_mangohud;
    g.launch_args = d.launch_args;

    const nextEnv = { ...(g.env_vars || {}) };
    if (d.dxvk) nextEnv["DXVK_ENABLE"] = "true"; else { delete nextEnv["DXVK_ENABLE"]; delete nextEnv["DXVK_ENABLED"]; }
    if (d.esync) nextEnv["WINEESYNC"] = "1"; else delete nextEnv["WINEESYNC"];
    if (d.fsync) nextEnv["WINEFSYNC"] = "1"; else delete nextEnv["WINEFSYNC"];
    if (d.fsr) nextEnv["WINE_FULLSCREEN_FSR"] = "1"; else delete nextEnv["WINE_FULLSCREEN_FSR"];
    if (d.battleye) nextEnv["BATTLEYE_RUNTIME"] = "1"; else delete nextEnv["BATTLEYE_RUNTIME"];
    if (d.eac) nextEnv["EASY_ANTI_CHEAT_RUNTIME"] = "1"; else delete nextEnv["EASY_ANTI_CHEAT_RUNTIME"];
    g.env_vars = nextEnv;

    await saveGamesToDisk();
    renderGames();
    renderBigPicture();
    closeBpPropertiesModal();
    showToast(t("toast.settings_saved", { title: g.title }), "success");
  }
}


let cachedBpStatus = JSON.parse(localStorage.getItem("nexus_bp_status") || "null");

function applyBpStatusToDom(status) {
  if (!status) return;

  const netIcon = document.getElementById("bp-net-icon");
  const netLabel = document.getElementById("bp-net-label");
  const batPill = document.getElementById("bp-bat-pill");
  const batIcon = document.getElementById("bp-bat-icon");
  const batLabel = document.getElementById("bp-bat-label");

  if (netIcon && netLabel) {
    if (status.network_type === "wifi") {
      netIcon.className = "text-emerald-400 flex items-center";
      netIcon.innerHTML = renderWifiSignalSvg(status.wifi_signal);
      netLabel.textContent = status.network_name || "Wi-Fi";
    } else if (status.network_type === "ethernet") {
      netIcon.className = "text-cyan-400 flex items-center";
      netIcon.innerHTML = `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>`;
      netLabel.textContent = status.network_name || "Ethernet";
    } else {
      netIcon.className = "text-rose-400 flex items-center";
      netIcon.innerHTML = `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>`;
      netLabel.textContent = t("sidebar.offline");
    }
  }

  if (batPill && batIcon && batLabel) {
    if (status.has_battery) {
      const pct = status.battery_percent;
      const charging = status.is_charging;

      batPill.classList.remove("hidden");
      batLabel.textContent = `${pct}%`;

      const colorCls = charging
      ? "text-cyan-400"
      : pct <= 20
      ? "text-rose-400"
      : pct <= 45
      ? "text-amber-400"
      : "text-emerald-400";

      const fillWidth = Math.max(2, Math.round((pct / 100) * 14));
      batIcon.className = `${colorCls} flex items-center`;
      batIcon.innerHTML = charging
      ? `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="18" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/><polyline points="11 9 9 12 13 12 11 15" stroke-width="2"/></svg>`
      : `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="18" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/><rect x="4" y="9" width="${fillWidth}" height="6" rx="1" fill="currentColor" stroke="none"/></svg>`;
    } else {
      batPill.classList.add("hidden");
    }
  }
}

function ensureBpStatusWidgets() {
  const clockEl = document.getElementById("bp-clock");
  if (!clockEl || document.getElementById("bp-status-bar")) return;

  const wrapper = document.createElement("div");
  wrapper.id = "bp-status-bar";
  wrapper.className = "flex items-center gap-3 mr-3";
  wrapper.innerHTML = `
  <div id="bp-net-pill" class="px-3 py-1.5 rounded-xl bg-slate-900/90 border border-slate-800 flex items-center gap-2 text-xs font-bold text-slate-300">
  <span id="bp-net-icon" class="text-cyan-400 flex items-center"></span>
  <span id="bp-net-label" class="max-w-[130px] truncate">${t("sidebar.checking")}</span>
  </div>
  <div id="bp-bat-pill" class="hidden px-3 py-1.5 rounded-xl bg-slate-900/90 border border-slate-800 flex items-center gap-2 text-xs font-bold text-slate-200">
  <span id="bp-bat-icon" class="flex items-center"></span>
  <span id="bp-bat-label" class="font-mono">100%</span>
  </div>
  `;

  const parent = clockEl.parentElement;
  if (parent) {
    parent.insertBefore(wrapper, parent.firstChild);
  }

  if (cachedBpStatus) {
    applyBpStatusToDom(cachedBpStatus);
  }
}

function renderWifiSignalSvg(signal) {
  const pct = Number(signal) || 0;
  const bars = pct >= 75 ? 4 : pct >= 50 ? 3 : pct >= 25 ? 2 : 1;
  const activeColor = pct < 25 ? "#fb7185" : pct < 50 ? "#fbbf24" : "#22d3ee";
  const dimColor = "rgba(148, 163, 184, 0.25)";

  return `
  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
  <path d="M1.42 9a16 16 0 0 1 21.16 0" stroke="${bars >= 4 ? activeColor : dimColor}"/>
  <path d="M5 12.55a11 11 0 0 1 14.08 0" stroke="${bars >= 3 ? activeColor : dimColor}"/>
  <path d="M8.53 16.11a6 6 0 0 1 6.95 0" stroke="${bars >= 2 ? activeColor : dimColor}"/>
  <circle cx="12" cy="20" r="1.2" fill="${activeColor}" stroke="none"/>
  </svg>
  `;
}

let lastBpStatusSerialized = null;

async function updateBpDeviceStatus(force = false) {
  if (!shouldPoll() || (!isBigPicture && !force)) return;
  ensureBpStatusWidgets();

  const invoke = getInvoke();
  if (!invoke) return;

  try {
    const status = await invoke("get_bp_device_status");
    cachedBpStatus = status;
    const serialized = JSON.stringify(status);
    if (serialized !== lastBpStatusSerialized) {
      lastBpStatusSerialized = serialized;
      localStorage.setItem("nexus_bp_status", serialized);
    }
    applyBpStatusToDom(status);
  } catch (e) {
    console.warn("Eroare get_bp_device_status:", e);
  }
}

function startBpStatusMonitor() {
  updateBpDeviceStatus(true);
  window.addEventListener("online", () => {
    if (isBigPicture) updateBpDeviceStatus();
  });
    window.addEventListener("offline", () => {
      if (isBigPicture) updateBpDeviceStatus();
    });
      setInterval(() => {
        if (isBigPicture && shouldPoll()) {
          updateBpDeviceStatus();
        }
      }, 10000);
}

// ==========================================
// GAMEPAD / CONTROLLER NAVIGATION ENGINE
// ==========================================
let gamepadLoopId = null;
let lastPadState = { left: false, right: false, up: false, down: false, btnA: false, btnB: false, btnX: false, btnY: false, lb: false, rb: false, btnMenu: false };
const PAD_ALL_PRESSED = Object.freeze({ left: true, right: true, up: true, down: true, btnA: true, btnB: true, btnX: true, btnY: true, lb: true, rb: true, btnMenu: true });

function startGamepadLoop() {
  if (gamepadLoopId) return;

  const resumeGamepadLoop = () => {
    gamepadLoopId = requestAnimationFrame(updateGamepad);
  };

  const updateGamepad = () => {
    if (!shouldPoll()) {
      lastPadState = PAD_ALL_PRESSED;
      gamepadLoopId = setTimeout(resumeGamepadLoop, 500);
      return;
    }

    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (let i = 0; i < gamepads.length; i++) {
      if (gamepads[i]) {
        pad = gamepads[i];
        break;
      }
    }

    if (pad) {
      const axisX = pad.axes[0] || 0;
      const axisY = pad.axes[1] || 0;

      const dpadUp = pad.buttons[12]?.pressed || axisY < -0.5;
      const dpadDown = pad.buttons[13]?.pressed || axisY > 0.5;
      const dpadLeft = pad.buttons[14]?.pressed || axisX < -0.5;
      const dpadRight = pad.buttons[15]?.pressed || axisX > 0.5;

      const btnA = pad.buttons[0]?.pressed;
      const btnB = pad.buttons[1]?.pressed;
      const btnX = pad.buttons[3]?.pressed;
      const btnY = pad.buttons[2]?.pressed;
      const lb = pad.buttons[4]?.pressed;
      const rb = pad.buttons[5]?.pressed;
      const btnMenu = pad.buttons[9]?.pressed;

      if (btnMenu && !lastPadState.btnMenu) {
        if (isBigPicture) {
          document.getElementById("btn-exit-bigpicture")?.click();
        } else {
          document.getElementById("btn-toggle-mode")?.click();
        }
      }

      if (isBigPicture) {
        if (bpPropsState.open) {
          const rows = getBpPropertyRows();
          if (dpadUp && !lastPadState.up) {
            bpPropsState.focusIdx = (bpPropsState.focusIdx - 1 + rows.length) % rows.length;
            renderBpProperties();
          }
          if (dpadDown && !lastPadState.down) {
            bpPropsState.focusIdx = (bpPropsState.focusIdx + 1) % rows.length;
            renderBpProperties();
          }
          if (dpadLeft && !lastPadState.left && rows[bpPropsState.focusIdx]?.type === "cycle") {
            cycleBpRunner(-1);
          }
          if (dpadRight && !lastPadState.right && rows[bpPropsState.focusIdx]?.type === "cycle") {
            cycleBpRunner(1);
          }
          if (btnA && !lastPadState.btnA) {
            activateBpPropertyRow(1);
          }
          if (btnB && !lastPadState.btnB) {
            closeBpPropertiesModal();
          }
        } else if (bpMenuState.open && bpMenuState.game) {
          const mainItems = getBpMainMenuItems(bpMenuState.game);
          const manageItems = getBpManageSubmenuItems(bpMenuState.game);

          if (dpadUp && !lastPadState.up) {
            if (bpMenuState.focusCol === "main") {
              bpMenuState.mainIdx = (bpMenuState.mainIdx - 1 + mainItems.length) % mainItems.length;
            } else {
              bpMenuState.manageIdx = (bpMenuState.manageIdx - 1 + manageItems.length) % manageItems.length;
            }
            renderBpGameDetails();
          }
          if (dpadDown && !lastPadState.down) {
            if (bpMenuState.focusCol === "main") {
              bpMenuState.mainIdx = (bpMenuState.mainIdx + 1) % mainItems.length;
            } else {
              bpMenuState.manageIdx = (bpMenuState.manageIdx + 1) % manageItems.length;
            }
            renderBpGameDetails();
          }
          if (dpadRight && !lastPadState.right) {
            if (bpMenuState.focusCol === "main" && mainItems[bpMenuState.mainIdx]?.id === "manage") {
              bpMenuState.focusCol = "manage";
              bpMenuState.manageIdx = 0;
              renderBpGameDetails();
            }
          }
          if (dpadLeft && !lastPadState.left) {
            if (bpMenuState.focusCol === "manage") {
              bpMenuState.focusCol = "main";
              renderBpGameDetails();
            }
          }
          if (btnA && !lastPadState.btnA) {
            confirmBpGameDetailsSelection();
          }
          if (btnB && !lastPadState.btnB) {
            if (bpMenuState.focusCol === "manage") {
              bpMenuState.focusCol = "main";
              renderBpGameDetails();
            } else {
              closeBpGameDetails();
            }
          }
        } else {
          let bpGames = getBpGamesFiltered();
          const bpTabsList = ["installed", "favorites", "steam", "epic", "gog"];

          if (dpadLeft && !lastPadState.left) { if (bpGames.length > 0) moveBpFocus(bpIndex - 1); }
          if (dpadRight && !lastPadState.right) { if (bpGames.length > 0) moveBpFocus(bpIndex + 1); }

          if (lb && !lastPadState.lb) {
            let idx = bpTabsList.indexOf(bpTab);
            idx = (idx - 1 + bpTabsList.length) % bpTabsList.length;
            bpTab = bpTabsList[idx];
            bpIndex = 0;
            updateBpTabUi();
            renderBigPicture();
          }
          if (rb && !lastPadState.rb) {
            let idx = bpTabsList.indexOf(bpTab);
            idx = (idx + 1) % bpTabsList.length;
            bpTab = bpTabsList[idx];
            bpIndex = 0;
            updateBpTabUi();
            renderBigPicture();
          }

          if (btnA && !lastPadState.btnA) {
            if (bpGames[bpIndex]) {
              if (checkInstalled(bpGames[bpIndex])) launchGame(bpGames[bpIndex]);
              else openBpGameDetails(bpGames[bpIndex]);
            }
          }
          if (btnB && !lastPadState.btnB) document.getElementById("btn-exit-bigpicture")?.click();
          if (btnX && !lastPadState.btnX) {
            if (bpGames[bpIndex]) openBpGameDetails(bpGames[bpIndex]);
          }
          if (btnY && !lastPadState.btnY) {
            showToast(t("toast.bp_search_unimpl"), "info");
          }
        }
      }

      lastPadState = { left: dpadLeft, right: dpadRight, up: dpadUp, down: dpadDown, btnA, btnB, btnX, btnY, lb, rb, btnMenu };
    }
    if (pad) {
      gamepadLoopId = requestAnimationFrame(updateGamepad);
    } else {
      gamepadLoopId = setTimeout(resumeGamepadLoop, 250);
    }
  };
  gamepadLoopId = requestAnimationFrame(updateGamepad);
}

async function openGameFilesFolder(game) {
  const invoke = getInvoke();
  if (!invoke || !game) return;

  try {
    await invoke("open_game_folder", {
      exePath: game.exe_path || "",
      winePrefix: game.wine_prefix || null,
      title: game.title || null
    });
    showToast(t("toast.folder_opened", { title: game.title }), "success");
  } catch (err) {
    showToast(t("toast.error_generic", { err }), "error");
  }
}

function openRunInPrefixModal(game) {
  if (!game) return;
  selectedPrefixGame = game;
  const pathInp = document.getElementById("prefix-exe-path");
  if (pathInp) pathInp.value = "";
  openModalAnimated("prefix-exe-modal");
}

function mergeEpicSyncResult(result) {
  const existingMap = new Map(games.map(g => [g.id, g]));
  let addedCount = 0;

  for (const epicGame of result.games) {
    const isInstalled = Boolean(epicGame.exe_path && epicGame.exe_path.length > 0);
    epicGame.is_installed = isInstalled;

    if (!existingMap.has(epicGame.id)) {
      games.push(epicGame);
      addedCount++;
    } else {
      const existing = existingMap.get(epicGame.id);
      if (!existing.exe_path && epicGame.exe_path) {
        existing.exe_path = epicGame.exe_path;
        existing.is_installed = true;
      }
    }
  }

  return addedCount;
}

let pendingEpicInstallGame = null;

async function openEpicInstallModal(game) {
  pendingEpicInstallGame = game;
  const modal = document.getElementById("epic-install-modal");
  if (!modal) return;

  const titleEl = document.getElementById("epic-install-title");
  const coverEl = document.getElementById("epic-install-cover");
  if (titleEl) titleEl.textContent = game.title;
  if (coverEl) coverEl.src = game.cover_url || "";

  modal.classList.remove("hidden");
  modal.classList.add("flex");

  await refreshLegendaryStatus();
}

const PAUSE_ICON_SVG = `
<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
<line x1="9" y1="6" x2="9" y2="18"></line>
<line x1="15" y1="6" x2="15" y2="18"></line>
</svg>
`;

const PLAY_ICON_SVG = `
<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
<polygon points="7 5 19 12 7 19 7 5"></polygon>
</svg>
`;

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return t("modal.epic_inst.unknown");
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

async function checkEpicInstallDiskSpace() {
  if (!pendingEpicInstallGame) return;
  const invoke = getInvoke();
  if (!invoke) return;

  const reqEl = document.getElementById("epic-space-required");
  const availEl = document.getElementById("epic-space-available");
  const warnEl = document.getElementById("epic-space-warning");
  const startBtn = document.getElementById("btn-epic-install-start");
  const installDir = document.getElementById("epic-install-path")?.value.trim() || "";

  if (startBtn) {
    startBtn.disabled = true;
    startBtn.textContent = t("modal.epic_inst.checking");
    startBtn.classList.add("opacity-50", "pointer-events-none");
  }
  if (reqEl) reqEl.textContent = t("modal.epic_inst.checking");
  if (availEl) availEl.textContent = t("modal.epic_inst.checking");
  warnEl?.classList.add("hidden");

  try {
    const info = await invoke("get_epic_game_disk_info", {
      appName: pendingEpicInstallGame.id,
      installDir,
    });

    if (reqEl) reqEl.textContent = formatBytes(info.required_bytes);
    if (availEl) {
      availEl.textContent = formatBytes(info.available_bytes);
      availEl.className = info.has_enough_space
      ? "font-mono font-bold text-emerald-400"
      : "font-mono font-bold text-red-400";
    }

    if (!info.has_enough_space) {
      warnEl?.classList.remove("hidden");
      if (startBtn) {
        startBtn.disabled = true;
        startBtn.textContent = t("modal.epic_inst.start");
        startBtn.classList.add("opacity-50", "pointer-events-none");
      }
    } else {
      warnEl?.classList.add("hidden");
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.textContent = t("modal.epic_inst.start");
        startBtn.classList.remove("opacity-50", "pointer-events-none");
      }
    }
  } catch (err) {
    if (reqEl) reqEl.textContent = t("modal.epic_inst.unknown");
    if (availEl) availEl.textContent = t("modal.epic_inst.unknown");
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.textContent = t("modal.epic_inst.start");
      startBtn.classList.remove("opacity-50", "pointer-events-none");
    }
  }
}

async function refreshLegendaryStatus() {
  const invoke = getInvoke();
  if (!invoke) return;

  try {
    const status = await invoke("check_legendary_status");
    const pathInput = document.getElementById("epic-install-path");
    if (pathInput && !pathInput.value) pathInput.value = status.default_dir;

    const warnBox = document.getElementById("legendary-missing-warning");
    const startBtn = document.getElementById("btn-epic-install-start");
    const recheckBtn = document.getElementById("btn-epic-install-recheck");

    if (status.installed) {
      warnBox?.classList.add("hidden");
      recheckBtn?.classList.add("hidden");
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.classList.remove("opacity-50", "pointer-events-none");
      }
      await checkEpicInstallDiskSpace();
    } else {
      warnBox?.classList.remove("hidden");
      recheckBtn?.classList.remove("hidden");
      if (startBtn) {
        startBtn.disabled = true;
        startBtn.classList.add("opacity-50", "pointer-events-none");
      }
    }
  } catch (err) {
    showToast(t("toast.error_generic", { err }), "error");
  }
}

function closeEpicInstallModal() {
  const modal = document.getElementById("epic-install-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }
  pendingEpicInstallGame = null;
}

function setupEventListeners() {
  window.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!e.target.closest("[data-game-id]")) {
      document.getElementById("custom-context-menu")?.classList.add("hidden");
    }
    if (!e.target.closest("[data-source-name]")) {
      document.getElementById("source-context-menu")?.classList.add("hidden");
    }
  });

  window.addEventListener("click", () => {
    document.getElementById("custom-context-menu")?.classList.add("hidden");
    document.getElementById("source-context-menu")?.classList.add("hidden");
  });

  const handleBpPrimaryAction = async () => {
    const bpGames = getBpGamesFiltered();
    if (bpGames.length === 0) return;
    const game = bpGames[bpIndex];
    if (!game) return;
    if (runningGames[game.id]) {
      const invoke = getInvoke();
      if (invoke) {
        await invoke("kill_game_process", { gameId: game.id });
        showToast(t("toast.force_stop", { title: game.title }), "info");
      }
    } else if (checkInstalled(game)) {
      launchGame(game);
    } else {
      openBpGameDetails(game);
    }
  };

  document.getElementById("bp-btn-play")?.addEventListener("click", handleBpPrimaryAction);

  document.getElementById("btn-check-updates")?.addEventListener("click", () => {
    checkForAppUpdates(false);
  });
  document.getElementById("btn-install-update")?.addEventListener("click", () => {
    installPendingAppUpdate();
  });

  document.getElementById("btn-add-dll")?.addEventListener("click", () => addDllOverrideRow());
  document.getElementById("btn-add-env")?.addEventListener("click", () => addEnvVarRow());

  document.getElementById("bp-btn-a")?.addEventListener("click", handleBpPrimaryAction);

  const btnToggleAdv = document.getElementById("btn-toggle-advanced");
  const advContainer = document.getElementById("advanced-options-container");
  const advChevron = document.getElementById("advanced-chevron");

  btnToggleAdv?.addEventListener("click", () => {
    advContainer?.classList.toggle("hidden");
    advChevron?.classList.toggle("rotate-180");
  });

  document.getElementById("bp-btn-b")?.addEventListener("click", () => {
    document.getElementById("btn-exit-bigpicture")?.click();
  });

  document.getElementById("bp-btn-x")?.addEventListener("click", () => {
    let bpGames = getBpGamesFiltered();
    if (bpGames[bpIndex]) openBpGameDetails(bpGames[bpIndex]);
  });

    document.getElementById("bp-btn-y")?.addEventListener("click", () => {
      showToast(t("toast.bp_search_unimpl"), "info");
    });

    document.getElementById("btn-toggle-theme")?.addEventListener("click", () => {
      applyTheme(currentTheme === "dark" ? "light" : "dark");
    });

    document.getElementById("btn-open-about")?.addEventListener("click", () => { openModalAnimated("about-modal"); });
    document.getElementById("close-about-modal")?.addEventListener("click", () => { closeModalAnimated("about-modal"); });
    document.getElementById("btn-close-about-ok")?.addEventListener("click", () => { closeModalAnimated("about-modal"); });
    document.getElementById("about-modal")?.addEventListener("click", (e) => {
      if (e.target.id === "about-modal") closeModalAnimated("about-modal");
    });

      const dropdownToggleBtn = document.getElementById("btn-add-game-dropdown-toggle");
      const dropdownMenu = document.getElementById("add-game-dropdown-menu");

      dropdownToggleBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        dropdownMenu?.classList.toggle("hidden");
      });

      window.addEventListener("click", () => {
        if (dropdownMenu && !dropdownMenu.classList.contains("hidden")) {
          dropdownMenu.classList.add("hidden");
        }
      });

      document.getElementById("ctx-browse-files")?.addEventListener("click", () => {
        if (selectedCtxGame) openGameFilesFolder(selectedCtxGame);
        document.getElementById("custom-context-menu")?.classList.add("hidden");
      });

      document.getElementById("ctx-run-prefix")?.addEventListener("click", () => {
        if (selectedCtxGame) openRunInPrefixModal(selectedCtxGame);
        document.getElementById("custom-context-menu")?.classList.add("hidden");
      });

      document.getElementById("ctx-play")?.addEventListener("click", () => {
        if (selectedCtxGame) launchGame(selectedCtxGame);
      });

        document.getElementById("ctx-favorite")?.addEventListener("click", async () => {
          if (selectedCtxGame) {
            selectedCtxGame.favorite = !selectedCtxGame.favorite;
            await saveGamesToDisk();
            renderGames();
          }
        });

        document.getElementById("ctx-fetch-art")?.addEventListener("click", () => {
          if (selectedCtxGame) fetchCoverForGame(selectedCtxGame);
        });

          document.getElementById("ctx-manage-tags")?.addEventListener("click", () => {
            if (selectedCtxGame) openTagsModal(selectedCtxGame);
          });

            document.getElementById("ctx-configure")?.addEventListener("click", () => {
              if (selectedCtxGame) openEditModal(selectedCtxGame);
            });

              document.getElementById("ctx-remove")?.addEventListener("click", () => {
                if (selectedCtxGame) {
                  openRemoveConfirmModal(selectedCtxGame);
                }
                document.getElementById("custom-context-menu")?.classList.add("hidden");
              });

              document.getElementById("close-remove-modal")?.addEventListener("click", () => closeModalAnimated("remove-confirm-modal"));
              document.getElementById("btn-cancel-remove")?.addEventListener("click", () => closeModalAnimated("remove-confirm-modal"));

              document.getElementById("btn-confirm-remove")?.addEventListener("click", async () => {
                if (!selectedRemoveGame) return;
                const chkUninstall = document.getElementById("chk-uninstall-files");
                const shouldUninstall = chkUninstall ? chkUninstall.checked : false;

                const invoke = getInvoke();
                const sourceTag = getSourceTag(selectedRemoveGame);

                if (invoke && shouldUninstall) {
                  try {
                    showToast(t("toast.game_uninstalling_files", { title: selectedRemoveGame.title }), "info");
                    if (sourceTag === "EPIC" || selectedRemoveGame.id.startsWith("epic_")) {
                      await invoke("uninstall_epic_game", {
                        appName: selectedRemoveGame.id,
                        exePath: selectedRemoveGame.exe_path || ""
                      });
                    } else {
                      await invoke("uninstall_game_files", {
                        exePath: selectedRemoveGame.exe_path || "",
                        winePrefix: selectedRemoveGame.wine_prefix || null
                      });
                    }
                    showToast(t("toast.game_files_deleted", { title: selectedRemoveGame.title }), "success");
                  } catch (err) {
                    showToast(t("toast.error_generic", { err }), "error");
                  }
                }

                const isExternalGame = sourceTag !== "CUSTOM" && sourceTag !== "NATIVE";

                if (isExternalGame) {
                  selectedRemoveGame.is_installed = false;

                  if (sourceTag === "STEAM") {
                    const appId = selectedRemoveGame.id.replace("steam_", "");
                    selectedRemoveGame.exe_path = `steam://install/${appId}`;
                  } else {
                    selectedRemoveGame.exe_path = "";
                  }

                  showToast(t("toast.game_moved_cloud", { title: selectedRemoveGame.title }), "info");
                } else {
                  games = games.filter(g => g.id !== selectedRemoveGame.id);
                  showToast(t("toast.game_deleted", { title: selectedRemoveGame.title }), "info");
                }

                await saveGamesToDisk();
                renderGames();
                renderSidebarTags();
                if (isBigPicture) renderBigPicture();

                closeModalAnimated("remove-confirm-modal");
                selectedRemoveGame = null;
              });

              document.getElementById("ctx-toggle-hide")?.addEventListener("click", async () => {
                if (selectedCtxGame) {
                  selectedCtxGame.hidden = !selectedCtxGame.hidden;
                  await saveGamesToDisk();
                  renderGames();
                  showToast(
                    selectedCtxGame.hidden
                    ? t("toast.game_hidden", { title: selectedCtxGame.title })
                    : t("toast.game_unhidden", { title: selectedCtxGame.title }),
                            "info"
                  );
                }
              });

              document.getElementById("btn-browse-prefix-exe")?.addEventListener("click", async () => {
                const invoke = getInvoke();
                if (!invoke) return;
                try {
                  const path = await invoke("select_file_dialog");
                  if (path) document.getElementById("prefix-exe-path").value = path;
                } catch (err) {
                  showToast(t("toast.error_generic", { err }), "error");
                }
              });

              document.getElementById("btn-run-prefix-exe")?.addEventListener("click", async () => {
                const invoke = getInvoke();
                const exePath = document.getElementById("prefix-exe-path").value.trim();

                if (!exePath || !selectedPrefixGame) {
                  showToast(t("toast.prefix_invalid_exe"), "error");
                  return;
                }

                try {
                  await invoke("run_exe_in_prefix", {
                    exePath: exePath,
                    winePrefix: selectedPrefixGame.wine_prefix || null,
                    runnerPath: selectedPrefixGame.runner_path || null
                  });
                  showToast(t("toast.prefix_launched"), "success");
                  closeModalAnimated("prefix-exe-modal");
                } catch (err) {
                  showToast(t("toast.error_generic", { err }), "error");
                }
              });

              const ctxWineToolsBtn = document.getElementById("ctx-wine-tools-btn");
              const ctxWineToolsSubmenu = document.getElementById("ctx-wine-tools-submenu");

              if (ctxWineToolsSubmenu) {
                document.body.appendChild(ctxWineToolsSubmenu);
                ctxWineToolsSubmenu.classList.remove("group-hover/wine:block", "absolute", "left-full", "right-full", "top-0", "bottom-0", "ml-1.5", "mr-1.5");
                ctxWineToolsSubmenu.classList.add("fixed", "z-[1000000]");
              }

              const openWineSubmenu = () => {
                if (!ctxWineToolsBtn || !ctxWineToolsSubmenu) return;
                const btnRect = ctxWineToolsBtn.getBoundingClientRect();
                ctxWineToolsSubmenu.classList.remove("hidden");

                const subRect = ctxWineToolsSubmenu.getBoundingClientRect();
                const subW = subRect.width || 208;
                const subH = subRect.height || 245;

                let left = btnRect.right + 6;
                if (left + subW > window.innerWidth - 12) {
                  left = btnRect.left - subW - 6;
                }

                let top = btnRect.top;
                if (top + subH > window.innerHeight - 12) {
                  top = Math.max(10, window.innerHeight - subH - 12);
                }

                ctxWineToolsSubmenu.style.left = `${Math.max(10, left)}px`;
                ctxWineToolsSubmenu.style.top = `${top}px`;
              };

              ctxWineToolsBtn?.addEventListener("mouseenter", openWineSubmenu);
              ctxWineToolsBtn?.addEventListener("click", (e) => {
                e.stopPropagation();
                if (ctxWineToolsSubmenu?.classList.contains("hidden")) {
                  openWineSubmenu();
                } else {
                  ctxWineToolsSubmenu?.classList.add("hidden");
                }
              });

              document.querySelectorAll("#custom-context-menu > button").forEach((otherBtn) => {
                otherBtn.addEventListener("mouseenter", () => {
                  ctxWineToolsSubmenu?.classList.add("hidden");
                });
              });

              window.addEventListener("click", () => {
                ctxWineToolsSubmenu?.classList.add("hidden");
              });

              window.addEventListener("contextmenu", (e) => {
                if (!e.target.closest("[data-game-id]")) {
                  ctxWineToolsSubmenu?.classList.add("hidden");
                }
              });

              document.querySelectorAll(".wine-tool-item").forEach((btn) => {
                btn.addEventListener("click", async (e) => {
                  e.stopPropagation();
                  const invoke = getInvoke();
                  const tool = btn.dataset.wineTool;

                  ctxWineToolsSubmenu?.classList.add("hidden");
                  document.getElementById("custom-context-menu")?.classList.add("hidden");

                  if (!selectedCtxGame || !invoke) return;

                  const winePrefix = selectedCtxGame.wine_prefix?.trim() || null;
                  const runnerPath = selectedCtxGame.runner_path?.trim() || getDefaultRunner() || null;

                  try {
                    await invoke("run_wine_tool", {
                      tool,
                      winePrefix,
                      runnerPath,
                    });
                    showToast(t("toast.wine_tool_opening", { tool }), "info");
                  } catch (err) {
                    showToast(t("toast.error_generic", { err }), "error");
                  }
                });
              });

              document.getElementById("btn-close-prefix-modal")?.addEventListener("click", () => { closeModalAnimated("prefix-exe-modal"); });
              document.getElementById("btn-close-prefix-x")?.addEventListener("click", () => { closeModalAnimated("prefix-exe-modal"); });

              document.getElementById("btn-install-game")?.addEventListener("click", () => {
                dropdownMenu?.classList.add("hidden");
                const select = document.getElementById("inst-runner");
                if (select && availableRunners) {
                  select.innerHTML = "";
                  availableRunners.forEach(r => {
                    const opt = document.createElement("option");
                    opt.value = r.path;
                    opt.textContent = r.name;
                    select.appendChild(opt);
                  });
                }
                openModalAnimated("installer-modal");
              });

              document.getElementById("close-installer-modal")?.addEventListener("click", () => { closeModalAnimated("installer-modal"); });

              document.getElementById("btn-browse-installer")?.addEventListener("click", async () => {
                const invoke = getInvoke();
                if (!invoke) return;

                try {
                  const path = await invoke("select_file_dialog");
                  if (path) {
                    document.getElementById("inst-exepath").value = path;
                    if (!document.getElementById("inst-title").value) {
                      const fileName = path.split("/").pop();
                      const cleanName = fileName.replace(/setup|installer|_|\.exe/gi, " ").trim();
                      document.getElementById("inst-title").value = cleanName || "New Game";
                    }
                  }
                } catch (err) {
                  showToast(t("toast.error_generic", { err }), "error");
                }
              });

              document.getElementById("btn-start-install")?.addEventListener("click", async () => {
                const title = document.getElementById("inst-title").value.trim();
                const installerPath = document.getElementById("inst-exepath").value.trim();
                const runnerPath = document.getElementById("inst-runner").value;

                if (!title || !installerPath) {
                  showToast(t("toast.installer_missing_fields"), "error");
                  return;
                }

                closeModalAnimated("installer-modal");
                showToast(t("toast.installer_running", { title }), "info");

                const invoke = getInvoke();
                if (!invoke) return;

                try {
                  const res = await invoke("run_game_installer", {
                    installerPath,
                    gameTitle: title,
                    runnerPath
                  });

                  if (res.success && res.detected_exe) {
                    const newGame = {
                      id: Date.now().toString(),
                                                                             title: title,
                                                                             exe_path: res.detected_exe,
                                                                             runner_path: runnerPath,
                                                                             wine_prefix: res.wine_prefix,
                                                                             launch_args: "",
                                                                             use_gamemode: true,
                                                                             use_mangohud: true,
                                                                             cover_url: "",
                                                                             banner_url: "",
                                                                             genre: "Action",
                                                                             source: "custom",
                                                                             favorite: false,
                                                                             hidden: false,
                                                                             tags: []
                    };

                    games.push(newGame);
                    await saveGamesToDisk();
                    renderGames();
                    showToast(t("toast.installer_success", { title }), "success");
                    fetchCoverForGame(newGame);
                  } else {
                    showToast(res.message || t("toast.installer_cancelled"), "info");
                  }
                } catch (err) {
                  showToast(t("toast.error_generic", { err }), "error");
                }
              });

              const exitBigPicture = async () => {
                if (!isBigPicture) return;
                isBigPicture = false;
                window.scrollTo(0, 0);
                if (document.body) document.body.scrollTop = 0;
                document.getElementById("big-picture-view")?.classList.add("hidden");
                document.getElementById("desktop-mode-view")?.classList.remove("hidden");
                await setFullscreenMode(false);
                renderGames();
              };

              document.addEventListener("fullscreenchange", () => {
                if (!document.fullscreenElement && isBigPicture) exitBigPicture();
              });

                document.getElementById("btn-login-epic")?.addEventListener("click", () => { openModalAnimated("epic-login-modal"); });
                document.getElementById("btn-login-steam")?.addEventListener("click", () => {
                  showToast(t("toast.steam_auto_detected"), "info");
                  syncExternalGames();
                });
                document.getElementById("btn-login-gog")?.addEventListener("click", () => {
                  showToast(t("toast.gog_soon"), "info");
                });

                document.getElementById("btn-scan-lutris")?.addEventListener("click", async () => {
                  showToast(t("toast.lutris_scanning"), "info");
                  const invoke = getInvoke();
                  if (!invoke) return;

                  try {
                    const scanned = await invoke("scan_external_launchers");
                    const lutrisGames = scanned.filter(g => g.source === "lutris");
                    let added = 0;

                    lutrisGames.forEach(scannedGame => {
                      const exists = games.some(g => g.id === scannedGame.id || g.title.toLowerCase() === scannedGame.title.toLowerCase());
                      if (!exists) {
                        games.push(scannedGame);
                        added++;
                      }
                    });

                    if (added > 0) {
                      await saveGamesToDisk();
                      renderGames();
                      renderSidebarTags();
                      showToast(t("toast.lutris_imported", { count: added }), "success");
                    } else {
                      showToast(t("toast.lutris_none"), "info");
                    }
                  } catch (err) {
                    showToast(t("toast.error_generic", { err }), "error");
                  }
                });

                document.getElementById("close-epic-modal")?.addEventListener("click", () => { closeModalAnimated("epic-login-modal"); });
                document.getElementById("epic-login-modal")?.addEventListener("click", (e) => {
                  if (e.target.id === "epic-login-modal") closeModalAnimated("epic-login-modal");
                });

                  document.getElementById("btn-submit-epic-auth")?.addEventListener("click", async () => {
                    const codeInput = document.getElementById("inp-epic-code");
                    const authCode = codeInput ? codeInput.value.trim() : "";
                    if (!authCode) {
                      showToast(t("toast.epic_auth_enter_code"), "error");
                      return;
                    }

                    const invoke = getInvoke();
                    if (!invoke) return;

                    try {
                      showToast(t("toast.epic_authenticating"), "info");
                      const result = await invoke("login_epic_games", { authCode });
                      mergeEpicSyncResult(result);

                      await saveGamesToDisk();
                      renderGames();
                      renderSidebarTags();
                      if (isBigPicture) renderBigPicture();

                      if (codeInput) codeInput.value = "";
                      closeModalAnimated("epic-login-modal");
                      showToast(t("toast.epic_connected", { name: result.display_name, count: result.games.length }), "success");
                    } catch (err) {
                      showToast(String(err), "error");
                    }
                  });

                  document.getElementById("btn-epic-browse-dir")?.addEventListener("click", async () => {
                    const invoke = getInvoke();
                    if (!invoke) return;
                    try {
                      const selected = await invoke("select_folder_dialog");
                      if (selected) {
                        document.getElementById("epic-install-path").value = selected;
                        await checkEpicInstallDiskSpace();
                      }
                    } catch (err) {
                      showToast(t("toast.error_generic", { err }), "error");
                    }
                  });

                  document.getElementById("btn-epic-install-cancel")?.addEventListener("click", (e) => {
                    e.preventDefault();
                    closeEpicInstallModal();
                  });

                  document.getElementById("epic-install-modal")?.addEventListener("click", (e) => {
                    if (e.target.id === "epic-install-modal") {
                      closeEpicInstallModal();
                    }
                  });

                  document.getElementById("epic-install-path")?.addEventListener("change", () => {
                    checkEpicInstallDiskSpace();
                  });

                  document.getElementById("btn-epic-install-start")?.addEventListener("click", async () => {
                    if (!pendingEpicInstallGame) return;
                    const invoke = getInvoke();
                    if (!invoke) return;

                    const installDir = document.getElementById("epic-install-path").value.trim();
                    if (!installDir) {
                      showToast(t("toast.select_valid_dir"), "error");
                      return;
                    }

                    const game = pendingEpicInstallGame;
                    closeEpicInstallModal();

                    pausedEpicDownload = {
                      gameId: game.id,
                      title: game.title,
                      installDir,
                      percent: 0,
                      paused: false,
                    };
                    localStorage.setItem("nexus_paused_epic", JSON.stringify(pausedEpicDownload));

                    try {
                      await invoke("install_epic_game", {
                        appName: game.id,
                        gameTitle: game.title,
                        installDir,
                      });
                      showToast(t("toast.epic_started", { title: game.title }), "info");
                    } catch (err) {
                      showToast(String(err), "error");
                    }
                  });

                  document.getElementById("btn-pause-download")?.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    const invoke = getInvoke();
                    if (!invoke || !pausedEpicDownload) return;

                    const badge = document.getElementById("dl-status-badge");
                    const speedEl = document.getElementById("dl-speed");

                    if (pausedEpicDownload.paused) {
                      if (badge) badge.textContent = t("sidebar.resuming");
                      if (speedEl) speedEl.textContent = t("sidebar.resuming_status");
                      try {
                        await invoke("install_epic_game", {
                          appName: pausedEpicDownload.gameId,
                          gameTitle: pausedEpicDownload.title,
                          installDir: pausedEpicDownload.installDir,
                        });
                      } catch (err) {
                        showToast(t("toast.error_generic", { err }), "error");
                      }
                    } else {
                      if (badge) badge.textContent = t("sidebar.pausing");
                      if (speedEl) speedEl.textContent = t("sidebar.pausing_status");
                      try {
                        await invoke("pause_epic_install");
                      } catch (err) {
                        showToast(t("toast.error_generic", { err }), "error");
                      }
                    }
                  });

                  document.getElementById("btn-cancel-download")?.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    const invoke = getInvoke();
                    if (!invoke) return;

                    const wasPaused = Boolean(pausedEpicDownload?.paused);
                    const appName = pausedEpicDownload?.gameId || null;
                    const installDir = pausedEpicDownload?.installDir || null;

                    const badge = document.getElementById("dl-status-badge");
                    const speedEl = document.getElementById("dl-speed");
                    const panel = document.getElementById("dl-active-panel");
                    if (badge) badge.textContent = t("sidebar.cancelling");
                    if (speedEl) speedEl.textContent = t("sidebar.cancelling_status");

                    try {
                      await invoke("cancel_epic_install", { appName, installDir });
                      if (wasPaused) {
                        pausedEpicDownload = null;
                        localStorage.removeItem("nexus_paused_epic");
                        if (badge) {
                          badge.textContent = t("sidebar.idle");
                          badge.className = "text-slate-500 font-medium";
                        }
                        if (panel) panel.classList.add("hidden");
                        renderGames();
                        if (isBigPicture) renderBigPicture();
                        showToast(t("toast.epic_cancelled_paused"), "info");
                      }
                    } catch (err) {
                      showToast(t("toast.error_generic", { err }), "error");
                    }
                  });

                  document.getElementById("btn-add-game")?.addEventListener("click", () => { openEditModal(null); });
                  document.getElementById("close-modal")?.addEventListener("click", () => { closeModalAnimated("game-modal"); });
                  document.getElementById("close-tags-modal")?.addEventListener("click", () => { closeModalAnimated("tags-modal"); });

                  document.getElementById("btn-save-tags")?.addEventListener("click", async () => {
                    if (selectedCtxGame) {
                      const inp = document.getElementById("inp-tags-list").value;
                      const tagArray = inp.split(",").map(tag => tag.trim()).filter(tag => tag.length > 0);
                      selectedCtxGame.tags = tagArray;
                      await saveGamesToDisk();
                      renderGames();
                      renderSidebarTags();
                      closeModalAnimated("tags-modal");
                    }
                  });

                  document.querySelectorAll(".tag-preset").forEach(btn => {
                    btn.addEventListener("click", () => {
                      const tagText = btn.textContent.replace("+ ", "").trim();
                      const inp = document.getElementById("inp-tags-list");
                      const current = inp.value.split(",").map(tag => tag.trim()).filter(tag => tag.length > 0);
                      if (!current.includes(tagText)) {
                        current.push(tagText);
                        inp.value = current.join(", ");
                      }
                    });
                  });

                  document.getElementById("btn-open-runners")?.addEventListener("click", () => {
                    switchRunnersTab('installed');
                    openModalAnimated("runners-modal");
                    if (window.lucide) window.lucide.createIcons();
                  });

                    document.getElementById("close-runners-btn")?.addEventListener("click", () => {
                      closeModalAnimated("runners-modal");
                    });

                    document.getElementById("runners-modal")?.addEventListener("click", (e) => {
                      if (e.target.id === "runners-modal") closeModalAnimated("runners-modal");
                    });

                      document.getElementById("btn-open-config")?.addEventListener("click", () => {
                        const invoke = getInvoke();
                        if (invoke) {
                          invoke("get_tray_settings")
                          .then((ts) => {
                            const chkClose = document.getElementById("cfg-close-to-tray");
                            const chkBg = document.getElementById("cfg-start-background");
                            if (chkClose) chkClose.checked = ts.close_to_tray;
                            if (chkBg) chkBg.checked = ts.start_in_background;
                          })
                          .catch(() => {});
                        }
                        openModalAnimated("config-modal");
                      });

                      document.getElementById("close-config-modal")?.addEventListener("click", () => { closeModalAnimated("config-modal"); });

                      document.querySelectorAll("[data-source-sync]").forEach(btn => {
                        btn.addEventListener("click", () => { syncExternalGames(); });
                      });

                      document.querySelectorAll(".cfg-tab").forEach(tab => {
                        tab.addEventListener("click", () => {
                          document.querySelectorAll(".cfg-tab").forEach(tabEl => {
                            tabEl.classList.remove("active", "text-indigo-400", "bg-indigo-950/60", "border", "border-indigo-800/50");
                            tabEl.classList.add("text-slate-400");
                          });

                          tab.classList.add("active", "text-indigo-400", "bg-indigo-950/60", "border", "border-indigo-800/50");
                          tab.classList.remove("text-slate-400");

                          document.querySelectorAll(".cfg-content").forEach(c => c.classList.add("hidden"));
                          const target = tab.dataset.cfgTab;
                          const contentEl = document.getElementById(`cfg-content-${target}`);
                          if (contentEl) contentEl.classList.remove("hidden");
                        });
                      });

                      document.getElementById("btn-save-config")?.addEventListener("click", async () => {
                        const invoke = getInvoke();
                        const closeToTray = document.getElementById("cfg-close-to-tray")?.checked ?? true;
                        const startInBackground = document.getElementById("cfg-start-background")?.checked ?? false;
                        if (invoke) {
                          await invoke("update_tray_settings", {
                            closeToTray,
                            startInBackground,
                          }).catch((e) => console.error("Tray settings save error:", e));
                        }
                        closeModalAnimated("config-modal");
                      });

                      document.getElementById("select-sort")?.addEventListener("change", (e) => {
                        selectedSort = e.target.value;
                        renderGames();
                      });

                      document.getElementById("btn-view-grid")?.addEventListener("click", () => {
                        viewMode = "grid";
                        document.getElementById("btn-view-grid").className = "p-2 rounded-lg bg-indigo-950 text-indigo-400 transition-colors";
                        document.getElementById("btn-view-list").className = "p-2 rounded-lg text-slate-500 hover:text-slate-300 bg-transparent transition-colors";
                        renderGames();
                      });

                      document.getElementById("btn-view-list")?.addEventListener("click", () => {
                        viewMode = "list";
                        document.getElementById("btn-view-list").className = "p-2 rounded-lg bg-indigo-950 text-indigo-400 transition-colors";
                        document.getElementById("btn-view-grid").className = "p-2 rounded-lg text-slate-500 hover:text-slate-300 bg-transparent transition-colors";
                        renderGames();
                      });

                      document.getElementById("btn-browse-exe")?.addEventListener("click", async () => {
                        const invoke = getInvoke();
                        if (!invoke) return;

                        try {
                          const path = await invoke("select_file_dialog");
                          if (path) {
                            document.getElementById("inp-exepath").value = path;
                            if (!document.getElementById("inp-title").value) {
                              const name = path.split("/").pop().replace(".exe", "");
                              document.getElementById("inp-title").value = name;
                            }
                          }
                        } catch (err) {
                          showToast(t("toast.error_generic", { err }), "error");
                        }
                      });

                      document.getElementById("btn-save-game")?.addEventListener("click", async () => {
                        const title = document.getElementById("inp-title").value.trim();
                        const exe_path = document.getElementById("inp-exepath").value.trim();
                        const runner_path = document.getElementById("select-runner").value;
                        const wine_prefix = document.getElementById("inp-wineprefix").value.trim();
                        const launch_args = document.getElementById("inp-args").value.trim();
                        const cover_url = document.getElementById("inp-cover").value.trim();
                        const use_gamemode = document.getElementById("chk-gamemode") ? document.getElementById("chk-gamemode").checked : true;
                        const use_mangohud = document.getElementById("chk-mangohud") ? document.getElementById("chk-mangohud").checked : true;

                        let env_vars = {};

                        if (document.getElementById("chk-dxvk")?.checked) env_vars["DXVK_ENABLE"] = "true";
                        if (document.getElementById("chk-esync")?.checked) env_vars["WINEESYNC"] = "1";
                        if (document.getElementById("chk-fsync")?.checked) env_vars["WINEFSYNC"] = "1";
                        if (document.getElementById("chk-fsr")?.checked) env_vars["WINE_FULLSCREEN_FSR"] = "1";
                        if (document.getElementById("chk-battleye")?.checked) env_vars["BATTLEYE_RUNTIME"] = "1";
                        if (document.getElementById("chk-eac")?.checked) env_vars["EASY_ANTI_CHEAT_RUNTIME"] = "1";

                        let dllParts = [];
                        document.querySelectorAll(".dll-row").forEach(row => {
                          const name = row.querySelector(".dll-name")?.value.trim();
                          const mode = row.querySelector(".dll-mode")?.value.trim();
                          if (name) {
                            dllParts.push(mode ? `${name}=${mode}` : name);
                          }
                        });
                        if (dllParts.length > 0) {
                          env_vars["WINEDLLOVERRIDES"] = dllParts.join(";");
                        }

                        document.querySelectorAll(".env-row").forEach(row => {
                          const k = row.querySelector(".env-key")?.value.trim();
                          const v = row.querySelector(".env-val")?.value.trim();
                          if (k) {
                            env_vars[k] = v;
                          }
                        });

                        if (!title) {
                          showToast(t("toast.fill_game_title"), "error");
                          return;
                        }
                        const save_path = document.getElementById("edit-game-save-path")?.value.trim() || null;

                        if (editingGameId) {
                          const game = games.find(g => g.id === editingGameId);
                          if (game) {
                            game.title = title;
                            game.exe_path = exe_path;
                            game.runner_path = runner_path;
                            game.wine_prefix = wine_prefix;
                            game.save_path = save_path;
                            game.launch_args = launch_args;
                            game.cover_url = cover_url;
                            game.use_gamemode = use_gamemode;
                            game.use_mangohud = use_mangohud;
                            game.env_vars = env_vars;
                          }
                        } else {
                          games.push({
                            id: Date.now().toString(),
                                     title, exe_path, runner_path, wine_prefix, save_path, launch_args, use_gamemode, use_mangohud,
                                     env_vars,
                                     cover_url, banner_url: cover_url, genre: "Action", source: "custom", favorite: false, hidden: false, tags: []
                          });
                        }

                        await saveGamesToDisk();
                        renderGames();
                        if (isBigPicture) renderBigPicture();
                        renderSidebarTags();
                        closeModalAnimated("game-modal");
                        showToast(t("toast.settings_saved", { title }), "success");
                      });

                      document.querySelectorAll(".bp-nav-tab").forEach(tab => {
                        tab.addEventListener("click", () => {
                          document.querySelectorAll(".bp-nav-tab").forEach(tabEl => {
                            tabEl.classList.remove("active", "bg-indigo-600", "text-white");
                            tabEl.classList.add("text-slate-400");
                          });
                          tab.classList.add("active", "bg-indigo-600", "text-white");
                          tab.classList.remove("text-slate-400");
                          bpTab = tab.dataset.bpTab;
                          bpIndex = 0;
                          renderBigPicture();
                        });
                      });

                      document.querySelectorAll(".nav-tab").forEach(tab => {
                        tab.addEventListener("click", () => {
                          activeTab = tab.dataset.tab;
                          activeSource = "all";
                          selectedTagFilter = "all";

                          updateSidebarNavUi();
                          renderSidebarTags();
                          renderGames();
                        });
                      });

                      document.getElementById("game-search-input")?.addEventListener("input", () => {
                        if (searchDebounceTimeout) clearTimeout(searchDebounceTimeout);
                        searchDebounceTimeout = setTimeout(() => {
                          renderGames();
                        }, 150);
                      });

                      document.getElementById("btn-toggle-mode")?.addEventListener("click", () => {
                        setFullscreenMode(true);
                        isBigPicture = true;
                        updateBpDeviceStatus();
                        bpTab = "installed";
                        bpIndex = 0;
                        document.getElementById("desktop-mode-view")?.classList.add("hidden");
                        document.getElementById("big-picture-view")?.classList.remove("hidden");
                        updateBpTabUi();
                        renderBigPicture();
                      });

                      document.getElementById("btn-exit-bigpicture")?.addEventListener("click", () => { exitBigPicture(); });

                      window.addEventListener("keydown", async (e) => {
                        if (e.key === "Escape" && isBigPicture) {
                          e.preventDefault();
                          await exitBigPicture();
                        }

                        const key = e.key.toLowerCase();

                        const activeElement = document.activeElement ? document.activeElement.tagName.toLowerCase() : "";
                        if (key === "f" && activeElement !== "input" && activeElement !== "textarea") {
                          e.preventDefault();
                          if (isBigPicture) {
                            document.getElementById("btn-exit-bigpicture")?.click();
                          } else {
                            document.getElementById("btn-toggle-mode")?.click();
                          }
                        }

                        if (isBigPicture) {
                          let bpGames = getBpGamesFiltered();

                          if (bpGames.length > 0) {
                            if (key === "arrowright" || key === "d") {
                              e.preventDefault();
                              moveBpFocus(bpIndex + 1);
                            } else if (key === "arrowleft" || key === "a") {
                              e.preventDefault();
                              moveBpFocus(bpIndex - 1);
                            } else if (key === "enter") {
                              e.preventDefault();
                              if (bpGames[bpIndex]) {
                                if (checkInstalled(bpGames[bpIndex])) launchGame(bpGames[bpIndex]);
                                else openEditModal(bpGames[bpIndex]);
                              }
                            }
                          }

                          if (key === "q") {
                            e.preventDefault();
                            const bpTabsList = ["installed", "favorites", "steam", "epic", "gog"];
                            let idx = bpTabsList.indexOf(bpTab);
                            idx = (idx - 1 + bpTabsList.length) % bpTabsList.length;
                            bpTab = bpTabsList[idx];
                            bpIndex = 0;
                            updateBpTabUi();
                            renderBigPicture();
                          } else if (key === "e") {
                            e.preventDefault();
                            const bpTabsList = ["installed", "favorites", "steam", "epic", "gog"];
                            let idx = bpTabsList.indexOf(bpTab);
                            idx = (idx + 1) % bpTabsList.length;
                            bpTab = bpTabsList[idx];
                            bpIndex = 0;
                            updateBpTabUi();
                            renderBigPicture();
                          }
                        }
                      });
}

async function renameGlobalTag(oldTag) {
  const newTag = prompt(t("lib.rename_tag_prompt", { tag: oldTag }), oldTag);
  if (!newTag || newTag.trim() === "" || newTag === oldTag) return;

  const cleanNewTag = newTag.trim();
  games.forEach(g => {
    if (g.tags && Array.isArray(g.tags)) {
      g.tags = g.tags.map(tag => tag === oldTag ? cleanNewTag : tag);
    }
  });

  if (selectedTagFilter === oldTag) selectedTagFilter = cleanNewTag;
  await saveGamesToDisk();
  renderGames();
  renderSidebarTags();
  showToast(t("toast.tag_renamed", { oldTag, newTag: cleanNewTag }), "success");
}

async function deleteGlobalTag(tagToDelete) {
  if (!confirm(t("lib.delete_tag_confirm", { tag: tagToDelete }))) return;

  games.forEach(g => {
    if (g.tags && Array.isArray(g.tags)) {
      g.tags = g.tags.filter(tag => tag !== tagToDelete);
    }
  });

  if (selectedTagFilter === tagToDelete) selectedTagFilter = "all";
  await saveGamesToDisk();
  renderGames();
  renderSidebarTags();
  showToast(t("toast.tag_deleted", { tag: tagToDelete }), "info");
}

window.addEventListener("gamepadconnected", (e) => {
  showToast(t("toast.controller_connected", { id: e.gamepad.id }), "success");
  startGamepadLoop();
});

function updateSidebarNavUi() {
  document.querySelectorAll(".nav-tab").forEach(tab => {
    const isTabActive = (activeSource === "all" && tab.dataset.tab === activeTab);
    if (isTabActive) {
      tab.classList.add("active", "bg-indigo-950/40", "text-indigo-400", "border-indigo-800/40");
      tab.classList.remove("text-slate-400", "border-transparent");
    } else {
      tab.classList.remove("active", "bg-indigo-950/40", "text-indigo-400", "border-indigo-800/40");
      tab.classList.add("text-slate-400", "border-transparent");
    }
  });

  document.querySelectorAll(".sidebar-source-item").forEach(item => {
    const srcName = item.dataset.sourceName;
    const isSourceActive = (activeSource.toLowerCase() === srcName.toLowerCase());
    if (isSourceActive) {
      item.classList.add("bg-indigo-950/60", "border-indigo-600");
      item.classList.remove("border-slate-800/80");
    } else {
      item.classList.remove("bg-indigo-950/60", "border-indigo-600");
      item.classList.add("border-slate-800/80");
    }
  });
}

function updateSourceSidebarUi() {
  ["steam", "epic", "gog", "lutris"].forEach(src => {
    const count = games.filter(g => !isToolOrRuntime(g.title) && !g.hidden && getSourceTag(g).toLowerCase() === src).length;
    const btnLogin = document.getElementById(`btn-login-${src}`);
    const badgeCount = document.getElementById(`badge-count-${src}`);
    const btnScanLutris = document.getElementById("btn-scan-lutris");

    if (count > 0) {
      if (btnLogin) btnLogin.classList.add("hidden");
      if (src === "lutris" && btnScanLutris) btnScanLutris.classList.add("hidden");
      if (badgeCount) {
        badgeCount.textContent = t("sidebar.games_count", { count });
        badgeCount.classList.remove("hidden");
      }
    } else {
      if (btnLogin) btnLogin.classList.remove("hidden");
      if (src === "lutris" && btnScanLutris) btnScanLutris.classList.remove("hidden");
      if (badgeCount) badgeCount.classList.add("hidden");
    }
  });
}

function setupSourceSidebarListeners() {
  document.querySelectorAll(".sidebar-source-item").forEach(item => {
    item.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;

      const src = item.dataset.sourceName;
      activeSource = src;
      activeTab = "all";
      selectedTagFilter = "all";

      updateSidebarNavUi();
      renderSidebarTags();
      renderGames();
    });

    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const src = item.dataset.sourceName;
      selectedSourceCtx = src;

      const menu = document.getElementById("source-context-menu");
      if (!menu) return;

      const rect = menu.getBoundingClientRect();
      const menuW = rect.width || 190;
      const menuH = rect.height || 100;

      let posX = e.clientX;
      let posY = e.clientY;

      if (posX + menuW > window.innerWidth - 10) posX = posX - menuW;
      if (posY + menuH > window.innerHeight - 10) posY = posY - menuH;

      menu.style.left = `${Math.max(10, posX)}px`;
      menu.style.top = `${Math.max(10, posY)}px`;
      menu.classList.remove("hidden");
      if (window.lucide) window.lucide.createIcons();
    });
  });

  document.getElementById("ctx-source-resync")?.addEventListener("click", async () => {
    if (!selectedSourceCtx) return;

    if (selectedSourceCtx === "epic") {
      const invoke = getInvoke();
      if (!invoke) return;
      try {
        showToast(t("toast.epic_resyncing"), "info");
        const result = await invoke("resync_epic_games");
        const added = mergeEpicSyncResult(result);
        await saveGamesToDisk();
        renderGames();
        renderSidebarTags();
        if (isBigPicture) renderBigPicture();
        showToast(t("toast.epic_resynced", { name: result.display_name, count: added }), "success");
      } catch (err) {
        showToast(String(err), "error");
      }
      return;
    }

    syncExternalGames();
  });

  document.getElementById("ctx-source-disconnect")?.addEventListener("click", async () => {
    if (!selectedSourceCtx) return;
    const srcName = selectedSourceCtx.toUpperCase();

    if (confirm(t("lib.disconnect_confirm", { source: srcName }))) {
      games = games.filter(g => getSourceTag(g).toLowerCase() !== selectedSourceCtx.toLowerCase());
      await saveGamesToDisk();

      if (activeSource.toLowerCase() === selectedSourceCtx.toLowerCase()) {
        activeSource = "all";
        activeTab = "installed";
      }

      updateSidebarNavUi();
      renderGames();
      renderSidebarTags();
      showToast(t("toast.source_disconnected", { source: srcName }), "info");
    }
  });
}

async function enrichSteamTitles() {
  const invoke = getInvoke();
  if (!invoke) return;

  const needTitle = games.filter(g => /^Steam Game \d+$/.test(g.title));
  if (needTitle.length === 0) return;

  const appIds = needTitle.map(g => g.id.replace("steam_", ""));
  showToast(t("toast.steam_fetching_titles", { count: appIds.length }), "info");

  try {
    const resolved = await invoke("resolve_steam_titles", { appIds });
    let updated = 0;

    for (const game of needTitle) {
      const appId = game.id.replace("steam_", "");
      const info = resolved[appId];
      if (info && info.name) {
        game.title = info.name;
        if (!game.cover_url && info.cover_url) {
          game.cover_url = info.cover_url;
        }
        updated++;
      }
    }

    if (updated > 0) {
      await saveGamesToDisk();
      renderGames();
      if (isBigPicture) renderBigPicture();
      showToast(t("toast.steam_updated_titles", { count: updated }), "success");
    }
  } catch (e) {
    console.error("Eroare la actualizarea titlurilor Steam:", e);
  }
}

let isFetchingProtonDb = false;

const BACKUP_ERROR_MAP = {
  ERR_SAVE_DIR_MISSING: "backup_err_dir_missing",
  ERR_SAVE_DIR_EMPTY: "backup_err_dir_empty",
  ERR_BACKUP_NOT_FOUND: "backup_err_not_found",
  ERR_INVALID_ARCHIVE: "backup_err_invalid_archive",
};

function formatBackupError(err) {
  const raw = String(err);
  if (BACKUP_ERROR_MAP[raw]) return t(BACKUP_ERROR_MAP[raw]);
  return `${t("backup_err_generic")} (${raw})`;
}

function formatBackupBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function renderGameBackups(game) {
  const container = document.getElementById("game-backups-list");
  const invoke = getInvoke();
  if (!container || !game || !invoke) return;

  try {
    const backups = await invoke("list_game_backups", { gameId: game.id });
    if (!backups || backups.length === 0) {
      container.innerHTML = `<div class="text-slate-500 text-xs py-1.5 italic">${t("backup_empty_list")}</div>`;
      return;
    }

    container.innerHTML = backups.map((b) => {
      const displayLabel =
      b.label === "AUTO_PRE_RESTORE"
      ? t("backup_auto_pre_restore")
      : escapeHtml(b.label) || t("backup_manual_label");
      const dateStr = new Date(b.created_at * 1000).toLocaleString();

      return `
      <div class="flex justify-between items-center gap-3 px-3 py-2 rounded-lg bg-slate-900/90 border border-slate-800/80">
      <div class="min-w-0">
      <div class="font-bold text-slate-200 text-xs truncate">${displayLabel}</div>
      <div class="text-[11px] font-mono text-slate-400">${dateStr} • ${formatBackupBytes(b.size_bytes)} (${b.file_count} files)</div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
      <button type="button" class="btn-restore-bkp px-2.5 py-1 rounded-md bg-emerald-500/15 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 font-bold text-[11px] transition" data-id="${b.id}">${t("backup_restore_btn")}</button>
      <button type="button" class="btn-delete-bkp px-2.5 py-1 rounded-md bg-red-500/15 hover:bg-red-500/30 border border-red-500/40 text-red-400 font-bold text-[11px] transition" data-id="${b.id}">${t("backup_delete_btn")}</button>
      </div>
      </div>
      `;
    }).join("");

    container.querySelectorAll(".btn-restore-bkp").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const savePath = document.getElementById("edit-game-save-path").value.trim();
        if (!savePath) return showToast(t("backup_err_dir_missing"), "error");
        if (!confirm(t("backup_confirm_restore"))) return;

        try {
          await invoke("restore_game_backup", {
            gameId: game.id,
            backupId: btn.dataset.id,
            savePath,
          });
          showToast(t("backup_toast_restored"), "success");
          await renderGameBackups(game);
        } catch (err) {
          showToast(formatBackupError(err), "error");
        }
      });
    });

    container.querySelectorAll(".btn-delete-bkp").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(t("backup_confirm_delete"))) return;
        try {
          await invoke("delete_game_backup", {
            gameId: game.id,
            backupId: btn.dataset.id,
          });
          showToast(t("backup_toast_deleted"), "success");
          await renderGameBackups(game);
        } catch (err) {
          showToast(formatBackupError(err), "error");
        }
      });
    });
  } catch (err) {
    container.innerHTML = `<div style="color: #ff6b6b; font-size: 0.85rem;">${formatBackupError(err)}</div>`;
  }
}

document.getElementById("btn-browse-save-path")?.addEventListener("click", async () => {
  const invoke = getInvoke();
  if (!invoke) return;
  const selected = await invoke("select_folder_dialog");
  if (selected) {
    document.getElementById("edit-game-save-path").value = selected;
  }
});

document.getElementById("btn-detect-save-path")?.addEventListener("click", async () => {
  const invoke = getInvoke();
  const currentEditingGame = editingGameId ? games.find(g => g.id === editingGameId) : null;
  if (!currentEditingGame || !invoke) return;

  const detected = await invoke("detect_game_save_path", {
    winePrefix: document.getElementById("inp-wineprefix")?.value.trim() || currentEditingGame.wine_prefix || null,
                                steamAppId: currentEditingGame.steam_app_id || (currentEditingGame.id.startsWith("steam_") ? currentEditingGame.id.replace("steam_", "") : null),
  });
  if (detected) {
    document.getElementById("edit-game-save-path").value = detected;
    showToast(t("backup_toast_detected"), "success");
  } else {
    showToast(t("backup_toast_not_detected"), "info");
  }
});

document.getElementById("btn-create-backup")?.addEventListener("click", async () => {
  const invoke = getInvoke();
  const currentEditingGame = editingGameId ? games.find(g => g.id === editingGameId) : null;
  if (!currentEditingGame || !invoke) return;

  const savePath = document.getElementById("edit-game-save-path").value.trim();
  const labelInput = document.getElementById("backup-label-input");
  const label = labelInput.value.trim();

  try {
    await invoke("create_game_backup", {
      gameId: currentEditingGame.id,
      savePath,
      label: label || null,
    });
    currentEditingGame.save_path = savePath;
    await saveGamesToDisk();
    labelInput.value = "";
    showToast(t("backup_toast_created"), "success");
    await renderGameBackups(currentEditingGame);
  } catch (err) {
    showToast(formatBackupError(err), "error");
  }
});

async function enrichProtonDbRatings() {
  if (isFetchingProtonDb || isWindows) return;
  const invoke = getInvoke();
  if (!invoke) return;

  const candidates = games.filter(g =>
  !g.protondb_tier &&
  !isToolOrRuntime(g.title) &&
  (g.id.startsWith("steam_") || getSourceTag(g) === "STEAM" || getSourceTag(g) === "EPIC" || getSourceTag(g) === "GOG" || getSourceTag(g) === "LUTRIS")
  );

  if (candidates.length === 0) return;
  isFetchingProtonDb = true;

  try {
    const payload = candidates.map(g => ({
      id: g.id,
      title: g.title,
      app_id: g.id.startsWith("steam_") ? g.id.replace("steam_", "") : (g.steam_app_id || null)
    }));

    const ratings = await invoke("fetch_protondb_ratings", { games: payload });
    let changed = false;

    for (const g of candidates) {
      const info = ratings[g.id];
      if (info && info.tier) {
        g.protondb_tier = info.tier;
        if (info.app_id) g.steam_app_id = info.app_id;
        changed = true;
      }
    }

    if (changed) {
      await saveGamesToDisk();
      renderGames();
      if (isBigPicture) renderBigPicture();
    }
  } catch (e) {
    console.warn("ProtonDB fetch error:", e);
  } finally {
    isFetchingProtonDb = false;
  }
}
function getProtonDbBadgeHtml(game, compact = false) {
  if (isWindows) return "";

  const source = getSourceTag(game);
  if (source !== "STEAM" && source !== "EPIC") return "";

  const tier = (game.protondb_tier || "").toLowerCase();
  if (!tier || tier === "none") return "";

  const styles = {
    native: "bg-emerald-950/90 text-emerald-400 border-emerald-500/40",
    platinum: "bg-cyan-950/90 text-cyan-300 border-cyan-400/50",
    gold: "bg-amber-950/90 text-amber-400 border-amber-500/40",
    silver: "bg-slate-900/95 text-slate-200 border-slate-400/40",
    bronze: "bg-orange-950/90 text-orange-400 border-orange-500/40",
    borked: "bg-red-950/90 text-red-400 border-red-500/40",
  };

  const badgeStyle = styles[tier];
  if (!badgeStyle) return "";

  const appId = game.id.startsWith("steam_")
  ? game.id.replace("steam_", "")
  : game.steam_app_id || "";

  const sizeClass = compact
  ? "px-1.5 py-0.5 text-[9px]"
  : "px-2 py-0.5 text-[9px] shadow-md";

  return `<button type="button" class="btn-protondb ${sizeClass} rounded-md font-black uppercase tracking-wider border ${badgeStyle} hover:brightness-125 transition cursor-pointer" data-proton-appid="${appId}" title="ProtonDB: ${tier.toUpperCase()} (Click pentru detalii)">${tier}</button>`;
}
