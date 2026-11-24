// themeEngine.js
export const THEME_PRESETS = {
    // === DARK THEMES ===
    "nexus-default": {
        id: "nexus-default",
        name: "Nexus Dark (Default)",
        mode: "dark",
        bgPrimary: "#020617",     // slate-950
        bgSecondary: "#0f172a",   // slate-900
        bgCard: "#0f172a",
        textPrimary: "#f8fafc",
        textSecondary: "#94a3b8",
        border: "#1e293b",
        accentPrimary: "#6366f1", // indigo-500
        accentSecondary: "#06b6d4", // cyan-500
        glowColor: "#a855f7",     // purple-500
        logoStart: "#a855f7",
        logoMid: "#4f46e5",
        logoEnd: "#06b6d4",
        pattern: "none"
    },
    "cyber-crimson": {
        id: "cyber-crimson",
        name: "Cyber Crimson",
        mode: "dark",
        bgPrimary: "#090408",
        bgSecondary: "#160a12",
        bgCard: "#180b14",
        textPrimary: "#fff1f2",
        textSecondary: "#fda4af",
        border: "#3b1226",
        accentPrimary: "#e11d48",
        accentSecondary: "#f97316",
        glowColor: "#f43f5e",
        logoStart: "#f43f5e",
        logoMid: "#be123c",
        logoEnd: "#fb923c",
        pattern: "grid"
    },
    "emerald-matrix": {
        id: "emerald-matrix",
        name: "Emerald Matrix",
        mode: "dark",
        bgPrimary: "#020c08",
        bgSecondary: "#061c14",
        bgCard: "#072017",
        textPrimary: "#ecfdf5",
        textSecondary: "#6ee7b7",
        border: "#064e3b",
        accentPrimary: "#10b981",
        accentSecondary: "#22d3ee",
        glowColor: "#34d399",
        logoStart: "#10b981",
        logoMid: "#059669",
        logoEnd: "#06b6d4",
        pattern: "dots"
    },
    "nordic-frost": {
        id: "nordic-frost",
        name: "Nordic Frost",
        mode: "dark",
        bgPrimary: "#191d24",
        bgSecondary: "#242933",
        bgCard: "#2e3440",
        textPrimary: "#eceff4",
        textSecondary: "#d8dee9",
        border: "#3b4252",
        accentPrimary: "#5e81ac",
        accentSecondary: "#88c0d0",
        glowColor: "#81a1c1",
        logoStart: "#88c0d0",
        logoMid: "#5e81ac",
        logoEnd: "#b48ead",
        pattern: "none"
    },

    // === LIGHT THEMES ===
    "daylight-clean": {
        id: "daylight-clean",
        name: "Daylight Clean",
        mode: "light",
        bgPrimary: "#f1f5f9",
        bgSecondary: "#ffffff",
        bgCard: "#ffffff",
        textPrimary: "#0f172a",
        textSecondary: "#475569",
        border: "#cbd5e1",
        accentPrimary: "#4f46e5",
        accentSecondary: "#0284c7",
        glowColor: "#7c3aed",
        logoStart: "#9333ea",
        logoMid: "#4f46e5",
        logoEnd: "#06b6d4",
        pattern: "none"
    },
    "sakura-blossom": {
        id: "sakura-blossom",
        name: "Sakura Blossom",
        mode: "light",
        bgPrimary: "#fdf2f8",
        bgSecondary: "#ffffff",
        bgCard: "#ffffff",
        textPrimary: "#500724",
        textSecondary: "#9d174d",
        border: "#fbcfe8",
        accentPrimary: "#db2777",
        accentSecondary: "#f43f5e",
        glowColor: "#ec4899",
        logoStart: "#f472b6",
        logoMid: "#db2777",
        logoEnd: "#fb7185",
        pattern: "dots"
    },
    "mint-breeze": {
        id: "mint-breeze",
        name: "Mint Breeze",
        mode: "light",
        bgPrimary: "#ecfdf5",
        bgSecondary: "#ffffff",
        bgCard: "#ffffff",
        textPrimary: "#064e3b",
        textSecondary: "#047857",
        border: "#a7f3d0",
        accentPrimary: "#059669",
        accentSecondary: "#0d9488",
        glowColor: "#10b981",
        logoStart: "#34d399",
        logoMid: "#059669",
        logoEnd: "#06b6d4",
        pattern: "diagonal"
    }
};

export const BACKGROUND_PATTERNS = {
    none: "none",
    dots: "radial-gradient(rgba(var(--nd-accent-sec-rgb), 0.18) 1.3px, transparent 1.3px)",
    "dots-dense": "radial-gradient(rgba(var(--nd-accent-sec-rgb), 0.15) 1px, transparent 1px)",
    grid: "linear-gradient(to right, rgba(var(--nd-accent-sec-rgb), 0.09) 1px, transparent 1px), linear-gradient(to bottom, rgba(var(--nd-accent-sec-rgb), 0.09) 1px, transparent 1px)",
    "blueprint-grid": "linear-gradient(to right, rgba(var(--nd-accent-sec-rgb), 0.14) 1px, transparent 1px), linear-gradient(to bottom, rgba(var(--nd-accent-sec-rgb), 0.14) 1px, transparent 1px), linear-gradient(to right, rgba(var(--nd-accent-sec-rgb), 0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(var(--nd-accent-sec-rgb), 0.05) 1px, transparent 1px)",
    diagonal: "repeating-linear-gradient(45deg, rgba(var(--nd-accent-sec-rgb), 0.07) 0px, rgba(var(--nd-accent-sec-rgb), 0.07) 2px, transparent 2px, transparent 12px)",
    crosshatch: "repeating-linear-gradient(45deg, rgba(var(--nd-accent-sec-rgb), 0.06) 0px, rgba(var(--nd-accent-sec-rgb), 0.06) 1px, transparent 1px, transparent 14px), repeating-linear-gradient(-45deg, rgba(var(--nd-accent-sec-rgb), 0.06) 0px, rgba(var(--nd-accent-sec-rgb), 0.06) 1px, transparent 1px, transparent 14px)",
    scanlines: "repeating-linear-gradient(to bottom, rgba(var(--nd-accent-sec-rgb), 0.08) 0px, rgba(var(--nd-accent-sec-rgb), 0.08) 1px, transparent 1px, transparent 4px)",
    carbon: "radial-gradient(rgba(var(--nd-accent-sec-rgb), 0.14) 15%, transparent 16%), radial-gradient(rgba(var(--nd-glow-rgb), 0.14) 15%, transparent 16%)",
    plus: "radial-gradient(circle, rgba(var(--nd-accent-sec-rgb), 0.2) 1.5px, transparent 1.5px), linear-gradient(to right, rgba(var(--nd-accent-sec-rgb), 0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(var(--nd-accent-sec-rgb), 0.06) 1px, transparent 1px)"
};

export const PATTERN_LABELS = {
    none: "None",
    dots: "Dots",
    "dots-dense": "Fine Dots",
    grid: "Grid",
    "blueprint-grid": "Blueprint",
    diagonal: "Diagonal",
    crosshatch: "Crosshatch",
    scanlines: "Scanlines",
    carbon: "Carbon",
    plus: "Tech Plus"
};

export const PATTERN_SIZES = {
    none: "auto",
    dots: "22px 22px",
    "dots-dense": "12px 12px",
    grid: "28px 28px",
    "blueprint-grid": "64px 64px, 64px 64px, 16px 16px, 16px 16px",
    diagonal: "auto",
    crosshatch: "auto",
    scanlines: "auto",
    carbon: "16px 16px",
    plus: "26px 26px"
};

function hexToRgb(hex) {
    const clean = (hex || "#6366f1").replace("#", "");
    const full = clean.length === 3 ? clean.split("").map(c => c + c).join("") : clean;
    const num = parseInt(full, 16);
    if (isNaN(num)) return "99, 102, 241";
    return `${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}`;
}

export function getSavedThemeConfig() {
    try {
        const raw = localStorage.getItem("nexus_theme_config");
        if (raw) {
            return { ...THEME_PRESETS["nexus-default"], ...JSON.parse(raw) };
        }
    } catch (e) {
        console.error("Failed to parse theme config:", e);
    }
    return { ...THEME_PRESETS["nexus-default"] };
}

export function applyThemeConfig(config) {
    const theme = { ...THEME_PRESETS["nexus-default"], ...config };
    const root = document.documentElement;

    // Toggle clasa light/dark pentru compatibilitate cu restul elementelor
    if (theme.mode === "light") {
        root.classList.add("theme-light");
        root.classList.remove("dark");
    } else {
        root.classList.remove("theme-light");
        root.classList.add("dark");
    }

    // Injectare variabile CSS globale
    root.style.setProperty("--nd-bg-primary", theme.bgPrimary);
    root.style.setProperty("--nd-bg-secondary", theme.bgSecondary);
    root.style.setProperty("--nd-bg-card", theme.bgCard);
    root.style.setProperty("--nd-text-primary", theme.textPrimary);
    root.style.setProperty("--nd-text-secondary", theme.textSecondary);
    root.style.setProperty("--nd-border", theme.border);

    root.style.setProperty("--nd-accent", theme.accentPrimary);
    root.style.setProperty("--nd-accent-secondary", theme.accentSecondary);
    root.style.setProperty("--nd-glow", theme.glowColor);


    // Variante RGB pentru transparențe (glassmorphism, hover glow, shadows)
    root.style.setProperty("--nd-bg-primary-rgb", hexToRgb(theme.bgPrimary));
    root.style.setProperty("--nd-bg-secondary-rgb", hexToRgb(theme.bgSecondary));
    root.style.setProperty("--nd-bg-card-rgb", hexToRgb(theme.bgCard));
    root.style.setProperty("--nd-accent-rgb", hexToRgb(theme.accentPrimary));
    root.style.setProperty("--nd-accent-sec-rgb", hexToRgb(theme.accentSecondary));
    root.style.setProperty("--nd-glow-rgb", hexToRgb(theme.glowColor));

    // Pattern de fundal
    const pat = BACKGROUND_PATTERNS[theme.pattern] || "none";
    const patSize = PATTERN_SIZES[theme.pattern] || "auto";
    root.style.setProperty("--nd-bg-pattern", pat);
    root.style.setProperty("--nd-bg-pattern-size", patSize);

    // Actualizare gradient SVG pentru Logo (atât în Top Bar, cât și în Big Picture & About Modal)
    const logoGrad = document.getElementById("nexus-grad");
    if (logoGrad) {
        const stops = logoGrad.querySelectorAll("stop");
        if (stops[0]) stops[0].setAttribute("stop-color", theme.logoStart || theme.glowColor);
        if (stops[1]) stops[1].setAttribute("stop-color", theme.logoMid || theme.accentPrimary);
        if (stops[2]) stops[2].setAttribute("stop-color", theme.logoEnd || theme.accentSecondary);
    }

    localStorage.setItem("nexus_theme_config", JSON.stringify(theme));
    return theme;
}

export function exportThemeJson(theme) {
    const payload = {
        schema: "nexusdeck-theme-v1",
        exported_at: new Date().toISOString(),
        theme
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeName = (theme.name || "custom-theme").toLowerCase().replace(/[^a-z0-9-_]/g, "_");
    a.href = url;
    a.download = `${safeName}.nexustheme.json`;
    a.click();
    URL.revokeObjectURL(url);
}

export function parseImportedThemeJson(jsonText) {
    const parsed = JSON.parse(jsonText);
    const data = parsed.theme ? parsed.theme : parsed;
    if (!data.bgPrimary || !data.accentPrimary) {
        throw new Error("Invalid theme JSON format");
    }
    return {
        ...THEME_PRESETS["nexus-default"],
        ...data,
        id: data.id || `custom_${Date.now()}`,
        name: data.name || "Imported Theme"
    };
}

const CUSTOM_THEMES_STORAGE_KEY = "nexus_custom_themes";

export function getSavedCustomThemes() {
    try {
        const raw = localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.error("Failed to parse custom themes:", e);
        return [];
    }
}

export function saveCustomTheme(theme) {
    const list = getSavedCustomThemes();
    const isExistingCustom = theme.id && theme.id.startsWith("custom_") && list.some(t => t.id === theme.id);
    const id = isExistingCustom ? theme.id : `custom_${Date.now()}`;

    const entry = {
        ...THEME_PRESETS["nexus-default"],
        ...theme,
        id,
        name: (theme.name || "My Custom Theme").trim()
    };

    const idx = list.findIndex(t => t.id === id);
    if (idx >= 0) {
        list[idx] = entry;
    } else {
        list.push(entry);
    }

    localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(list));
    return entry;
}

export function deleteCustomTheme(themeId) {
    const list = getSavedCustomThemes().filter(t => t.id !== themeId);
    localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(list));
    return list;
}
