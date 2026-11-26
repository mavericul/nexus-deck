// ==========================================
// LUCIDE: randare incrementală a iconițelor
// ==========================================
// lucide 0.344 ignoră opțiunea `root` și, la fiecare createIcons(), caută TOATE elementele
// [data-lucide] din document — inclusiv SVG-urile deja generate (care păstrează atributul) —
// și le reconstruiește. Cu o bibliotecă mare, fiecare toast / pas de navigare în Big Picture
// recrea mii de SVG-uri. Aici convertim doar elementele încă neconvertite (non-SVG), în `root`
// (sau în tot documentul), cu același rezultat ca lucide.
(function patchLucideCreateIcons() {
  const L = window.lucide;
  if (!L || !L.icons || typeof L.createElement !== "function" || L.__nexusIncremental) return;
  const toPascal = (name) =>
    name.replace(/(\w)(\w*)(_|-|\s*)/g, (_, first, rest) => first.toUpperCase() + rest.toLowerCase());

  L.createIcons = function (opts = {}) {
    const root = (opts && opts.root) || document;
    const icons = (opts && opts.icons) || L.icons;
    const extraAttrs = (opts && opts.attrs) || {};
    root.querySelectorAll("[data-lucide]:not(svg)").forEach((el) => {
      const name = el.getAttribute("data-lucide");
      const icon = name && icons[toPascal(name)];
      if (!icon || !el.parentNode) return;
      const [tag, defaultAttrs, children] = icon;
      const elAttrs = {};
      for (const attr of el.attributes) elAttrs[attr.name] = attr.value;
      const classes = ["lucide", `lucide-${name}`, elAttrs.class, extraAttrs.class]
        .filter(Boolean)
        .join(" ");
      const svg = L.createElement([
        tag,
        { ...defaultAttrs, "data-lucide": name, ...extraAttrs, ...elAttrs, class: classes },
        children,
      ]);
      el.parentNode.replaceChild(svg, el);
    });
  };
  L.__nexusIncremental = true;

  // Lucide original ignora `root`, deci ORICE apel (ex. randarea grilei) convertea ca efect secundar
  // și iconițele statice / inserate fără un createIcons() explicit. Păstrăm acea garanție:
  // o conversie inițială + un observator care convertește iconițele noi (grupat pe cadru).
  const convertAll = () => {
    try {
      L.createIcons();
    } catch (e) {
      console.warn("lucide:", e);
    }
  };
  convertAll();

  let scheduled = false;
  const hasPendingIcon = (node) =>
    node.nodeType === 1 &&
    node.namespaceURI !== "http://www.w3.org/2000/svg" &&
    ((node.hasAttribute && node.hasAttribute("data-lucide")) ||
      (node.querySelector && node.querySelector("[data-lucide]:not(svg)")));
  new MutationObserver((mutations) => {
    if (scheduled) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (hasPendingIcon(node)) {
          scheduled = true;
          requestAnimationFrame(() => {
            scheduled = false;
            convertAll();
          });
          return;
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();

// Culorile temelor ajung în atribute `style` și în variabile CSS. O temă importată dintr-un
// fișier primit de la altcineva putea închide atributul și injecta HTML/JS. Acceptăm doar
// formatele de culoare pe care le produce editorul (hex, rgb/rgba/hsl/hsla).
const THEME_COLOR_KEYS = [
  "bgPrimary", "bgSecondary", "bgCard", "textPrimary", "textSecondary", "border",
  "accentPrimary", "accentSecondary", "glowColor", "logoStart", "logoMid", "logoEnd",
];
const SAFE_CSS_COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s]+\))$/i;

function safeCssColor(value, fallback = "transparent") {
  const v = String(value ?? "").trim();
  return SAFE_CSS_COLOR.test(v) ? v : fallback;
}

function sanitizeThemeColors(theme) {
  const clean = { ...theme };
  // Numele iconițelor ajung într-un SVG generat: doar nume lucide valide
  if ("patternIcons" in clean) clean.patternIcons = sanitizePatternIcons(clean.patternIcons);
  for (const key of THEME_COLOR_KEYS) {
    if (key in clean && !SAFE_CSS_COLOR.test(String(clean[key] ?? "").trim())) {
      delete clean[key]; // revine la valoarea temei implicite
    }
  }
  return clean;
}

function safeJsonParse(raw, fallback) {
  try {
    return raw == null ? fallback : JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

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
let pausedEpicDownload = safeJsonParse(localStorage.getItem("nexus_paused_epic"), null);
let selectedSourceCtx = null;
let viewMode = "grid";
let selectedGenre = "all";
let selectedSort = "name-asc";
let selectedTagFilter = "all";
let selectedCtxGame = null;
let selectedPrefixGame = null;
let searchDebounceTimeout = null;

import { t, setLanguage, getLanguage, applyTranslationsToDom } from "./i18n.js";
import { LUCIDE_CATEGORY_TITLES, LUCIDE_ICONS_BY_CATEGORY, LUCIDE_ICON_TAGS } from "./lucideCategories.js";

import {
  THEME_PRESETS,
  BACKGROUND_PATTERNS,
  PATTERN_SIZES,
  PATTERN_LABELS,
  CUSTOM_ICON_PATTERN_KEY,
  MAX_PATTERN_ICONS,
  DEFAULT_PATTERN_ICONS,
  sanitizePatternIcons,
  getLucideIconNode,
  buildLucideIconGridPattern,
  resolveThemePatternCss,
  getSavedThemeConfig,
  applyThemeConfig,
  exportThemeJson,
  parseImportedThemeJson,
  getSavedCustomThemes,
  saveCustomTheme,
  deleteCustomTheme
} from "./themeEngine.js";

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

      // O sesiune de 0 secunde (lansare eșuată, instalare Steam) nu merită un toast „jocul s-a închis”
      if (playtime_seconds > 0) {
        showToast(t("toast.game_closed", { sec: playtime_seconds }), "info");
      }
    } else {
      runningGames[game_id] = status;
    }

    renderGames();
    if (isBigPicture) renderBigPicture();
  });

  // Lansări eșuate raportate de backend (din tray, proces care pică imediat, joc nedetectat)
  window.__TAURI__.event.listen("game-launch-failed", (event) => {
    const { game_id, message } = event.payload || {};
    if (game_id) delete runningGames[game_id];
    renderGames();
    if (isBigPicture) renderBigPicture();

    const title = games.find((g) => g.id === game_id)?.title;
    const text = title ? `${title}: ${message}` : String(message || "");
    showToast(text, "error", 10000);
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

// Un singur timer de urmărire per joc: click-uri repetate pe "Install" porneau intervale paralele,
// fiecare cu propriile invoke-uri la 3 s și salvări duplicate.
const steamInstallTimers = new Map();

function startSteamInstallTracking(game) {
  const appId = game.id.replace("steam_", "");
  if (steamInstallTimers.has(game.id)) return;
  installingGames[game.id] = 0;
  renderGames();
  if (isBigPicture) renderBigPicture();

  let sawManifest = false;
  let notFoundChecks = 0;

  let busy = false;
  const stop = () => {
    stop();
    steamInstallTimers.delete(game.id);
  };
  const timer = setInterval(async () => {
    const invoke = getInvoke();
    if (!invoke) {
      stop();
      return;
    }
    // O verificare lentă (disc ocupat) nu trebuie să se suprapună cu următoarea
    if (busy) return;
    busy = true;

    try {
      const res = await invoke("check_steam_install_status", { appId });

      if (res.state === "installed") {
        stop();
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
          stop();
          delete installingGames[game.id];
          renderGames();
          if (isBigPicture) renderBigPicture();
        }
      }
    } catch (err) {
      console.error("Eroare verificare instalare Steam:", err);
    } finally {
      busy = false;
    }
  }, 3000);
  steamInstallTimers.set(game.id, timer);
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

let activeThemeConfig = getSavedThemeConfig();

function initThemeCentre() {
  activeThemeConfig = applyThemeConfig(activeThemeConfig);

  const openBtn = document.getElementById("btn-open-theme-centre");
  const closeBtn = document.getElementById("close-theme-centre");
  const presetsGrid = document.getElementById("theme-presets-grid");
  const customGrid = document.getElementById("custom-themes-grid");
  const customCountEl = document.getElementById("custom-themes-count");

  // Tabs
  const tabGalleryBtn = document.getElementById("tab-tc-gallery");
  const tabStudioBtn = document.getElementById("tab-tc-studio");
  const viewGallery = document.getElementById("tc-view-gallery");
  const viewStudio = document.getElementById("tc-view-studio");

  // Studio Controls
  const saveCustomBtn = document.getElementById("btn-save-custom-theme");
  const resetStudioBtn = document.getElementById("btn-reset-studio-theme");
  const inpMode = document.getElementById("tc-mode");
  const inpBgPrimary = document.getElementById("tc-bg-primary");
  const inpBgSecondary = document.getElementById("tc-bg-secondary");
  const inpAccent = document.getElementById("tc-accent");
  const inpAccentSec = document.getElementById("tc-accent-sec");
  const inpGlow = document.getElementById("tc-glow");
  const inpLogoStart = document.getElementById("tc-logo-start");
  const inpLogoMid = document.getElementById("tc-logo-mid");
  const inpLogoEnd = document.getElementById("tc-logo-end");
  const inpPattern = document.getElementById("tc-pattern");
  const patternGrid = document.getElementById("tc-pattern-grid");
  const inpName = document.getElementById("tc-theme-name");

  let studioBaseTheme = { ...activeThemeConfig };
  let isStudioDirty = false;
  // Iconițele pattern-ului custom; se păstrează și dacă utilizatorul trece temporar pe alt pattern
  let studioPatternIcons = sanitizePatternIcons(activeThemeConfig.patternIcons);
  if (studioPatternIcons.length === 0) studioPatternIcons = [...DEFAULT_PATTERN_ICONS];

  // =========================================================
  // HELPERE CONVERSIE CULORI (HEX <-> HSV) PENTRU COLOR WHEEL
  // =========================================================
  const normalizeHex = (val) => {
    if (!val) return null;
    let hex = val.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
      hex = hex.split("").map((c) => c + c).join("");
    }
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return `#${hex.toLowerCase()}`;
    }
    return null;
  };

  const hexToHsv = (hex) => {
    const clean = (normalizeHex(hex) || "#6366f1").slice(1);
    const r = parseInt(clean.slice(0, 2), 16) / 255;
    const g = parseInt(clean.slice(2, 4), 16) / 255;
    const b = parseInt(clean.slice(4, 6), 16) / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;

    if (d !== 0) {
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h: h * 360, s, v };
  };

  const hsvToHex = (h, s, v) => {
    const hue = ((h % 360) + 360) % 360;
    const c = v * s;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = v - c;
    let r1 = 0, g1 = 0, b1 = 0;

    if (hue < 60) { r1 = c; g1 = x; b1 = 0; }
    else if (hue < 120) { r1 = x; g1 = c; b1 = 0; }
    else if (hue < 180) { r1 = 0; g1 = c; b1 = x; }
    else if (hue < 240) { r1 = 0; g1 = x; b1 = c; }
    else if (hue < 300) { r1 = x; g1 = 0; b1 = c; }
    else { r1 = c; g1 = 0; b1 = x; }

    const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
    return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
  };

  // =========================================================
  // CUSTOM COLOR WHEEL POPOVER + SWATCH BUTTONS
  // =========================================================
  const colorSwatchesMap = new Map();
  let wheelState = {
    activeInput: null,
    h: 240,
    s: 0.75,
    v: 0.95,
    dragging: false
  };

  const ensureColorWheelPopover = () => {
    let pop = document.getElementById("nd-color-wheel-popover");
    if (pop) return pop;

    pop = document.createElement("div");
    pop.id = "nd-color-wheel-popover";
    pop.className = "hidden space-y-3 select-none";
    pop.innerHTML = `
    <div class="flex items-center justify-between">
    <span id="nd-cw-label" class="text-[11px] font-bold uppercase tracking-wider opacity-75">Pick Color</span>
    <button type="button" id="nd-cw-close" class="p-1 rounded-lg hover:bg-white/10 transition text-xs opacity-75 hover:opacity-100">✕</button>
    </div>

    <div class="relative flex items-center justify-center">
    <div id="nd-cw-canvas"></div>
    <div id="nd-cw-cursor" class="pointer-events-none absolute w-4 h-4 rounded-full border-2 border-white shadow-md -translate-x-1/2 -translate-y-1/2"></div>
    </div>

    <div class="space-y-1">
    <div class="flex items-center justify-between text-[10px] font-mono opacity-75">
    <span>Brightness</span>
    <span id="nd-cw-val-pct">100%</span>
    </div>
    <input type="range" id="nd-cw-val-slider" min="0" max="100" value="100" class="nd-wheel-val-slider" />
    </div>

    <div class="flex items-center gap-2">
    <div id="nd-cw-preview-dot" class="w-8 h-8 rounded-lg border shrink-0 shadow-inner" style="border-color: var(--nd-border);"></div>
    <input type="text" id="nd-cw-hex-input" maxlength="7" placeholder="#6366f1"
    class="flex-1 rounded-lg px-2.5 py-1.5 text-xs font-mono font-bold uppercase border focus:outline-none" />
    </div>

    <div class="nd-cw-presets-grid">
    ${["#020617", "#0f172a", "#f8fafc", "#6366f1", "#06b6d4", "#a855f7", "#10b981", "#e11d48"]
      .map((c) => `<button type="button" data-cw-preset="${c}" class="nd-cw-preset-btn" style="background-color:${c} !important;"></button>`)
      .join("")}
      </div>
      `;
      document.body.appendChild(pop);

      const canvas = pop.querySelector("#nd-cw-canvas");
      const cursor = pop.querySelector("#nd-cw-cursor");
      const valSlider = pop.querySelector("#nd-cw-val-slider");
      const valPct = pop.querySelector("#nd-cw-val-pct");
      const hexInput = pop.querySelector("#nd-cw-hex-input");
      const previewDot = pop.querySelector("#nd-cw-preview-dot");



      const syncWheelControls = (updateHexField = true) => {
        const currentHex = hsvToHex(wheelState.h, wheelState.s, wheelState.v);
        const pureHueHex = hsvToHex(wheelState.h, wheelState.s, 1);

        const radius = (canvas.offsetWidth || 196) / 2;
        const rad = (wheelState.h * Math.PI) / 180;
        const cx = radius + Math.cos(rad) * wheelState.s * radius;
        const cy = radius + Math.sin(rad) * wheelState.s * radius;

        cursor.style.left = `${canvas.offsetLeft + cx}px`;
        cursor.style.top = `${canvas.offsetTop + cy}px`;
        cursor.style.backgroundColor = currentHex;

        valSlider.value = Math.round(wheelState.v * 100);
        valSlider.style.background = `linear-gradient(to right, #000000, ${pureHueHex})`;
        valPct.textContent = `${Math.round(wheelState.v * 100)}%`;
        previewDot.style.backgroundColor = currentHex;

        if (updateHexField) {
          hexInput.value = currentHex.toUpperCase();
        }
      };

      const commitWheelColor = (updateHexField = true) => {
        const hex = hsvToHex(wheelState.h, wheelState.s, wheelState.v);
        syncWheelControls(updateHexField);

        if (wheelState.activeInput) {
          wheelState.activeInput.value = hex;
          const swatch = colorSwatchesMap.get(wheelState.activeInput.id);
          if (swatch) swatch.style.backgroundColor = hex;
          handleCustomChange();
        }
      };

      const pickFromCanvasEvent = (e) => {
        const rect = canvas.getBoundingClientRect();
        const radius = rect.width / 2;
        const dx = e.clientX - (rect.left + radius);
        const dy = e.clientY - (rect.top + radius);
        const dist = Math.min(radius, Math.sqrt(dx * dx + dy * dy));
        wheelState.h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
        wheelState.s = dist / radius;
        commitWheelColor(true);
      };

      canvas.addEventListener("pointerdown", (e) => {
        wheelState.dragging = true;
        canvas.setPointerCapture(e.pointerId);
        pickFromCanvasEvent(e);
      });
      canvas.addEventListener("pointermove", (e) => {
        if (wheelState.dragging) pickFromCanvasEvent(e);
      });
        canvas.addEventListener("pointerup", (e) => {
          wheelState.dragging = false;
          canvas.releasePointerCapture?.(e.pointerId);
        });

        valSlider.addEventListener("input", () => {
          wheelState.v = Number(valSlider.value) / 100;
          commitWheelColor(true);
        });

        hexInput.addEventListener("input", () => {
          const valid = normalizeHex(hexInput.value);
          if (valid) {
            const hsv = hexToHsv(valid);
            wheelState.h = hsv.h;
            wheelState.s = hsv.s;
            wheelState.v = hsv.v;
            commitWheelColor(false);
          }
        });

        pop.querySelectorAll("[data-cw-preset]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const hsv = hexToHsv(btn.dataset.cwPreset);
            wheelState.h = hsv.h;
            wheelState.s = hsv.s;
            wheelState.v = hsv.v;
            commitWheelColor(true);
          });
        });

        pop.querySelector("#nd-cw-close")?.addEventListener("click", () => closeColorWheelPopover());
        pop.addEventListener("click", (e) => e.stopPropagation());

        pop._syncFromHex = (hex, labelText) => {
          const hsv = hexToHsv(hex);
          wheelState.h = hsv.h;
          wheelState.s = hsv.s;
          wheelState.v = hsv.v;
          const lbl = pop.querySelector("#nd-cw-label");
          if (lbl) lbl.textContent = labelText || "Pick Color";
          syncWheelControls(true);
        };

        window.addEventListener("click", () => closeColorWheelPopover());
        return pop;
  };

  const closeColorWheelPopover = () => {
    const pop = document.getElementById("nd-color-wheel-popover");
    pop?.classList.add("hidden");
    colorSwatchesMap.forEach((btn) => btn.classList.remove("active"));
    wheelState.activeInput = null;
  };

  const openColorWheelForInput = (inputEl, swatchBtn, labelText) => {
    const pop = ensureColorWheelPopover();
    const isSame = wheelState.activeInput === inputEl && !pop.classList.contains("hidden");
    closeColorWheelPopover();
    if (isSame) return;

    wheelState.activeInput = inputEl;
    swatchBtn.classList.add("active");
    pop._syncFromHex(inputEl.value, labelText);
    pop.classList.remove("hidden");

    const rect = swatchBtn.getBoundingClientRect();
    const popW = pop.offsetWidth || 256;
    const popH = pop.offsetHeight || 340;

    let left = rect.right - popW;
    if (left < 12) left = rect.left;
    if (left + popW > window.innerWidth - 12) left = window.innerWidth - popW - 12;

    let top = rect.bottom + 8;
    if (top + popH > window.innerHeight - 12) {
      top = Math.max(12, rect.top - popH - 8);
    }

    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  };

  const initCustomColorSwatches = () => {
    const colorInputs = [
      { el: inpBgPrimary, label: "Main Background", small: false },
      { el: inpBgSecondary, label: "Panels & Sidebar", small: false },
      { el: inpAccent, label: "Accent & Buttons", small: false },
      { el: inpAccentSec, label: "Secondary Highlight", small: false },
      { el: inpGlow, label: "Card Hover Glow", small: false },
      { el: inpLogoStart, label: "Logo Gradient (Start)", small: true },
      { el: inpLogoMid, label: "Logo Gradient (Middle)", small: true },
      { el: inpLogoEnd, label: "Logo Gradient (End)", small: true }
    ];

    colorInputs.forEach(({ el, label, small }) => {
      if (!el || colorSwatchesMap.has(el.id)) return;
      el.classList.add("hidden");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.title = el.title || label;
      btn.className = small ? "nd-color-swatch-btn nd-swatch-sm" : "nd-color-swatch-btn";
      btn.style.backgroundColor = el.value || "#6366f1";

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openColorWheelForInput(el, btn, label);
      });

      el.parentNode.insertBefore(btn, el);
      colorSwatchesMap.set(el.id, btn);
    });
  };
  initCustomColorSwatches();

  // =========================================================
  // VISUAL PATTERN PICKER GRID (#tc-pattern-grid)
  // =========================================================
  const syncPatternGridSelection = (selectedKey) => {
    if (!patternGrid) return;
    patternGrid.querySelectorAll(".tc-pattern-card").forEach((card) => {
      card.classList.toggle("active", card.dataset.patternKey === selectedKey);
    });
  };

  // ---------- Pattern custom din iconițe lucide ----------
  const ICON_SUGGESTIONS = [
    "gamepad-2", "joystick", "swords", "sword", "shield", "skull", "ghost", "crown", "trophy",
    "star", "heart", "zap", "flame", "rocket", "diamond", "hexagon", "triangle", "circle",
    "square", "cpu", "terminal", "code", "music", "headphones", "dices", "puzzle", "target", "sparkles",
  ];
  const iconPanel = document.getElementById("tc-icon-pattern-panel");
  const iconSlotsEl = document.getElementById("tc-icon-slots");
  const iconCategorySel = document.getElementById("tc-icon-category");
  const iconSearchInp = document.getElementById("tc-icon-search");
  const iconBrowserEl = document.getElementById("tc-icon-browser");
  const iconBrowserCount = document.getElementById("tc-icon-browser-count");
  let iconBrowserCategory = "popular";
  const iconDatalist = document.getElementById("tc-lucide-icon-names");

  const iconPreviewSvg = (name, cls = "w-4 h-4") => {
    const node = getLucideIconNode(name);
    if (!node || !window.lucide?.createElement) return null;
    const [tag, attrs, children] = node;
    const svg = window.lucide.createElement([tag, { ...attrs, class: cls }, children]);
    return svg;
  };

  const customPatternPreviewCss = () => {
    const { backgroundImage, backgroundSize } = buildLucideIconGridPattern(
      studioPatternIcons,
      inpAccentSec?.value || "#06b6d4",
      0.45
    );
    // Cardul are doar ~40px înălțime: tile la jumătate, ca rândurile să se vadă întregi
    const half = backgroundSize.replace(/(\d+)px/g, (_, n) => `${Math.round(Number(n) / 2)}px`);
    return `background-image: ${backgroundImage}; background-size: ${half}; background-position: center;`;
  };

  const refreshCustomPatternCard = () => {
    const preview = patternGrid?.querySelector(`[data-pattern-key="${CUSTOM_ICON_PATTERN_KEY}"] .tc-pattern-preview`);
    if (preview) preview.setAttribute("style", customPatternPreviewCss());
  };

  const fillIconDatalist = () => {
    if (!iconDatalist || iconDatalist.childElementCount > 0 || !window.lucide?.icons) return;
    // Numele în format kebab-case (ca pe lucide.dev), derivate din cheile PascalCase ale bibliotecii
    const names = Object.keys(window.lucide.icons)
      .map((k) => k.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Za-z])([0-9])/g, "$1-$2").toLowerCase())
      .filter((n) => getLucideIconNode(n));
    const frag = document.createDocumentFragment();
    [...new Set(names)].sort().forEach((n) => {
      const opt = document.createElement("option");
      opt.value = n;
      frag.appendChild(opt);
    });
    iconDatalist.appendChild(frag);
  };

  const setPatternIcons = (next) => {
    studioPatternIcons = sanitizePatternIcons(next);
    if (studioPatternIcons.length === 0) studioPatternIcons = [...DEFAULT_PATTERN_ICONS];
    renderIconPatternPanel();
    refreshCustomPatternCard();
    if (inpPattern?.value === CUSTOM_ICON_PATTERN_KEY) handleCustomChange();
  };

  const renderIconPatternPanel = () => {
    if (!iconPanel) return;
    const isCustom = inpPattern?.value === CUSTOM_ICON_PATTERN_KEY;
    iconPanel.classList.toggle("hidden", !isCustom);
    if (!isCustom) return;
    fillIconDatalist();

    if (iconSlotsEl) {
      iconSlotsEl.innerHTML = "";
      for (let i = 0; i < MAX_PATTERN_ICONS; i++) {
        const name = studioPatternIcons[i] || "";
        const slot = document.createElement("div");
        slot.className = "flex items-center gap-1.5 p-1.5 rounded-lg border border-slate-800 bg-slate-900/60";

        const prev = document.createElement("div");
        prev.className = "w-7 h-7 shrink-0 rounded-md flex items-center justify-center bg-slate-950/70";
        prev.style.color = inpAccentSec?.value || "var(--nd-accent-secondary)";
        const svg = name ? iconPreviewSvg(name) : null;
        if (svg) prev.appendChild(svg);

        const input = document.createElement("input");
        input.type = "text";
        input.value = name;
        input.placeholder = i === 0 ? "gamepad-2" : t("theme.icons_optional");
        input.setAttribute("list", "tc-lucide-icon-names");
        input.spellcheck = false;
        input.className = "flex-1 min-w-0 bg-transparent outline-none text-xs text-slate-200 placeholder:text-slate-600";
        const commit = () => {
          const value = input.value.trim().toLowerCase();
          if (value && !getLucideIconNode(value)) {
            input.classList.add("text-red-400");
            showToast(t("toast.icon_not_found", { name: value }), "warning");
            return;
          }
          const next = [...studioPatternIcons];
          next[i] = value;
          setPatternIcons(next.filter(Boolean));
        };
        input.addEventListener("change", commit);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            input.blur();
          }
        });

        const clear = document.createElement("button");
        clear.type = "button";
        clear.title = t("theme.icons_remove");
        clear.className = "p-1 rounded-md text-slate-500 hover:text-red-400 transition cursor-pointer";
        clear.textContent = "✕";
        clear.disabled = !name || studioPatternIcons.length <= 1;
        clear.style.opacity = clear.disabled ? "0.3" : "1";
        clear.addEventListener("click", () => setPatternIcons(studioPatternIcons.filter((_, idx) => idx !== i)));

        slot.append(prev, input, clear);
        iconSlotsEl.appendChild(slot);
      }
    }

    renderIconBrowser();
  };

  // ---------- Browser de iconițe: categorie + căutare ----------
  const allLucideNames = () => {
    if (!allLucideNames.cache) {
      const set = new Set();
      Object.values(LUCIDE_ICONS_BY_CATEGORY).forEach((list) => list.forEach((n) => set.add(n)));
      allLucideNames.cache = [...set].filter((n) => getLucideIconNode(n)).sort();
    }
    return allLucideNames.cache;
  };

  const fillIconCategories = () => {
    if (!iconCategorySel || iconCategorySel.childElementCount > 0) return;
    const opt = (value, label) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      return o;
    };
    iconCategorySel.appendChild(opt("popular", t("theme.icons_popular")));
    iconCategorySel.appendChild(opt("all", t("theme.icons_all")));
    Object.entries(LUCIDE_CATEGORY_TITLES)
      .filter(([id]) => LUCIDE_ICONS_BY_CATEGORY[id]?.length)
      .sort((a, b) => a[1].localeCompare(b[1]))
      .forEach(([id, title]) => {
        iconCategorySel.appendChild(opt(id, `${title} (${LUCIDE_ICONS_BY_CATEGORY[id].length})`));
      });
    iconCategorySel.value = iconBrowserCategory;
    iconCategorySel.dispatchEvent(new Event("change"));
    iconCategorySel.addEventListener("change", (e) => {
      if (!e.isTrusted && iconCategorySel.value === iconBrowserCategory) return;
      iconBrowserCategory = iconCategorySel.value;
      if (iconBrowserEl) iconBrowserEl.scrollTop = 0;
      renderIconBrowser();
    });
    let searchTimer = null;
    iconSearchInp?.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        if (iconBrowserEl) iconBrowserEl.scrollTop = 0;
        renderIconBrowser();
      }, 120);
    });
  };

  const iconsForBrowser = () => {
    const query = (iconSearchInp?.value || "").trim().toLowerCase();
    let pool;
    if (iconBrowserCategory === "popular") {
      // „Populare” + căutare = caută în toate iconițele
      pool = query ? allLucideNames() : ICON_SUGGESTIONS;
    } else if (iconBrowserCategory === "all") {
      pool = allLucideNames();
    } else {
      pool = LUCIDE_ICONS_BY_CATEGORY[iconBrowserCategory] || [];
    }
    pool = pool.filter((n) => getLucideIconNode(n));
    if (!query) return pool;
    const terms = query.split(/\s+/);
    return pool.filter((n) => {
      const hay = `${n} ${LUCIDE_ICON_TAGS[n] || ""}`.toLowerCase();
      return terms.every((term) => hay.includes(term));
    });
  };

  const toggleBrowserIcon = (n) => {
    if (studioPatternIcons.includes(n)) {
      setPatternIcons(studioPatternIcons.filter((x) => x !== n));
    } else if (studioPatternIcons.length < MAX_PATTERN_ICONS) {
      setPatternIcons([...studioPatternIcons, n]);
    } else {
      // Plin: înlocuiește ultima iconiță
      setPatternIcons([...studioPatternIcons.slice(0, MAX_PATTERN_ICONS - 1), n]);
    }
  };

  let iconBrowserKey = null;
  const highlightBrowserSelection = () => {
    iconBrowserEl?.querySelectorAll("[data-icon-name]").forEach((btn) => {
      const on = studioPatternIcons.includes(btn.dataset.iconName);
      btn.style.boxShadow = on ? "inset 0 0 0 2px var(--nd-accent)" : "";
      btn.style.color = on ? "var(--nd-accent)" : "";
    });
  };

  const renderIconBrowser = () => {
    if (!iconBrowserEl) return;
    fillIconCategories();
    // Aceeași categorie și căutare: doar actualizăm evidențierea, fără a reconstrui grila
    const key = `${iconBrowserCategory}|${(iconSearchInp?.value || "").trim().toLowerCase()}`;
    if (key === iconBrowserKey && iconBrowserEl.childElementCount > 0) {
      highlightBrowserSelection();
      return;
    }
    iconBrowserKey = key;
    const names = iconsForBrowser();
    const frag = document.createDocumentFragment();
    names.forEach((n) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.title = n;
      btn.dataset.iconName = n;
      btn.className = "w-8 h-8 rounded-lg flex items-center justify-center border border-slate-800 bg-slate-900/60 text-slate-300 hover:border-slate-600 transition cursor-pointer";
      const svg = iconPreviewSvg(n);
      if (svg) btn.appendChild(svg);
      const on = studioPatternIcons.includes(n);
      // box-shadow: stilurile temei suprascriu border-color cu !important
      if (on) {
        btn.style.boxShadow = "inset 0 0 0 2px var(--nd-accent)";
        btn.style.color = "var(--nd-accent)";
      }
      frag.appendChild(btn);
    });
    iconBrowserEl.replaceChildren(frag);
    if (iconBrowserCount) {
      iconBrowserCount.textContent = names.length
        ? t("theme.icons_count", { count: names.length })
        : t("theme.icons_none_found");
    }
  };

  // Un singur listener pe grilă (delegare), nu câte unul pe fiecare din cele ~1400 de butoane
  iconBrowserEl?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-icon-name]");
    if (btn) toggleBrowserIcon(btn.dataset.iconName);
  });

  // Numele pattern-ului în limba curentă (cheile lipsă revin la eticheta engleză din themeEngine)
  const patternLabel = (key) => {
    const tr = t(`theme.pattern.${key}`);
    return tr !== `theme.pattern.${key}` ? tr : (PATTERN_LABELS && PATTERN_LABELS[key]) || key;
  };

  const renderPatternPickerGrid = () => {
    if (!patternGrid) return;
    const currentKey = inpPattern?.value || "none";

    patternGrid.innerHTML = Object.entries(BACKGROUND_PATTERNS)
    .map(([key, cssPattern]) => {
      const size = PATTERN_SIZES[key] || "auto";
      const label = patternLabel(key);
      const isActive = key === currentKey;

      return `
      <button type="button" data-pattern-key="${escapeHtml(key)}"
      class="tc-pattern-card ${isActive ? "active" : ""} p-2 rounded-xl flex flex-col items-center gap-1.5 cursor-pointer text-center">
      <div class="tc-pattern-preview w-full h-10 rounded-lg"
      style="background-image: ${cssPattern}; background-size: ${size};"></div>
      <span class="text-[11px] truncate w-full">${escapeHtml(label)}</span>
      </button>
      `;
    })
    .join("") + `
      <button type="button" data-pattern-key="${CUSTOM_ICON_PATTERN_KEY}"
      class="tc-pattern-card ${currentKey === CUSTOM_ICON_PATTERN_KEY ? "active" : ""} p-2 rounded-xl flex flex-col items-center gap-1.5 cursor-pointer text-center">
      <div class="tc-pattern-preview w-full h-10 rounded-lg" style="${escapeHtml(customPatternPreviewCss())}"></div>
      <span class="text-[11px] truncate w-full">${escapeHtml(patternLabel(CUSTOM_ICON_PATTERN_KEY))}</span>
      </button>`;

    patternGrid.querySelectorAll(".tc-pattern-card").forEach((card) => {
      card.addEventListener("click", () => {
        const chosen = card.dataset.patternKey;
        if (inpPattern) inpPattern.value = chosen;
        syncPatternGridSelection(chosen);
        renderIconPatternPanel();
        handleCustomChange();
      });
    });
    renderIconPatternPanel();
  };
  renderPatternPickerGrid();

  // =========================================================
  // TABURI, PREVIEW LIVE & SINCRONIZARE STUDIO
  // =========================================================
  const setStudioDirty = (dirty) => {
    isStudioDirty = dirty;
    if (saveCustomBtn) {
      saveCustomBtn.disabled = !dirty;
    }
  };

  const switchThemeCentreTab = (tab) => {
    closeColorWheelPopover();
    const activeCls = "active px-4 py-2 rounded-xl text-xs font-bold text-indigo-400 bg-indigo-950/60 border border-indigo-800/50 flex items-center gap-2 transition cursor-pointer";
    const inactiveCls = "px-4 py-2 rounded-xl text-xs font-bold text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 border border-transparent flex items-center gap-2 transition cursor-pointer";

    if (tab === "studio") {
      viewGallery?.classList.add("hidden");
      viewStudio?.classList.remove("hidden");
      if (tabStudioBtn) tabStudioBtn.className = activeCls;
      if (tabGalleryBtn) tabGalleryBtn.className = inactiveCls;
      renderPatternPickerGrid();
      updateStudioPreview(buildStudioThemeObject(true));
    } else {
      viewStudio?.classList.add("hidden");
      viewGallery?.classList.remove("hidden");
      if (tabGalleryBtn) tabGalleryBtn.className = activeCls;
      if (tabStudioBtn) tabStudioBtn.className = inactiveCls;
      renderAllThemeGrids();
    }
    if (window.lucide) window.lucide.createIcons();
  };

    tabGalleryBtn?.addEventListener("click", () => switchThemeCentreTab("gallery"));
    tabStudioBtn?.addEventListener("click", () => switchThemeCentreTab("studio"));

    const updateStudioPreview = (cfg) => {
      const card = document.getElementById("tc-live-preview");
      const logo = document.getElementById("tc-preview-logo");
      const title = document.getElementById("tc-preview-title");
      const badge = document.getElementById("tc-preview-badge");
      const sub = document.getElementById("tc-preview-sub");
      const pill = document.getElementById("tc-preview-pill");
      const btn = document.getElementById("tc-preview-btn");

      if (!card) return;
      const { backgroundImage: patCss, backgroundSize: patSize } = resolveThemePatternCss(cfg, 0.22);

      card.style.cssText = `background-color: ${cfg.bgPrimary} !important; background-image: ${patCss}; background-size: ${patSize}; border-color: ${cfg.border} !important; box-shadow: 0 0 22px -6px ${cfg.glowColor}66;`;
      if (logo) {
        logo.style.cssText = `background: linear-gradient(135deg, ${cfg.logoStart}, ${cfg.logoMid}, ${cfg.logoEnd}) !important; color: #ffffff !important;`;
      }
      if (title) {
        title.textContent = cfg.name || "Custom Theme";
        title.style.cssText = `color: ${cfg.textPrimary} !important;`;
      }
      if (badge) {
        badge.textContent = (cfg.mode || "dark").toUpperCase();
        badge.style.cssText = `background-color: ${cfg.bgSecondary} !important; color: ${cfg.textSecondary} !important; border-color: ${cfg.border} !important;`;
      }
      if (sub) {
        sub.style.cssText = `color: ${cfg.textSecondary} !important;`;
      }
      if (pill) {
        pill.style.cssText = `background-color: ${cfg.bgSecondary} !important; color: ${cfg.accentSecondary} !important; border-color: ${cfg.border} !important;`;
      }
      if (btn) {
        btn.style.cssText = `background-color: ${cfg.accentPrimary} !important; color: #ffffff !important;`;
      }
    };

    const syncStudioInputs = (cfg, isPresetSource = false) => {
      studioBaseTheme = { ...cfg };

      if (inpMode) {
        inpMode.value = cfg.mode || "dark";
        inpMode.dispatchEvent(new Event("change"));
      }

      const syncColorField = (inputEl, hexVal) => {
        if (!inputEl) return;
        inputEl.value = hexVal;
        const swatch = colorSwatchesMap.get(inputEl.id);
        if (swatch) swatch.style.backgroundColor = hexVal;
      };

        syncColorField(inpBgPrimary, cfg.bgPrimary);
        syncColorField(inpBgSecondary, cfg.bgSecondary);
        syncColorField(inpAccent, cfg.accentPrimary);
        syncColorField(inpAccentSec, cfg.accentSecondary);
        syncColorField(inpGlow, cfg.glowColor);
        syncColorField(inpLogoStart, cfg.logoStart || cfg.glowColor);
        syncColorField(inpLogoMid, cfg.logoMid || cfg.accentPrimary);
        syncColorField(inpLogoEnd, cfg.logoEnd || cfg.accentSecondary);

        studioPatternIcons = sanitizePatternIcons(cfg.patternIcons);
        if (studioPatternIcons.length === 0) studioPatternIcons = [...DEFAULT_PATTERN_ICONS];
        if (inpPattern) {
          inpPattern.value = cfg.pattern || "none";
          syncPatternGridSelection(inpPattern.value);
        }
        renderIconPatternPanel();
        refreshCustomPatternCard();

        if (inpName) {
          const isBuiltIn = Boolean(THEME_PRESETS[cfg.id]) || isPresetSource;
          inpName.value = isBuiltIn ? `${cfg.name} (Copy)` : (cfg.name || "Custom Theme");
        }

        setStudioDirty(false);
        updateStudioPreview(buildStudioThemeObject(true));
    };

    const renderThemeCardHtml = (theme, isCustom = false) => {
      const isSelected = activeThemeConfig.id === theme.id;
      return `
      <div data-theme-card-id="${escapeHtml(theme.id)}"
      class="group relative p-3 rounded-xl border text-left transition flex flex-col gap-2.5 cursor-pointer ${isSelected ? "ring-2" : "opacity-90 hover:opacity-100"}"
      style="background: ${safeCssColor(theme.bgSecondary)} !important; border-color: ${safeCssColor(isSelected ? theme.accentPrimary : theme.border)} !important; color: ${safeCssColor(theme.textPrimary)} !important; --tw-ring-color: ${safeCssColor(theme.accentPrimary)};">
      <div class="flex items-center justify-between w-full gap-1">
      <span class="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded"
      style="background: ${safeCssColor(theme.bgPrimary)} !important; color: ${safeCssColor(theme.textSecondary)} !important; border: 1px solid ${safeCssColor(theme.border)} !important;">
      ${escapeHtml(theme.mode)}
      </span>
      <div class="flex items-center gap-1">
      <span class="w-3 h-3 rounded-full border border-black/20" style="background: ${safeCssColor(theme.accentPrimary)} !important;"></span>
      <span class="w-3 h-3 rounded-full border border-black/20" style="background: ${safeCssColor(theme.glowColor)} !important;"></span>
      <span class="w-3 h-3 rounded-full border border-black/20" style="background: ${safeCssColor(theme.accentSecondary)} !important;"></span>
      </div>
      </div>
      <div class="flex items-center justify-between gap-1 w-full">
      <span class="text-xs font-bold truncate" style="color: ${safeCssColor(theme.textPrimary)} !important;">${escapeHtml(theme.name)}</span>
      <div class="flex items-center gap-0.5 shrink-0">
      <button type="button" data-customize-theme-id="${escapeHtml(theme.id)}" title="${escapeHtml(t("theme.customize"))}"
      class="p-1 rounded-md opacity-75 hover:opacity-100 transition" style="color: ${safeCssColor(theme.accentPrimary)} !important;">
      <i data-lucide="sliders" class="w-3.5 h-3.5"></i>
      </button>
      ${isCustom ? `
        <button type="button" data-delete-custom-id="${escapeHtml(theme.id)}" title="${escapeHtml(t("theme.delete"))}"
        class="p-1 rounded-md opacity-75 hover:opacity-100 hover:bg-red-500/20 text-red-400 transition">
        <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
        ` : ""}
        </div>
        </div>
        </div>
        `;
    };

    const renderPresetsGrid = () => {
      if (!presetsGrid) return;
      presetsGrid.innerHTML = Object.values(THEME_PRESETS)
      .map((preset) => renderThemeCardHtml(preset, false))
      .join("");

      presetsGrid.querySelectorAll("[data-theme-card-id]").forEach((card) => {
        card.addEventListener("click", (e) => {
          const preset = THEME_PRESETS[card.dataset.themeCardId];
          if (!preset) return;
          activeThemeConfig = applyThemeConfig({ ...preset });
          syncStudioInputs(activeThemeConfig, true);
          renderAllThemeGrids();

          if (e.target.closest("[data-customize-theme-id]")) {
            switchThemeCentreTab("studio");
          }
        });
      });
    };

    const renderCustomThemesGrid = () => {
      if (!customGrid) return;
      const customList = getSavedCustomThemes();
      if (customCountEl) customCountEl.textContent = customList.length;

      if (customList.length === 0) {
        customGrid.innerHTML = `
        <div class="col-span-full p-5 rounded-xl border border-dashed border-slate-700/80 text-center space-y-2">
        <p class="text-xs text-slate-400">${escapeHtml(t("theme.no_custom"))}</p>
        <button type="button" id="btn-empty-go-studio" class="px-3.5 py-1.5 rounded-lg text-xs font-bold text-white transition cursor-pointer" style="background: var(--nd-accent);">
        ${escapeHtml(t("theme.open_studio"))}
        </button>
        </div>
        `;
        document.getElementById("btn-empty-go-studio")?.addEventListener("click", () => {
          switchThemeCentreTab("studio");
        });
        return;
      }

      customGrid.innerHTML = customList
      .map((theme) => renderThemeCardHtml(theme, true))
      .join("");

      customGrid.querySelectorAll("[data-theme-card-id]").forEach((card) => {
        card.addEventListener("click", (e) => {
          if (e.target.closest("[data-delete-custom-id]")) return;
          const found = getSavedCustomThemes().find((t) => t.id === card.dataset.themeCardId);
          if (!found) return;
          activeThemeConfig = applyThemeConfig({ ...found });
          syncStudioInputs(activeThemeConfig, false);
          renderAllThemeGrids();

          if (e.target.closest("[data-customize-theme-id]")) {
            switchThemeCentreTab("studio");
          }
        });
      });

      customGrid.querySelectorAll("[data-delete-custom-id]").forEach((delBtn) => {
        delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const idToDelete = delBtn.dataset.deleteCustomId;
          deleteCustomTheme(idToDelete);
          if (activeThemeConfig.id === idToDelete) {
            activeThemeConfig = applyThemeConfig({ ...THEME_PRESETS["nexus-default"] });
            syncStudioInputs(activeThemeConfig, true);
          }
          renderAllThemeGrids();
          showToast(t("toast.theme_deleted"), "info");
        });
      });

      if (window.lucide) window.lucide.createIcons();
    };

      const renderAllThemeGrids = () => {
        renderPresetsGrid();
        renderCustomThemesGrid();
        if (window.lucide) window.lucide.createIcons();
      };

        function mixHexColors(hex1, hex2, weight = 0.28) {
          const parse = (h) => {
            const clean = (h || "#1e293b").replace("#", "");
            const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
            const num = parseInt(full, 16);
            return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
          };

          const [r1, g1, b1] = parse(hex1);
          const [r2, g2, b2] = parse(hex2);

          const r = Math.round(r1 * (1 - weight) + r2 * weight);
          const g = Math.round(g1 * (1 - weight) + g2 * weight);
          const b = Math.round(b1 * (1 - weight) + b2 * weight);

          return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
        }

        const buildStudioThemeObject = (keepCustomId = false) => {
          const mode = inpMode?.value || "dark";
          const isLight = mode === "light";
          const preserveId = keepCustomId && activeThemeConfig.id?.startsWith("custom_")
          ? activeThemeConfig.id
          : "unsaved_custom";

          const dynamicBorder = mixHexColors(
            inpBgSecondary.value,
            inpAccent.value,
            isLight ? 0.35 : 0.28
          );

          return {
            ...activeThemeConfig,
            id: preserveId,
            name: inpName?.value.trim() || "Custom Theme",
            mode,
            bgPrimary: inpBgPrimary.value,
            bgSecondary: inpBgSecondary.value,
            bgCard: inpBgSecondary.value,
            textPrimary: isLight ? "#0f172a" : "#f8fafc",
            textSecondary: isLight ? "#475569" : "#94a3b8",
            border: dynamicBorder,
            accentPrimary: inpAccent.value,
            accentSecondary: inpAccentSec.value,
            glowColor: inpGlow.value,
            logoStart: inpLogoStart.value,
            logoMid: inpLogoMid.value,
            logoEnd: inpLogoEnd.value,
            pattern: inpPattern.value,
            patternIcons: [...studioPatternIcons]
          };
        };

        function handleCustomChange() {
          const updated = buildStudioThemeObject(false);
          activeThemeConfig = applyThemeConfig(updated);
          updateStudioPreview(updated);
          refreshCustomPatternCard(); // culoarea iconițelor urmează „Secondary Highlight”
          setStudioDirty(true);
        }

        inpName?.addEventListener("input", handleCustomChange);
        inpMode?.addEventListener("change", (e) => {
          if (e.isTrusted) handleCustomChange();
        });

          resetStudioBtn?.addEventListener("click", () => {
            closeColorWheelPopover();
            activeThemeConfig = applyThemeConfig({ ...studioBaseTheme });
            syncStudioInputs(activeThemeConfig, Boolean(THEME_PRESETS[studioBaseTheme.id]));
            renderAllThemeGrids();
            showToast(t("toast.studio_reverted"), "info");
          });

          saveCustomBtn?.addEventListener("click", () => {
            if (!isStudioDirty) return;
            closeColorWheelPopover();
            const saved = saveCustomTheme(buildStudioThemeObject(true));
            activeThemeConfig = applyThemeConfig(saved);
            syncStudioInputs(activeThemeConfig, false);
            renderAllThemeGrids();
            switchThemeCentreTab("gallery");
            showToast(t("toast.theme_saved", { name: saved.name }), "success");
          });

          openBtn?.addEventListener("click", () => {
            syncStudioInputs(activeThemeConfig, Boolean(THEME_PRESETS[activeThemeConfig.id]));
            switchThemeCentreTab("gallery");
            openModalAnimated("theme-centre-modal");
            if (window.lucide) window.lucide.createIcons();
          });

            closeBtn?.addEventListener("click", () => {
              closeColorWheelPopover();
              closeModalAnimated("theme-centre-modal");
            });

            // Export JSON
            document.getElementById("btn-export-theme")?.addEventListener("click", () => {
              exportThemeJson(activeThemeConfig);
              showToast(t("toast.theme_exported"), "success");
            });

            // Import JSON (salvează automat și în lista de teme custom)
            const fileInput = document.getElementById("inp-import-theme-file");
            document.getElementById("btn-import-theme")?.addEventListener("click", () => fileInput?.click());
            fileInput?.addEventListener("change", async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                const text = await file.text();
                const imported = sanitizeThemeColors(parseImportedThemeJson(text));
                const saved = saveCustomTheme({ ...imported, id: `custom_${Date.now()}` });
                activeThemeConfig = applyThemeConfig(saved);
                syncStudioInputs(activeThemeConfig, false);
                switchThemeCentreTab("gallery");
                showToast(t("toast.theme_imported", { name: saved.name }), "success");
              } catch (err) {
                showToast(t("toast.theme_invalid"), "error");
              } finally {
                fileInput.value = "";
              }
            });
}

// ==========================================
// BIG PICTURE: QUICK SETTINGS & SYSTEM DRAWER
// ==========================================

let cachedBpStatus = safeJsonParse(localStorage.getItem("nexus_bp_status"), null);
let bpSettingsState = {
  open: false,
  tab: "quick", // "quick" | "network" | "system" | "power"
  focusZone: "tabs", // "tabs" | "items"
  tabIdx: 0,
  itemIdx: 0,
  sysInfo: {
    volume: 75,
    muted: false,
    hasBrightness: true,
    brightness: 80,
    wifiEnabled: true,
    wifiSsid: cachedBpStatus?.network_name || "Disconnected",
    btEnabled: true,
    depsResult: null,
    depsInstalling: false
  }
};

const BP_TABS = [
  { id: "quick",   label: "Quick Access", shortLabel: "Quick",   icon: "zap" },
  { id: "network", label: "Network & BT", shortLabel: "Network", icon: "wifi" },
  { id: "system",  label: "System",       shortLabel: "System",  icon: "cpu" },
  { id: "theme",   label: "Theme",        shortLabel: "Theme",   icon: "palette" },
  { id: "power",   label: "Power",        shortLabel: "Power",   icon: "power" }
  // Wi-Fi / Bluetooth se controlează prin nmcli / rfkill: tab-ul există doar pe Linux
].filter((tab) => !(isWindows && tab.id === "network"));

const BP_SETTINGS_TABS = BP_TABS.map((tab) => tab.id);

function ensureBpSettingsDrawerExists() {
  const bpRoot = document.getElementById("big-picture-view") || document.body;

  // 1. Adaugă butonul de Settings în header-ul Big Picture (lângă Exit to Desktop)
  const exitBtn = document.getElementById("btn-exit-bigpicture");
  if (exitBtn && !document.getElementById("btn-bp-open-settings")) {
    const settingsBtn = document.createElement("button");
    settingsBtn.id = "btn-bp-open-settings";
    settingsBtn.type = "button";
    settingsBtn.className = "flex items-center gap-2 bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-slate-200 px-4 py-2.5 rounded-full text-xs font-bold transition shadow-lg cursor-pointer";
    settingsBtn.innerHTML = `<i data-lucide="settings" class="w-4 h-4 text-cyan-400"></i> <span>${t("bp.settings.btn")}</span>`;
    settingsBtn.addEventListener("click", () => openBpSettingsDrawer("quick"));
    exitBtn.parentElement?.insertBefore(settingsBtn, exitBtn);
  }

  // 2. Creează Drawer-ul lateral (stil Steam Deck Quick Access Menu)
  if (!document.getElementById("bp-settings-overlay")) {
    const overlay = document.createElement("div");
    overlay.id = "bp-settings-overlay";
    overlay.style.zIndex = "99992";
    overlay.className = "fixed inset-0 hidden bg-slate-950/90 flex justify-end select-none";
    overlay.innerHTML = `
    <div id="bp-settings-drawer" style="width: 540px; background-color: var(--nd-bg-secondary); border-color: var(--nd-border);"
    class="h-full border-l shadow-2xl flex flex-col justify-between p-8">

    <!-- Header & Tabs -->
    <div class="space-y-5">
    <div class="flex items-center justify-between">
    <div class="flex items-center gap-2.5">
    <i data-lucide="sliders" class="w-5 h-5" style="color: var(--nd-accent);"></i>
    <h2 id="bp-settings-heading" class="text-lg font-black uppercase tracking-wider" style="color: var(--nd-text-primary);">${t("bp.settings.title")}</h2>
    </div>
    <button id="btn-bp-settings-close" type="button" class="p-2 rounded-xl border transition cursor-pointer" style="border-color: var(--nd-border); color: var(--nd-text-secondary);">
    <i data-lucide="x" class="w-5 h-5"></i>
    </button>
    </div>

    <!-- Tab Bar (LB / RB sau D-Pad) -->
    <div id="bp-settings-tabs" class="grid grid-cols-5 gap-1.5 p-1.5 rounded-2xl border" style="background-color: var(--nd-bg-primary); border-color: var(--nd-border);"></div>
    </div>

    <!-- Lista de controale din tab-ul activ -->
    <div id="bp-settings-items" class="flex-1 overflow-y-auto py-6 space-y-3 pr-1" style="min-height: 0; overscroll-behavior: contain;"></div>

    <!-- Footer Legendă Controller -->
    <div class="pt-4 border-t flex items-center justify-between text-xs font-bold" style="border-color: var(--nd-border); color: var(--nd-text-secondary);">
    <div class="flex items-center gap-4">
    <span class="flex items-center gap-1.5">
    <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-slate-800 text-white">
    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
    </span>
    <span id="bp-set-hint-adj">${t("bp.hint.adjust")}</span>
    </span>
    <span class="flex items-center gap-1.5">
    <span class="w-6 h-6 rounded-full flex items-center justify-center text-white font-black" style="background-color: var(--nd-accent);">A</span>
    <span id="bp-set-hint-sel">${t("bp.hint.select")}</span>
    </span>
    </div>
    <span class="flex items-center gap-1.5">
    <span class="w-6 h-6 rounded-full flex items-center justify-center text-white font-black" style="background-color: var(--nd-accent);">B</span>
    <span id="bp-set-hint-back">${t("bp.hint.back")}</span>
    </span>
    </div>
    </div>
    `;

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeBpSettingsDrawer();
    });
      bpRoot.appendChild(overlay);
      document.getElementById("btn-bp-settings-close")?.addEventListener("click", closeBpSettingsDrawer);
  }
}

let lastBpSysSyncAt = 0;


// 2. Deschide drawer-ul instant (<16ms) și sincronizează backend-ul abia după paint, cu cache de 15s:
async function openBpSettingsDrawer(initialTab = "quick") {
  ensureBpSettingsDrawerExists();
  const tabIdx = Math.max(0, BP_SETTINGS_TABS.indexOf(initialTab));

  bpSettingsState.open = true;
  bpSettingsState.tab = BP_SETTINGS_TABS[tabIdx];
  bpSettingsState.tabIdx = tabIdx;
  bpSettingsState.focusZone = "items";
  bpSettingsState.itemIdx = 0;

  document.getElementById("bp-settings-overlay")?.classList.remove("hidden");
  renderBpSettingsDrawer();

  const now = Date.now();
  if (now - lastBpSysSyncAt > 15000 || initialTab === "system") {
    requestAnimationFrame(() => {
      setTimeout(async () => {
        await syncBpSystemState();
        lastBpSysSyncAt = Date.now();
        if (bpSettingsState.open) renderBpSettingsDrawer();
      }, 0);
    });
  }
}

function closeBpSettingsDrawer() {
  bpSettingsState.open = false;
  document.getElementById("bp-settings-overlay")?.classList.add("hidden");
}

window.openBpSettingsDrawer = openBpSettingsDrawer;
window.closeBpSettingsDrawer = closeBpSettingsDrawer;

// Apel către backend pentru setări de sistem: eroarea apare ca toast (cel mult unul la 4 s,
// ca un slider ținut apăsat să nu inunde ecranul), în loc să fie înghițită.
let lastBpSysErrorAt = 0;
function bpSysCall(cmd, args) {
  const invoke = getInvoke();
  if (!invoke) return Promise.resolve(false);
  return invoke(cmd, args)
    .then(() => true)
    .catch((err) => {
      const now = Date.now();
      if (now - lastBpSysErrorAt > 4000) {
        lastBpSysErrorAt = now;
        showToast(t("toast.error_generic", { err: String(err) }), "error");
      }
      return false;
    });
}

// Citește starea reală a sistemului. Valorile reale înlocuiesc ce a rămas salvat local:
// altfel `bpSystemState` (cu valori implicite sau vechi) umbrea mereu starea reală.
async function refreshBpQuickState() {
  const invoke = getInvoke();
  if (!invoke) return;

  const sys = await invoke("get_quick_system_settings").catch(() => null);
  if (!sys) return;

  bpSettingsState.sysInfo.volume = sys.volume ?? bpSettingsState.sysInfo.volume;
  bpSettingsState.sysInfo.muted = Boolean(sys.muted);
  bpSettingsState.sysInfo.hasBrightness = sys.has_brightness !== false;
  bpSettingsState.sysInfo.brightness = sys.brightness ?? bpSettingsState.sysInfo.brightness;
  bpSettingsState.sysInfo.wifiEnabled = sys.wifi_enabled !== false;
  bpSettingsState.sysInfo.wifiSsid = sys.wifi_ssid || cachedBpStatus?.network_name || "Wi-Fi";
  bpSettingsState.sysInfo.btEnabled = sys.bt_enabled !== false;

  bpSystemState.volume = sys.volume ?? bpSystemState.volume;
  bpSystemState.muted = Boolean(sys.muted);
  if (sys.has_brightness !== false) bpSystemState.brightness = sys.brightness ?? bpSystemState.brightness;
  bpSystemState.wifiConnected = sys.wifi_enabled !== false;
  bpSystemState.wifiName = sys.wifi_ssid || bpSystemState.wifiName;
  bpSystemState.bluetoothEnabled = sys.bt_enabled !== false;
  saveBpSystemState();
  if (typeof updateBpTopStatusIndicators === "function") updateBpTopStatusIndicators();
}

async function syncBpSystemState() {
  const invoke = getInvoke();
  if (!invoke) return;

  try {
    await refreshBpQuickState();

    if (!isWindows) {
      const deps = await invoke("check_system_dependencies").catch(() => null);
      if (deps) bpSettingsState.sysInfo.depsResult = deps;
    }
  } catch (e) {
    console.warn("syncBpSystemState error:", e);
  }
}

const BP_SYS_STORAGE_KEY = "nexus_bp_system_state_v1";
const bpSystemState = Object.assign(
  {
    brightness: 80,
    volume: 75,
    muted: false,
    nightLight: false,
    fpsOverlay: false,
    globalMangohud: true,
    globalGamemode: true,
    wifiConnected: true,
    wifiName: cachedBpStatus?.network_name || "Wi-Fi",
    bluetoothEnabled: true,
    btDevice: "Bluetooth"
  },
  safeJsonParse(localStorage.getItem(BP_SYS_STORAGE_KEY), null) || {}
);

function saveBpSystemState() {
  try {
    localStorage.setItem(BP_SYS_STORAGE_KEY, JSON.stringify(bpSystemState));
  } catch (_) {}
}

function renderBpTabs(container, activeId) {
  if (!container) return;

  container.innerHTML = BP_TABS.map((tab) => {
    const isActive = tab.id === activeId;
    return `
    <button
    type="button"
    data-bp-tab="${tab.id}"
    title="${tab.label}"
    aria-label="${tab.label}"
    class="bp-nav-tab ${isActive ? "active" : ""} flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold transition"
    >
    <i data-lucide="${tab.icon}" class="w-4 h-4 shrink-0"></i>
    <span>${tab.shortLabel}</span>
    </button>
    `;
  }).join("");

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function applyBpNightLightOverlay() {
  let el = document.getElementById("bp-night-light-overlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "bp-night-light-overlay";
    el.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:99990;background:rgba(255,147,41,0.22);mix-blend-mode:multiply;transition:opacity 0.2s ease;";
    document.body.appendChild(el);
  }
  el.style.opacity = bpSystemState.nightLight ? "1" : "0";
  el.style.display = bpSystemState.nightLight ? "block" : "none";
}

let bpFpsRafId = null;
function toggleBpFpsOverlay(enabled) {
  let el = document.getElementById("bp-fps-overlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "bp-fps-overlay";
    el.style.cssText =
    "position:fixed;top:16px;left:16px;z-index:99991;pointer-events:none;padding:6px 10px;border-radius:10px;font-family:monospace;font-size:12px;font-weight:800;background:rgba(2,6,23,0.85);color:#34d399;border:1px solid rgba(52,211,153,0.4);";
    document.body.appendChild(el);
  }

  if (bpFpsRafId) {
    cancelAnimationFrame(bpFpsRafId);
    bpFpsRafId = null;
  }

  if (!enabled) {
    el.classList.add("hidden");
    return;
  }

  el.classList.remove("hidden");
  let frames = 0;
  let lastTime = performance.now();
  el.textContent = "FPS: --";

  const tick = (now) => {
    frames++;
    const dt = now - lastTime;
    if (dt >= 500) {
      const fps = Math.round((frames * 1000) / dt);
      el.textContent = `FPS: ${fps}`;
      frames = 0;
      lastTime = now;
    }
    if (bpSystemState.fpsOverlay) {
      bpFpsRafId = requestAnimationFrame(tick);
    }
  };
  bpFpsRafId = requestAnimationFrame(tick);
}

// Aplică starea salvată la încărcare
applyBpNightLightOverlay();
if (bpSystemState.fpsOverlay) toggleBpFpsOverlay(true);

// Controalele care folosesc comenzi Linux (wpctl, brightnessctl, nmcli, MangoHud, GameMode,
// verificarea pachetelor) nu au efect pe Windows: acolo nu le afișăm.
const BP_LINUX_ONLY_ITEMS = new Set([
  "brightness", "volume", "mute_audio", "global_mangohud", "global_gamemode",
  "wifi_toggle", "bt_toggle", "check_dependencies",
]);

function getBpSettingsItemsForTab(tab) {
  const items = buildBpSettingsItemsForTab(tab);
  return isWindows ? items.filter((item) => !BP_LINUX_ONLY_ITEMS.has(item.id)) : items;
}

function buildBpSettingsItemsForTab(tab) {
  const sys = typeof bpSystemState === "object" && bpSystemState ? bpSystemState : {};
  const appVer = typeof APP_VERSION !== "undefined" ? APP_VERSION : "";

  if (tab === "quick") {
    return [
      {
        id: "brightness",
        type: "slider",
        label: t("bp.settings.brightness"),
        value: sys.brightness ?? bpSettingsState.sysInfo?.brightness ?? 80,
        min: 10,
        max: 100,
        step: 5,
        unit: "%"
      },
      {
        id: "volume",
        type: "slider",
        label: t("bp.settings.volume"),
        value: sys.volume ?? bpSettingsState.sysInfo?.volume ?? 75,
        min: 0,
        max: 100,
        step: 5,
        unit: "%"
      },
      {
        id: "mute_audio",
        type: "toggle",
        label: t("bp.settings.mute_audio") || "Mute Audio",
        sublabel: t("bp.settings.mute_audio_sub") || "Mute or unmute system output",
        value: Boolean(sys.muted ?? bpSettingsState.sysInfo?.muted)
      },
      {
        id: "night_light",
        type: "toggle",
        label: t("bp.settings.night_light"),
        sublabel: t("bp.settings.night_light_sub"),
        value: Boolean(sys.nightLight)
      },
      {
        id: "global_mangohud",
        type: "toggle",
        label: t("bp.settings.global_mangohud") || "Global MangoHud Overlay",
        sublabel: t("bp.settings.global_mangohud_sub") || "Performance & FPS overlay",
        value: Boolean(sys.globalMangohud)
      },
      {
        id: "global_gamemode",
        type: "toggle",
        label: t("bp.settings.global_gamemode") || "Global Feral GameMode",
        sublabel: t("bp.settings.global_gamemode_sub") || "CPU & performance governor boost",
        value: Boolean(sys.globalGamemode)
      }
    ];
  }

  if (tab === "network") {
    const wifiOn = sys.wifiConnected ?? bpSettingsState.sysInfo?.wifiEnabled ?? true;
    const wifiName = sys.wifiName || bpSettingsState.sysInfo?.wifiSsid || "Wi-Fi";
    const btOn = sys.bluetoothEnabled ?? bpSettingsState.sysInfo?.btEnabled ?? true;
    const btName = sys.btDevice || "Bluetooth";

    return [
      {
        id: "wifi_toggle",
        type: "toggle",
        label: t("bp.settings.wifi"),
        sublabel: wifiOn
        ? `${t("bp.settings.connected")}: ${wifiName}`
        : t("bp.settings.disconnected"),
        value: Boolean(wifiOn)
      },
      {
        id: "bt_toggle",
        type: "toggle",
        label: t("bp.settings.bluetooth"),
        sublabel: btOn ? btName : t("bp.settings.disabled"),
        value: Boolean(btOn)
      }
    ];
  }

  if (tab === "system") {
    const hasPendingUpdate = Boolean(typeof pendingAppUpdate !== "undefined" && pendingAppUpdate);
    const updateSublabel = hasPendingUpdate
    ? (t("bp.settings.update_ready_sub", { version: pendingAppUpdate.version }) ||
    `NexusDeck Application Update • v${pendingAppUpdate.version} Ready`)
    : (appVer
    ? `${t("bp.settings.current_version")}: v${appVer}`
    : (t("bp.settings.check_updates_sub") || "Check for application updates"));

    const depsInfo = bpSettingsState.sysInfo?.depsResult;
    const depsSublabel = !depsInfo
    ? (t("bp.settings.check_deps_sub") || "Verify system & gaming dependencies")
    : depsInfo.all_installed
    ? (t("bp.settings.deps_all_installed") || "Linux Gaming Dependencies: All dependencies installed")
    : (t("bp.settings.deps_missing", {
      count: (depsInfo.dependencies || []).filter((d) => !d.installed).length
    }) || "Some dependencies are missing");

    return [
      {
        id: hasPendingUpdate ? "download_and_restart" : "check_updates",
        type: "action",
        label: hasPendingUpdate
        ? (t("bp.settings.download_and_restart") || "Download & Restart")
        : t("bp.settings.check_updates"),
        sublabel: updateSublabel,
        tone: hasPendingUpdate ? "warn" : "normal"
      },
      {
        id: "check_dependencies",
        type: "action",
        label: t("bp.settings.check_dependencies") || "Check Dependencies",
        sublabel: depsSublabel,
        tone: "normal"
      },
      {
        id: "reload_ui",
        type: "action",
        label: t("bp.settings.reload_ui"),
        sublabel: t("bp.settings.reload_ui_sub"),
        tone: "normal"
      }
    ];
  }

  if (tab === "theme") {
    const items = [];
    const presets = typeof THEME_PRESETS === "object" && THEME_PRESETS ? Object.values(THEME_PRESETS) : [];
    const customList = typeof getSavedCustomThemes === "function" ? getSavedCustomThemes() : [];

    presets.forEach((preset) => {
      const isCurrent = activeThemeConfig?.id === preset.id;
      items.push({
        id: `theme_apply_${preset.id}`,
        type: "theme",
        label: preset.name,
        sublabel: `${t("bp.settings.theme.presets")} • ${(preset.mode || "dark").toUpperCase()}`,
                 active: isCurrent,
                 accentColor: preset.accentPrimary,
                 glowColor: preset.glowColor,
                 onSelect: () => {
                   activeThemeConfig = applyThemeConfig({ ...preset });
                   renderBpSettingsDrawer();
                   showToast(t("toast.theme_imported", { name: preset.name }), "success");
                 }
      });
    });

    customList.forEach((custom) => {
      const isCurrent = activeThemeConfig?.id === custom.id;
      items.push({
        id: `theme_apply_${custom.id}`,
        type: "theme",
        label: custom.name,
        sublabel: `${t("bp.settings.theme.custom")} • ${(custom.mode || "dark").toUpperCase()}`,
                 active: isCurrent,
                 accentColor: custom.accentPrimary,
                 glowColor: custom.glowColor,
                 onSelect: () => {
                   activeThemeConfig = applyThemeConfig({ ...custom });
                   renderBpSettingsDrawer();
                   showToast(t("toast.theme_imported", { name: custom.name }), "success");
                 }
      });
    });

    return items;
  }

  return [
    {
      id: "sleep",
      type: "action",
      label: t("bp.settings.sleep") || "Sleep",
      sublabel: t("bp.settings.sleep_sub") || "Suspend system to memory",
      tone: "normal"
    },
    {
      id: "reboot",
      type: "action",
      label: t("bp.settings.reboot") || "Restart",
      sublabel: t("bp.settings.reboot_sub") || "Reboot the system",
      tone: "warn"
    },
    {
      id: "shutdown",
      type: "action",
      label: t("bp.settings.shutdown") || "Shut Down",
      sublabel: t("bp.settings.shutdown_sub") || "Power off the system",
      tone: "danger"
    },
    {
      id: "exit_bp",
      type: "action",
      label: t("bp.settings.exit_bp"),
      sublabel: t("bp.settings.exit_bp_sub"),
      tone: "normal"
    },
    {
      id: "restart_app",
      type: "action",
      label: t("bp.settings.restart_app"),
      sublabel: t("bp.settings.restart_app_sub"),
      tone: "warn"
    },
    {
      id: "quit_app",
      type: "action",
      label: t("bp.settings.quit_app"),
      sublabel: t("bp.settings.quit_app_sub"),
      tone: "danger"
    }
  ];
}

function renderBpSettingsDrawer() {
  const tabsContainer = document.getElementById("bp-settings-tabs");
  const itemsContainer = document.getElementById("bp-settings-items");
  if (!tabsContainer || !itemsContainer) return;

  const activeTab = BP_SETTINGS_TABS.includes(bpSettingsState.tab)
  ? bpSettingsState.tab
  : BP_SETTINGS_TABS[0];
  bpSettingsState.tab = activeTab;
  bpSettingsState.tabIdx = BP_SETTINGS_TABS.indexOf(activeTab);

  const tabLabels = {
    quick: t("bp.settings.tab.quick"),
    network: t("bp.settings.tab.network"),
    system: t("bp.settings.tab.system"),
    theme: t("bp.settings.tab.theme"),
    power: t("bp.settings.tab.power")
  };

  const items = getBpSettingsItemsForTab(activeTab);
  if (bpSettingsState.itemIdx >= items.length) {
    bpSettingsState.itemIdx = Math.max(0, items.length - 1);
  }

  tabsContainer.innerHTML = BP_TABS.map((tab, idx) => {
    const isActive = activeTab === tab.id;
    const activeStyle = isActive
    ? `background: linear-gradient(90deg, var(--nd-accent), var(--nd-glow)); color: var(--nd-btn-text, #ffffff);`
    : `background: transparent; color: var(--nd-text-secondary);`;

    return `
    <button type="button" data-bp-set-tab="${tab.id}" data-bp-tab-idx="${idx}"
    title="${escapeHtml(tab.label)}" aria-label="${escapeHtml(tab.label)}" style="${activeStyle}"
    class="py-3 px-2 rounded-xl transition cursor-pointer flex items-center justify-center">
    <i data-lucide="${tab.icon}" class="w-4 h-4 shrink-0"></i>
    </button>
    `;
  }).join("");

  itemsContainer.innerHTML = items
  .map((item, idx) => {
    const isFocused = idx === bpSettingsState.itemIdx;
    const focusGradientStyle = `style="background: linear-gradient(90deg, var(--nd-accent), var(--nd-glow)); color: var(--nd-btn-text, #ffffff); border-color: transparent;"`;
    const baseStyle = `style="background: var(--nd-bg-primary); border-color: var(--nd-border); color: var(--nd-text-primary);"`;

    if (item.type === "theme") {
      const badgeText = item.active ? t("bp.settings.theme.active") : "›";
      const pillStyle = item.active
      ? "background: rgba(16,185,129,0.2); color: #34d399; border: 1px solid rgba(16,185,129,0.4);"
      : "background: transparent; color: inherit;";

      return `
      <div data-bp-set-item="${idx}" ${isFocused ? focusGradientStyle : baseStyle}
      class="p-4 rounded-2xl border flex items-center justify-between gap-3 transition cursor-pointer ${isFocused ? "shadow-xl font-extrabold" : "font-semibold"}">
      <div class="min-w-0">
      <div class="text-sm truncate">${escapeHtml(item.label)}</div>
      ${item.sublabel ? `<div class="text-xs opacity-75 truncate mt-0.5">${escapeHtml(item.sublabel)}</div>` : ""}
      </div>
      <div class="flex items-center gap-2 shrink-0">
      <span class="w-3.5 h-3.5 rounded-full border border-white/25" style="background:${item.accentColor || "var(--nd-accent)"};"></span>
      <span class="w-3.5 h-3.5 rounded-full border border-white/25" style="background:${item.glowColor || "var(--nd-glow)"};"></span>
      <span class="px-2.5 py-0.5 rounded-full text-xs font-black" style="${pillStyle}">${escapeHtml(badgeText)}</span>
      </div>
      </div>
      `;
    }

    if (item.type === "slider") {
      const trackBg = isFocused ? "rgba(0,0,0,0.28)" : "rgba(255,255,255,0.12)";
      const fillBg = isFocused ? "var(--nd-btn-text, #ffffff)" : "var(--nd-accent)";
      return `
      <div data-bp-set-item="${idx}" ${isFocused ? focusGradientStyle : baseStyle}
      class="p-4 rounded-2xl border transition cursor-pointer ${isFocused ? "shadow-xl font-extrabold" : "font-semibold"}">
      <div class="flex items-center justify-between mb-2.5">
      <span class="text-sm">${escapeHtml(item.label)}</span>
      <span class="text-xs font-black px-2 py-0.5 rounded-lg" style="background: rgba(0,0,0,0.22);">${item.value}${item.unit}</span>
      </div>
      <div class="w-full h-2.5 rounded-full overflow-hidden" style="background: ${trackBg};">
      <div class="h-full rounded-full transition-all" style="width: ${item.value}%; background: ${fillBg};"></div>
      </div>
      </div>
      `;
    }

    if (item.type === "toggle") {
      const pillBg = item.value
      ? isFocused
      ? "rgba(0,0,0,0.35)"
      : "var(--nd-accent)"
      : "rgba(255,255,255,0.14)";
      return `
      <div data-bp-set-item="${idx}" ${isFocused ? focusGradientStyle : baseStyle}
      class="p-4 rounded-2xl border flex items-center justify-between gap-3 transition cursor-pointer ${isFocused ? "shadow-xl font-extrabold" : "font-semibold"}">
      <div class="min-w-0">
      <div class="text-sm truncate">${escapeHtml(item.label)}</div>
      ${item.sublabel ? `<div class="text-xs opacity-75 truncate mt-0.5">${escapeHtml(item.sublabel)}</div>` : ""}
      </div>
      <div class="w-12 h-6 rounded-full p-0.5 transition shrink-0 flex items-center ${item.value ? "justify-end" : "justify-start"}"
      style="background: ${pillBg};">
      <div class="w-5 h-5 rounded-full bg-white shadow"></div>
      </div>
      </div>
      `;
    }

    const toneStyle =
    !isFocused && item.tone === "danger"
    ? `style="background: rgba(244,63,94,0.12); border-color: rgba(244,63,94,0.35); color: #fda4af;"`
    : !isFocused && item.tone === "warn"
    ? `style="background: rgba(245,158,11,0.12); border-color: rgba(245,158,11,0.35); color: #fcd34d;"`
    : baseStyle;

    return `
    <div data-bp-set-item="${idx}" ${isFocused ? focusGradientStyle : toneStyle}
    class="p-4 rounded-2xl border flex items-center justify-between gap-3 transition cursor-pointer ${isFocused ? "shadow-xl font-extrabold" : "font-semibold"}">
    <div class="min-w-0">
    <div class="text-sm truncate">${escapeHtml(item.label)}</div>
    ${item.sublabel ? `<div class="text-xs opacity-75 truncate mt-0.5">${escapeHtml(item.sublabel)}</div>` : ""}
    </div>
    <span class="text-xs opacity-80 font-black">›</span>
    </div>
    `;
  })
  .join("");

  tabsContainer.querySelectorAll("[data-bp-set-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      bpSettingsState.tab = btn.dataset.bpSetTab;
      bpSettingsState.tabIdx = Number(btn.dataset.bpTabIdx) || 0;
      bpSettingsState.itemIdx = 0;
      renderBpSettingsDrawer();
    });
  });

  itemsContainer.querySelectorAll("[data-bp-set-item]").forEach((el) => {
    el.addEventListener("click", () => {
      bpSettingsState.itemIdx = Number(el.dataset.bpSetItem);
      activateBpSettingsItem(1);
    });
  });

  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }

  // Elementul selectat cu gamepad-ul / tastatura trebuie să rămână vizibil: înainte nu derula
  // nimeni lista, iar focusul cobora sub marginea panoului (vizibil la lista lungă de teme).
  const focusedItem = itemsContainer.querySelector(`[data-bp-set-item="${bpSettingsState.itemIdx}"]`);
  if (focusedItem) {
    const box = itemsContainer.getBoundingClientRect();
    const r = focusedItem.getBoundingClientRect();
    const margin = 12;
    if (r.top < box.top + margin) {
      itemsContainer.scrollTop -= box.top + margin - r.top;
    } else if (r.bottom > box.bottom - margin) {
      itemsContainer.scrollTop += r.bottom - (box.bottom - margin);
    }
  }
}

function updateBpGamepadLabels(gamepadId = "") {
  const badge = document.getElementById("bp-btn-select-badge");
  if (!badge) return;
  let id = gamepadId;
  if (!id && navigator.getGamepads) {
    const pads = navigator.getGamepads();
    const active = Array.from(pads).find(Boolean);
    if (active) id = active.id || "";
  }
  const isXbox = /xbox|xinput|045e/i.test(id);
  badge.textContent = isXbox ? "VIEW" : "SELECT";
}
async function adjustBpSettingsSlider(delta) {
  const items = getBpSettingsItemsForTab(bpSettingsState.tab);
  const item = items[bpSettingsState.itemIdx];
  if (!item || item.type !== "slider") return;

  const invoke = getInvoke();
  const minVal = item.min ?? 0;
  const maxVal = item.max ?? 100;
  const currentVal = Number(item.value ?? 0);
  const nextVal = Math.max(minVal, Math.min(maxVal, currentVal + delta));

  if (item.id === "volume") {
    bpSystemState.volume = nextVal;
    bpSettingsState.sysInfo.muted = false;
    bpSettingsState.sysInfo.volume = nextVal;
    saveBpSystemState();
    renderBpSettingsDrawer();
    bpSysCall("set_system_volume", { percent: nextVal });
  } else if (item.id === "brightness") {
    bpSystemState.brightness = nextVal;
    bpSettingsState.sysInfo.brightness = nextVal;
    saveBpSystemState();
    if (typeof applyBpBrightnessOverlay === "function") applyBpBrightnessOverlay();
    renderBpSettingsDrawer();
    bpSysCall("set_screen_brightness", { percent: nextVal });
  }
}

async function activateBpSettingsItem(dir = 1) {
  const items = getBpSettingsItemsForTab(bpSettingsState.tab);
  const item = items[bpSettingsState.itemIdx];
  if (!item) return;

  if (item.type === "theme" && typeof item.onSelect === "function") {
    item.onSelect();
    return;
  }

  if (item.type === "slider") {
    const step = Number(item.step ?? 5);
    const currentVal = Number(item.value ?? 0);
    const nextVal = Math.max(item.min ?? 0, Math.min(item.max ?? 100, currentVal + dir * step));

    if (typeof bpSystemState === "object" && bpSystemState) {
      if (item.id === "brightness") {
        bpSystemState.brightness = nextVal;
        if (typeof applyBpBrightnessOverlay === "function") applyBpBrightnessOverlay();
      } else if (item.id === "volume") {
        bpSystemState.volume = nextVal;
      }
      if (typeof saveBpSystemState === "function") saveBpSystemState();
    }
    if (item.id === "volume") {
      bpSettingsState.sysInfo.muted = false;
      bpSettingsState.sysInfo.volume = nextVal;
      bpSysCall("set_system_volume", { percent: nextVal });
      showToast(`${t("bp.settings.volume")}: ${nextVal}%`, "info");
    } else if (item.id === "brightness") {
      bpSettingsState.sysInfo.brightness = nextVal;
      bpSysCall("set_screen_brightness", { percent: nextVal });
    }
    renderBpSettingsDrawer();
    return;
  }

  if (item.type === "toggle") {
    if (typeof bpSystemState === "object" && bpSystemState) {
      if (item.id === "mute_audio") {
        const nextMuted = !Boolean(bpSystemState.muted ?? bpSettingsState.sysInfo?.muted);
        bpSystemState.muted = nextMuted;
        bpSettingsState.sysInfo.muted = nextMuted;
        bpSysCall("toggle_system_mute", { muted: nextMuted });
      } else if (item.id === "global_mangohud") {
        bpSystemState.globalMangohud = !bpSystemState.globalMangohud;
        getInvoke()?.("set_global_mangohud", { enabled: bpSystemState.globalMangohud }).catch(() => {});
      } else if (item.id === "global_gamemode") {
        bpSystemState.globalGamemode = !bpSystemState.globalGamemode;
        getInvoke()?.("set_global_gamemode", { enabled: bpSystemState.globalGamemode }).catch(() => {});
      } else if (item.id === "night_light") {
        bpSystemState.nightLight = !bpSystemState.nightLight;
        if (typeof applyBpNightLightOverlay === "function") applyBpNightLightOverlay();
      } else if (item.id === "fps_overlay") {
        bpSystemState.fpsOverlay = !bpSystemState.fpsOverlay;
        if (typeof toggleBpFpsOverlay === "function") toggleBpFpsOverlay(bpSystemState.fpsOverlay);
      } else if (item.id === "wifi_toggle" || item.id === "bt_toggle") {
        // Comută radioul real (nmcli/rfkill, bluetoothctl); dacă eșuează, revenim la starea veche
        const isWifi = item.id === "wifi_toggle";
        const stateKey = isWifi ? "wifiConnected" : "bluetoothEnabled";
        const prev = Boolean(bpSystemState[stateKey]);
        bpSystemState[stateKey] = !prev;
        if (typeof updateBpTopStatusIndicators === "function") updateBpTopStatusIndicators();

        bpSysCall(isWifi ? "toggle_wifi" : "toggle_bluetooth", { enabled: !prev }).then(async (ok) => {
          if (!ok) {
            bpSystemState[stateKey] = prev;
          } else {
            // conexiunea/radioul au nevoie de o clipă ca să se stabilizeze
            await new Promise((resolve) => setTimeout(resolve, 2500));
            await refreshBpQuickState();
          }
          saveBpSystemState();
          if (typeof updateBpTopStatusIndicators === "function") updateBpTopStatusIndicators();
          renderBpSettingsDrawer();
        });
      }
      if (typeof saveBpSystemState === "function") saveBpSystemState();
    }
    renderBpSettingsDrawer();
    return;
  }

  if (item.type === "action") {
    if (item.id === "sleep" || item.id === "reboot" || item.id === "shutdown") {
      const invoke = getInvoke();
      if (!invoke) {
        showToast(t("toast.error_generic", { err: "Tauri invoke unavailable" }), "error");
        return;
      }

      const statusLabels = {
        sleep: t("bp.settings.sleeping") || "Suspending system...",
        reboot: t("bp.settings.rebooting") || "Restarting system...",
        shutdown: t("bp.settings.shutting_down") || "Shutting down system..."
      };

      try {
        showToast(statusLabels[item.id], "info");
        await invoke("system_power_action", { action: item.id });
        closeBpSettingsDrawer();
      } catch (err) {
        showToast(t("toast.error_generic", { err: String(err) }), "error");
      }
      return;
    }

    if (item.id === "download_and_restart") {
      closeBpSettingsDrawer();
      if (typeof installPendingAppUpdate === "function") {
        await installPendingAppUpdate();
      }
    } else if (item.id === "check_updates") {
      if (typeof checkForAppUpdates === "function") {
        showToast(t("modal.cfg.checking_updates") || "Checking for updates...", "info");
        await checkForAppUpdates(false);
        renderBpSettingsDrawer();
      } else {
        showToast(t("bp.settings.up_to_date"), "success");
      }
    } else if (item.id === "check_dependencies") {
      closeBpSettingsDrawer();
      if (typeof openDependenciesWizard === "function") {
        await openDependenciesWizard(true);
      } else {
        const invoke = getInvoke();
        const deps = await invoke?.("check_system_dependencies").catch(() => null);
        if (deps) bpSettingsState.sysInfo.depsResult = deps;
        renderBpSettingsDrawer();
      }
    } else if (item.id === "reload_ui" || item.id === "restart_app") {
      window.location.reload();
    } else if (item.id === "exit_bp") {
      closeBpSettingsDrawer();
      if (typeof exitBigPictureMode === "function") {
        exitBigPictureMode();
      } else {
        document.getElementById("btn-exit-bigpicture")?.click();
      }
    } else if (item.id === "quit_app") {
      closeBpSettingsDrawer();
      if (window.__TAURI__?.process?.exit) {
        window.__TAURI__.process.exit(0);
      } else {
        window.close();
      }
    }
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  initThemeCentre();
  applyTranslationsToDom();
  loadSavedUiSettings();
  enhanceCustomSelects();
  setupEventListeners();
  setupUiSettingsListeners();
  setupSourceSidebarListeners();
  setupEmulationUi();
  initBigPictureSearchOSK();
  initTuxRunnerEasterEgg();
  initGamesContainerEvents();
  initDependenciesWizard();
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
  <input type="text" placeholder="${t("modal.game.dll_name_ph")}" value="${escapeHtml(dll)}" class="dll-name flex-1 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono">

  <input type="text" placeholder="${t("modal.game.dll_mode_ph")}" value="${escapeHtml(mode)}" class="dll-mode w-32 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono" title="${t("modal.game.dll_mode_title")}">

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
  <input type="text" placeholder="${t("modal.game.env_key_ph")}" value="${escapeHtml(key)}" class="env-key flex-1 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono">
  <input type="text" placeholder="${t("modal.game.env_val_ph")}" value="${escapeHtml(val)}" class="env-val flex-1 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono">
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

function showToast(message, type = "info", durationMs = 4000) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "fixed bottom-5 right-5 flex flex-col gap-2 pointer-events-none";
  }

  // Asigură că #toast-container este mereu ultimul element în <body> și deasupra oricărui modal/blur
  container.style.zIndex = "2147483647";
  if (document.body.lastElementChild !== container) {
    document.body.appendChild(container);
  }

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
  } else if (type === "warning") {
    borderColor = "border-amber-500/40";
    iconName = "alert-triangle";
    iconColor = "text-amber-400";
  }

  toast.className = `pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl glass-panel border ${borderColor} text-xs font-semibold text-slate-100 shadow-2xl transition-all duration-300 transform translate-y-4 opacity-0`;

  // Mesajul conține titluri de jocuri, erori de la legendary/Wine etc.: text, niciodată HTML
  toast.innerHTML = `
  <i data-lucide="${iconName}" class="w-4 h-4 ${iconColor} shrink-0"></i>
  <span style="white-space:pre-line;overflow-wrap:anywhere"></span>
  `;
  toast.querySelector("span").textContent = String(message ?? "");
  toast.style.maxWidth = "min(28rem, calc(100vw - 2.5rem))";

  container.appendChild(toast);
  if (window.lucide) window.lucide.createIcons();

  requestAnimationFrame(() => {
    toast.classList.remove("translate-y-4", "opacity-0");
  });

  setTimeout(() => {
    toast.classList.add("translate-y-4", "opacity-0");
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
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

function enhanceCustomSelects() {
  const closeAllMenus = (exceptMenu = null) => {
    document.querySelectorAll(".nexus-select-wrap.open").forEach((w) => w.classList.remove("open"));
    document.querySelectorAll(".nexus-select-menu").forEach((m) => {
      if (m !== exceptMenu) m.classList.add("hidden");
    });
  };

  if (!window._nexusSelectGlobalListener) {
    window.addEventListener("click", () => closeAllMenus());
    window.addEventListener("resize", () => closeAllMenus());
    window.addEventListener("scroll", (e) => {
      // Nu închide meniul dacă dai scroll chiar în interiorul listei de opțiuni
      if (e.target && e.target.classList?.contains("nexus-select-menu")) return;
      closeAllMenus();
    }, true);
    window._nexusSelectGlobalListener = true;
  }

  document.querySelectorAll("select").forEach((select) => {
    // Ignoră select-ul de limbă (care are deja steagurile custom) sau cele deja procesate
    if (select.id === "cfg-lang" || select.dataset.enhanced === "true") return;
    select.dataset.enhanced = "true";

    // Păstrează lățimea originală dacă este inline (ex. în bara de sortare)
    const isCompact = !select.classList.contains("w-full");
    select.classList.add("hidden");

    const wrap = document.createElement("div");
    wrap.className = isCompact ? "nexus-select-wrap !w-auto min-w-[170px]" : "nexus-select-wrap";
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "nexus-select-trigger";
    trigger.innerHTML = `
    <span class="nexus-select-label truncate"></span>
    <svg class="w-4 h-4 opacity-60 shrink-0 transition-transform duration-150" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="6 9 12 15 18 9"></polyline>
    </svg>
    `;

    const menu = document.createElement("div");
    menu.className = "nexus-select-menu hidden";
    document.body.appendChild(menu);

    wrap.appendChild(trigger);

    const positionMenu = () => {
      const rect = trigger.getBoundingClientRect();
      menu.style.width = `${rect.width}px`;
      menu.style.left = `${rect.left}px`;

      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow < 210 && rect.top > 210) {
        menu.style.top = "auto";
        menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
      } else {
        menu.style.bottom = "auto";
        menu.style.top = `${rect.bottom + 6}px`;
      }
    };

    const syncOptions = () => {
      const labelEl = trigger.querySelector(".nexus-select-label");
      const selectedOpt = select.options[select.selectedIndex];
      if (labelEl) {
        labelEl.textContent = selectedOpt ? selectedOpt.textContent : "";
      }

      menu.innerHTML = "";
      Array.from(select.options).forEach((opt, idx) => {
        if (opt.hidden) return;
        const item = document.createElement("button");
        item.type = "button";
        const isSelected = idx === select.selectedIndex;
        item.className = `nexus-select-option ${isSelected ? "selected" : ""}`;
        item.innerHTML = `
        <span class="truncate">${opt.textContent}</span>
        ${isSelected ? `<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>` : ""}
        `;

        item.addEventListener("click", (e) => {
          e.stopPropagation();
          select.value = opt.value;
          syncOptions();
          menu.classList.add("hidden");
          wrap.classList.remove("open");
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });

        menu.appendChild(item);
      });
    };

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = menu.classList.contains("hidden");
      closeAllMenus(menu);
      if (willOpen) {
        positionMenu();
        menu.classList.remove("hidden");
        wrap.classList.add("open");
      } else {
        menu.classList.add("hidden");
        wrap.classList.remove("open");
      }
    });

    // Sincronizează automat când codul schimbă .value, opțiunile sau traducerile
    select.addEventListener("change", syncOptions);
    const observer = new MutationObserver(syncOptions);
    observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true });

    syncOptions();
  });
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
    const LANG_OPTIONS_HTML = {
      en: `<svg viewBox="0 0 60 30" class="w-5 h-3.5 rounded-[2px] shrink-0 shadow-sm"><path d="M0,0 v30 h60 v-30 z" fill="#012169"/><path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/><path d="M0,0 L60,30 M60,0 L0,30" stroke="#C8102E" stroke-width="4"/><path d="M30,0 v30 M0,15 h60" stroke="#fff" stroke-width="10"/><path d="M30,0 v30 M0,15 h60" stroke="#C8102E" stroke-width="6"/></svg><span>English (UK)</span>`,
      ro: `<svg viewBox="0 0 3 2" class="w-5 h-3.5 rounded-[2px] shrink-0 shadow-sm"><rect width="1" height="2" x="0" fill="#002B7F"/><rect width="1" height="2" x="1" fill="#FCD116"/><rect width="1" height="2" x="2" fill="#CE1126"/></svg><span>Română</span>`
    };

    const syncCustomLangUi = (lang) => {
      const selectedEl = document.getElementById("cfg-lang-selected");
      if (selectedEl) {
        selectedEl.innerHTML = LANG_OPTIONS_HTML[lang] || LANG_OPTIONS_HTML.en;
      }
    };

    if (selectLang) {
      selectLang.value = getLanguage();
      syncCustomLangUi(selectLang.value);

      const langBtn = document.getElementById("cfg-lang-btn");
      const langMenu = document.getElementById("cfg-lang-menu");

      langBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        langMenu?.classList.toggle("hidden");
      });

      document.querySelectorAll("[data-lang-opt]").forEach((optBtn) => {
        optBtn.addEventListener("click", () => {
          const chosen = optBtn.dataset.langOpt;
          langMenu?.classList.add("hidden");
          if (selectLang.value !== chosen) {
            selectLang.value = chosen;
            syncCustomLangUi(chosen);
            selectLang.dispatchEvent(new Event("change"));
          }
        });
      });

      window.addEventListener("click", () => langMenu?.classList.add("hidden"));

      selectLang.addEventListener("change", (e) => {
        syncCustomLangUi(e.target.value);
        setLanguage(e.target.value);
        gameNodeCache.clear();
        renderGames();
        renderSidebarTags();
        updateSourceSidebarUi();
        if (isBigPicture) {
          renderBigPicture();
          if (bpMenuState.open) renderBpGameDetails();
          if (bpPropsState.open) renderBpProperties();
          if (bpSettingsState.open) renderBpSettingsDrawer();
        }
        showToast(t("toast.lang_changed"), "success");
      });
    }
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

// save_games trimite și rescrie TOATĂ biblioteca. Apelurile apropiate în timp (ProtonDB, scanări,
// favorite, playtime...) se unesc într-o singură salvare, la 300 ms după ultimul apel.
// Promisiunea întoarsă se rezolvă după salvarea efectivă, deci `await saveGamesToDisk()` rămâne valid.
const SAVE_DEBOUNCE_MS = 300;
let saveTimer = null;
let saveWaiters = [];
let saveQueue = Promise.resolve();

function saveGamesToDisk() {
  return new Promise((resolve) => {
    saveWaiters.push(resolve);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushPendingSave, SAVE_DEBOUNCE_MS);
  });
}

// Salvează imediat ce e în așteptare (ex. când fereastra se ascunde în tray sau se închide)
function flushPendingSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (saveWaiters.length === 0) return saveQueue;

  const waiters = saveWaiters;
  saveWaiters = [];
  // Salvările rulează una după alta: una veche nu o poate suprascrie pe una mai nouă
  saveQueue = saveQueue.then(writeGamesToDisk).then(() => {
    waiters.forEach((resolve) => resolve());
  });
  return saveQueue;
}

async function writeGamesToDisk() {
  const invoke = getInvoke();
  if (!invoke) return;
  try {
    await invoke("save_games", { games });
  } catch (e) {
    showToast(t("toast.error_generic", { err: e }), "error");
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushPendingSave();
});
window.addEventListener("pagehide", () => {
  flushPendingSave();
});

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

    // Index-uri în loc de games.find() pentru fiecare joc scanat: cu mii de jocuri Steam deținute,
    // căutarea liniară (cu toLowerCase la fiecare comparație) bloca interfața la sincronizare.
    const byId = new Map(games.map((g) => [g.id, g]));
    const byTitle = new Map();
    for (const g of games) {
      const key = String(g.title || "").toLowerCase();
      if (!byTitle.has(key)) byTitle.set(key, g);
    }

    scannedGames.forEach(scanned => {
      const titleKey = String(scanned.title || "").toLowerCase();
      const sameId = byId.get(scanned.id);
      const existingGame = sameId || byTitle.get(titleKey);

      if (!existingGame) {
        games.push(scanned);
        byId.set(scanned.id, scanned);
        if (!byTitle.has(titleKey)) byTitle.set(titleKey, scanned);
        addedCount++;
      } else {
        const wasInstalled = checkInstalled(existingGame);
        const isNowInstalled = Boolean(
          scanned.is_installed || (scanned.exe_path && !scanned.exe_path.includes("steam://install/"))
        );

        if (!wasInstalled && isNowInstalled) {
          existingGame.is_installed = true;
          if (scanned.exe_path) existingGame.exe_path = scanned.exe_path;
          updatedCount++;
        } else if (
          wasInstalled && !isNowInstalled && sameId &&
          scanned.id.startsWith("steam_") && existingGame.exe_path?.startsWith("steam://")
        ) {
          // Dezinstalat din clientul Steam: înainte rămânea marcat „instalat” pentru totdeauna
          existingGame.is_installed = false;
          existingGame.exe_path = `steam://install/${scanned.id.replace("steam_", "")}`;
          updatedCount++;
        }
      }
    });

    if (addedCount > 0 || updatedCount > 0) {
      await saveGamesToDisk();
      renderGames();
      // Un joc instalat între timp trece pe nivelul 1 și în Big Picture
      if (isBigPicture) renderBigPicture();
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


// ==========================================
// EMULARE (date comune pentru Desktop și Big Picture)
// ==========================================
let emulationOverview = null;
let selectedEmuSystem = "all";

// Etichete scurte de rezervă, până se încarcă prezentarea generală din backend
const EMU_SYSTEM_SHORT_FALLBACK = {
  nes: "NES", snes: "SNES", n64: "N64", gb: "GB", gbc: "GBC", gba: "GBA", nds: "NDS",
  gc: "GC", wii: "WII", wiiu: "WII U", switch: "SWITCH", psx: "PS1", ps2: "PS2", ps3: "PS3",
  psp: "PSP", megadrive: "MD", mastersystem: "SMS", gamegear: "GG", segacd: "SEGA CD",
  saturn: "SATURN", dreamcast: "DC",
};

function isEmulatedGame(game) {
  return Boolean(game) && (game.source === "emulator" || String(game.id || "").startsWith("emu_"));
}

function emuSystemInfo(systemId) {
  return emulationOverview?.systems?.find((s) => s.id === systemId) || null;
}

function emuSystemShort(systemId) {
  return emuSystemInfo(systemId)?.short || EMU_SYSTEM_SHORT_FALLBACK[systemId] || String(systemId || "?").toUpperCase();
}

function emuSystemName(systemId) {
  return emuSystemInfo(systemId)?.name || emuSystemShort(systemId);
}

function emuEmulatorName(emulatorId) {
  const known = emulationOverview?.known_emulators?.find(([id]) => id === emulatorId);
  return known ? known[1] : emulatorId;
}

// Textul badge-ului de pe card: sistemul (PS2, SNES…) pentru jocurile emulate
function getSourceBadgeText(game) {
  return isEmulatedGame(game) ? emuSystemShort(game.system) : getSourceTag(game);
}

// Rândul de sub titlu: emulatorul (ales sau implicit) pentru jocurile emulate, runner-ul în rest
function getGameRunnerLabel(game) {
  if (!isEmulatedGame(game)) return getRunnerDisplayName(game.runner_path);
  const chosen = game.emulator || emuSystemInfo(game.system)?.emulator;
  return chosen ? emuEmulatorName(chosen) : t("emu.no_emulator");
}

async function loadEmulationOverview() {
  const invoke = getInvoke();
  if (!invoke) return null;
  try {
    emulationOverview = await invoke("get_emulation_overview");
  } catch (e) {
    console.warn("get_emulation_overview:", e);
  }
  return emulationOverview;
}

// Scanează folderele de ROM-uri și combină rezultatul cu biblioteca: jocurile noi se adaugă,
// cele existente își păstrează titlul, favoritele, timpul de joc și setările; ROM-urile
// care nu mai există pe disc sunt marcate neinstalate (nu șterse, ca să nu se piardă istoricul).
async function scanRomsIntoLibrary({ silent = false } = {}) {
  const invoke = getInvoke();
  if (!invoke) return null;
  let scanned;
  try {
    scanned = await invoke("scan_roms");
  } catch (e) {
    showToast(t("toast.error_generic", { err: String(e) }), "error");
    return null;
  }

  const byId = new Map(games.map((g) => [g.id, g]));
  const foundIds = new Set();
  let added = 0;
  for (const rom of scanned) {
    foundIds.add(rom.id);
    const existing = byId.get(rom.id);
    if (existing) {
      existing.exe_path = rom.exe_path;
      existing.system = rom.system;
      existing.is_installed = true;
      if (!existing.cover_url) existing.cover_url = rom.cover_url;
    } else {
      games.push({
        ...rom,
        runner_path: "",
        use_gamemode: false,
        use_mangohud: false,
        genre: null,
        env_vars: null,
      });
      added++;
    }
  }
  let missing = 0;
  for (const g of games) {
    if (isEmulatedGame(g) && !foundIds.has(g.id) && g.is_installed !== false) {
      g.is_installed = false;
      missing++;
    }
  }

  await saveGamesToDisk();
  renderGames();
  renderSidebarTags();
  if (isBigPicture) renderBigPicture();
  if (!silent) {
    showToast(t("emu.scan_result", { added, total: scanned.length, missing }), added > 0 ? "success" : "info");
  }
  return { added, total: scanned.length, missing };
}

// ---------- Emulator Manager ----------
async function saveEmulationConfig(mutator) {
  const invoke = getInvoke();
  if (!invoke || !emulationOverview) return;
  const config = JSON.parse(JSON.stringify(emulationOverview.config || { rom_root: "~/ROMs", systems: {} }));
  config.systems = config.systems || {};
  mutator(config);
  try {
    await invoke("save_emulation_config", { config });
  } catch (e) {
    showToast(t("toast.error_generic", { err: String(e) }), "error");
  }
  await loadEmulationOverview();
  renderEmulatorManager();
  renderGames();
}

function renderEmulatorManager() {
  const ov = emulationOverview;
  if (!ov) return;

  const rootInput = document.getElementById("inp-rom-root");
  if (rootInput && document.activeElement !== rootInput) rootInput.value = ov.config?.rom_root || ov.rom_root || "";

  const detected = document.getElementById("emu-detected-list");
  if (detected) {
    const installedIds = new Map((ov.emulators || []).map((e) => [e.id, e]));
    detected.innerHTML = (ov.known_emulators || []).map(([id, name]) => {
      const inst = installedIds.get(id);
      if (inst) {
        return `<span class="px-2.5 py-1 rounded-lg border text-[11px] font-bold flex items-center gap-1.5" style="border-color: rgba(16,185,129,0.45); color: #34d399;" title="${escapeHtml(inst.target)}">
          <i data-lucide="check-circle-2" class="w-3 h-3"></i>${escapeHtml(name)} · ${escapeHtml(inst.kind)}</span>`;
      }
      // Fără pachet Flatpak (Xenia): doar o indicație de instalare manuală
      if (Array.isArray(ov.installable) && !ov.installable.includes(id)) {
        const hintKey = `emu.manual_install_${id}`;
        const hint = t(hintKey) !== hintKey ? t(hintKey) : t("emu.manual_install", { name });
        return `<span class="px-2.5 py-1 rounded-lg border text-[11px] font-bold flex items-center gap-1.5 cursor-help" style="border-color: rgba(100,116,139,0.35); color: #64748b;" title="${escapeHtml(hint)}">
          <i data-lucide="info" class="w-3 h-3"></i>${escapeHtml(name)} · ${escapeHtml(t("emu.manual"))}</span>`;
      }
      const busy = emuInstalling === id;
      const canInstall = ov.flatpak_available && !emuInstalling;
      const title = ov.flatpak_available ? t("emu.install_title", { name }) : t("emu.flatpak_missing");
      return `<button type="button" data-emu-install="${escapeHtml(id)}" ${canInstall ? "" : "disabled"}
        class="px-2.5 py-1 rounded-lg border text-[11px] font-bold flex items-center gap-1.5 transition ${canInstall ? "cursor-pointer" : "cursor-not-allowed"}"
        style="border-color: ${busy ? "rgba(251,146,60,0.6)" : "rgba(100,116,139,0.35)"}; color: ${busy ? "#fb923c" : "#64748b"}; opacity: ${canInstall || busy ? 1 : 0.6};"
        title="${escapeHtml(title)}">
        <i data-lucide="${busy ? "loader-2" : "download"}" class="w-3 h-3 ${busy ? "animate-spin" : ""}"></i>${escapeHtml(name)}${busy ? "" : ` · ${escapeHtml(t("emu.install"))}`}</button>`;
    }).join("");
    detected.querySelectorAll("[data-emu-install]").forEach((btn) => {
      btn.addEventListener("click", () => installEmulator(btn.dataset.emuInstall));
    });
  }

  const list = document.getElementById("emu-systems-list");
  if (!list) return;
  const counts = {};
  games.forEach((g) => {
    if (isEmulatedGame(g) && g.is_installed !== false) counts[g.system] = (counts[g.system] || 0) + 1;
  });

  list.innerHTML = (ov.systems || []).map((sys) => {
    const chosen = ov.config?.systems?.[sys.id]?.emulator || "";
    const options = [`<option value="">${escapeHtml(t("emu.default_option", { name: sys.emulator ? emuEmulatorName(sys.emulator) : t("emu.none") }))}</option>`]
      .concat((sys.available_emulators || []).map((id) =>
        `<option value="${escapeHtml(id)}" ${id === chosen ? "selected" : ""}>${escapeHtml(emuEmulatorName(id))}</option>`))
      .join("");

    const warnings = [];
    if (!sys.emulator) warnings.push(t("emu.warn_no_emulator"));
    if (sys.has_retroarch_core === false) warnings.push(t("emu.warn_no_core"));
    if (sys.bios_ok === false) warnings.push(t("emu.warn_no_bios"));

    const folderStyle = sys.folder_exists ? "color: #94a3b8;" : "color: #64748b; text-decoration: line-through;";
    return `<div class="p-2.5 rounded-xl border border-slate-800 bg-slate-900/50 grid items-center gap-3" style="grid-template-columns: 4.5rem minmax(0,1fr) 11rem;">
      <span class="emu-source-badge px-2 py-0.5 rounded-md text-[10px] font-black uppercase border text-center truncate">${escapeHtml(sys.short)}</span>
      <div class="min-w-0">
        <div class="text-xs font-bold text-slate-200 truncate">${escapeHtml(sys.name)}
          <span class="ml-1 text-[10px] font-mono text-slate-500">${counts[sys.id] ? escapeHtml(t("sidebar.games_count", { count: counts[sys.id] })) : ""}</span>
        </div>
        <div class="text-[10px] font-mono truncate" style="${folderStyle}" title="${escapeHtml(sys.folder)}">${escapeHtml(sys.folder)}</div>
        ${warnings.length ? `<div class="text-[10px] font-semibold mt-0.5 flex items-center gap-2 flex-wrap" style="color:#fbbf24;">⚠ ${escapeHtml(warnings.join(" · "))}
          ${sys.has_retroarch_core === false ? (emuCoreInstalling.has(sys.id)
            ? `<span class="flex items-center gap-1" style="color:#fb923c;"><i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i>${escapeHtml(t("emu.core_installing"))}</span>`
            : `<button type="button" data-emu-core="${escapeHtml(sys.id)}" class="px-2 py-0.5 rounded-md border font-bold cursor-pointer" style="border-color: rgba(251,146,60,0.5); color:#fb923c;">${escapeHtml(t("emu.install_core"))}</button>`) : ""}
          ${sys.bios_ok === false && sys.emulator ? `<button type="button" data-emu-bios="${escapeHtml(sys.id)}" class="px-2 py-0.5 rounded-md border font-bold cursor-pointer flex items-center gap-1" style="border-color: rgba(251,146,60,0.5); color:#fb923c;"><i data-lucide="file-up" class="w-3 h-3"></i>${escapeHtml(t("emu.import_bios"))}</button>` : ""}
        </div>` : ""}
        ${sys.bios_ok === false ? `<details class="mt-1 text-[10px] text-slate-500">
          <summary class="cursor-pointer select-none font-semibold text-slate-400 hover:text-slate-200 transition flex items-center gap-1"><i data-lucide="scale" class="w-3 h-3"></i>${escapeHtml(t("emu.bios_how"))}</summary>
          <p class="mt-1" style="line-height:1.4">${escapeHtml(t("emu.bios_legal"))}</p>
          <p class="mt-1 font-mono text-slate-400" style="line-height:1.4">${escapeHtml(sys.bios_files?.length ? t("emu.bios_names", { names: sys.bios_files.join(", ") }) : t("emu.bios_any_name"))}</p>
        </details>` : ""}
      </div>
      <select data-emu-system="${escapeHtml(sys.id)}" class="custom-select w-full rounded-lg px-2 py-1.5 text-[11px] font-medium" ${sys.available_emulators?.length ? "" : "disabled"}>${options}</select>
    </div>`;
  }).join("");

  list.querySelectorAll("[data-emu-bios]").forEach((btn) => {
    btn.addEventListener("click", () => importBios(btn.dataset.emuBios));
  });

  list.querySelectorAll("[data-emu-core]").forEach((btn) => {
    btn.addEventListener("click", () => installRetroarchCores([btn.dataset.emuCore]));
  });

  // Acțiuni globale: foldere lipsă, core-uri lipsă
  const missingFolders = (ov.systems || []).some((s) => !s.folder_exists);
  document.getElementById("btn-emu-create-folders")?.classList.toggle("hidden", !missingFolders);
  const missingCores = (ov.systems || []).filter((s) => s.has_retroarch_core === false && !emuCoreInstalling.has(s.id));
  document.getElementById("btn-emu-install-all-cores")?.classList.toggle("hidden", missingCores.length === 0);

  list.querySelectorAll("select[data-emu-system]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const id = sel.dataset.emuSystem;
      saveEmulationConfig((cfg) => {
        cfg.systems[id] = { ...(cfg.systems[id] || {}), emulator: sel.value || null };
      });
    });
  });
  if (typeof enhanceCustomSelects === "function") enhanceCustomSelects();
  if (window.lucide) window.lucide.createIcons();
}

// ---------- Foldere de ROM-uri și core-uri RetroArch ----------
const emuCoreInstalling = new Set();

async function createRomFolders() {
  const invoke = getInvoke();
  if (!invoke) return;
  try {
    const created = await invoke("create_rom_folders");
    showToast(t("emu.folders_created", { count: created }), "success");
  } catch (e) {
    showToast(t("toast.error_generic", { err: String(e) }), "error");
  }
  await loadEmulationOverview();
  renderEmulatorManager();
}

// Copiază un BIOS ales de utilizator în folderul emulatorului (fără descărcări: BIOS-ul e protejat de copyright)
async function importBios(systemId) {
  const invoke = getInvoke();
  if (!invoke) return;
  let dest = null;
  try {
    dest = await invoke("import_bios", { systemId });
  } catch (e) {
    showToast(t("toast.error_generic", { err: String(e) }), "error");
    return;
  }
  if (!dest) return; // dialog închis
  await loadEmulationOverview();
  renderEmulatorManager();
  const sys = emuSystemInfo(systemId);
  if (sys?.bios_ok === false) {
    // Copiat, dar emulatorul nu-l va recunoaște: numele nu e unul dintre cele așteptate
    showToast(t("emu.bios_wrong_name", { names: (sys.bios_files || []).join(", ") }), "warning");
  } else {
    showToast(t("emu.bios_imported", { path: dest }), "success");
  }
}

// Instalează core-urile pe rând (descărcările în paralel ar încărca inutil serverul libretro)
async function installRetroarchCores(systemIds) {
  const invoke = getInvoke();
  if (!invoke) return;
  const todo = systemIds.filter((id) => !emuCoreInstalling.has(id));
  if (todo.length === 0) return;
  todo.forEach((id) => emuCoreInstalling.add(id));
  renderEmulatorManager();
  const status = document.getElementById("emu-scan-status");
  let ok = 0;
  const failed = [];
  for (const id of todo) {
    if (status) status.textContent = t("emu.core_installing_for", { system: emuSystemShort(id) });
    try {
      await invoke("install_retroarch_core", { systemId: id });
      ok++;
    } catch (e) {
      failed.push(`${emuSystemShort(id)}: ${e}`);
    }
    emuCoreInstalling.delete(id);
    await loadEmulationOverview();
    renderEmulatorManager();
  }
  if (status) status.textContent = t("emu.cores_done", { ok, failed: failed.length });
  if (failed.length) showToast(failed.join("\n"), "error", 10000);
  else showToast(t("emu.cores_done", { ok, failed: 0 }), "success");
  renderGames();
}

// ---------- Instalarea emulatoarelor (Flatpak) ----------
let emuInstalling = null;

async function installEmulator(id) {
  const invoke = getInvoke();
  if (!invoke || emuInstalling) return;
  const name = emuEmulatorName(id);
  emuInstalling = id;
  renderEmulatorManager();
  const status = document.getElementById("emu-scan-status");
  if (status) status.textContent = t("emu.installing", { name });
  try {
    await invoke("install_emulator", { emulatorId: id });
    showToast(t("emu.installed", { name }), "success");
    if (status) status.textContent = t("emu.installed", { name });
  } catch (e) {
    showToast(String(e), "error", 9000);
    if (status) status.textContent = "";
  } finally {
    emuInstalling = null;
    await loadEmulationOverview();
    renderEmulatorManager();
    renderGames();
  }
}

if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event.listen("emulator-install-progress", (event) => {
    const { id, line } = event.payload || {};
    const status = document.getElementById("emu-scan-status");
    if (status && id === emuInstalling && line) {
      status.textContent = `${emuEmulatorName(id)}: ${line}`.slice(0, 140);
    }
  });
}

async function openEmulatorManager() {
  openModalAnimated("emulator-manager-modal");
  const status = document.getElementById("emu-scan-status");
  if (status && !emuInstalling) status.textContent = t("emu.detecting");
  await loadEmulationOverview();
  if (status && !emuInstalling) {
    status.textContent = emulationOverview && !emulationOverview.flatpak_available && !isWindows
      ? t("emu.flatpak_missing")
      : "";
  }
  renderEmulatorManager();
}

function setupEmulationUi() {
  document.getElementById("btn-open-emulator-manager")?.addEventListener("click", openEmulatorManager);
  document.getElementById("btn-login-emulator")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openEmulatorManager();
  });
  document.getElementById("btn-scan-roms-menu")?.addEventListener("click", () => {
    document.getElementById("add-game-dropdown-menu")?.classList.add("hidden");
    openEmulatorManager();
  });
  const close = () => closeModalAnimated("emulator-manager-modal");
  document.getElementById("close-emulator-manager")?.addEventListener("click", close);
  document.getElementById("close-emulator-manager-footer")?.addEventListener("click", close);

  const rootInput = document.getElementById("inp-rom-root");
  rootInput?.addEventListener("change", () => {
    const value = rootInput.value.trim();
    if (value) saveEmulationConfig((cfg) => { cfg.rom_root = value; });
  });
  document.getElementById("btn-browse-rom-root")?.addEventListener("click", async () => {
    const invoke = getInvoke();
    if (!invoke) return;
    const folder = await invoke("select_folder_dialog").catch(() => null);
    if (folder) {
      if (rootInput) rootInput.value = folder;
      saveEmulationConfig((cfg) => { cfg.rom_root = folder; });
    }
  });

  document.getElementById("btn-emu-create-folders")?.addEventListener("click", createRomFolders);
  document.getElementById("btn-emu-install-all-cores")?.addEventListener("click", () => {
    const ids = (emulationOverview?.systems || []).filter((s) => s.has_retroarch_core === false).map((s) => s.id);
    installRetroarchCores(ids);
  });

  document.getElementById("btn-emu-scan")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    const status = document.getElementById("emu-scan-status");
    if (status) status.textContent = t("emu.scanning");
    const result = await scanRomsIntoLibrary({ silent: true });
    btn.disabled = false;
    if (status && result) status.textContent = t("emu.scan_result", result);
    renderEmulatorManager();
  });

  // Prezentarea generală (sisteme, emulatoare) se încarcă în fundal, pentru etichete și setări
  loadEmulationOverview().then(() => renderGames());
}

// Rândul de filtre pe sistem, deasupra bibliotecii (doar când sursa „Emulare” e selectată)
// Sistemele cu emulator instalat: apar în bibliotecă chiar dacă încă nu au ROM-uri
function emuReadySystemIds() {
  return (emulationOverview?.systems || []).filter((s) => s.emulator).map((s) => s.id);
}

async function openRomFolder(systemId) {
  const invoke = getInvoke();
  if (!invoke) return;
  try {
    await invoke("open_rom_folder", { systemId });
  } catch (err) {
    showToast(String(err), "error");
  }
}

function renderEmuSystemChips(emuGames) {
  const box = document.getElementById("emu-system-chips");
  if (!box) return;
  if (activeSource !== "emulator") {
    box.classList.add("hidden");
    return;
  }
  const counts = {};
  emuGames.forEach((g) => { counts[g.system] = (counts[g.system] || 0) + 1; });
  const systems = Object.keys(counts).sort((a, b) => emuSystemShort(a).localeCompare(emuSystemShort(b)));
  if (selectedEmuSystem !== "all" && !counts[selectedEmuSystem]) selectedEmuSystem = "all";

  const chip = (id, label, count) => {
    const on = selectedEmuSystem === id;
    const style = on
      ? "background: rgba(var(--nd-accent-rgb),0.16); border-color: rgba(var(--nd-accent-rgb),0.55); color: var(--nd-accent);"
      : "border-color: rgba(51,65,85,0.8); color: #94a3b8;";
    return `<button type="button" data-emu-chip="${escapeHtml(id)}" class="px-3 py-1.5 rounded-full border text-xs font-bold transition cursor-pointer" style="${style}">
      ${escapeHtml(label)} <span class="font-mono opacity-70">${count}</span></button>`;
  };
  box.innerHTML = chip("all", t("emu.all_systems"), emuGames.length) +
    systems.map((id) => chip(id, emuSystemShort(id), counts[id])).join("");
  box.classList.toggle("hidden", systems.length < 2);
  box.querySelectorAll("[data-emu-chip]").forEach((b) => {
    b.addEventListener("click", () => {
      selectedEmuSystem = b.dataset.emuChip;
      renderGames();
    });
  });
}

function getRunnerDisplayName(path) {
  if (!path || path === "/usr/bin/wine") return "System Wine";
  if (path.includes("lutris")) return "Lutris Wine";
  if (path.includes("Proton") || path.includes("compatibilitytools")) return "Proton GE";
  return "Custom Runner";
}

function getSourceTag(game) {
  if (isEmulatedGame(game)) return "EMULATOR";
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
      return "steam-source-badge text-sky-400 border-sky-500/40";
    case "EMULATOR":
      return "emu-source-badge text-orange-400 border-orange-500/30";
    case "EPIC":
      // Prima clasă dă culoarea textului și în Big Picture (acolo se folosește doar ea)
      return "epic-source-badge text-purple-400 border-purple-500/30";
    case "HEROIC":
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
      await stopGameProcess(game);
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
  if (activeSource !== "emulator") document.getElementById("emu-system-chips")?.classList.add("hidden");

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
      if (libTitle) {
        const sourceLabel = activeSource === "emulator" ? t("sidebar.emulation") : activeSource.toUpperCase();
        libTitle.textContent = t("lib.source_prefix", { source: sourceLabel });
      }
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

  const showEmuSections = activeSource === "emulator" && searchTerm.length === 0;
  if (displayGames.length === 0 && !(showEmuSections && emuReadySystemIds().length > 0)) {
    if (showEmuSections) renderEmuSystemChips([]);
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
      getGameRunnerLabel(game),
      srcTag(game),
      getSourceBadgeText(game),
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
      statusBadge = `<span class="text-cyan-400 font-bold flex items-center gap-1 shrink-0 ml-1 animate-pulse"><i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> <span data-installing-badge="${escapeHtml(game.id)}">${label}</span></span>`;
    } else if (!inst) {
      statusBadge = `<span class="text-slate-400 font-bold flex items-center gap-1 shrink-0 ml-1"><i data-lucide="download-cloud" class="w-3.5 h-3.5"></i> ${t("game.status.uninstalled")}</span>`;
    }

    let mainActionButton = `<button class="btn-play p-3.5 rounded-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition shadow-xl shadow-emerald-500/40"><i data-lucide="play" class="w-5 h-5 fill-current"></i></button>`;

    if (gameStatus === "playing") {
      mainActionButton = `<button class="btn-stop p-3.5 rounded-full bg-red-600 hover:bg-red-500 text-white transition shadow-xl shadow-red-600/40" title="${t("game.btn.force_stop_title")}"><i data-lucide="square" class="w-5 h-5 fill-current"></i></button>`;
    } else if (isInstalling) {
      const pct = installingGames[game.id];
      const label = pct > 0 ? t("game.status.installing_pct", { pct: pct.toFixed(0) }) : t("game.status.installing");
      mainActionButton = `<div class="px-4 py-2.5 rounded-full bg-cyan-500/20 border border-cyan-400/60 text-cyan-300 font-bold text-xs flex items-center gap-2 shadow-xl backdrop-blur-md cursor-default"><i data-lucide="loader-2" class="w-4 h-4 animate-spin text-cyan-400"></i><span data-installing-pill="${escapeHtml(game.id)}">${label}</span></div>`;
    } else if (!inst) {
      mainActionButton = `<button class="btn-install p-3.5 rounded-full bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition shadow-xl shadow-cyan-500/40" title="${t("game.btn.install_title")}"><i data-lucide="download" class="w-5 h-5"></i></button>`;
    }

    const coverImg = game.cover_url || "";
    const runnerName = getGameRunnerLabel(game);
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
    ? `<img src="${escapeHtml(coverImg)}" loading="lazy" decoding="async" class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">`
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
    ${escapeHtml(getSourceBadgeText(game))}
    </span>
    ${getProtonDbBadgeHtml(game)}
    </div>

    <button class="btn-fav absolute top-3 right-3 z-30 p-2 rounded-full bg-slate-950/80 hover:bg-slate-900 text-amber-400 transition" data-id="${escapeHtml(game.id)}">
    <i data-lucide="star" class="w-4 h-4 ${game.favorite ? "fill-current" : ""}"></i>
    </button>

    ${isInstalling ? `
      <div class="absolute bottom-3 left-3 right-3 z-10 px-3 py-1.5 rounded-xl bg-slate-950/90 border border-cyan-500/40 backdrop-blur-md flex items-center justify-between text-xs font-bold text-cyan-400 shadow-lg group-hover:opacity-0 transition-opacity">
      <span class="flex items-center gap-1.5"><i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> ${t("game.status.installing")}</span>
      <span class="font-mono text-[11px]" data-installing-cover="${escapeHtml(game.id)}">${installingGames[game.id] > 0 ? installingGames[game.id].toFixed(0) + "%" : "..."}</span>
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
      mainActionButton = `<span class="px-4 py-2 bg-cyan-500/15 border border-cyan-500/40 text-cyan-400 font-bold rounded-lg text-xs flex items-center gap-1.5"><i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> <span data-installing-list="${escapeHtml(game.id)}">${label}</span></span>`;
    } else if (!inst) {
      mainActionButton = `<button class="btn-install px-4 py-2 bg-cyan-500 text-slate-950 font-bold rounded-lg hover:bg-cyan-400 transition text-xs flex items-center gap-1.5"><i data-lucide="download" class="w-4 h-4"></i> ${t("game.btn.install")}</button>`;
    }

    const coverImg = game.cover_url || "";
    const imgElement = coverImg
    ? `<img src="${escapeHtml(coverImg)}" loading="lazy" decoding="async" class="w-12 h-16 object-cover rounded-lg shrink-0" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">`
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
    <span class="text-xs text-cyan-400 font-mono">${getGameRunnerLabel(game)}</span>
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

  const emuFolderBtn = (sysId, label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = label
      ? "list-btn-settings w-full flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-[11px] font-bold whitespace-nowrap transition cursor-pointer"
      : "list-btn-settings p-2 rounded-lg transition cursor-pointer shrink-0";
    b.title = emuSystemInfo(sysId)?.folder || t("emu.open_folder");
    b.innerHTML = `<i data-lucide="folder-open" class="w-4 h-4"></i>${label ? `<span>${escapeHtml(label)}</span>` : ""}`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      openRomFolder(sysId);
    });
    return b;
  };

  // Antet de secțiune pentru un sistem emulat: nume, număr de jocuri, emulator și buton spre folder
  const createEmuSectionHeader = (sysId, count) => {
    const info = emuSystemInfo(sysId);
    const emuLabel = info?.emulator ? emuEmulatorName(info.emulator) : "";
    return cachedNode(`emuh|${sysId}`, `${lang}|${count}|${emuLabel}|${info?.folder || ""}`, null, null, () => {
      const div = document.createElement("div");
      div.className = "w-full col-span-full flex items-center gap-3 pt-4 pb-2 border-b border-slate-800/80 mt-2 mb-1";
      div.innerHTML = `
      <div class="flex items-center gap-2.5 min-w-0">
      <i data-lucide="joystick" class="w-5 h-5" style="color: var(--nd-accent)"></i>
      <h2 class="text-xs font-black text-slate-300 uppercase tracking-widest truncate">${escapeHtml(emuSystemName(sysId))}</h2>
      </div>
      <span class="px-2 py-0.5 rounded-full text-[10px] font-mono bg-slate-900 border border-slate-800 text-slate-400">${count}</span>
      ${emuLabel ? `<span class="text-[11px] text-slate-500 font-mono truncate">${escapeHtml(emuLabel)}</span>` : ""}
      <div style="margin-left:auto"></div>`;
      div.lastElementChild.appendChild(emuFolderBtn(sysId));
      return div;
    });
  };

  // Card compact pentru un sistem pregătit (emulator instalat) dar fără ROM-uri
  const createEmuEmptyCard = (sysId) => {
    const info = emuSystemInfo(sysId);
    const folder = info?.folder || "";
    const emuLabel = info?.emulator ? emuEmulatorName(info.emulator) : "";
    return cachedNode(`emue|${mode}|${sysId}`, `${lang}|${folder}|${emuLabel}`, mode, null, () => {
      const div = document.createElement("div");
      if (mode === "grid") {
        div.className = "glass-panel rounded-2xl p-4 flex flex-col gap-3";
        div.innerHTML = `
        <div class="flex items-start justify-between gap-2">
          <span class="text-2xl font-black tracking-tight" style="color: var(--nd-accent)">${escapeHtml(emuSystemShort(sysId))}</span>
          <i data-lucide="joystick" class="w-5 h-5 text-slate-600 mt-1"></i>
        </div>
        <div class="min-w-0">
          <h3 class="font-extrabold text-sm text-slate-100 truncate" title="${escapeHtml(emuSystemName(sysId))}">${escapeHtml(emuSystemName(sysId))}</h3>
          <span class="text-xs text-slate-400 font-mono block mt-1 truncate">${escapeHtml(emuLabel)}</span>
          <span class="text-[10px] text-slate-500 font-mono block mt-1 truncate" title="${escapeHtml(folder)}">${escapeHtml(folder)}</span>
        </div>`;
        div.appendChild(emuFolderBtn(sysId, t("emu.open_folder")));
      } else {
        div.className = "glass-panel p-3 rounded-xl flex items-center justify-between gap-4";
        div.innerHTML = `
        <div class="flex items-center gap-4 min-w-0">
          <div class="w-12 h-12 rounded-lg shrink-0 flex items-center justify-center bg-slate-900"><span class="text-xs font-black" style="color: var(--nd-accent)">${escapeHtml(emuSystemShort(sysId))}</span></div>
          <div class="min-w-0">
            <h4 class="font-extrabold text-base text-white truncate">${escapeHtml(emuSystemName(sysId))}</h4>
            <span class="text-xs text-slate-500 font-mono block truncate">${escapeHtml(emuLabel)}${emuLabel ? " · " : ""}${escapeHtml(folder)}</span>
          </div>
        </div>`;
        div.appendChild(emuFolderBtn(sysId));
      }
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

  if (activeSource === "emulator" && searchTerm.length === 0) {
    // Emulare: filtre pe sistem deasupra; la „Toate”, câte o secțiune pentru fiecare sistem
    const visibleEmu = displayGames;
    renderEmuSystemChips(visibleEmu);
    const bySystem = new Map();
    const wanted = (id) => selectedEmuSystem === "all" || id === selectedEmuSystem;
    // Sistemele cu emulator instalat apar mereu, chiar fără ROM-uri (cu buton spre folderul lor)
    emuReadySystemIds().filter(wanted).forEach((id) => bySystem.set(id, []));
    visibleEmu
      .filter((g) => wanted(g.system))
      .forEach((g) => {
        if (!bySystem.has(g.system)) bySystem.set(g.system, []);
        bySystem.get(g.system).push(g);
      });
    [...bySystem.keys()]
      .sort((a, b) => emuSystemShort(a).localeCompare(emuSystemShort(b)))
      .forEach((sysId) => {
        const list = bySystem.get(sysId);
        if (list.length === 0) return;
        nodes.push(createEmuSectionHeader(sysId, list.length));
        list.forEach((g) => nodes.push(gameNode(g)));
      });
    // Sistemele pregătite dar fără ROM-uri: grupate la final, câte un card compact
    const emptySystems = [...bySystem.keys()]
      .filter((id) => bySystem.get(id).length === 0)
      .sort((a, b) => emuSystemName(a).localeCompare(emuSystemName(b)));
    if (emptySystems.length > 0) {
      nodes.push(createSectionHeader("emu-empty", t("emu.empty_systems"), emptySystems.length, "folder-plus", "text-slate-400"));
      emptySystems.forEach((id) => nodes.push(createEmuEmptyCard(id)));
    }
  } else if (activeSource !== "all" && searchTerm.length === 0) {
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

async function exportGameProfile(game) {
  const invoke = getInvoke();
  if (!invoke || !game) return;

  const runnerObj = availableRunners.find(r => r.path === game.runner_path);
  const runnerName = runnerObj ? runnerObj.name : getGameRunnerLabel(game);

  try {
    const saved = await invoke("export_game_profile", {
      game,
      runnerName,
    });
    if (saved) {
      showToast(
        t("toast.profile_exported", { title: game.title }) || `Profile exported for "${game.title}"!`,
                "success"
      );
    }
  } catch (err) {
    showToast(String(err), "error");
  }
}

// Variabile care pot încărca cod sau schimba căutarea executabilelor: la import le semnalăm utilizatorului
const RISKY_ENV_KEYS = new Set(["LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH", "PATH", "BASH_ENV", "ENV"]);

async function importGameProfileIntoModal() {
  const invoke = getInvoke();
  if (!invoke) return;

  try {
    const profile = await invoke("import_game_profile");
    if (!profile) return;

    // 1. Potrivire runner local după nume
    const runnerSelect = document.getElementById("select-runner");
    if (runnerSelect && profile.runner_name && availableRunners.length > 0) {
      const found = availableRunners.find(
        r => (r.name || "").toLowerCase() === profile.runner_name.toLowerCase()
      );
      if (found) {
        runnerSelect.value = found.path;
      }
    }

    // 2. Populare câmpuri din modal
    const titleInput = document.getElementById("inp-title");
    if (titleInput && !titleInput.value.trim() && profile.title) {
      titleInput.value = profile.title;
    }

    const argsInput = document.getElementById("inp-args");
    if (argsInput) argsInput.value = profile.launch_args || "";

    const coverInput = document.getElementById("inp-cover");
    if (coverInput && !coverInput.value.trim() && profile.cover_url) {
      coverInput.value = profile.cover_url;
    }

    const gmCheckbox = document.getElementById("chk-gamemode");
    if (gmCheckbox) gmCheckbox.checked = Boolean(profile.use_gamemode);

    const mhCheckbox = document.getElementById("chk-mangohud");
    if (mhCheckbox) mhCheckbox.checked = Boolean(profile.use_mangohud);

    // 3. Variabile de mediu și DLL overrides: aceeași logică ca la deschiderea modalului
    const envs = profile.env_vars || {};
    const dllContainer = document.getElementById("dll-overrides-list");
    const envContainer = document.getElementById("env-vars-list");
    if (dllContainer) dllContainer.innerHTML = "";
    if (envContainer) envContainer.innerHTML = "";
    applyEnvVarsToModal(envs);
    if (profile.gamescope) applyGamescopeToModal(profile.gamescope);
    if (window.lucide) window.lucide.createIcons();

    // Titlul și cheile vin dintr-un fișier străin, iar showToast folosește innerHTML
    showToast(t("toast.profile_applied_modal", { title: profile.title }), "success");

    const riskyKeys = Object.keys(envs).filter(k => RISKY_ENV_KEYS.has(k.toUpperCase()));
    if (riskyKeys.length > 0) {
      showToast(t("toast.profile_risky_env", { vars: riskyKeys.join(", ") }), "warning");
    }
  } catch (err) {
    showToast(String(err), "error");
  }
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

// ==========================================
// GAMESCOPE (setări per joc, salvate în game.gamescope)
// ==========================================
const GAMESCOPE_DEFAULTS = Object.freeze({
  enabled: false,
  hdr: false,
  resolution: "1920x1080",
  window_mode: "fullscreen",
  fps_limit: null,
});

function normalizeGamescope(raw) {
  const g = { ...GAMESCOPE_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  const res = String(g.resolution || "").trim().toLowerCase().replace(/\s+/g, "");
  g.resolution = /^\d{3,5}x\d{3,5}$/.test(res) ? res : GAMESCOPE_DEFAULTS.resolution;
  g.window_mode = ["fullscreen", "borderless", "windowed"].includes(g.window_mode) ? g.window_mode : "fullscreen";
  const fps = parseInt(g.fps_limit, 10);
  g.fps_limit = Number.isFinite(fps) && fps > 0 && fps <= 1000 ? fps : null;
  g.enabled = Boolean(g.enabled);
  g.hdr = Boolean(g.hdr);
  return g;
}

// Ca în Lutris: opțiunile sunt vizibile, dar inactive cât timp Gamescope e oprit
function syncGamescopeFieldsState() {
  const enabled = Boolean(document.getElementById("chk-gamescope")?.checked);
  const box = document.getElementById("gamescope-options");
  if (!box) return;
  box.style.opacity = enabled ? "1" : "0.45";
  box.style.pointerEvents = enabled ? "" : "none";
  box.querySelectorAll("input, select").forEach((el) => {
    el.disabled = !enabled;
  });
}

function applyGamescopeToModal(raw) {
  const g = normalizeGamescope(raw);
  const set = (id, fn) => {
    const el = document.getElementById(id);
    if (el) fn(el);
  };
  set("chk-gamescope", (el) => (el.checked = g.enabled));
  set("chk-gamescope-hdr", (el) => (el.checked = g.hdr));
  set("inp-gamescope-res", (el) => (el.value = g.resolution));
  set("select-gamescope-mode", (el) => {
    el.value = g.window_mode;
    el.dispatchEvent(new Event("change")); // actualizează dropdown-ul custom (nexus-select)
  });
  set("inp-gamescope-fps", (el) => (el.value = g.fps_limit ?? ""));
  syncGamescopeFieldsState();
}

function readGamescopeFromModal() {
  return normalizeGamescope({
    enabled: document.getElementById("chk-gamescope")?.checked,
    hdr: document.getElementById("chk-gamescope-hdr")?.checked,
    resolution: document.getElementById("inp-gamescope-res")?.value,
    window_mode: document.getElementById("select-gamescope-mode")?.value,
    fps_limit: document.getElementById("inp-gamescope-fps")?.value,
  });
}

document.getElementById("chk-gamescope")?.addEventListener("change", syncGamescopeFieldsState);

// Secțiunea „Emulare” din setările jocului: vizibilă doar la jocurile emulate, care ascund în
// schimb câmpurile Wine (runner, prefix, DXVK, DLL overrides).
async function applyEmulationToModal(game) {
  const modal = document.getElementById("game-modal");
  const section = document.getElementById("emu-settings-section");
  const emulated = isEmulatedGame(game);
  modal?.classList.toggle("editing-emulated", emulated);
  section?.classList.toggle("hidden", !emulated);
  if (!emulated) return;

  if (!emulationOverview) await loadEmulationOverview();
  const sys = emuSystemInfo(game.system);
  const badge = document.getElementById("emu-settings-system");
  if (badge) badge.textContent = emuSystemShort(game.system);

  const sel = document.getElementById("select-game-emulator");
  if (sel) {
    const defaultName = sys?.emulator ? emuEmulatorName(sys.emulator) : t("emu.none");
    sel.innerHTML = `<option value="">${escapeHtml(t("emu.default_option", { name: defaultName }))}</option>` +
      (sys?.available_emulators || []).map((id) =>
        `<option value="${escapeHtml(id)}">${escapeHtml(emuEmulatorName(id))}</option>`).join("");
    sel.value = game.emulator && (sys?.available_emulators || []).includes(game.emulator) ? game.emulator : "";
    sel.dispatchEvent(new Event("change"));
  }
  const coreInput = document.getElementById("inp-game-core");
  if (coreInput) coreInput.value = game.core || "";
  syncEmuCoreField();
}

// Câmpul de core are sens doar când emulatorul efectiv e RetroArch
function syncEmuCoreField() {
  const game = editingGameId ? games.find((g) => g.id === editingGameId) : null;
  const field = document.getElementById("emu-core-field");
  if (!field || !game) return;
  const chosen = document.getElementById("select-game-emulator")?.value || emuSystemInfo(game.system)?.emulator;
  field.classList.toggle("hidden", chosen !== "retroarch");
}
document.getElementById("select-game-emulator")?.addEventListener("change", syncEmuCoreField);

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

  const btnExportProfile = document.getElementById("btn-export-game-profile");
  if (btnExportProfile) {
    btnExportProfile.classList.toggle("hidden", !game);
  }

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

  applyEnvVarsToModal(envs);
  applyGamescopeToModal(game ? game.gamescope : null);
  applyEmulationToModal(game);

  openModalAnimated("game-modal");
  if (window.lucide) window.lucide.createIcons();
}

// Populează checkbox-urile, override-urile DLL și variabilele de mediu din modal pe baza unui
// obiect `envs` (folosit la deschiderea modalului și la importul unui profil).
function applyEnvVarsToModal(envs) {
  const chkDxvk = document.getElementById("chk-dxvk");
  if (chkDxvk) chkDxvk.checked = envs["DXVK_ENABLE"] === "true" || envs["DXVK_ENABLED"] === "1";

  // VKD3D e activ implicit (ca în Lutris): se salvează doar dezactivarea
  const chkVkd3d = document.getElementById("chk-vkd3d");
  if (chkVkd3d) chkVkd3d.checked = envs["NEXUS_DISABLE_VKD3D"] !== "1";

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
    "DXVK_ENABLE", "DXVK_ENABLED", "NEXUS_DISABLE_VKD3D", "WINEESYNC", "WINEFSYNC",
    "WINE_FULLSCREEN_FSR", "BATTLEYE_RUNTIME", "EASY_ANTI_CHEAT_RUNTIME",
    "WINEDLLOVERRIDES", "MANGOHUD", "MANGOHUD_DLSYM", "MANGOHUD_VULKAN_DLSYM", "WINEPREFIX"
  ];

  Object.entries(envs).forEach(([k, v]) => {
    if (!ignoredKeys.includes(k)) {
      addEnvVarRow(k, v);
    }
  });
}

async function launchGame(game) {
  if (!game) return;
  const invoke = getInvoke();
  if (!invoke) return;
  // Dublu-click / A apăsat de două ori: a doua lansare pornea jocul încă o dată, iar backend-ul
  // pierdea urmărirea primei instanțe (timp de joc și „stopped” greșite)
  if (runningGames[game.id]) return;

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
    showToast(t("toast.error_generic", { err: String(err) }), "error");
  }
}

// Oprire forțată: un eșec (proces deja închis, kill refuzat) nu mai rămâne o promisiune respinsă
async function stopGameProcess(game) {
  const invoke = getInvoke();
  if (!invoke || !game) return;
  try {
    await invoke("kill_game_process", { gameId: game.id });
    showToast(t("toast.force_stop", { title: game.title }), "info");
  } catch (err) {
    // Backend-ul a emis oricum „stopped”, deci UI-ul se aduce singur în starea corectă
    showToast(t("toast.error_generic", { err: String(err) }), "error");
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

// Taburile bibliotecii din Big Picture (LB / RB, Q / E)
const BP_LIBRARY_TABS = ["installed", "favorites", "steam", "epic", "gog", "emulator"];

// Emulare în Big Picture, pe 2 niveluri: întâi sistemele, apoi jocurile sistemului ales
let bpEmuSystem = null; // null = nivelul sistemelor
let bpEmuSystemIdx = 0; // poziția sistemului în carusel, pentru întoarcere

function isBpEmuSystemEntry(game) {
  return !!game?.__emuSystem;
}

// Câte o „intrare” de carusel pentru fiecare sistem cu jocuri
function getBpEmuSystemEntries(pool) {
  const bySystem = new Map();
  pool.forEach((g) => {
    if (!bySystem.has(g.system)) bySystem.set(g.system, []);
    bySystem.get(g.system).push(g);
  });
  return [...bySystem.entries()]
    .sort((a, b) => emuSystemName(a[0]).localeCompare(emuSystemName(b[0])))
    .map(([sys, list]) => ({
      id: `__emusys_${sys}`,
      __emuSystem: sys,
      title: emuSystemName(sys),
      system: sys,
      source: "emulator",
      is_installed: true,
      count: list.length,
      playtime_minutes: list.reduce((sum, g) => sum + (g.playtime_minutes || 0), 0),
      sampleCover: list.find((g) => g.cover_url)?.cover_url || ""
    }));
}

// Steam / Epic / GOG pe 2 niveluri: nivelul 1 = jocurile instalate + cardul „Neinstalate”,
// nivelul 2 = jocurile neinstalate. Un joc instalat trece singur pe nivelul 1 (filtrarea e dinamică).
const BP_STORE_TABS = ["steam", "epic", "gog"];
let bpStoreUninstalled = false; // true = nivelul 2
let bpStoreReturnIdx = 0;

function isBpStoreLibraryEntry(game) {
  return !!game?.__storeLibrary;
}

// Intrările „virtuale” din carusel (sisteme, cardul de neinstalate): nu sunt jocuri
function isBpPseudoEntry(game) {
  return isBpEmuSystemEntry(game) || isBpStoreLibraryEntry(game);
}

function getBpStoreLibraryEntry(uninstalled) {
  return {
    id: `__store_${bpTab}`,
    __storeLibrary: true,
    title: t("bp.store.uninstalled"),
    source: bpTab,
    is_installed: true,
    count: uninstalled.length,
    covers: uninstalled.filter((g) => g.cover_url).slice(0, 4).map((g) => g.cover_url)
  };
}

function enterBpStoreLibrary() {
  bpStoreReturnIdx = bpIndex;
  bpStoreUninstalled = true;
  bpIndex = 0;
  renderBigPicture();
}

function setBpTab(tab) {
  bpTab = tab;
  bpIndex = 0;
  bpEmuSystem = null;
  bpStoreUninstalled = false;
  updateBpTabUi();
  renderBigPicture();
}

function cycleBpTab(dir) {
  const idx = BP_LIBRARY_TABS.indexOf(bpTab);
  setBpTab(BP_LIBRARY_TABS[(idx + dir + BP_LIBRARY_TABS.length) % BP_LIBRARY_TABS.length]);
}

function enterBpEmuSystem(systemId) {
  bpEmuSystemIdx = bpIndex;
  bpEmuSystem = systemId;
  bpIndex = 0;
  renderBigPicture();
}

// B / Escape pe nivelul 2: înapoi la nivelul 1. Întoarce true dacă a tratat apăsarea.
function bpLevelBack() {
  if (bpSearchQuery.trim() !== "") return false;
  if (bpTab === "emulator" && bpEmuSystem) {
    bpEmuSystem = null;
    bpIndex = bpEmuSystemIdx;
  } else if (BP_STORE_TABS.includes(bpTab) && bpStoreUninstalled) {
    bpStoreUninstalled = false;
    bpIndex = bpStoreReturnIdx;
  } else {
    return false;
  }
  renderBigPicture();
  return true;
}

// A / Enter / butonul principal: intră în sistem, pornește jocul sau deschide detaliile
function bpActivate(game) {
  if (!game) return;
  if (isBpEmuSystemEntry(game)) {
    enterBpEmuSystem(game.__emuSystem);
  } else if (isBpStoreLibraryEntry(game)) {
    enterBpStoreLibrary();
  } else if (checkInstalled(game)) {
    launchGame(game);
  } else {
    openBpGameDetails(game);
  }
}

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
  } else if (bpTab === "emulator") {
    bpGames = bpGames.filter((g) => isEmulatedGame(g) && g.is_installed !== false);
    bpGames.sort((a, b) => a.title.localeCompare(b.title));
    // Cu o căutare activă se caută direct în toate jocurile emulate (fără nivelul sistemelor)
    if (bpSearchQuery.trim() === "") {
      if (bpEmuSystem) {
        const inSystem = bpGames.filter((g) => g.system === bpEmuSystem);
        if (inSystem.length > 0) return clampBpIndex(inSystem);
        bpEmuSystem = null; // sistemul nu mai are jocuri (ROM-uri șterse): înapoi la sisteme
      }
      return clampBpIndex(getBpEmuSystemEntries(bpGames));
    }
  } else if (["steam", "epic", "gog", "lutris"].includes(bpTab)) {
    bpGames = bpGames.filter(g => getSourceTag(g).toLowerCase() === bpTab);

    if (BP_STORE_TABS.includes(bpTab) && bpSearchQuery.trim() === "") {
      const byTitle = (a, b) => a.title.localeCompare(b.title);
      // Jocurile în curs de instalare rămân pe nivelul 2 până se termină instalarea
      const installed = bpGames.filter(checkInstalled).sort(byTitle);
      const uninstalled = bpGames.filter((g) => !checkInstalled(g)).sort(byTitle);
      if (bpStoreUninstalled) {
        if (uninstalled.length > 0) return clampBpIndex(uninstalled);
        bpStoreUninstalled = false; // totul s-a instalat: înapoi pe nivelul 1
        bpIndex = Math.max(0, installed.length - 1);
      }
      if (uninstalled.length > 0) installed.push(getBpStoreLibraryEntry(uninstalled));
      return clampBpIndex(installed);
    }

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

  // Filtrare în timp real după search-ul din Big Picture
  if (bpSearchQuery.trim() !== "") {
    const q = bpSearchQuery.trim().toLowerCase();
    bpGames = bpGames.filter(
      (g) =>
      g.title.toLowerCase().includes(q) ||
      (g.source && g.source.toLowerCase().includes(q)) ||
      (Array.isArray(g.tags) && g.tags.some((tag) => tag.toLowerCase().includes(q)))
    );
  }

  return clampBpIndex(bpGames);
}

function clampBpIndex(list) {
  if (bpIndex >= list.length) bpIndex = 0;
  return list;
}

function updateBpTabUi() {
  document.querySelectorAll(".bp-nav-tab").forEach(tab => {
    if (tab.dataset.bpTab === bpTab) {
      tab.classList.add("active", "bg-indigo-600", "text-white");
      tab.classList.remove("text-slate-400");
      tab.style.color = "#ffffff";
    } else {
      tab.classList.remove("active", "bg-indigo-600", "text-white");
      tab.classList.add("text-slate-400");
      tab.style.color = "";
    }
  });
}

function updateBpHero() {
  let bpGames = getBpGamesFiltered();
  if (!bpGames.length || bpIndex >= bpGames.length) return;

  const game = bpGames[bpIndex];
  if (isBpEmuSystemEntry(game)) {
    updateBpHeroForSystem(game);
    return;
  }
  if (isBpStoreLibraryEntry(game)) {
    updateBpHeroForStoreLibrary(game);
    return;
  }
  const heroTitle = document.getElementById("bp-hero-title");
  const heroRunner = document.getElementById("bp-hero-runner");
  const heroPlaytime = document.getElementById("bp-hero-playtime");
  const heroDesc = document.getElementById("bp-hero-desc");
  const bgAmbient = document.getElementById("bp-ambient-bg");
  const playBtn = document.getElementById("bp-btn-play");

  if (heroTitle) {
    heroTitle.textContent = game.title;
    heroTitle.style.fontSize = "";
  }

  if (heroRunner) {
    const sourceTag = getSourceTag(game);
    heroRunner.textContent = isEmulatedGame(game)
      ? `${emuSystemShort(game.system)} · ${getGameRunnerLabel(game)}`
      : sourceTag;
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

  if (heroDesc && isEmulatedGame(game)) {
    heroDesc.textContent = t("bp.emu.game_desc");
  } else if (heroDesc) {
    heroDesc.textContent = game.launch_args
    ? t("bp.args_desc", { args: game.launch_args })
    : t("bp.ready_desc");
  }

  if (bgAmbient) {
    const cover = game.banner_url || game.cover_url || "https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=1200&q=80";
    if (!bgAmbient.style.backgroundImage.includes(cover)) {
      bgAmbient.style.backgroundImage = `url(${JSON.stringify(cover)})`;
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

  updateBpBreadcrumb();
  if (window.lucide) window.lucide.createIcons();
}

// Eroul pentru un sistem (nivelul 1 din Emulare)
function updateBpHeroForSystem(entry) {
  const info = emuSystemInfo(entry.__emuSystem);
  const heroTitle = document.getElementById("bp-hero-title");
  const heroRunner = document.getElementById("bp-hero-runner");
  const heroPlaytime = document.getElementById("bp-hero-playtime");
  const heroDesc = document.getElementById("bp-hero-desc");
  const bgAmbient = document.getElementById("bp-ambient-bg");
  const playBtn = document.getElementById("bp-btn-play");

  if (heroTitle) {
    heroTitle.textContent = entry.title;
    // Numele lungi („Sega Mega Drive / Genesis”) ar împinge caruselul în afara ecranului
    heroTitle.style.fontSize = entry.title.length > 18 ? "clamp(2.25rem, 4.5vw, 3.75rem)" : "";
  }
  if (heroRunner) {
    heroRunner.textContent = info?.emulator
      ? `${emuSystemShort(entry.__emuSystem)} · ${emuEmulatorName(info.emulator)}`
      : emuSystemShort(entry.__emuSystem);
    heroRunner.className = `px-4 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider bg-slate-950/80 border ${getSourceBadgeClass("EMULATOR")}`;
  }
  if (heroPlaytime) {
    const pt = formatPlaytime(entry.playtime_minutes);
    heroPlaytime.className = "text-sm text-slate-300 font-medium flex items-center gap-1.5 bg-slate-900/80 px-4 py-1.5 rounded-lg border border-slate-800";
    heroPlaytime.innerHTML = `<i data-lucide="gamepad-2" class="w-4 h-4 text-cyan-400"></i> ${escapeHtml(t("sidebar.games_count", { count: entry.count }))}${
      pt ? ` <span class="text-slate-500">·</span> <i data-lucide="clock" class="w-4 h-4 text-cyan-400"></i> ${pt}` : ""}`;
  }
  if (heroDesc) heroDesc.textContent = t("bp.emu.system_desc");
  if (bgAmbient) {
    const cover = entry.sampleCover || "https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=1200&q=80";
    if (!bgAmbient.style.backgroundImage.includes(cover)) {
      bgAmbient.style.backgroundImage = `url(${JSON.stringify(cover)})`;
    }
  }
  if (playBtn) {
    playBtn.innerHTML = `<i data-lucide="layout-grid" class="w-6 h-6"></i><span>${escapeHtml(t("bp.emu.open_system"))}</span>`;
    playBtn.className = "px-10 py-4 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-base flex items-center gap-3 shadow-xl shadow-emerald-500/25 transform hover:scale-105 transition";
  }
  updateBpBreadcrumb();
  if (window.lucide) window.lucide.createIcons();
}

// Eroul pentru cardul „Neinstalate” (nivelul 1 din Steam / Epic / GOG)
function updateBpHeroForStoreLibrary(entry) {
  const heroTitle = document.getElementById("bp-hero-title");
  const heroRunner = document.getElementById("bp-hero-runner");
  const heroPlaytime = document.getElementById("bp-hero-playtime");
  const heroDesc = document.getElementById("bp-hero-desc");
  const bgAmbient = document.getElementById("bp-ambient-bg");
  const playBtn = document.getElementById("bp-btn-play");

  if (heroTitle) {
    heroTitle.textContent = entry.title;
    heroTitle.style.fontSize = "";
  }
  if (heroRunner) {
    const tag = entry.source.toUpperCase();
    heroRunner.textContent = t(`bp.tab.${entry.source}`);
    heroRunner.className = `px-4 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider bg-slate-950/80 border ${getSourceBadgeClass(tag)}`;
  }
  if (heroPlaytime) {
    heroPlaytime.className = "text-sm text-slate-300 font-medium flex items-center gap-1.5 bg-slate-900/80 px-4 py-1.5 rounded-lg border border-slate-800";
    heroPlaytime.innerHTML = `<i data-lucide="cloud" class="w-4 h-4 text-cyan-400"></i> ${escapeHtml(t("sidebar.games_count", { count: entry.count }))}`;
  }
  if (heroDesc) heroDesc.textContent = t("bp.store.library_desc");
  if (bgAmbient && entry.covers[0] && !bgAmbient.style.backgroundImage.includes(entry.covers[0])) {
    bgAmbient.style.backgroundImage = `url(${JSON.stringify(entry.covers[0])})`;
  }
  if (playBtn) {
    playBtn.innerHTML = `<i data-lucide="layout-grid" class="w-6 h-6"></i><span>${escapeHtml(t("bp.emu.open_system"))}</span>`;
    playBtn.className = "px-10 py-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-white border border-slate-700 font-black text-base flex items-center gap-3 shadow-xl transform hover:scale-105 transition";
  }
  updateBpBreadcrumb();
  if (window.lucide) window.lucide.createIcons();
}

// „Emulare › PlayStation” deasupra eroului, ca să fie clar pe ce nivel ești și că B te întoarce
function updateBpBreadcrumb() {
  let el = document.getElementById("bp-emu-breadcrumb");
  const heroTitle = document.getElementById("bp-hero-title");
  if (!el && heroTitle?.parentElement) {
    el = document.createElement("div");
    el.id = "bp-emu-breadcrumb";
    el.className = "text-xs font-black uppercase tracking-widest mb-2 flex items-center gap-2";
    el.style.color = "var(--nd-text-secondary)";
    heroTitle.parentElement.insertBefore(el, heroTitle);
  }
  if (!el) return;
  const storeLevel2 = BP_STORE_TABS.includes(bpTab) && bpStoreUninstalled;
  if ((bpTab !== "emulator" && !storeLevel2) || bpSearchQuery.trim() !== "") {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  if (storeLevel2) {
    el.innerHTML = `<span>${escapeHtml(t(`bp.tab.${bpTab}`))}</span><span style="color: var(--nd-accent)">›</span><span style="color: var(--nd-accent)">${escapeHtml(t("bp.store.uninstalled"))}</span>
       <span class="ml-3 px-2 py-0.5 rounded-md border text-[10px] tracking-wider" style="border-color: var(--nd-border)">B · ${escapeHtml(t("bp.store.back_installed"))}</span>`;
    return;
  }
  el.innerHTML = bpEmuSystem
    ? `<span>${escapeHtml(t("sidebar.emulation"))}</span><span style="color: var(--nd-accent)">›</span><span style="color: var(--nd-accent)">${escapeHtml(emuSystemName(bpEmuSystem))}</span>
       <span class="ml-3 px-2 py-0.5 rounded-md border text-[10px] tracking-wider" style="border-color: var(--nd-border)">B · ${escapeHtml(t("bp.emu.back_systems"))}</span>`
    : `<span style="color: var(--nd-accent)">${escapeHtml(t("sidebar.emulation"))}</span><span>›</span><span>${escapeHtml(t("bp.emu.choose_system"))}</span>`;
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

// Cardul „Neinstalate”: un mozaic cu copertele câtorva jocuri neinstalate
function createBpStoreLibraryCard(entry, idx) {
  const card = document.createElement("div");
  card.className = `shrink-0 w-72 rounded-3xl glass-card cursor-pointer border-2 overflow-hidden transition-transform duration-150 transform-gpu ${
    idx === bpIndex ? "bp-focused ring-4 ring-purple-500 scale-105" : "border-slate-800/80 opacity-60 hover:opacity-100"
  }`;
  const tiles = entry.covers.map((c) =>
    `<div class="bg-cover bg-center" style="background-image: url(${escapeHtml(JSON.stringify(c))}); filter: grayscale(1) brightness(0.55);"></div>`).join("");
  card.innerHTML = `
  <div class="aspect-[3/4] relative overflow-hidden rounded-t-3xl" style="background: var(--nd-bg-secondary, #0f172a);">
    <div class="absolute inset-0" style="display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;">${tiles}</div>
    <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center" style="background: rgba(2,6,23,0.35);">
      <i data-lucide="download-cloud" class="w-14 h-14" style="color: var(--nd-accent)"></i>
      <span class="font-black text-white drop-shadow-lg" style="font-size: 3rem; line-height: 1;">${entry.count}</span>
    </div>
    <div class="absolute inset-0 bg-gradient-to-t from-slate-950 via-transparent to-transparent"></div>
  </div>
  <div class="p-4 bg-slate-900/90 rounded-b-3xl">
    <h4 class="font-extrabold text-lg text-white truncate">${escapeHtml(entry.title)}</h4>
    <span class="text-xs font-black uppercase tracking-wider" style="color: var(--nd-accent)">${escapeHtml(t("bp.store.library_card"))}</span>
  </div>`;
  card.addEventListener("click", () => {
    if (idx === bpIndex) enterBpStoreLibrary();
    else moveBpFocus(idx);
  });
  return card;
}

// Cardul unui sistem în carusel: prescurtarea mare peste coperta unui joc, estompată
function createBpSystemCard(entry, idx) {
  const card = document.createElement("div");
  card.className = `shrink-0 w-72 rounded-3xl glass-card cursor-pointer border-2 overflow-hidden transition-transform duration-150 transform-gpu ${
    idx === bpIndex ? "bp-focused ring-4 ring-purple-500 scale-105" : "border-slate-800/80 opacity-60 hover:opacity-100"
  }`;
  const cover = entry.sampleCover
    ? `<div class="absolute inset-0 bg-cover bg-center" style="background-image: url(${escapeHtml(JSON.stringify(entry.sampleCover))}); filter: blur(6px) brightness(0.45); transform: scale(1.15);"></div>`
    : "";
  card.innerHTML = `
  <div class="aspect-[3/4] relative overflow-hidden rounded-t-3xl" style="background: radial-gradient(circle at 50% 35%, rgba(var(--nd-accent-rgb), 0.35), var(--nd-bg-secondary, #0f172a) 70%);">
    ${cover}
    <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center">
      <i data-lucide="joystick" class="w-12 h-12" style="color: var(--nd-accent)"></i>
      <span class="font-black tracking-tight text-white drop-shadow-lg" style="font-size: 3.25rem; line-height: 1;">${escapeHtml(emuSystemShort(entry.__emuSystem))}</span>
    </div>
    <div class="absolute inset-0 bg-gradient-to-t from-slate-950 via-transparent to-transparent"></div>
  </div>
  <div class="p-4 bg-slate-900/90 rounded-b-3xl">
    <h4 class="font-extrabold text-lg text-white truncate">${escapeHtml(entry.title)}</h4>
    <span class="text-xs font-black uppercase tracking-wider" style="color: var(--nd-accent)">${escapeHtml(t("sidebar.games_count", { count: entry.count }))}</span>
  </div>`;
  card.addEventListener("click", () => {
    // Primul click selectează, al doilea (pe cardul deja selectat) intră în sistem
    if (idx === bpIndex) enterBpEmuSystem(entry.__emuSystem);
    else moveBpFocus(idx);
  });
  return card;
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
    : bpTab === "emulator"
    ? t("bp.emu.empty_desc")
    : t("bp.no_games_desc");
    updateBpBreadcrumb();

    if (playBtn) playBtn.classList.add("hidden");
    if (heroStatus) heroStatus.classList.add("hidden");
    return;
  }

  if (playBtn) playBtn.classList.remove("hidden");
  if (heroStatus) heroStatus.classList.remove("hidden");

  if (bpIndex >= bpGames.length) bpIndex = 0;

  const fragment = document.createDocumentFragment();

  bpGames.forEach((game, idx) => {
    if (isBpEmuSystemEntry(game)) {
      fragment.appendChild(createBpSystemCard(game, idx));
      return;
    }
    if (isBpStoreLibraryEntry(game)) {
      fragment.appendChild(createBpStoreLibraryCard(game, idx));
      return;
    }
    const isInst = checkInstalled(game);

    const card = document.createElement("div");
    card.className = `shrink-0 w-72 rounded-3xl glass-card cursor-pointer border-2 overflow-hidden transition-transform duration-150 transform-gpu ${
      idx === bpIndex ? "bp-focused ring-4 ring-purple-500 scale-105" : "border-slate-800/80 opacity-60 hover:opacity-100"
    }`;

    const coverImg = game.cover_url || "";
    const sourceTag = getSourceTag(game);
    const badgeTextColor = getSourceBadgeClass(sourceTag).split(' ')[0];

    const imgElement = coverImg
    ? `<img src="${escapeHtml(coverImg)}" loading="lazy" decoding="async" class="w-full h-full object-cover transition-all duration-300 ${!isInst ? 'grayscale opacity-75' : ''}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">`
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
    <span class="text-xs font-black uppercase tracking-wider ${badgeTextColor}">${escapeHtml(getSourceBadgeText(game))}</span>
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
  // Jocurile emulate n-au dezinstalare: ROM-ul se șterge din folderul lui
  if (isInst && !isEmulatedGame(game)) {
    items.push({ id: "uninstall", label: t("bp.opt.uninstall"), danger: true });
  }
  items.push({ id: "remove", label: t("bp.opt.remove"), danger: true });

  // Acțiunea distructivă „armată” de prima apăsare cere a doua apăsare pe același rând
  const armed = bpMenuState.armed;
  items.forEach((item, idx) => {
    if (armed && armed.gameId === game.id && armed.id === item.id && bpMenuState.manageIdx === idx) {
      item.label = `${item.label} — ${t("bp.opt.confirm_again")}`;
    }
  });
  return items;
}

// true dacă acțiunea poate rula acum; altfel o „armează” și cere încă o apăsare.
// (Un confirm() nativ nu poate fi apăsat cu gamepad-ul, iar o singură apăsare greșită pe A
// ștergea fișierele jocului.)
function bpDangerConfirmed(game, actionId) {
  const armed = bpMenuState.armed;
  if (armed && armed.gameId === game.id && armed.id === actionId && armed.idx === bpMenuState.manageIdx) {
    bpMenuState.armed = null;
    return true;
  }
  bpMenuState.armed = { gameId: game.id, id: actionId, idx: bpMenuState.manageIdx };
  renderBpGameDetails();
  return false;
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
    <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-slate-800 text-white">
    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
    </span>
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
  if (optLabelEl) {
    optLabelEl.textContent = t("bp.opt.title");
    optLabelEl.style.color = "var(--nd-accent)";
  }
  if (hintNavEl) hintNavEl.textContent = t("bp.hint.nav");
  if (hintSelEl) hintSelEl.textContent = t("bp.hint.select");
  if (hintBackEl) hintBackEl.textContent = t("bp.hint.back");

  const titleEl = document.getElementById("bp-details-game-title");
  const crumbEl = document.getElementById("bp-details-breadcrumb");
  const mainList = document.getElementById("bp-details-main-list");
  const manageList = document.getElementById("bp-details-manage-list");

  if (titleEl) {
    titleEl.textContent = game.title;
    titleEl.style.color = "var(--nd-text-primary)";
  }
  if (crumbEl) {
    crumbEl.textContent = bpMenuState.focusCol === "manage" ? t("bp.opt.breadcrumb_manage") : t("bp.opt.breadcrumb");
    crumbEl.style.backgroundColor = "var(--nd-bg-secondary)";
    crumbEl.style.borderColor = "var(--nd-border)";
    crumbEl.style.color = "var(--nd-text-secondary)";
  }

  const focusGradientStyle = `style="background: linear-gradient(90deg, var(--nd-accent) 0%, var(--nd-accent-secondary) 100%); color: #ffffff !important;"`;

  const mainItems = getBpMainMenuItems(game);
  mainList.innerHTML = mainItems.map((item, idx) => {
    const isFocused = bpMenuState.focusCol === "main" && bpMenuState.mainIdx === idx;
    const isActiveParent = bpMenuState.focusCol === "manage" && item.id === "manage";
    const rowCls = isFocused
    ? "bp-opt-focused text-white font-extrabold shadow-lg"
    : isActiveParent
    ? "font-bold"
    : item.danger
    ? "text-rose-500 font-semibold"
    : "font-semibold";

    const inactiveStyle = isActiveParent
    ? `style="background: rgba(var(--nd-accent-rgb), 0.18); color: var(--nd-accent);"`
    : "";

    return `
    <button type="button" data-bp-main-idx="${idx}" ${isFocused ? focusGradientStyle : inactiveStyle}
    class="w-full px-6 py-4 text-left text-lg flex items-center justify-between border-b transition-colors ${rowCls}">
    <span class="flex items-center gap-3.5">
    ${item.icon ? `<span class="w-6 text-center text-xl font-bold" style="color: ${isFocused ? "#ffffff" : "var(--nd-accent)"};">${item.icon}</span>` : ""}
    <span>${item.label}</span>
    </span>
    ${item.hasSubmenu ? `<span class="text-xl font-bold" style="color: ${isFocused ? "#ffffff" : "var(--nd-text-secondary)"};">›</span>` : ""}
    </button>
    `;
  }).join("");

  if (bpMenuState.focusCol === "manage") {
    const manageItems = getBpManageSubmenuItems(game);
    manageList.classList.remove("hidden");
    manageList.innerHTML = manageItems.map((item, idx) => {
      const isFocused = bpMenuState.manageIdx === idx;
      const rowCls = isFocused
      ? "bp-opt-focused text-white font-extrabold shadow-lg"
      : item.danger
      ? "text-rose-500 font-semibold"
      : "font-semibold";
      return `
      <button type="button" data-bp-manage-idx="${idx}" ${isFocused ? focusGradientStyle : ""}
      class="w-full px-6 py-4 text-left text-lg flex items-center justify-between border-b transition-colors ${rowCls}">
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
          })
          .catch((err) => showToast(t("toast.error_generic", { err: String(err) }), "error"));
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
      if (!bpDangerConfirmed(game, "uninstall")) return;
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
      if (!bpDangerConfirmed(game, "remove")) return;
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
      vkd3d: envs["NEXUS_DISABLE_VKD3D"] !== "1",
      esync: envs["WINEESYNC"] === "1",
      fsync: envs["WINEFSYNC"] === "1",
      fsr: envs["WINE_FULLSCREEN_FSR"] === "1",
      battleye: envs["BATTLEYE_RUNTIME"] === "1",
      eac: envs["EASY_ANTI_CHEAT_RUNTIME"] === "1",
      launch_args: game.launch_args || "",
      emulator: game.emulator || "",
      core: game.core || ""
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

// Opțiunile ciclabile pentru jocurile emulate: emulatorul („” = implicitul sistemului) și core-ul RetroArch
function getBpEmuCycleOptions(key) {
  const sys = emuSystemInfo(bpPropsState.game?.system);
  if (key === "emulator") return ["", ...(sys?.available_emulators || [])];
  if (key === "core") return ["", ...(sys?.cores || [])];
  return [];
}

function bpEffectiveEmulator(d) {
  return d.emulator || emuSystemInfo(bpPropsState.game?.system)?.emulator || "";
}

function getBpPropertyRows() {
  const d = bpPropsState.draft;
  if (isEmulatedGame(bpPropsState.game)) {
    const sys = emuSystemInfo(bpPropsState.game.system);
    const emuText = d.emulator
      ? emuEmulatorName(d.emulator)
      : t("emu.default_option", { name: sys?.emulator ? emuEmulatorName(sys.emulator) : t("emu.none") });
    const rows = [{ key: "emulator", type: "cycle", label: t("emu.emulator"), valueText: `‹  ${emuText}  ›` }];
    if (bpEffectiveEmulator(d) === "retroarch") {
      const coreText = d.core || t("emu.default_option", { name: sys?.cores?.[0] || t("emu.none") });
      rows.push({ key: "core", type: "cycle", label: t("emu.core"), valueText: `‹  ${coreText}  ›` });
    }
    if (!isWindows) {
      rows.push({ key: "use_gamemode", type: "toggle", label: t("modal.game.gamemode"), value: d.use_gamemode });
      rows.push({ key: "use_mangohud", type: "toggle", label: t("modal.game.mangohud"), value: d.use_mangohud });
    }
    rows.push({ key: "save", type: "action", label: t("bp.props.save") });
    return rows;
  }
  const runnerObj = availableRunners.find(r => r.path === d.runner_path);
  const runnerLabel = runnerObj ? runnerObj.name : getRunnerDisplayName(d.runner_path);

  const rows = [
    { key: "runner_path", type: "cycle", label: t("modal.game.runner"), valueText: `‹  ${runnerLabel}  ›` },
    { key: "use_gamemode", type: "toggle", label: t("modal.game.gamemode"), value: d.use_gamemode },
    { key: "use_mangohud", type: "toggle", label: t("modal.game.mangohud"), value: d.use_mangohud },
    { key: "dxvk", type: "toggle", label: t("bp.props.dxvk"), value: d.dxvk },
    { key: "vkd3d", type: "toggle", label: t("bp.props.vkd3d"), value: d.vkd3d },
    { key: "esync", type: "toggle", label: t("bp.props.esync"), value: d.esync },
    { key: "fsync", type: "toggle", label: t("bp.props.fsync"), value: d.fsync },
    { key: "fsr", type: "toggle", label: t("bp.props.fsr"), value: d.fsr },
    { key: "battleye", type: "toggle", label: t("bp.props.battleye"), value: d.battleye },
    { key: "eac", type: "toggle", label: t("bp.props.eac"), value: d.eac },
    { key: "launch_args", type: "info", label: t("modal.game.args"), valueText: d.launch_args || t("bp.props.none") },
    { key: "save", type: "action", label: t("bp.props.save") }
  ];
  // Pe Windows jocurile rulează nativ: runner-ul și ajustările Wine nu au sens
  return isWindows ? rows.filter((r) => r.key === "launch_args" || r.key === "save") : rows;
}

function renderBpProperties() {
  if (!bpPropsState.open) return;
  const list = document.getElementById("bp-props-list");
  if (!list) return;

  const badgeEl = document.getElementById("bp-props-badge");
  const titleEl = document.getElementById("bp-props-title");
  const sourceEl = document.getElementById("bp-props-source");
  const hintRunEl = document.getElementById("bp-props-hint-runner");
  const hintTogEl = document.getElementById("bp-props-hint-toggle");
  const hintBackEl = document.getElementById("bp-props-hint-back");

  if (badgeEl) {
    badgeEl.textContent = t("bp.props.title");
    badgeEl.style.backgroundColor = "rgba(var(--nd-accent-rgb), 0.18)";
    badgeEl.style.borderColor = "rgba(var(--nd-accent-rgb), 0.4)";
    badgeEl.style.color = "var(--nd-accent)";
  }
  if (titleEl) titleEl.style.color = "var(--nd-text-primary)";
  if (sourceEl) sourceEl.style.color = "var(--nd-text-secondary)";
  if (hintRunEl) hintRunEl.textContent = t("bp.hint.change_runner");
  if (hintTogEl) hintTogEl.textContent = t("bp.hint.toggle_apply");
  if (hintBackEl) hintBackEl.textContent = t("bp.hint.back");

  const focusGradientStyle = `style="background: linear-gradient(90deg, var(--nd-accent) 0%, var(--nd-accent-secondary) 100%); color: #ffffff !important; border-color: var(--nd-accent) !important;"`;
  const rows = getBpPropertyRows();

  list.innerHTML = rows.map((row, idx) => {
    const isFocused = idx === bpPropsState.focusIdx;

    if (row.type === "action") {
      const inactiveActionStyle = `style="background: rgba(var(--nd-accent-rgb), 0.16); color: var(--nd-accent); border-color: rgba(var(--nd-accent-rgb), 0.4);"`;
      return `
      <div data-bp-prop-idx="${idx}" ${isFocused ? focusGradientStyle : inactiveActionStyle}
      class="mt-6 px-6 py-4 rounded-xl text-center font-black text-lg tracking-wide cursor-pointer transition border">
      ${row.label}
      </div>
      `;
    }

    const inactiveRowStyle = `style="background: var(--nd-bg-secondary); color: var(--nd-text-primary); border-color: var(--nd-border);"`;

    let rightControl = "";
    if (row.type === "toggle") {
      rightControl = row.value
      ? `<span class="px-4 py-1.5 rounded-full text-sm font-black bg-emerald-500/20 text-emerald-500 border border-emerald-500/40" style="${isFocused ? "background: rgba(0,0,0,0.35); color: #6ee7b7;" : ""}">${t("bp.props.on")}</span>`
      : `<span class="px-4 py-1.5 rounded-full text-sm font-black" style="${isFocused ? "background: rgba(0,0,0,0.28); color: #ffffff;" : "background: var(--nd-bg-primary); color: var(--nd-text-secondary);"}">${t("bp.props.off")}</span>`;
    } else {
      rightControl = `<span class="text-base font-mono font-bold" style="color: ${isFocused ? "#ffffff" : "var(--nd-accent)"};">${escapeHtml(row.valueText)}</span>`;
    }

    return `
    <div data-bp-prop-idx="${idx}" ${isFocused ? focusGradientStyle : inactiveRowStyle}
    class="px-6 py-4 rounded-xl flex items-center justify-between gap-4 cursor-pointer transition-colors border ${isFocused ? "font-extrabold shadow-xl" : "font-semibold"}">
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
  const row = getBpPropertyRows()[bpPropsState.focusIdx];
  if (row && (row.key === "emulator" || row.key === "core")) {
    const opts = getBpEmuCycleOptions(row.key);
    if (opts.length === 0) return;
    const cur = Math.max(0, opts.indexOf(bpPropsState.draft[row.key]));
    bpPropsState.draft[row.key] = opts[(cur + dir + opts.length) % opts.length];
    // Rândul de core apare / dispare după emulator: focusul rămâne pe rândul curent
    renderBpProperties();
    return;
  }
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
    if (isEmulatedGame(g)) {
      if (d.emulator) g.emulator = d.emulator; else delete g.emulator;
      if (d.core && bpEffectiveEmulator(d) === "retroarch") g.core = d.core; else delete g.core;
      g.use_gamemode = d.use_gamemode;
      g.use_mangohud = d.use_mangohud;
      await saveGamesToDisk();
      renderGames();
      renderBigPicture();
      closeBpPropertiesModal();
      showToast(t("toast.settings_saved", { title: g.title }), "success");
      return;
    }
    g.runner_path = d.runner_path;
    g.use_gamemode = d.use_gamemode;
    g.use_mangohud = d.use_mangohud;
    g.launch_args = d.launch_args;

    const nextEnv = { ...(g.env_vars || {}) };
    if (d.dxvk) nextEnv["DXVK_ENABLE"] = "true"; else { delete nextEnv["DXVK_ENABLE"]; delete nextEnv["DXVK_ENABLED"]; }
    if (d.vkd3d) delete nextEnv["NEXUS_DISABLE_VKD3D"]; else nextEnv["NEXUS_DISABLE_VKD3D"] = "1";
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

// =========================================================
// BIG PICTURE SEARCH & ON-SCREEN KEYBOARD (OSK)
// =========================================================
let bpSearchQuery = "";
let isBpOskOpen = false;

function initBigPictureSearchOSK() {
  const overlay = document.getElementById("bp-osk-overlay");
  const input = document.getElementById("bp-osk-input");
  const keysContainer = document.getElementById("bp-osk-keys");
  const triggerBtn = document.getElementById("bp-search-bar-trigger");
  const displaySpan = document.getElementById("bp-search-display");
  const clearBadge = document.getElementById("bp-search-clear-badge");
  const clearBtn = document.getElementById("bp-osk-clear");
  const doneBtn = document.getElementById("bp-osk-done");
  const footerBtnY = document.getElementById("bp-btn-y");

  if (!overlay || !input || !keysContainer) return;

  const ROWS = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "⌫"],
    ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
    ["A", "S", "D", "F", "G", "H", "J", "K", "L", "-"],
    ["Z", "X", "C", "V", "B", "N", "M", ":", "'"],
    ["SPACE", "CLEAR", "DONE"]
  ];

  let focusRow = 1;
  let focusCol = 0;
  function syncBpSearchUI() {
    bpSearchQuery = input.value;
    const footerBLabel = document.querySelector("#bp-btn-b span:last-child");

    if (displaySpan) {
      if (bpSearchQuery.trim()) {
        displaySpan.textContent = bpSearchQuery;
        displaySpan.classList.remove("text-slate-400");
        displaySpan.classList.add("font-bold");
        displaySpan.style.color = "var(--nd-text-primary)";
        clearBadge?.classList.remove("hidden");
        if (footerBLabel) footerBLabel.textContent = t("bp.search.clear") || "CLEAR SEARCH";
      } else {
        displaySpan.textContent = t("bp.search.trigger") || "Search games (Y)...";
        displaySpan.classList.add("text-slate-400");
        displaySpan.classList.remove("font-bold");
        displaySpan.style.color = "";
        clearBadge?.classList.add("hidden");
        if (footerBLabel) footerBLabel.textContent = t("bp.hint.back");
      }
    }

    if (typeof renderBigPicture === "function") renderBigPicture();
  }
  function renderKeys() {
    keysContainer.innerHTML = "";
    ROWS.forEach((row, rIdx) => {
      const rowDiv = document.createElement("div");
      rowDiv.className = "flex items-center justify-center gap-2";

      row.forEach((key, cIdx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        const isFocused = rIdx === focusRow && cIdx === focusCol;

        let widthClass = "w-12 h-11";
        let colorClass = "";
        let inlineStyle = "background: var(--nd-bg-primary); color: var(--nd-text-primary); border-color: var(--nd-border);";

        if (key === "SPACE") {
          widthClass = "flex-1 max-w-xs h-11";
        } else if (key === "CLEAR") {
          widthClass = "w-28 h-11";
          colorClass = "text-rose-500";
          inlineStyle = "background: var(--nd-bg-primary); border-color: var(--nd-border);";
        } else if (key === "DONE") {
          widthClass = "w-28 h-11";
          colorClass = "bg-emerald-600 hover:bg-emerald-500 text-slate-950 border-emerald-500";
          inlineStyle = "";
        } else if (key === "⌫") {
          widthClass = "w-16 h-11";
          colorClass = "text-amber-500";
          inlineStyle = "background: var(--nd-bg-primary); border-color: var(--nd-border);";
        }

        if (isFocused) {
          colorClass = "scale-105 text-white shadow-lg";
          inlineStyle = "background: var(--nd-accent); color: #ffffff; border-color: var(--nd-accent); box-shadow: 0 0 0 2px var(--nd-accent-secondary);";
        }

        btn.className = `${widthClass} ${colorClass} rounded-xl border font-extrabold text-sm flex items-center justify-center transition`;
        if (inlineStyle) {
          btn.style.cssText = inlineStyle;
        }

        btn.textContent =
        key === "CLEAR" ? (t("bp.search.clear") || "CLEAR") :
        key === "DONE" ? (t("bp.search.done") || "DONE") :
        key;

        btn.addEventListener("click", () => {
          focusRow = rIdx;
          focusCol = cIdx;
          activateKey(key);
          renderKeys();
        });

        rowDiv.appendChild(btn);
      });

      keysContainer.appendChild(rowDiv);
    });
  }

  function activateKey(key) {
    if (key === "⌫") {
      input.value = input.value.slice(0, -1);
    } else if (key === "SPACE") {
      input.value += " ";
    } else if (key === "CLEAR") {
      input.value = "";
    } else if (key === "DONE") {
      window.closeBpOsk();
      return;
    } else {
      input.value += key.toLowerCase();
    }
    syncBpSearchUI();
  }

  window.openBpOsk = function () {
    isBpOskOpen = true;
    overlay.classList.remove("hidden");
    focusRow = 1;
    focusCol = 0;
    renderKeys();
    setTimeout(() => input.focus(), 30);
  };

  window.closeBpOsk = function () {
    isBpOskOpen = false;
    overlay.classList.add("hidden");
    input.blur();
    window.focus();
    document.body?.focus();
    // Blochează toate butoanele până sunt eliberate fizic, ca să nu declanșeze acțiuni în spate
    lastPadState = { ...PAD_ALL_PRESSED };
  };

  window.resetBpSearch = function () {
    input.value = "";
    syncBpSearchUI();
  };

  triggerBtn?.addEventListener("click", (e) => {
    if (clearBadge && (e.target === clearBadge || clearBadge.contains(e.target))) {
      e.stopPropagation();
      window.resetBpSearch();
      return;
    }
    window.openBpOsk();
  });

  footerBtnY?.addEventListener("click", () => window.openBpOsk());

  clearBtn?.addEventListener("click", () => {
    window.resetBpSearch();
    renderKeys();
  });

  doneBtn?.addEventListener("click", () => window.closeBpOsk());

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) window.closeBpOsk();
  });

    input.addEventListener("input", () => syncBpSearchUI());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        window.closeBpOsk();
      }
    });

    // Control Gamepad dedicat când tastatura virtuală este deschisă
    let lastGpState = {};
    setInterval(() => {
      if (!isBpOskOpen) return;
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const gp = Array.from(pads).find(Boolean);
      if (!gp) return;

      const up = gp.buttons[12]?.pressed || gp.axes[1] < -0.6;
      const down = gp.buttons[13]?.pressed || gp.axes[1] > 0.6;
      const left = gp.buttons[14]?.pressed || gp.axes[0] < -0.6;
      const right = gp.buttons[15]?.pressed || gp.axes[0] > 0.6;
      const btnA = gp.buttons[0]?.pressed;
      const btnB = gp.buttons[1]?.pressed;
      const btnX = gp.buttons[2]?.pressed;
      const btnY = gp.buttons[3]?.pressed;
      const btnStart = gp.buttons[9]?.pressed;

      if (up && !lastGpState.up) {
        focusRow = (focusRow - 1 + ROWS.length) % ROWS.length;
        focusCol = Math.min(focusCol, ROWS[focusRow].length - 1);
        renderKeys();
      }
      if (down && !lastGpState.down) {
        focusRow = (focusRow + 1) % ROWS.length;
        focusCol = Math.min(focusCol, ROWS[focusRow].length - 1);
        renderKeys();
      }
      if (left && !lastGpState.left) {
        focusCol = (focusCol - 1 + ROWS[focusRow].length) % ROWS[focusRow].length;
        renderKeys();
      }
      if (right && !lastGpState.right) {
        focusCol = (focusCol + 1) % ROWS[focusRow].length;
        renderKeys();
      }
      if (btnA && !lastGpState.btnA) {
        activateKey(ROWS[focusRow][focusCol]);
        renderKeys();
      }
      if (btnX && !lastGpState.btnX) {
        activateKey("⌫");
      }
      if (btnY && !lastGpState.btnY) {
        activateKey("SPACE");
      }
      if ((btnB && !lastGpState.btnB) || (btnStart && !lastGpState.btnStart)) {
        window.closeBpOsk();
      }

      lastGpState = { up, down, left, right, btnA, btnB, btnX, btnY, btnStart };
    }, 90);
}

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
let lastPadState = { left: false, right: false, up: false, down: false, btnA: false, btnB: false, btnX: false, btnY: false, lb: false, rb: false, btnMenu: false, btnSelect: false};
const PAD_ALL_PRESSED = Object.freeze({ left: true, right: true, up: true, down: true, btnA: true, btnB: true, btnX: true, btnY: true, lb: true, rb: true, btnMenu: true, btnSelect: true });

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
      const btnSelect = pad.buttons[8]?.pressed; // Butonul View (Xbox) / Select (PS)
      // Toggle Quick Settings cu View / Select în Big Picture
      if (isBigPicture && !isBpOskOpen && btnSelect && !lastPadState.btnSelect) {
        if (bpSettingsState.open) {
          closeBpSettingsDrawer();
        } else if (!bpPropsState.open && !bpMenuState.open) {
          openBpSettingsDrawer("quick");
        }
      }

      if (btnMenu && !lastPadState.btnMenu) {
        if (isBigPicture) {
          document.getElementById("btn-exit-bigpicture")?.click();
        } else {
          document.getElementById("btn-toggle-mode")?.click();
        }
      }

      if (isBigPicture && !isBpOskOpen) {
        if (bpSettingsState.open) {
          const items = getBpSettingsItemsForTab(bpSettingsState.tab);

          if (dpadUp && !lastPadState.up && items.length > 0) {
            bpSettingsState.focusZone = "items";
            bpSettingsState.itemIdx = (bpSettingsState.itemIdx - 1 + items.length) % items.length;
            renderBpSettingsDrawer();
          }
          if (dpadDown && !lastPadState.down && items.length > 0) {
            bpSettingsState.focusZone = "items";
            bpSettingsState.itemIdx = (bpSettingsState.itemIdx + 1) % items.length;
            renderBpSettingsDrawer();
          }
          if (dpadLeft && !lastPadState.left) {
            if (items[bpSettingsState.itemIdx]?.type === "slider") {
              adjustBpSettingsSlider(-5);
            } else {
              bpSettingsState.tabIdx = (bpSettingsState.tabIdx - 1 + BP_SETTINGS_TABS.length) % BP_SETTINGS_TABS.length;
              bpSettingsState.tab = BP_SETTINGS_TABS[bpSettingsState.tabIdx];
              bpSettingsState.focusZone = "items";
              bpSettingsState.itemIdx = 0;
              renderBpSettingsDrawer();
            }
          }
          if (dpadRight && !lastPadState.right) {
            if (items[bpSettingsState.itemIdx]?.type === "slider") {
              adjustBpSettingsSlider(5);
            } else {
              bpSettingsState.tabIdx = (bpSettingsState.tabIdx + 1) % BP_SETTINGS_TABS.length;
              bpSettingsState.tab = BP_SETTINGS_TABS[bpSettingsState.tabIdx];
              bpSettingsState.focusZone = "items";
              bpSettingsState.itemIdx = 0;
              renderBpSettingsDrawer();
            }
          }
          if (lb && !lastPadState.lb) {
            bpSettingsState.tabIdx = (bpSettingsState.tabIdx - 1 + BP_SETTINGS_TABS.length) % BP_SETTINGS_TABS.length;
            bpSettingsState.tab = BP_SETTINGS_TABS[bpSettingsState.tabIdx];
            bpSettingsState.focusZone = "items";
            bpSettingsState.itemIdx = 0;
            renderBpSettingsDrawer();
          }
          if (rb && !lastPadState.rb) {
            bpSettingsState.tabIdx = (bpSettingsState.tabIdx + 1) % BP_SETTINGS_TABS.length;
            bpSettingsState.tab = BP_SETTINGS_TABS[bpSettingsState.tabIdx];
            bpSettingsState.focusZone = "items";
            bpSettingsState.itemIdx = 0;
            renderBpSettingsDrawer();
          }
          if (btnA && !lastPadState.btnA) {
            activateBpSettingsItem(1);
          }
          if (btnB && !lastPadState.btnB) {
            closeBpSettingsDrawer();
          }
        } else if (bpPropsState.open) {
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

          if (dpadLeft && !lastPadState.left) { if (bpGames.length > 0) moveBpFocus(bpIndex - 1); }
          if (dpadRight && !lastPadState.right) { if (bpGames.length > 0) moveBpFocus(bpIndex + 1); }

          if (lb && !lastPadState.lb) cycleBpTab(-1);
          if (rb && !lastPadState.rb) cycleBpTab(1);

          if (btnA && !lastPadState.btnA) {
            bpActivate(bpGames[bpIndex]);
          }
          if (btnB && !lastPadState.btnB) {
            if (bpSearchQuery.trim() !== "") {
              window.resetBpSearch();
            } else if (!bpLevelBack()) {
              document.getElementById("btn-exit-bigpicture")?.click();
            }
          }
          if (btnX && !lastPadState.btnX) {
            const g = bpGames[bpIndex];
            if (g && !isBpPseudoEntry(g)) openBpGameDetails(g);
          }
          if (btnY && !lastPadState.btnY) {
            window.openBpOsk();
          }
        }
      }

      lastPadState = {
        left: dpadLeft, right: dpadRight, up: dpadUp, down: dpadDown,
        btnA, btnB, btnX, btnY, lb, rb, btnMenu, btnSelect
      };
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
      await stopGameProcess(game);
    } else {
      bpActivate(game);
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

  document.getElementById("btn-export-game-profile")?.addEventListener("click", () => {
    const game = editingGameId ? games.find(g => g.id === editingGameId) : null;
    if (game) exportGameProfile(game);
  });

    document.getElementById("btn-import-game-profile")?.addEventListener("click", () => {
      importGameProfileIntoModal();
    });

  const btnToggleAdv = document.getElementById("btn-toggle-advanced");
  const advContainer = document.getElementById("advanced-options-container");
  const advChevron = document.getElementById("advanced-chevron");

  btnToggleAdv?.addEventListener("click", () => {
    advContainer?.classList.toggle("hidden");
    advChevron?.classList.toggle("rotate-180");
  });

  document.getElementById("bp-btn-b")?.addEventListener("click", () => {
    if (bpSearchQuery.trim() !== "") {
      window.resetBpSearch();
    } else {
      document.getElementById("btn-exit-bigpicture")?.click();
    }
  });

  document.getElementById("bp-btn-x")?.addEventListener("click", () => {
    let bpGames = getBpGamesFiltered();
    if (bpGames[bpIndex]) openBpGameDetails(bpGames[bpIndex]);
  });

    document.getElementById("bp-btn-y")?.addEventListener("click", () => {
      window.openBpOsk();
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
                closeBpSettingsDrawer();
                if (typeof window.closeBpOsk === "function") window.closeBpOsk();
                if (typeof window.resetBpSearch === "function") window.resetBpSearch();
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
                        if (document.getElementById("chk-vkd3d") && !document.getElementById("chk-vkd3d").checked) {
                          env_vars["NEXUS_DISABLE_VKD3D"] = "1";
                        }
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
                        const gamescope = readGamescopeFromModal();
                        const resInput = document.getElementById("inp-gamescope-res")?.value.trim();
                        if (gamescope.enabled && resInput && !/^\d{3,5}\s*x\s*\d{3,5}$/i.test(resInput)) {
                          showToast(t("gamescope.invalid_res"), "error");
                          return;
                        }

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
                            game.gamescope = gamescope;
                            if (isEmulatedGame(game)) {
                              const emu = document.getElementById("select-game-emulator")?.value || "";
                              const core = document.getElementById("inp-game-core")?.value.trim() || "";
                              if (emu) game.emulator = emu; else delete game.emulator;
                              if (core) game.core = core; else delete game.core;
                            }
                          }
                        } else {
                          games.push({
                            id: Date.now().toString(),
                                     title, exe_path, runner_path, wine_prefix, save_path, launch_args, use_gamemode, use_mangohud,
                                     env_vars, gamescope,
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
                        tab.addEventListener("click", () => setBpTab(tab.dataset.bpTab));
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
                        updateBpGamepadLabels();
                        startGamepadLoop();
                        bpTab = "installed";
                        bpIndex = 0;
                        bpEmuSystem = null;
                        bpStoreUninstalled = false;
                        document.getElementById("desktop-mode-view")?.classList.add("hidden");
                        document.getElementById("big-picture-view")?.classList.remove("hidden");
                        updateBpTabUi();
                        renderBigPicture();
                      });

                      document.getElementById("btn-exit-bigpicture")?.addEventListener("click", () => { exitBigPicture(); });

                      window.addEventListener("keydown", async (e) => {
                        if (isBpOskOpen) return;
                        if (e.key === "Escape" && isBigPicture) {
                          e.preventDefault();
                          if (bpSettingsState.open) {
                            closeBpSettingsDrawer();
                          } else if (bpSearchQuery.trim() !== "") {
                            window.resetBpSearch();
                          } else if (!bpLevelBack()) {
                            await exitBigPicture();
                          }
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
                              const g = bpGames[bpIndex];
                              if (isBpPseudoEntry(g)) bpActivate(g);
                              else if (g && checkInstalled(g)) launchGame(g);
                              else if (g) openEditModal(g);
                            }
                          }

                          if (key === "q") {
                            e.preventDefault();
                            cycleBpTab(-1);
                          } else if (key === "e") {
                            e.preventDefault();
                            cycleBpTab(1);
                          } else if (key === "backspace" && activeElement !== "input" && activeElement !== "textarea") {
                            if (bpLevelBack()) e.preventDefault();
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
      // Redenumire într-o colecție existentă: fără dubluri în tag-urile aceluiași joc
      g.tags = [...new Set(g.tags.map(tag => tag === oldTag ? cleanNewTag : tag))];
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
  updateBpGamepadLabels(e.gamepad.id);
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
  ["steam", "epic", "gog", "lutris", "emulator"].forEach(src => {
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

    if (selectedSourceCtx === "emulator") {
      scanRomsIntoLibrary();
      return;
    }

    if (selectedSourceCtx === "epic") {
      const invoke = getInvoke();
      if (!invoke) return;
      try {
        showToast(t("toast.epic_resyncing"), "info");
        const result = await invoke("sync_epic_games");
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

// Pornirea și fiecare sincronizare o apelează: fără gardă, două sincronizări rapide trimiteau
// de două ori aceleași (zeci/sute de) cereri către Steam.
let isFetchingSteamTitles = false;

async function enrichSteamTitles() {
  const invoke = getInvoke();
  if (!invoke || isFetchingSteamTitles) return;

  const needTitle = games.filter(g => /^Steam Game \d+$/.test(g.title));
  if (needTitle.length === 0) return;
  isFetchingSteamTitles = true;

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
  } finally {
    isFetchingSteamTitles = false;
  }
}

let isFetchingProtonDb = false;

const BACKUP_ERROR_MAP = {
  ERR_SAVE_DIR_MISSING: "backup_err_dir_missing",
  ERR_SAVE_DIR_EMPTY: "backup_err_dir_empty",
  ERR_BACKUP_NOT_FOUND: "backup_err_not_found",
  ERR_INVALID_ARCHIVE: "backup_err_invalid_archive",
  ERR_SAVE_DIR_UNSAFE: "backup_err_unsafe_dir",
  ERR_SAVE_DIR_TOO_LARGE: "backup_err_too_large",
};

function formatBackupError(err) {
  const raw = String(err);
  if (BACKUP_ERROR_MAP[raw]) return t(BACKUP_ERROR_MAP[raw]);
  return `${t("backup_err_generic")} (${raw})`; // text simplu: apelanții îl escapează dacă îl pun în HTML
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
    container.innerHTML = `<div style="color: #ff6b6b; font-size: 0.85rem;">${escapeHtml(formatBackupError(err))}</div>`;
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

document.getElementById("btn-create-backup")?.addEventListener("click", async (e) => {
  const invoke = getInvoke();
  const currentEditingGame = editingGameId ? games.find(g => g.id === editingGameId) : null;
  const btn = e.currentTarget;
  // Arhivarea poate dura câteva secunde: un dublu-click crea două backup-uri identice
  if (!currentEditingGame || !invoke || btn.disabled) return;
  btn.disabled = true;

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
  } finally {
    btn.disabled = false;
  }
});

async function enrichProtonDbRatings() {
  if (isFetchingProtonDb || isWindows) return;
  const invoke = getInvoke();
  if (!invoke) return;

  const nowSecs = Math.floor(Date.now() / 1000);
  const RECHECK_UNRATED_AFTER_SECS = 7 * 24 * 3600;

  const candidates = games.filter(g =>
  (!g.protondb_tier ||
    (g.protondb_tier === "none" && nowSecs - (g.protondb_updated_at || 0) > RECHECK_UNRATED_AFTER_SECS)) &&
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
      if (!info) continue;
      if (info.app_id) g.steam_app_id = info.app_id;
      // Fără date ProtonDB: marcăm "none" (badge-ul nu se afișează) și reîncercăm abia după 7 zile
      g.protondb_tier = info.tier || "none";
      g.protondb_updated_at = nowSecs;
      changed = true;
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

// ==========================================
// EASTER EGG: TUX RUNNER (5x Logo Click)
// ==========================================
function initTuxRunnerEasterEgg() {
  const logoContainer = document.getElementById('nexus-logo-trigger');
  const modal = document.getElementById('tux-runner-modal');
  const closeBtn = document.getElementById('close-tux-runner-btn');
  const canvas = document.getElementById('tux-runner-canvas');
  const overlay = document.getElementById('tux-runner-overlay');
  const overlayTitle = document.getElementById('tux-overlay-title');
  const startBtn = document.getElementById('tux-start-btn');
  const scoreEl = document.getElementById('tux-current-score');
  const highScoreEl = document.getElementById('tux-high-score');

  if (!logoContainer || !modal || !canvas) return;

  const ctx = canvas.getContext('2d');
  let clickCount = 0;
  let clickTimer = null;

  // 1. Trigger: 5 click-uri rapide pe logo
  logoContainer.addEventListener('click', () => {
    clickCount++;
    clearTimeout(clickTimer);

    if (clickCount >= 5) {
      clickCount = 0;
      openTuxRunner();
    } else {
      clickTimer = setTimeout(() => {
        clickCount = 0;
      }, 1500);
    }
  });

  // State-ul jocului
  let animationId = null;
  let isPlaying = false;
  let score = 0;
  let highScore = parseInt(localStorage.getItem('nexus_tux_highscore') || '0', 10);
  let gameSpeed = 5;
  let frameCount = 0;

  const groundY = 185;
  const tux = {
    x: 55,
    y: groundY - 36,
    width: 30,
    height: 36,
    vy: 0,
    gravity: 0.65,
    jumpPower: -11.5,
    isGrounded: true
  };

  let obstacles = [];
  let clouds = [
    { x: 120, y: 35, w: 46 },
    { x: 380, y: 55, w: 60 },
    { x: 560, y: 28, w: 40 }
  ];

  function updateScoreUI() {
    scoreEl.textContent = String(Math.floor(score)).padStart(5, '0');
    highScoreEl.textContent = String(Math.floor(highScore)).padStart(5, '0');
  }

  function openTuxRunner() {
    updateScoreUI();
    resetGame(false);
    drawScene();
    modal.classList.remove('hidden');
    requestAnimationFrame(() => {
      modal.classList.add('open');
    });
  }

  function closeTuxRunner() {
    isPlaying = false;
    cancelAnimationFrame(animationId);
    modal.classList.remove('open');
    setTimeout(() => {
      modal.classList.add('hidden');
    }, 250);
  }

  function resetGame(autoStart = true) {
    score = 0;
    gameSpeed = 5.2;
    frameCount = 0;
    obstacles = [];
    tux.y = groundY - tux.height;
    tux.vy = 0;
    tux.isGrounded = true;
    updateScoreUI();

    if (autoStart) {
      isPlaying = true;
      overlay.classList.add('hidden');
      cancelAnimationFrame(animationId);
      gameLoop();
    } else {
      isPlaying = false;
      overlayTitle.textContent = (typeof t === 'function' && t('tux_ready') !== 'tux_ready') ? t('tux_ready') : 'Ready to run?';
      startBtn.textContent = (typeof t === 'function' && t('tux_start_btn') !== 'tux_start_btn') ? t('tux_start_btn') : 'Play';
      overlay.classList.remove('hidden');
    }
  }

  function jump() {
    if (modal.classList.contains('hidden')) return;
    if (!isPlaying) {
      resetGame(true);
      return;
    }
    if (tux.isGrounded) {
      tux.vy = tux.jumpPower;
      tux.isGrounded = false;
    }
  }

  // Desenare Tux (stil pixel/vector minimalist)
  function drawTux(x, y) {
    // Corp negru
    ctx.fillStyle = '#18181b';
    ctx.beginPath();
    ctx.roundRect(x + 4, y + 4, 22, 28, 10);
    ctx.fill();

    // Burtă albă
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(x + 8, y + 13, 14, 17, 7);
    ctx.fill();

    // Ochi
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x + 17, y + 8, 4, 4);
    ctx.fillStyle = '#000000';
    ctx.fillRect(x + 19, y + 9, 2, 2);

    // Cioc portocaliu
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(x + 24, y + 11);
    ctx.lineTo(x + 31, y + 14);
    ctx.lineTo(x + 24, y + 16);
    ctx.closePath();
    ctx.fill();

    // Picioare animate
    const legOffset = isPlaying && tux.isGrounded ? Math.sin(frameCount * 0.35) * 3 : 0;
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(x + 7, y + 32 + legOffset, 6, 4);
    ctx.fillRect(x + 17, y + 32 - legOffset, 6, 4);
  }

  // Desenare obstacole (Bug-uri roșii / Ferestre BSOD)
  function drawObstacle(obs) {
    if (obs.type === 'bug') {
      // Bug / Eroare
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.roundRect(obs.x, obs.y, obs.width, obs.height, 6);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px monospace';
      ctx.fillText('ERR', obs.x + 3, obs.y + obs.height / 2 + 4);
    } else {
      // Fereastră albastră / Crash
      ctx.fillStyle = '#2563eb';
      ctx.beginPath();
      ctx.roundRect(obs.x, obs.y, obs.width, obs.height, 4);
      ctx.fill();
      ctx.fillStyle = '#93c5fd';
      ctx.fillRect(obs.x + 3, obs.y + 3, obs.width - 6, 4);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(':(', obs.x + 6, obs.y + 20);
    }
  }
  function drawScene() {
    const rootStyles = getComputedStyle(document.documentElement);
    const themeBorder = rootStyles.getPropertyValue('--nd-border').trim() || '#334155';
    const themeTextSec = rootStyles.getPropertyValue('--nd-text-secondary').trim() || '#94a3b8';

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Nori decorativi (adaptați la tema activă)
    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = themeTextSec;
    clouds.forEach(c => {
      ctx.beginPath();
      ctx.roundRect(c.x, c.y, c.w, 12, 6);
      ctx.fill();
    });
    ctx.restore();

    // Linia solului
    ctx.strokeStyle = themeBorder;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(canvas.width, groundY);
    ctx.stroke();

    // Obstacole
    obstacles.forEach(drawObstacle);

    // Tux
    drawTux(tux.x, tux.y);
  }

  // Logica rulează la pas fix (60 pași/s), indiferent de rata de refresh: înainte, totul
  // avansa o dată pe cadru, deci pe un monitor de 144 Hz jocul mergea de 2,4 ori mai repede.
  const STEP_MS = 1000 / 60;
  let lastFrameTime = null;
  let stepAccumulator = 0;

  function gameLoop(now) {
    if (!isPlaying) {
      lastFrameTime = null;
      return;
    }
    if (typeof now !== "number" || lastFrameTime === null) {
      // Pornire / repornire: primul cadru doar fixează referința de timp
      lastFrameTime = typeof now === "number" ? now : performance.now();
      stepAccumulator = STEP_MS;
    } else {
      // Plafon: după un tab ascuns nu „recuperăm” secunde întregi dintr-odată
      stepAccumulator += Math.min(now - lastFrameTime, 250);
      lastFrameTime = now;
    }

    while (stepAccumulator >= STEP_MS) {
      stepAccumulator -= STEP_MS;
      if (!gameStep()) {
        lastFrameTime = null;
        return; // game over: gameStep a desenat deja scena finală
      }
    }

    drawScene();
    animationId = requestAnimationFrame(gameLoop);
  }

  // Un pas de simulare. Întoarce false la game over.
  function gameStep() {
    frameCount++;

    // Fizică Tux
    tux.vy += tux.gravity;
    tux.y += tux.vy;
    if (tux.y >= groundY - tux.height) {
      tux.y = groundY - tux.height;
      tux.vy = 0;
      tux.isGrounded = true;
    }

    // Mișcare nori
    clouds.forEach(c => {
      c.x -= gameSpeed * 0.25;
      if (c.x + c.w < 0) c.x = canvas.width + 20;
    });

      // Generare obstacole
      const lastObs = obstacles[obstacles.length - 1];
      const minGap = 230 + Math.random() * 160;
      if (!lastObs || canvas.width - lastObs.x > minGap) {
        const isTall = Math.random() > 0.55;
        obstacles.push({
          x: canvas.width + 10,
          y: isTall ? groundY - 34 : groundY - 24,
          width: isTall ? 26 : 28,
          height: isTall ? 34 : 24,
          type: isTall ? 'bsod' : 'bug'
        });
      }

      // Actualizare obstacole & coliziuni
      for (let i = obstacles.length - 1; i >= 0; i--) {
        const obs = obstacles[i];
        obs.x -= gameSpeed;

        // Hitbox ușor iertător (-4px margine)
        if (
          tux.x + 6 < obs.x + obs.width - 4 &&
          tux.x + tux.width - 6 > obs.x + 4 &&
          tux.y + 4 < obs.y + obs.height - 4 &&
          tux.y + tux.height - 4 > obs.y + 4
        ) {
          // Game Over
          isPlaying = false;
          if (score > highScore) {
            highScore = Math.floor(score);
            localStorage.setItem('nexus_tux_highscore', String(highScore));
          }
          updateScoreUI();
          overlayTitle.textContent = (typeof t === 'function' ? t('tux_game_over') : 'Kernel Panic! Ai lovit un obstacol.');
          startBtn.textContent = (typeof t === 'function' ? t('tux_restart_btn') : 'Încearcă din nou');
          overlay.classList.remove('hidden');
          drawScene();
          return false;
        }

        if (obs.x + obs.width < 0) {
          obstacles.splice(i, 1);
        }
      }

      // Scor și creștere treptată a vitezei
      score += 0.15;
      gameSpeed += 0.0012;
      updateScoreUI();
      return true;
  }

  // Controale
  startBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    resetGame(true);
  });

  canvas.addEventListener('mousedown', jump);
  closeBtn.addEventListener('click', closeTuxRunner);

    window.addEventListener('tux-runner-jump', jump);
    document.addEventListener('keydown', (e) => {
      if (modal.classList.contains('hidden')) return;
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        e.preventDefault();
        jump();
      } else if (e.code === 'Escape') {
        closeTuxRunner();
      }
    });
}

let lastDepsCheckResult = null;

function buildManualInstallCommand(pkgManager, packages) {
  const pkgs = packages.join(" ");
  switch (pkgManager) {
    case "pacman": return `sudo pacman -S --needed ${pkgs}`;
    case "apt": return `sudo apt update && sudo apt install -y ${pkgs}`;
    case "dnf": return `sudo dnf install -y ${pkgs}`;
    case "zypper": return `sudo zypper install -y ${pkgs}`;
    default: return pkgs;
  }
}

async function openDependenciesWizard(forceShow = false) {
  if (isWindows) return;
  const invoke = getInvoke();
  if (!invoke) return;

  try {
    const res = await invoke("check_system_dependencies");
    if (!res.is_linux) return;

    // Dacă nu s-a apăsat manual butonul și toate sunt instalate, nu afișa la pornire
    if (!forceShow && res.all_installed) return;

    const chkDontShow = document.getElementById("chk-deps-dont-show");
    if (chkDontShow) {
      chkDontShow.checked = localStorage.getItem("nexus_skip_deps_wizard") === "true";
    }

    renderDependenciesWizard(res);
    openModalAnimated("deps-wizard-modal");
  } catch (err) {
    if (forceShow) {
      showToast(t("toast.error_generic", { err }), "error");
    }
  }
}

function renderDependenciesWizard(res) {
  lastDepsCheckResult = res;
  const distroLabel = document.getElementById("deps-distro-label");
  const listEl = document.getElementById("deps-wizard-list");
  const installBtn = document.getElementById("btn-deps-install");
  const manualBox = document.getElementById("deps-manual-cmd-box");
  const manualText = document.getElementById("deps-manual-cmd-text");

  if (distroLabel) {
    distroLabel.textContent = t("modal.deps.detected_os", {
      distro: res.distro_name,
      manager: res.pkg_manager,
    });
  }

  const missingPackages = [];

  if (listEl) {
    listEl.innerHTML = res.dependencies.map((dep) => {
      const pkgName = dep.packages[res.pkg_manager] || dep.id;
      if (!dep.installed) missingPackages.push(pkgName);

      const descKey = `modal.deps.desc_${dep.id}`;
      const localizedDesc = t(descKey) !== descKey ? t(descKey) : dep.required_for;

      return `
      <div class="flex items-center justify-between p-3 rounded-xl bg-slate-900/80 border ${dep.installed ? "border-slate-800/80" : "border-amber-500/40"}">
      <div class="flex items-center gap-3 min-w-0">
      <input
      type="checkbox"
      class="dep-pkg-checkbox rounded"
      data-pkg="${escapeHtml(pkgName)}"
      ${dep.installed ? "disabled" : "checked"}
      />
      <div class="min-w-0">
      <div class="flex items-center gap-2">
      <span class="text-xs font-bold text-white">${escapeHtml(dep.name)}</span>
      <span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-950 text-slate-400 border border-slate-800">${escapeHtml(pkgName)}</span>
      </div>
      <p class="text-[11px] text-slate-400 truncate">${escapeHtml(localizedDesc)}</p>
      </div>
      </div>

      <span class="px-2.5 py-1 rounded-lg text-[10px] font-bold shrink-0 ${
        dep.installed
        ? "bg-emerald-950/80 text-emerald-400 border border-emerald-500/30"
        : "bg-amber-950/80 text-amber-300 border border-amber-500/30"
      }">
      ${dep.installed ? t("modal.deps.installed_badge") : t("modal.deps.missing_badge")}
      </span>
      </div>
      `;
    }).join("");
  }

  if (missingPackages.length > 0 && manualBox && manualText) {
    manualBox.classList.remove("hidden");
    manualText.textContent = buildManualInstallCommand(res.pkg_manager, missingPackages);
  } else if (manualBox) {
    manualBox.classList.add("hidden");
  }

  if (installBtn) {
    const canAutoInstall = missingPackages.length > 0 && res.pkg_manager !== "unknown";
    installBtn.disabled = !canAutoInstall;
    installBtn.classList.toggle("hidden", missingPackages.length === 0);
  }

  if (window.lucide) window.lucide.createIcons();
}

function initDependenciesWizard() {
  if (isWindows) return;

  const closeAndSavePref = () => {
    const chkDontShow = document.getElementById("chk-deps-dont-show");
    if (chkDontShow?.checked) {
      localStorage.setItem("nexus_skip_deps_wizard", "true");
    } else {
      localStorage.removeItem("nexus_skip_deps_wizard");
    }
    closeModalAnimated("deps-wizard-modal");
  };

  document.getElementById("btn-close-deps-modal")?.addEventListener("click", closeAndSavePref);
  document.getElementById("btn-deps-skip")?.addEventListener("click", closeAndSavePref);

  document.getElementById("btn-open-deps-wizard")?.addEventListener("click", () => {
    closeModalAnimated("config-modal");
    openDependenciesWizard(true);
  });

  document.getElementById("btn-copy-deps-cmd")?.addEventListener("click", async () => {
    const cmd = document.getElementById("deps-manual-cmd-text")?.textContent;
    if (cmd && navigator.clipboard) {
      await navigator.clipboard.writeText(cmd);
      showToast(t("toast.deps_copied"), "success");
    }
  });

  document.getElementById("btn-deps-install")?.addEventListener("click", async () => {
    const invoke = getInvoke();
    if (!invoke || !lastDepsCheckResult) return;

    const selectedPkgs = Array.from(document.querySelectorAll(".dep-pkg-checkbox:checked"))
    .map((cb) => cb.dataset.pkg)
    .filter(Boolean);

    if (selectedPkgs.length === 0) {
      showToast(t("toast.deps_select_one"), "warning");
      return;
    }

    const btn = document.getElementById("btn-deps-install");
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>${t("modal.deps.installing")}</span>`;
    if (window.lucide) window.lucide.createIcons();

    try {
      const msg = await invoke("install_system_dependencies", {
        pkgManager: lastDepsCheckResult.pkg_manager,
        packages: selectedPkgs,
      });
      showToast(String(msg), "success");

      const updated = await invoke("check_system_dependencies");
      renderDependenciesWizard(updated);
      await loadRunners();

      if (updated.all_installed) {
        setTimeout(() => closeAndSavePref(), 900);
      }
    } catch (err) {
      showToast(t("toast.error_generic", { err: String(err) }), "error", 9000);

      // Instalare parțială: pachetele care au reușit trebuie să apară ca instalate în listă
      try {
        const updated = await invoke("check_system_dependencies");
        renderDependenciesWizard(updated);
        await loadRunners();
      } catch (_) {}
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="download" class="w-4 h-4"></i><span data-i18n="modal.deps.install">${t("modal.deps.install")}</span>`;
      if (window.lucide) window.lucide.createIcons();
    }
  });

  if (localStorage.getItem("nexus_skip_deps_wizard") !== "true") {
    setTimeout(() => openDependenciesWizard(false), 600);
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

  return `<button type="button" class="btn-protondb ${sizeClass} rounded-md font-black uppercase tracking-wider border ${badgeStyle} hover:brightness-125 transition cursor-pointer" data-proton-appid="${appId}" title="${t("game.protondb_title", { tier: tier.toUpperCase() })}">${tier}</button>`;
}
