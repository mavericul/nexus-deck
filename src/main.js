let games = [];
let availableRunners = [];
let editingGameId = null;
let isBigPicture = false;
let bpIndex = 0;
let activeTab = "all";
let bpTab = "all";
let viewMode = "grid"; // "grid" sau "list"
let selectedGenre = "all";
let selectedSort = "name-asc";
let selectedTagFilter = "all";
let selectedCtxGame = null;
let selectedPrefixGame = null;
let currentTheme = localStorage.getItem("nexus_theme") || "dark";

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
  if (!title) return false;
  const lower = title.toLowerCase();
  return IGNORED_TOOLS.some(kw => lower.includes(kw));
}

// Detectare platforma (Windows vs Linux)
const isWindows = navigator.userAgent.toLowerCase().includes("win") || navigator.platform.toLowerCase().includes("win");

if (isWindows) {
  document.body.classList.add("platform-windows");
}

const getInvoke = () => window.__TAURI__?.core?.invoke || window.__TAURI__?.tauri?.invoke || window.__TAURI__?.invoke;

document.addEventListener("DOMContentLoaded", async () => {
  if (window.lucide) window.lucide.createIcons();

  await loadRunners();
  await loadGames();

  applyTheme(currentTheme);
  loadSavedUiSettings();
  setupEventListeners();
  setupUiSettingsListeners();
  startClock();
  startSysMonitor();
  renderGames();
  renderSidebarTags();
});

// ==========================================
// THEME ENGINE
// ==========================================
function applyTheme(theme) {
  currentTheme = theme;
  localStorage.setItem("nexus_theme", theme);
  const root = document.documentElement;
  const themeText = document.getElementById("theme-text");

  if (theme === "light") {
    root.classList.add("theme-light");
    if (themeText) themeText.innerText = "Dark Mode";
  } else {
    root.classList.remove("theme-light");
    if (themeText) themeText.innerText = "Light Mode";
  }
}

// ==========================================
// NOTIFICĂRI TOAST
// ==========================================
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
  } catch (e) {
    console.error("Error loading UI settings from localStorage:", e);
  }
}

function saveUiSettings() {
  const chkGlass = document.getElementById("cfg-glass-effects");
  const chkMonitor = document.getElementById("cfg-resource-monitor");
  const selectFontSize = document.getElementById("cfg-font-size");
  const selectUiScale = document.getElementById("cfg-ui-scale");

  const config = {
    glassmorphism: chkGlass ? chkGlass.checked : true,
    resourceMonitor: chkMonitor ? chkMonitor.checked : true,
    fontSize: selectFontSize ? selectFontSize.value : "base",
    uiScale: selectUiScale ? selectUiScale.value : "100"
  };

  localStorage.setItem("nexusdeck_ui_config", JSON.stringify(config));
}

function setupUiSettingsListeners() {
  const chkGlass = document.getElementById("cfg-glass-effects");
  const chkMonitor = document.getElementById("cfg-resource-monitor");
  const resMonitorContainer = document.getElementById("top-resource-monitor");
  const selectFontSize = document.getElementById("cfg-font-size");
  const selectUiScale = document.getElementById("cfg-ui-scale");

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
}

function startClock() {
  const updateClock = () => {
    const now = new Date();
    const clockEl = document.getElementById("bp-clock");
    if (clockEl) {
      clockEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
  };
  updateClock();
  setInterval(updateClock, 1000);
}

async function startSysMonitor() {
  const updateStats = async () => {
    const invoke = getInvoke();
    if (!invoke) return;
    try {
      const stats = await invoke("get_system_stats");
      if (stats) {
        document.getElementById("stat-cpu").textContent = `${stats.cpu_usage}%`;
        document.getElementById("stat-ram").textContent = `${stats.ram_used_gb} / ${stats.ram_total_gb}GB`;
      }
    } catch (e) {
      console.error(e);
    }
  };
  await updateStats();
  setInterval(updateStats, 2000);
}

async function loadRunners() {
  const invoke = getInvoke();
  if (!invoke) return;
  try {
    availableRunners = await invoke("get_available_runners");
    const select = document.getElementById("select-runner");
    if (select) {
      select.innerHTML = "";
      availableRunners.forEach(r => {
        const opt = document.createElement("option");
        opt.value = r.path;
        opt.textContent = r.name;
        select.appendChild(opt);
      });
    }
  } catch (e) {
    console.error("Error loading runners:", e);
  }
}

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
    showToast("Save error: " + e, "error");
  }
}

async function fetchCoverForGame(game) {
  if (!game) return;

  showToast(`Searching cover art for "${game.title}"...`, "info");

  const invoke = getInvoke();
  if (!invoke) return;

  try {
    const foundUrl = await invoke("search_cover_art", { title: game.title });

    if (foundUrl) {
      game.cover_url = foundUrl;
      await saveGamesToDisk();
      renderGames();
      showToast(`Found and applied Steam cover for "${game.title}"!`, "success");
    } else {
      showToast(`Could not auto-match artwork for "${game.title}". Set custom URL in settings.`, "info");
    }
  } catch (e) {
    showToast("Error searching cover art: " + e, "error");
  }
}

async function syncExternalGames() {
  const invoke = getInvoke();
  if (!invoke) return;

  try {
    const scannedGames = await invoke("scan_external_launchers");
    let addedCount = 0;

    scannedGames.forEach(scanned => {
      const exists = games.some(g => g.id === scanned.id || g.title.toLowerCase() === scanned.title.toLowerCase());
      if (!exists) {
        games.push(scanned);
        addedCount++;
      }
    });

    if (addedCount > 0) {
      await saveGamesToDisk();
      renderGames();
      renderSidebarTags();
      showToast(`Imported ${addedCount} new games!`, "success");
    } else {
      showToast("No new games found or all games are already imported.", "info");
    }
  } catch (e) {
    showToast("Error scanning external launchers: " + e, "error");
  }
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
      g.tags.forEach(t => tagSet.add(t.trim()));
    }
  });
  return Array.from(tagSet);
}

function renderSidebarTags() {
  const container = document.getElementById("sidebar-tags-container");
  if (!container) return;

  const tags = getAllUniqueTags();
  if (tags.length === 0) {
    container.innerHTML = `<span class="text-[11px] text-slate-500 px-3 italic">No collections yet</span>`;
    return;
  }

  container.innerHTML = tags.map(tag => `
  <div data-tag-filter="${tag}" class="sidebar-tag-item group flex items-center justify-between px-3 py-1.5 rounded-lg hover:bg-slate-800/40 cursor-pointer ${selectedTagFilter === tag ? "bg-indigo-950/60 text-indigo-400 font-bold" : ""}">
  <span class="flex items-center gap-2 truncate">
  <i data-lucide="tag" class="w-3.5 h-3.5 text-pink-400 shrink-0"></i>
  <span class="truncate">${tag}</span>
  </span>
  <div class="flex items-center gap-1">
  <span class="text-[10px] font-mono bg-slate-800 px-1.5 py-0.5 rounded text-slate-400">${games.filter(g => g.tags && g.tags.includes(tag)).length}</span>
  <button class="btn-edit-tag p-1 text-slate-500 hover:text-indigo-300 opacity-0 group-hover:opacity-100 transition" data-tag="${tag}" title="Edit Tag">
  <i data-lucide="pencil" class="w-3 h-3"></i>
  </button>
  <button class="btn-delete-tag p-1 text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition" data-tag="${tag}" title="Delete Tag">
  <i data-lucide="trash-2" class="w-3 h-3"></i>
  </button>
  </div>
  </div>
  `).join("");

  // Handler Click pe Tag pentru Filtrare
  container.querySelectorAll(".sidebar-tag-item").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".btn-edit-tag") || e.target.closest(".btn-delete-tag")) return;
      const tag = el.dataset.tagFilter;
      selectedTagFilter = selectedTagFilter === tag ? "all" : tag;
      renderSidebarTags();
      renderGames();
    });
  });

  // Handler Editare Tag
  container.querySelectorAll(".btn-edit-tag").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      renameGlobalTag(btn.dataset.tag);
    });
  });

  // Handler Ștergere Tag
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
    hideTextEl.textContent = game.hidden ? "Unhide Game" : "Hide Game";
  }

  const ctxMenu = document.getElementById("custom-context-menu");
  if (!ctxMenu) return;

  // 1. Mutam elementul direct in <body> pentru ca pozitionarea sa fie strict raportata la fereastra aplicatiei (viewport)
  if (ctxMenu.parentElement !== document.body) {
    document.body.appendChild(ctxMenu);
  }

  // 2. Afisam meniul temporar pentru a-i putea masura dimensiunile reale
  ctxMenu.style.position = "fixed";
  ctxMenu.style.zIndex = "999999";
  ctxMenu.classList.remove("hidden");

  // 3. Masuram dimensiunile exacte calculate de browser
  const rect = ctxMenu.getBoundingClientRect();
  const menuWidth = rect.width || 220;
  const menuHeight = rect.height || 320;

  const windowWidth = window.innerWidth;
  const windowHeight = window.innerHeight;

  let posX = e.clientX;
  let posY = e.clientY;

  // Daca click-ul e prea aproape de marginea din dreapta, deschidem meniul SPRE STANGA cursorului
  if (posX + menuWidth > windowWidth - 12) {
    posX = posX - menuWidth;
  }

  // Daca click-ul e prea aproape de marginea de jos, deschidem meniul IN SUS față de cursor
  if (posY + menuHeight > windowHeight - 12) {
    posY = posY - menuHeight;
  }

  // Asiguram o margine de siguranta fata de stanga si sus
  posX = Math.max(10, posX);
  posY = Math.max(10, posY);

  ctxMenu.style.left = `${posX}px`;
  ctxMenu.style.top = `${posY}px`;

  if (window.lucide) window.lucide.createIcons();
}

function renderGames() {
  const container = document.getElementById("games-container");
  if (!container) return;
  container.innerHTML = "";

  const validGames = games.filter(g => !isToolOrRuntime(g.title));

  const hiddenCount = validGames.filter(g => g.hidden === true).length;
  const visibleGames = validGames.filter(g => !g.hidden);

  document.getElementById("count-all").textContent = visibleGames.length;
  if (document.getElementById("count-installed")) {
    document.getElementById("count-installed").textContent = visibleGames.length;
  }
  document.getElementById("count-favorites").textContent = visibleGames.filter(g => g.favorite).length;
  if (document.getElementById("count-hidden")) {
    document.getElementById("count-hidden").textContent = hiddenCount;
  }

  let displayGames = [...validGames];

  if (activeTab === "hidden") {
    displayGames = displayGames.filter(g => g.hidden === true);
    document.getElementById("library-title").textContent = "Hidden Games";
  } else {
    displayGames = displayGames.filter(g => !g.hidden);

    if (activeTab === "favorites") {
      displayGames = displayGames.filter(g => g.favorite);
      document.getElementById("library-title").textContent = "Favorite Games";
    } else {
      document.getElementById("library-title").textContent = "All Library Games";
    }
  }

  if (selectedTagFilter !== "all") {
    displayGames = displayGames.filter(g => g.tags && g.tags.includes(selectedTagFilter));
    document.getElementById("library-title").textContent = `Collection: ${selectedTagFilter}`;
  }

  if (selectedGenre !== "all") {
    displayGames = displayGames.filter(g => (g.genre || "Action").toLowerCase() === selectedGenre.toLowerCase());
  }

  if (selectedSort === "name-asc") {
    displayGames.sort((a, b) => a.title.localeCompare(b.title));
  } else if (selectedSort === "name-desc") {
    displayGames.sort((a, b) => b.title.localeCompare(a.title));
  } else if (selectedSort === "source-asc") {
    displayGames.sort((a, b) => getSourceTag(a).localeCompare(getSourceTag(b)));
  } else if (selectedSort === "source-desc") {
    displayGames.sort((a, b) => getSourceTag(b).localeCompare(getSourceTag(a)));
  }

  document.getElementById("library-count-badge").textContent = `${displayGames.length} items`;

  if (displayGames.length === 0) {
    container.innerHTML = `<div class="col-span-full py-20 flex flex-col items-center justify-center text-slate-500">
    <i data-lucide="folder-open" class="w-10 h-10 mb-2 opacity-50"></i>
    <p class="text-sm font-medium">No games found.</p>
    </div>`;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  if (viewMode === "grid") {
    container.className = "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 items-start";
    displayGames.forEach(game => {
      const card = document.createElement("div");
      card.className = "glass-card card-glow-hover group relative cursor-pointer w-full flex flex-col border border-slate-800/80 rounded-2xl overflow-hidden transform-gpu";

      const coverImg = game.cover_url || "https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=600&q=80";
      const runnerName = getRunnerDisplayName(game.runner_path);
      const sourceTag = getSourceTag(game);
      const badgeClass = getSourceBadgeClass(sourceTag);

      const displayTags = (game.tags || []).filter(t => {
        const lower = t.toLowerCase();
        return lower !== "installed" && lower !== "lutris" && lower !== "epic games" && lower !== "steam" && lower !== "gog";
      });

      const tagsHtml = displayTags.length > 0
      ? displayTags.map(t => `<span class="px-1.5 py-0.5 rounded text-[9px] bg-pink-950/80 text-pink-300 border border-pink-700/50">${t}</span>`).join(" ")
      : "";

      card.innerHTML = `
      <div class="relative w-full aspect-[3/4] overflow-hidden bg-slate-900 rounded-t-2xl">
      <img src="${coverImg}" class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105">
      <div class="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-transparent to-transparent"></div>

      <span class="absolute top-3 left-3 px-2.5 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-slate-950/80 backdrop-blur-md ${badgeClass} border z-10">
      ${sourceTag}
      </span>

      <button class="btn-fav absolute top-3 right-3 z-30 p-2 rounded-full bg-slate-950/80 hover:bg-slate-900 text-amber-400 transition" data-id="${game.id}">
      <i data-lucide="star" class="w-4 h-4 ${game.favorite ? "fill-current" : ""}"></i>
      </button>

      <div class="absolute inset-0 bg-slate-950/80 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center gap-2.5 z-20 pointer-events-none group-hover:pointer-events-auto">
      <button class="btn-play p-3.5 rounded-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition shadow-xl shadow-emerald-500/40">
      <i data-lucide="play" class="w-5 h-5 fill-current"></i>
      </button>
      <button class="btn-edit p-3 rounded-full bg-purple-950/90 text-purple-300 hover:bg-purple-900 transition">
      <i data-lucide="settings" class="w-4 h-4"></i>
      </button>
      <button class="btn-delete p-3 rounded-full bg-red-950/90 text-red-400 hover:bg-red-900 transition">
      <i data-lucide="trash-2" class="w-4 h-4"></i>
      </button>
      </div>
      </div>

      <div class="p-3.5 bg-slate-900/90 flex-1 flex flex-col justify-between rounded-b-2xl">
      <div>
      <h3 class="font-extrabold text-sm text-slate-100 truncate group-hover:text-indigo-300 transition-colors">${game.title}</h3>
      <span class="text-xs text-slate-400 font-mono block mt-1">${runnerName}</span>
      </div>

      <div class="mt-3 flex items-center justify-between text-xs">
      <div class="flex flex-wrap gap-1">${tagsHtml}</div>
      <span class="text-emerald-400 font-bold flex items-center gap-1 shrink-0 ml-1">
      <i data-lucide="check-circle" class="w-3.5 h-3.5"></i> Installed
      </span>
      </div>
      </div>
      `;
      card.querySelector(".btn-play").addEventListener("click", (e) => { e.stopPropagation(); launchGame(game); });
      card.querySelector(".btn-fav").addEventListener("click", async (e) => { e.stopPropagation(); game.favorite = !game.favorite; await saveGamesToDisk(); renderGames(); });
      card.querySelector(".btn-edit").addEventListener("click", (e) => { e.stopPropagation(); openEditModal(game); });
      card.querySelector(".btn-delete").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (confirm(`Delete "${game.title}" from library?`)) { games = games.filter(g => g.id !== game.id); await saveGamesToDisk(); renderGames(); }
      });

      card.addEventListener("contextmenu", (e) => showContextMenu(e, game));

      container.appendChild(card);
    });
  } else {
    // LIST VIEW
    container.className = "flex flex-col space-y-2.5 w-full";
    displayGames.forEach(game => {
      const item = document.createElement("div");
      item.className = "glass-panel p-3 rounded-xl flex items-center justify-between hover:border-indigo-500/50 transition cursor-pointer";
      item.innerHTML = `
      <div class="flex items-center gap-4">
      <img src="${game.cover_url || 'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=200&q=80'}" class="w-12 h-16 object-cover rounded-lg">
      <div>
      <h4 class="font-extrabold text-base text-white">${game.title}</h4>
      <span class="text-xs text-cyan-400 font-mono">${getRunnerDisplayName(game.runner_path)}</span>
      </div>
      </div>
      <div class="flex items-center gap-3">
      <button class="btn-play px-4 py-2 bg-emerald-500 text-slate-950 font-bold rounded-lg hover:bg-emerald-400 transition text-xs flex items-center gap-1.5"><i data-lucide="play" class="w-4 h-4 fill-current"></i> Launch</button>
      <button class="btn-edit p-2 bg-slate-800 text-purple-300 rounded-lg hover:bg-slate-700 transition"><i data-lucide="settings" class="w-4 h-4"></i></button>
      <button class="btn-delete p-2 bg-slate-800 text-red-400 rounded-lg hover:bg-slate-700 transition"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
      </div>
      `;

      item.querySelector(".btn-play").addEventListener("click", (e) => { e.stopPropagation(); launchGame(game); });
      item.querySelector(".btn-edit").addEventListener("click", (e) => { e.stopPropagation(); openEditModal(game); });
      item.querySelector(".btn-delete").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (confirm(`Delete "${game.title}"?`)) { games = games.filter(g => g.id !== game.id); await saveGamesToDisk(); renderGames(); }
      });

      item.addEventListener("contextmenu", (e) => showContextMenu(e, game));

      container.appendChild(item);
    });
  }

  if (window.lucide) window.lucide.createIcons();
}

function openTagsModal(game) {
  if (!game) return;
  selectedCtxGame = game;
  document.getElementById("tags-modal-title").textContent = `Manage Tags for "${game.title}"`;
  document.getElementById("inp-tags-list").value = game.tags ? game.tags.join(", ") : "";
  openModalAnimated("tags-modal");
}

function openEditModal(game = null) {
  editingGameId = game ? game.id : null;
  document.getElementById("modal-title").innerHTML = game
  ? `<i data-lucide="settings" class="w-5 h-5 text-purple-400"></i> Settings: "${game.title}"`
  : `<i data-lucide="plus" class="w-5 h-5 text-indigo-400"></i> Add New Game`;

  document.getElementById("inp-title").value = game ? game.title : "";
  document.getElementById("inp-exepath").value = game ? game.exe_path : "";
  document.getElementById("inp-wineprefix").value = game ? (game.wine_prefix || "") : "";
  document.getElementById("inp-args").value = game ? (game.launch_args || "") : "";
  document.getElementById("inp-cover").value = game ? (game.cover_url || "") : "";
  document.getElementById("chk-gamemode").checked = game ? game.use_gamemode : true;
  document.getElementById("chk-mangohud").checked = game ? game.use_mangohud : true;

  if (game && game.runner_path) {
    document.getElementById("select-runner").value = game.runner_path;
  }

  openModalAnimated("game-modal");
  if (window.lucide) window.lucide.createIcons();
}

async function launchGame(game) {
  if (!game) return;
  const invoke = getInvoke();
  if (!invoke) return;

  try {
    const res = await invoke("launch_game", { game });
    console.log("Launched:", res);
  } catch (err) {
    showToast("Launch error: " + err, "error");
  }
}

async function setFullscreenMode(enable) {
  try {
    if (enable) {
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
    } else {
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
      }
    }
  } catch (e) {
    console.warn("Fullscreen request error:", e);
  }
}

function renderBigPicture() {
  const carousel = document.getElementById("bp-carousel");
  if (!carousel) return;

  carousel.innerHTML = "";

  const playBtn = document.getElementById("bp-btn-play");
  const heroStatus = document.getElementById("bp-hero-status");

  let bpGames = games.filter(g => !isToolOrRuntime(g.title) && !g.hidden);

  if (bpTab === "favorites") {
    bpGames = bpGames.filter(g => g.favorite);
  }

  if (bpGames.length === 0) {
    document.getElementById("bp-hero-title").textContent = "No Games Found";
    document.getElementById("bp-hero-desc").textContent = bpTab === "favorites"
    ? "No favorite games added yet."
    : "Add games in Desktop Mode to run them here.";

    if (playBtn) playBtn.classList.add("hidden");
    if (heroStatus) heroStatus.classList.add("hidden");
    return;
  }

  if (playBtn) playBtn.classList.remove("hidden");
  if (heroStatus) heroStatus.classList.remove("hidden");

  if (bpIndex >= bpGames.length) bpIndex = 0;

  const fragment = document.createDocumentFragment();

  bpGames.forEach((game, idx) => {
    const card = document.createElement("div");
    card.className = `shrink-0 w-60 rounded-2xl glass-card cursor-pointer border-2 overflow-hidden transition-transform duration-150 transform-gpu ${
      idx === bpIndex ? "bp-focused" : "border-slate-800/80 opacity-60 hover:opacity-100"
    }`;

    const coverImg = game.cover_url || "https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=600&q=80";
    const runnerName = getRunnerDisplayName(game.runner_path);

    card.innerHTML = `
    <div class="aspect-[3/4] relative overflow-hidden bg-slate-900 rounded-t-2xl">
    <img src="${coverImg}" class="w-full h-full object-cover" loading="eager">
    <div class="absolute inset-0 bg-gradient-to-t from-slate-950 via-transparent to-transparent"></div>
    ${game.favorite ? '<i data-lucide="star" class="w-4 h-4 text-amber-400 fill-current absolute top-3 right-3"></i>' : ''}
    </div>
    <div class="p-3.5 bg-slate-900/90 rounded-b-2xl">
    <h4 class="font-extrabold text-base text-white truncate">${game.title}</h4>
    <span class="text-xs text-cyan-400 font-mono">${runnerName}</span>
    </div>
    `;

    card.addEventListener("click", () => {
      bpIndex = idx;
      renderBigPicture();
    });

    fragment.appendChild(card);
  });

  carousel.appendChild(fragment);

  const focusedCard = carousel.children[bpIndex];
  const scrollContainer = carousel.parentElement;
  if (focusedCard && scrollContainer) {
    const containerWidth = scrollContainer.clientWidth;
    const cardLeft = focusedCard.offsetLeft;
    const cardWidth = focusedCard.clientWidth;

    scrollContainer.scrollTo({
      left: cardLeft - containerWidth / 2 + cardWidth / 2,
      behavior: "instant"
    });
  }

  const selectedGame = bpGames[bpIndex];
  if (selectedGame) {
    document.getElementById("bp-hero-title").textContent = selectedGame.title;
    document.getElementById("bp-hero-runner").textContent = getRunnerDisplayName(selectedGame.runner_path);
    document.getElementById("bp-hero-desc").textContent = selectedGame.launch_args ? `Args: ${selectedGame.launch_args}` : "Ready to launch with NexusDeck Engine.";

    const bgAmbient = document.getElementById("bp-ambient-bg");
    if (bgAmbient) {
      const cover = selectedGame.cover_url || "https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=1200&q=80";
      if (!bgAmbient.style.backgroundImage.includes(cover)) {
        bgAmbient.style.backgroundImage = `url('${cover}')`;
      }
    }
  }

  if (window.lucide) window.lucide.createIcons();
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
    showToast(`Directorul jocului "${game.title}" s-a deschis.`, "success");
  } catch (err) {
    showToast("Eroare la deschiderea folderului: " + err, "error");
  }
}

function openRunInPrefixModal(game) {
  selectedPrefixGame = game;
  const input = document.getElementById("prefix-exe-path");
  if (input) input.value = "";
  openModalAnimated("prefix-exe-modal");
}

function setupEventListeners() {
  window.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  });

  window.addEventListener("click", () => {
    const ctxMenu = document.getElementById("custom-context-menu");
    if (ctxMenu) ctxMenu.classList.add("hidden");
  });

    // THEME TOGGLE
    document.getElementById("btn-toggle-theme")?.addEventListener("click", () => {
      applyTheme(currentTheme === "dark" ? "light" : "dark");
    });

    // ABOUT MODAL
    document.getElementById("btn-open-about")?.addEventListener("click", () => { openModalAnimated("about-modal"); });
    document.getElementById("close-about-modal")?.addEventListener("click", () => { closeModalAnimated("about-modal"); });
    document.getElementById("btn-close-about-ok")?.addEventListener("click", () => { closeModalAnimated("about-modal"); });
    document.getElementById("about-modal")?.addEventListener("click", (e) => {
      if (e.target.id === "about-modal") closeModalAnimated("about-modal");
    });

      // ADD GAME DROPDOWN
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

      // CONTEXT MENU HANDLERS
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

              document.getElementById("ctx-remove")?.addEventListener("click", async () => {
                if (selectedCtxGame && confirm(`Remove "${selectedCtxGame.title}" from library?`)) {
                  games = games.filter(g => g.id !== selectedCtxGame.id);
                  await saveGamesToDisk();
                  renderGames();
                  renderSidebarTags();
                }
              });

              document.getElementById("ctx-toggle-hide")?.addEventListener("click", async () => {
                if (selectedCtxGame) {
                  selectedCtxGame.hidden = !selectedCtxGame.hidden;
                  await saveGamesToDisk();
                  renderGames();
                  showToast(
                    selectedCtxGame.hidden
                    ? `Hidden "${selectedCtxGame.title}". Find it in Hidden tab.`
                    : `Unhidden "${selectedCtxGame.title}".`,
                    "info"
                  );
                }
              });

              // PREFIX EXE MODAL HANDLERS
              document.getElementById("btn-browse-prefix-exe")?.addEventListener("click", async () => {
                const invoke = getInvoke();
                if (!invoke) return;
                try {
                  const path = await invoke("select_file_dialog");
                  if (path) document.getElementById("prefix-exe-path").value = path;
                } catch (err) {
                  showToast("Eroare selecție fișier: " + err, "error");
                }
              });

              document.getElementById("btn-run-prefix-exe")?.addEventListener("click", async () => {
                const invoke = getInvoke();
                const exePath = document.getElementById("prefix-exe-path").value.trim();

                if (!exePath || !selectedPrefixGame) {
                  showToast("Selectează un fișier .exe valid!", "error");
                  return;
                }

                try {
                  await invoke("run_exe_in_prefix", {
                    exePath: exePath,
                    winePrefix: selectedPrefixGame.wine_prefix || null,
                    runnerPath: selectedPrefixGame.runner_path || null
                  });
                  showToast("Executabilul a fost lansat în prefix!", "success");
                  closeModalAnimated("prefix-exe-modal");
                } catch (err) {
                  showToast("Eroare la lansare: " + err, "error");
                }
              });

              document.getElementById("btn-close-prefix-modal")?.addEventListener("click", () => { closeModalAnimated("prefix-exe-modal"); });
              document.getElementById("btn-close-prefix-x")?.addEventListener("click", () => { closeModalAnimated("prefix-exe-modal"); });

              // INSTALLER MODAL
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
                  showToast("Eroare la deschiderea dialogului de fișiere: " + err, "error");
                }
              });

              document.getElementById("btn-start-install")?.addEventListener("click", async () => {
                const title = document.getElementById("inst-title").value.trim();
                const installerPath = document.getElementById("inst-exepath").value.trim();
                const runnerPath = document.getElementById("inst-runner").value;

                if (!title || !installerPath) {
                  showToast("Completați numele jocului și fișierul installer!", "error");
                  return;
                }

                closeModalAnimated("installer-modal");
                showToast(`Se rulează installer-ul pentru "${title}". Parcurgeți pașii de pe ecran...`, "info");

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
                    showToast(`"${title}" a fost instalat și adăugat în librărie!`, "success");
                    fetchCoverForGame(newGame);
                  } else {
                    showToast(res.message || "Instalarea a fost anulată.", "info");
                  }
                } catch (err) {
                  showToast("Eroare la instalare: " + err, "error");
                }
              });

              // BIG PICTURE EXIT
              const exitBigPicture = async () => {
                if (!isBigPicture) return;
                isBigPicture = false;
                document.getElementById("big-picture-view")?.classList.add("hidden");
                document.getElementById("desktop-mode-view")?.classList.remove("hidden");
                await setFullscreenMode(false);
                renderGames();
              };

              document.addEventListener("fullscreenchange", () => {
                if (!document.fullscreenElement && isBigPicture) exitBigPicture();
              });

                // SOURCES & LOGINS
                document.getElementById("btn-login-epic")?.addEventListener("click", () => { openModalAnimated("epic-login-modal"); });
                document.getElementById("btn-login-steam")?.addEventListener("click", () => {
                  showToast("Steam path auto-detected! Click Sync All to refresh.", "info");
                  syncExternalGames();
                });
                document.getElementById("btn-login-gog")?.addEventListener("click", () => {
                  showToast("GOG login integration coming soon! Use Heroic Sync for now.", "info");
                });

                document.getElementById("btn-scan-lutris")?.addEventListener("click", async () => {
                  showToast("Scanning Lutris library...", "info");
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
                      showToast(`Imported ${added} new game(s) from Lutris!`, "success");
                    } else {
                      showToast("No new Lutris games found in default paths.", "info");
                    }
                  } catch (err) {
                    showToast("Lutris scan error: " + err, "error");
                  }
                });

                document.getElementById("close-epic-modal")?.addEventListener("click", () => { closeModalAnimated("epic-login-modal"); });
                document.getElementById("epic-login-modal")?.addEventListener("click", (e) => {
                  if (e.target.id === "epic-login-modal") closeModalAnimated("epic-login-modal");
                });

                  document.getElementById("btn-submit-epic-auth")?.addEventListener("click", async () => {
                    const code = document.getElementById("inp-epic-code").value.trim();
                    if (!code) {
                      showToast("Please enter an authorization code!", "error");
                      return;
                    }

                    const invoke = getInvoke();
                    if (!invoke) return;

                    try {
                      const res = await invoke("login_epic_games", { authCode: code });
                      showToast(res, "success");
                      closeModalAnimated("epic-login-modal");
                      await syncExternalGames();
                    } catch (err) {
                      showToast(err, "error");
                    }
                  });

                  // MODALS GENERALE
                  document.getElementById("btn-add-game")?.addEventListener("click", () => { openEditModal(null); });
                  document.getElementById("close-modal")?.addEventListener("click", () => { closeModalAnimated("game-modal"); });
                  document.getElementById("close-tags-modal")?.addEventListener("click", () => { closeModalAnimated("tags-modal"); });

                  document.getElementById("btn-save-tags")?.addEventListener("click", async () => {
                    if (selectedCtxGame) {
                      const inp = document.getElementById("inp-tags-list").value;
                      const tagArray = inp.split(",").map(t => t.trim()).filter(t => t.length > 0);
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
                      const current = inp.value.split(",").map(t => t.trim()).filter(t => t.length > 0);
                      if (!current.includes(tagText)) {
                        current.push(tagText);
                        inp.value = current.join(", ");
                      }
                    });
                  });

                  document.getElementById("btn-open-runners")?.addEventListener("click", () => {
                    const container = document.getElementById("runners-list-container");
                    if (container) {
                      container.innerHTML = availableRunners.map(r => `
                      <div class="p-3 bg-slate-900 rounded-xl border border-slate-800 text-xs">
                      <div class="font-bold text-cyan-400">${r.name}</div>
                      <div class="text-[10px] font-mono text-slate-400 truncate mt-0.5">${r.path}</div>
                      </div>
                      `).join("");
                    }
                    openModalAnimated("runners-modal");
                  });
                  document.getElementById("close-runners-modal")?.addEventListener("click", () => { closeModalAnimated("runners-modal"); });

                  document.getElementById("btn-open-config")?.addEventListener("click", () => { openModalAnimated("config-modal"); });
                  document.getElementById("close-config-modal")?.addEventListener("click", () => { closeModalAnimated("config-modal"); });

                  document.querySelectorAll("[data-source-sync]").forEach(btn => {
                    btn.addEventListener("click", () => { syncExternalGames(); });
                  });

                  document.querySelectorAll(".cfg-tab").forEach(tab => {
                    tab.addEventListener("click", () => {
                      document.querySelectorAll(".cfg-tab").forEach(t => {
                        t.classList.remove("active", "text-indigo-400", "bg-indigo-950/60", "border", "border-indigo-800/50");
                        t.classList.add("text-slate-400");
                      });

                      tab.classList.add("active", "text-indigo-400", "bg-indigo-950/60", "border", "border-indigo-800/50");
                      tab.classList.remove("text-slate-400");

                      document.querySelectorAll(".cfg-content").forEach(c => c.classList.add("hidden"));
                      const target = tab.dataset.cfgTab;
                      const contentEl = document.getElementById(`cfg-content-${target}`);
                      if (contentEl) contentEl.classList.remove("hidden");
                    });
                  });

                  document.getElementById("btn-save-config")?.addEventListener("click", () => { closeModalAnimated("config-modal"); });

                  document.getElementById("select-sort")?.addEventListener("change", (e) => {
                    selectedSort = e.target.value;
                    renderGames();
                  });

                  document.getElementById("btn-view-grid")?.addEventListener("click", () => {
                    viewMode = "grid";
                    renderGames();
                  });
                  document.getElementById("btn-view-list")?.addEventListener("click", () => {
                    viewMode = "list";
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
                      showToast("Eroare la deschiderea dialogului de fișiere: " + err, "error");
                    }
                  });

                  document.getElementById("btn-save-game")?.addEventListener("click", async () => {
                    const title = document.getElementById("inp-title").value.trim();
                    const exe_path = document.getElementById("inp-exepath").value.trim();
                    const runner_path = document.getElementById("select-runner").value;
                    const wine_prefix = document.getElementById("inp-wineprefix").value.trim();
                    const launch_args = document.getElementById("inp-args").value.trim();
                    const cover_url = document.getElementById("inp-cover").value.trim();
                    const use_gamemode = document.getElementById("chk-gamemode").checked;
                    const use_mangohud = document.getElementById("chk-mangohud").checked;

                    if (!title || !exe_path) {
                      showToast("Please fill in title and file path!", "error");
                      return;
                    }

                    if (editingGameId) {
                      const game = games.find(g => g.id === editingGameId);
                      if (game) {
                        game.title = title;
                        game.exe_path = exe_path;
                        game.runner_path = runner_path;
                        game.wine_prefix = wine_prefix;
                        game.launch_args = launch_args;
                        game.cover_url = cover_url;
                        game.use_gamemode = use_gamemode;
                        game.use_mangohud = use_mangohud;
                      }
                    } else {
                      games.push({
                        id: Date.now().toString(),
                                 title, exe_path, runner_path, wine_prefix, launch_args, use_gamemode, use_mangohud, cover_url, banner_url: cover_url, genre: "Action", source: "custom", favorite: false, hidden: false, tags: []
                      });
                    }

                    await saveGamesToDisk();
                    renderGames();
                    renderSidebarTags();
                    closeModalAnimated("game-modal");
                  });

                  document.getElementById("bp-btn-play")?.addEventListener("click", () => {
                    let bpGames = games.filter(g => !isToolOrRuntime(g.title) && !g.hidden);
                    if (bpTab === "favorites") bpGames = bpGames.filter(g => g.favorite);
                    if (bpGames[bpIndex]) launchGame(bpGames[bpIndex]);
                  });

                    document.querySelectorAll(".bp-nav-tab").forEach(tab => {
                      tab.addEventListener("click", () => {
                        document.querySelectorAll(".bp-nav-tab").forEach(t => t.classList.remove("active", "bg-indigo-600", "text-white"));
                        tab.classList.add("active", "bg-indigo-600", "text-white");
                        bpTab = tab.dataset.bpTab;
                        bpIndex = 0;
                        renderBigPicture();
                      });
                    });

                    document.querySelectorAll(".nav-tab").forEach(tab => {
                      tab.addEventListener("click", () => {
                        document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active", "bg-indigo-950/40", "text-indigo-400", "border-indigo-800/40"));
                        tab.classList.add("active", "bg-indigo-950/40", "text-indigo-400", "border-indigo-800/40");
                        activeTab = tab.dataset.tab;
                        selectedTagFilter = "all";
                        renderSidebarTags();
                        renderGames();
                      });
                    });

                    document.getElementById("game-search-input")?.addEventListener("input", (e) => {
                      const term = e.target.value.toLowerCase();
                      const filtered = games.filter(g => !isToolOrRuntime(g.title) && g.title.toLowerCase().includes(term));
                      renderGamesWithFilter(filtered);
                    });

                    document.getElementById("btn-toggle-mode")?.addEventListener("click", async () => {
                      isBigPicture = true;
                      document.getElementById("desktop-mode-view")?.classList.add("hidden");
                      document.getElementById("big-picture-view")?.classList.remove("hidden");
                      await setFullscreenMode(true);
                      renderBigPicture();
                    });

                    document.getElementById("btn-exit-bigpicture")?.addEventListener("click", () => { exitBigPicture(); });

                    window.addEventListener("keydown", async (e) => {
                      if (e.key === "Escape" && isBigPicture) {
                        e.preventDefault();
                        await exitBigPicture();
                      }

                      if (e.key === "F11") {
                        e.preventDefault();
                        if (isBigPicture) exitBigPicture();
                        else document.getElementById("btn-toggle-mode")?.click();
                      }

                      if (isBigPicture) {
                        let bpGames = games.filter(g => !isToolOrRuntime(g.title) && !g.hidden);
                        if (bpTab === "favorites") bpGames = bpGames.filter(g => g.favorite);

                        if (bpGames.length > 0) {
                          const key = e.key.toLowerCase();
                          if (key === "arrowright" || key === "d") {
                            e.preventDefault();
                            bpIndex = (bpIndex + 1) % bpGames.length;
                            renderBigPicture();
                          } else if (key === "arrowleft" || key === "a") {
                            e.preventDefault();
                            bpIndex = (bpIndex - 1 + bpGames.length) % bpGames.length;
                            renderBigPicture();
                          } else if (key === "enter") {
                            e.preventDefault();
                            if (bpGames[bpIndex]) launchGame(bpGames[bpIndex]);
                          }
                        }
                      }
                    });
}

// Redenumire Tag în toate jocurile
async function renameGlobalTag(oldTag) {
  const newTag = prompt(`Redenumește tag-ul "${oldTag}":`, oldTag);
  if (!newTag || newTag.trim() === "" || newTag === oldTag) return;

  const cleanNewTag = newTag.trim();
  games.forEach(g => {
    if (g.tags && Array.isArray(g.tags)) {
      g.tags = g.tags.map(t => t === oldTag ? cleanNewTag : t);
    }
  });

  if (selectedTagFilter === oldTag) selectedTagFilter = cleanNewTag;
  await saveGamesToDisk();
  renderGames();
  renderSidebarTags();
  showToast(`Tag-ul "${oldTag}" a fost redenumit în "${cleanNewTag}".`, "success");
}

// Ștergere Tag din toate jocurile
async function deleteGlobalTag(tagToDelete) {
  if (!confirm(`Sigur vrei să ștergi tag-ul "${tagToDelete}" din toate jocurile?`)) return;

  games.forEach(g => {
    if (g.tags && Array.isArray(g.tags)) {
      g.tags = g.tags.filter(t => t !== tagToDelete);
    }
  });

  if (selectedTagFilter === tagToDelete) selectedTagFilter = "all";
  await saveGamesToDisk();
  renderGames();
  renderSidebarTags();
  showToast(`Tag-ul "${tagToDelete}" a fost șters.`, "info");
}

function renderGamesWithFilter(filteredList) {
  const container = document.getElementById("games-container");
  if (!container) return;
  container.innerHTML = "";
  filteredList.forEach(game => {
    const card = document.createElement("div");
    card.className = "glass-card card-glow-hover group relative rounded-2xl cursor-pointer w-full flex flex-col border border-slate-800/80 transform-gpu";
    const coverImg = game.cover_url || "https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=600&q=80";
    card.innerHTML = `
    <div class="relative w-full aspect-[3/4] overflow-hidden bg-slate-900">
    <img src="${coverImg}" class="w-full h-full object-cover">
    <div class="absolute inset-0 bg-slate-950/70 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
    <button class="btn-play p-3 rounded-full bg-emerald-500 text-slate-950 hover:scale-110 transition shadow-lg"><i data-lucide="play" class="w-5 h-5 fill-current"></i></button>
    </div>
    </div>
    <div class="p-3 bg-slate-900/80">
    <h3 class="font-bold text-sm text-slate-200 truncate">${game.title}</h3>
    </div>
    `;
    card.querySelector(".btn-play").addEventListener("click", () => launchGame(game));
    container.appendChild(card);
  });
  if (window.lucide) window.lucide.createIcons();
}

// ==========================================
// GAMEPAD / CONTROLLER NAVIGATION ENGINE
// ==========================================
let gamepadLoopId = null;
let lastPadState = {
  left: false, right: false, up: false, down: false,
  btnA: false, btnB: false, btnX: false, btnY: false,
  lb: false, rb: false
};

function startGamepadLoop() {
  if (gamepadLoopId) return;

  const updateGamepad = () => {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(gamepads).find(p => p !== null);

    if (pad && isBigPicture) {
      const axisX = pad.axes[0] || 0;
      const axisY = pad.axes[1] || 0;

      const dpadUp = pad.buttons[12]?.pressed || axisY < -0.5;
      const dpadDown = pad.buttons[13]?.pressed || axisY > 0.5;
      const dpadLeft = pad.buttons[14]?.pressed || axisX < -0.5;
      const dpadRight = pad.buttons[15]?.pressed || axisX > 0.5;

      const btnA = pad.buttons[0]?.pressed;
      const btnB = pad.buttons[1]?.pressed;
      const btnX = pad.buttons[2]?.pressed;
      const btnY = pad.buttons[3]?.pressed;
      const lb = pad.buttons[4]?.pressed;
      const rb = pad.buttons[5]?.pressed;

      let bpGames = games.filter(g => !isToolOrRuntime(g.title) && !g.hidden);
      if (bpTab === "favorites") bpGames = bpGames.filter(g => g.favorite);

      if (dpadLeft && !lastPadState.left) {
        if (bpGames.length > 0) {
          bpIndex = (bpIndex - 1 + bpGames.length) % bpGames.length;
          renderBigPicture();
        }
      }

      if (dpadRight && !lastPadState.right) {
        if (bpGames.length > 0) {
          bpIndex = (bpIndex + 1) % bpGames.length;
          renderBigPicture();
        }
      }

      if (lb && !lastPadState.lb) {
        bpTab = "all";
        bpIndex = 0;
        updateBpTabUi();
        renderBigPicture();
      }
      if (rb && !lastPadState.rb) {
        bpTab = "favorites";
        bpIndex = 0;
        updateBpTabUi();
        renderBigPicture();
      }

      if (btnA && !lastPadState.btnA) {
        if (bpGames[bpIndex]) launchGame(bpGames[bpIndex]);
      }

      if (btnB && !lastPadState.btnB) {
        document.getElementById("btn-exit-bigpicture")?.click();
      }

      if (btnX && !lastPadState.btnX) {
        if (bpGames[bpIndex]) openEditModal(bpGames[bpIndex]);
      }

      lastPadState = { left: dpadLeft, right: dpadRight, up: dpadUp, down: dpadDown, btnA, btnB, btnX, btnY, lb, rb };
    }

    gamepadLoopId = requestAnimationFrame(updateGamepad);
  };

  gamepadLoopId = requestAnimationFrame(updateGamepad);
}

function updateBpTabUi() {
  document.querySelectorAll(".bp-nav-tab").forEach(t => {
    if (t.dataset.bpTab === bpTab) {
      t.classList.add("active", "bg-indigo-600", "text-white");
    } else {
      t.classList.remove("active", "bg-indigo-600", "text-white");
    }
  });
}

window.addEventListener("gamepadconnected", (e) => {
  showToast(`Controller conectat: ${e.gamepad.id}`, "success");
  startGamepadLoop();
});

startGamepadLoop();
