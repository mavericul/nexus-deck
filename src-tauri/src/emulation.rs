//! Suport pentru emulatoare: definiții de sisteme și emulatoare, detectarea emulatoarelor instalate,
//! configurația (folderul de ROM-uri, emulatorul implicit per sistem), scanarea ROM-urilor și
//! construirea comenzii de lansare.
//!
//! Convenția de foldere e cea din ES-DE / RetroDECK: `<rom_root>/<sistem>/...` (ex. `~/ROMs/snes`),
//! ca să funcționeze direct cu colecțiile existente. Fiecare sistem poate avea și un folder propriu.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

// -----------------------------------------------------------------------------
// DEFINIȚII
// -----------------------------------------------------------------------------

pub struct EmulatorDef {
    pub id: &'static str,
    /// Executabile Windows căutate în folderele de emulatoare; pe Linux rulează prin Wine / Proton
    pub windows_exes: &'static [&'static str],
    pub name: &'static str,
    /// Executabile căutate în PATH (în ordine)
    pub bins: &'static [&'static str],
    /// ID-uri Flatpak (în ordine)
    pub flatpaks: &'static [&'static str],
    /// Fragment de nume pentru AppImage-uri din ~/Applications, ~/.local/bin etc. (minuscule)
    pub appimage_hint: &'static str,
    /// Argumentele de lansare; `{rom}` e înlocuit cu calea ROM-ului
    pub args: &'static [&'static str],
}

pub const EMULATORS: &[EmulatorDef] = &[
    EmulatorDef {
        id: "retroarch",
        windows_exes: &[],
        name: "RetroArch",
        bins: &["retroarch"],
        flatpaks: &["org.libretro.RetroArch"],
        appimage_hint: "retroarch",
        args: &["-f", "{rom}"], // core-ul se adaugă separat (-L)
    },
    EmulatorDef {
        id: "duckstation",
        windows_exes: &[],
        name: "DuckStation",
        bins: &["duckstation-qt", "duckstation"],
        flatpaks: &["org.duckstation.DuckStation"],
        appimage_hint: "duckstation",
        args: &["-fullscreen", "-batch", "--", "{rom}"],
    },
    EmulatorDef {
        id: "pcsx2",
        windows_exes: &[],
        name: "PCSX2",
        bins: &["pcsx2-qt", "pcsx2"],
        flatpaks: &["net.pcsx2.PCSX2"],
        appimage_hint: "pcsx2",
        args: &["-fullscreen", "-nogui", "--", "{rom}"],
    },
    EmulatorDef {
        id: "rpcs3",
        windows_exes: &[],
        name: "RPCS3",
        bins: &["rpcs3"],
        flatpaks: &["net.rpcs3.RPCS3"],
        appimage_hint: "rpcs3",
        args: &["--no-gui", "{rom}"],
    },
    EmulatorDef {
        id: "ppsspp",
        windows_exes: &[],
        name: "PPSSPP",
        bins: &["PPSSPPSDL", "ppsspp", "PPSSPPQt"],
        flatpaks: &["org.ppsspp.PPSSPP"],
        appimage_hint: "ppsspp",
        args: &["--fullscreen", "{rom}"],
    },
    EmulatorDef {
        id: "dolphin",
        windows_exes: &[],
        name: "Dolphin",
        bins: &["dolphin-emu"],
        flatpaks: &["org.DolphinEmu.dolphin-emu"],
        appimage_hint: "dolphin",
        args: &["-b", "-e", "{rom}"],
    },
    EmulatorDef {
        id: "cemu",
        windows_exes: &[],
        name: "Cemu",
        bins: &["cemu", "Cemu"],
        flatpaks: &["info.cemu.Cemu"],
        appimage_hint: "cemu",
        args: &["-f", "-g", "{rom}"],
    },
    EmulatorDef {
        id: "ryujinx",
        windows_exes: &[],
        name: "Ryujinx",
        bins: &["Ryujinx", "ryujinx"],
        flatpaks: &["io.github.ryubing.Ryujinx", "org.ryujinx.Ryujinx"],
        appimage_hint: "ryujinx",
        args: &["--fullscreen", "{rom}"],
    },
    EmulatorDef {
        id: "melonds",
        windows_exes: &[],
        name: "melonDS",
        bins: &["melonDS", "melonds"],
        flatpaks: &["net.kuribo64.melonDS"],
        appimage_hint: "melonds",
        args: &["-f", "{rom}"],
    },
    EmulatorDef {
        id: "xemu",
        windows_exes: &[],
        name: "xemu",
        bins: &["xemu"],
        flatpaks: &["app.xemu.xemu"],
        appimage_hint: "xemu",
        args: &["-full-screen", "-dvd_path", "{rom}"],
    },
    EmulatorDef {
        id: "xenia",
        // Xenia Canary: build-ul de Linux (experimental) sau cel de Windows, prin Proton (umu) / Wine
        windows_exes: &["xenia_canary.exe", "xenia.exe"],
        name: "Xenia",
        bins: &["xenia_canary", "xenia-canary", "xenia"],
        flatpaks: &[],
        appimage_hint: "xenia",
        args: &["--fullscreen", "{rom}"],
    },
];

pub struct SystemDef {
    /// Numele folderului (convenția ES-DE) și ID-ul sistemului
    pub id: &'static str,
    pub name: &'static str,
    /// Eticheta scurtă de pe carduri
    pub short: &'static str,
    pub extensions: &'static [&'static str],
    /// Emulatoarele potrivite, în ordinea preferinței (primul instalat devine implicit)
    pub emulators: &'static [&'static str],
    /// Core-uri RetroArch, în ordinea preferinței (fără sufixul `_libretro`)
    pub cores: &'static [&'static str],
    /// Numele playlist-ului libretro (pentru coperți de pe thumbnails.libretro.com)
    pub libretro_playlist: &'static str,
    /// Fișiere BIOS: e suficient să existe unul dintre ele (gol = nu e nevoie de BIOS)
    pub bios_any: &'static [&'static str],
}

pub const SYSTEMS: &[SystemDef] = &[
    SystemDef { id: "nes", name: "Nintendo Entertainment System", short: "NES",
        extensions: &["nes", "fds", "unf", "unif", "zip", "7z"], emulators: &["retroarch"],
        cores: &["mesen", "nestopia", "fceumm"], libretro_playlist: "Nintendo - Nintendo Entertainment System", bios_any: &[] },
    SystemDef { id: "snes", name: "Super Nintendo", short: "SNES",
        extensions: &["sfc", "smc", "fig", "swc", "bs", "zip", "7z"], emulators: &["retroarch"],
        cores: &["snes9x", "bsnes", "bsnes_hd_beta"], libretro_playlist: "Nintendo - Super Nintendo Entertainment System", bios_any: &[] },
    SystemDef { id: "n64", name: "Nintendo 64", short: "N64",
        extensions: &["n64", "z64", "v64", "zip", "7z"], emulators: &["retroarch"],
        cores: &["mupen64plus_next", "parallel_n64"], libretro_playlist: "Nintendo - Nintendo 64", bios_any: &[] },
    SystemDef { id: "gb", name: "Game Boy", short: "GB",
        extensions: &["gb", "zip", "7z"], emulators: &["retroarch"],
        cores: &["gambatte", "sameboy", "mgba"], libretro_playlist: "Nintendo - Game Boy", bios_any: &[] },
    SystemDef { id: "gbc", name: "Game Boy Color", short: "GBC",
        extensions: &["gbc", "zip", "7z"], emulators: &["retroarch"],
        cores: &["gambatte", "sameboy", "mgba"], libretro_playlist: "Nintendo - Game Boy Color", bios_any: &[] },
    SystemDef { id: "gba", name: "Game Boy Advance", short: "GBA",
        extensions: &["gba", "zip", "7z"], emulators: &["retroarch"],
        cores: &["mgba", "vba_next", "vbam"], libretro_playlist: "Nintendo - Game Boy Advance", bios_any: &[] },
    SystemDef { id: "nds", name: "Nintendo DS", short: "NDS",
        extensions: &["nds", "zip", "7z"], emulators: &["melonds", "retroarch"],
        cores: &["melondsds", "melonds", "desmume"], libretro_playlist: "Nintendo - Nintendo DS", bios_any: &[] },
    SystemDef { id: "gc", name: "Nintendo GameCube", short: "GC",
        extensions: &["iso", "gcm", "rvz", "gcz", "ciso"], emulators: &["dolphin", "retroarch"],
        cores: &["dolphin"], libretro_playlist: "Nintendo - GameCube", bios_any: &[] },
    SystemDef { id: "wii", name: "Nintendo Wii", short: "WII",
        extensions: &["iso", "wbfs", "rvz", "gcz", "wad"], emulators: &["dolphin", "retroarch"],
        cores: &["dolphin"], libretro_playlist: "Nintendo - Wii", bios_any: &[] },
    SystemDef { id: "wiiu", name: "Nintendo Wii U", short: "WII U",
        extensions: &["wud", "wux", "wua", "rpx"], emulators: &["cemu"],
        cores: &[], libretro_playlist: "Nintendo - Wii U", bios_any: &[] },
    SystemDef { id: "switch", name: "Nintendo Switch", short: "SWITCH",
        extensions: &["nsp", "xci"], emulators: &["ryujinx"],
        cores: &[], libretro_playlist: "Nintendo - Switch", bios_any: &[] },
    SystemDef { id: "psx", name: "PlayStation", short: "PS1",
        extensions: &["cue", "chd", "pbp", "m3u", "ecm"], emulators: &["duckstation", "retroarch"],
        cores: &["swanstation", "mednafen_psx_hw", "pcsx_rearmed"], libretro_playlist: "Sony - PlayStation",
        bios_any: &["scph5501.bin", "scph1001.bin", "scph7001.bin", "scph5500.bin", "scph5502.bin", "scph101.bin", "ps1_rom.bin"] },
    SystemDef { id: "ps2", name: "PlayStation 2", short: "PS2",
        extensions: &["iso", "chd", "cso", "gz", "bin"], emulators: &["pcsx2"],
        cores: &[], libretro_playlist: "Sony - PlayStation 2", bios_any: &["*"] },
    SystemDef { id: "ps3", name: "PlayStation 3", short: "PS3",
        extensions: &["iso"], emulators: &["rpcs3"],
        cores: &[], libretro_playlist: "Sony - PlayStation 3", bios_any: &[] },
    SystemDef { id: "psp", name: "PlayStation Portable", short: "PSP",
        extensions: &["iso", "cso", "pbp", "chd"], emulators: &["ppsspp", "retroarch"],
        cores: &["ppsspp"], libretro_playlist: "Sony - PlayStation Portable", bios_any: &[] },
    SystemDef { id: "megadrive", name: "Sega Mega Drive / Genesis", short: "MD",
        extensions: &["md", "gen", "smd", "bin", "zip", "7z"], emulators: &["retroarch"],
        cores: &["genesis_plus_gx", "picodrive"], libretro_playlist: "Sega - Mega Drive - Genesis", bios_any: &[] },
    SystemDef { id: "mastersystem", name: "Sega Master System", short: "SMS",
        extensions: &["sms", "zip", "7z"], emulators: &["retroarch"],
        cores: &["genesis_plus_gx", "picodrive"], libretro_playlist: "Sega - Master System - Mark III", bios_any: &[] },
    SystemDef { id: "gamegear", name: "Sega Game Gear", short: "GG",
        extensions: &["gg", "zip", "7z"], emulators: &["retroarch"],
        cores: &["genesis_plus_gx"], libretro_playlist: "Sega - Game Gear", bios_any: &[] },
    SystemDef { id: "segacd", name: "Sega CD", short: "SEGA CD",
        extensions: &["cue", "chd", "m3u"], emulators: &["retroarch"],
        cores: &["genesis_plus_gx", "picodrive"], libretro_playlist: "Sega - Mega-CD - Sega CD",
        bios_any: &["bios_CD_U.bin", "bios_CD_E.bin", "bios_CD_J.bin"] },
    SystemDef { id: "saturn", name: "Sega Saturn", short: "SATURN",
        extensions: &["cue", "chd", "m3u"], emulators: &["retroarch"],
        cores: &["mednafen_saturn", "yabasanshiro", "kronos"], libretro_playlist: "Sega - Saturn",
        bios_any: &["sega_101.bin", "mpr-17933.bin", "saturn_bios.bin"] },
    SystemDef { id: "dreamcast", name: "Sega Dreamcast", short: "DC",
        extensions: &["cdi", "gdi", "chd", "m3u"], emulators: &["retroarch"],
        cores: &["flycast"], libretro_playlist: "Sega - Dreamcast", bios_any: &[] },
    // xemu își alege singur fișierele de sistem (MCPX, BIOS, HDD) la prima pornire
    SystemDef { id: "xbox", name: "Microsoft Xbox", short: "XBOX",
        extensions: &["iso", "xiso"], emulators: &["xemu"],
        cores: &[], libretro_playlist: "Microsoft - Xbox", bios_any: &[] },
    SystemDef { id: "xbox360", name: "Microsoft Xbox 360", short: "X360",
        extensions: &["iso", "xex", "zar"], emulators: &["xenia"],
        cores: &[], libretro_playlist: "Microsoft - Xbox 360", bios_any: &[] },
];

pub fn system_def(id: &str) -> Option<&'static SystemDef> {
    SYSTEMS.iter().find(|s| s.id == id)
}

pub fn emulator_def(id: &str) -> Option<&'static EmulatorDef> {
    EMULATORS.iter().find(|e| e.id == id)
}

// -----------------------------------------------------------------------------
// CONFIGURAȚIE (~/.config/nexusdeck/emulation.json)
// -----------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct SystemConfig {
    /// Folder propriu pentru sistem (altfel `<rom_root>/<id>`)
    pub folder: Option<String>,
    /// Emulatorul implicit ales de utilizator (altfel primul instalat din listă)
    pub emulator: Option<String>,
    /// Core-ul RetroArch ales (altfel primul găsit)
    pub core: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(default)]
pub struct EmulationConfig {
    pub rom_root: String,
    pub systems: HashMap<String, SystemConfig>,
}

impl Default for EmulationConfig {
    fn default() -> Self {
        Self { rom_root: "~/ROMs".to_string(), systems: HashMap::new() }
    }
}

fn config_path() -> PathBuf {
    let mut dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("nexusdeck");
    let _ = fs::create_dir_all(&dir);
    dir.join("emulation.json")
}

pub fn load_config() -> EmulationConfig {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save_config(cfg: &EmulationConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let path = config_path();
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(tmp, path).map_err(|e| e.to_string())
}

fn expand_tilde(p: &str) -> PathBuf {
    let p = p.trim();
    if p == "~" || p.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(p.trim_start_matches('~').trim_start_matches('/'));
        }
    }
    PathBuf::from(p)
}

pub fn system_folder(cfg: &EmulationConfig, sys: &SystemDef) -> PathBuf {
    match cfg.systems.get(sys.id).and_then(|c| c.folder.as_deref()).filter(|f| !f.trim().is_empty()) {
        Some(folder) => expand_tilde(folder),
        None => expand_tilde(&cfg.rom_root).join(sys.id),
    }
}

// -----------------------------------------------------------------------------
// DETECTAREA EMULATOARELOR
// -----------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone, PartialEq)]
pub enum InstallKind {
    Native,
    Flatpak,
    AppImage,
    /// Executabil Windows rulat prin Proton (umu-run) sau Wine
    Wine,
}

#[derive(Serialize, Debug, Clone)]
pub struct InstalledEmulator {
    pub id: String,
    pub name: String,
    pub kind: InstallKind,
    /// Calea executabilului / AppImage-ului sau ID-ul Flatpak
    pub target: String,
}

fn find_in_path(bin: &str) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(target_os = "windows") { &[".exe", ""] } else { &[""] };
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths).find_map(|dir| {
        exts.iter()
            .map(|ext| dir.join(format!("{}{}", bin, ext)))
            .find(|p| p.is_file())
    })
}

fn installed_flatpaks() -> HashSet<String> {
    let mut set = HashSet::new();
    // Citire directă din folderele Flatpak (instant, fără `flatpak list`)
    let mut roots = vec![PathBuf::from("/var/lib/flatpak/app")];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".local/share/flatpak/app"));
    }
    for root in roots {
        if let Ok(entries) = fs::read_dir(root) {
            for e in entries.flatten() {
                set.insert(e.file_name().to_string_lossy().to_string());
            }
        }
    }
    set
}

fn appimage_dirs() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    vec![
        home.join("Applications"),
        home.join("AppImages"),
        home.join(".local/bin"),
        home.join("Emulation/tools"),
        home.join("Desktop"),
    ]
}

/// Caută un executabil Windows de emulator în folderele obișnuite și cu un nivel de subfoldere
/// (ex. `~/Applications/xenia_canary/xenia_canary.exe`).
fn find_windows_exe(names: &[&str]) -> Option<PathBuf> {
    if names.is_empty() {
        return None;
    }
    let home = dirs::home_dir()?;
    let mut roots = appimage_dirs();
    roots.push(home.join("Games"));
    roots.push(home.join(".local/share/xenia"));
    roots.push(home.join("Emulation"));
    let matches = |dir: &Path| -> Option<PathBuf> {
        let entries = fs::read_dir(dir).ok()?;
        entries.flatten().map(|e| e.path()).find(|p| {
            p.is_file()
                && p.file_name()
                    .map(|n| names.iter().any(|want| n.to_string_lossy().eq_ignore_ascii_case(want)))
                    .unwrap_or(false)
        })
    };
    for root in roots {
        if let Some(hit) = matches(&root) {
            return Some(hit);
        }
        let Ok(entries) = fs::read_dir(&root) else { continue };
        for sub in entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
            if let Some(hit) = matches(&sub) {
                return Some(hit);
            }
        }
    }
    None
}

/// Calea Windows (`Z:\...`) a unui fișier, pentru programele rulate prin Wine
fn wine_path(path: &str) -> String {
    format!("Z:{}", path.replace('/', "\\"))
}

pub fn detect_emulators() -> Vec<InstalledEmulator> {
    let flatpaks = installed_flatpaks();
    let appimages: Vec<PathBuf> = appimage_dirs()
        .into_iter()
        .filter_map(|d| fs::read_dir(d).ok())
        .flat_map(|it| it.flatten().map(|e| e.path()))
        .filter(|p| {
            p.extension()
                .map(|e| e.to_string_lossy().eq_ignore_ascii_case("appimage"))
                .unwrap_or(false)
        })
        .collect();

    let mut found = Vec::new();
    for emu in EMULATORS {
        if let Some(path) = emu.bins.iter().find_map(|b| find_in_path(b)) {
            found.push(InstalledEmulator {
                id: emu.id.into(),
                name: emu.name.into(),
                kind: InstallKind::Native,
                target: path.to_string_lossy().to_string(),
            });
            continue;
        }
        if let Some(fp) = emu.flatpaks.iter().find(|f| flatpaks.contains(**f)) {
            found.push(InstalledEmulator {
                id: emu.id.into(),
                name: emu.name.into(),
                kind: InstallKind::Flatpak,
                target: fp.to_string(),
            });
            continue;
        }
        if let Some(exe) = find_windows_exe(emu.windows_exes) {
            found.push(InstalledEmulator {
                id: emu.id.into(),
                name: emu.name.into(),
                // Pe Windows executabilul rulează direct
                kind: if cfg!(target_os = "windows") { InstallKind::Native } else { InstallKind::Wine },
                target: exe.to_string_lossy().to_string(),
            });
            continue;
        }
        if let Some(app) = appimages.iter().find(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().to_lowercase().contains(emu.appimage_hint))
                .unwrap_or(false)
        }) {
            found.push(InstalledEmulator {
                id: emu.id.into(),
                name: emu.name.into(),
                kind: InstallKind::AppImage,
                target: app.to_string_lossy().to_string(),
            });
        }
    }
    found
}

/// Emulatorul folosit efectiv pentru un sistem: cel ales de utilizator (dacă e instalat),
/// altfel primul instalat din lista de preferințe a sistemului.
pub fn resolve_emulator<'a>(
    sys: &SystemDef,
    preferred: Option<&str>,
    installed: &'a [InstalledEmulator],
) -> Option<&'a InstalledEmulator> {
    if let Some(p) = preferred.filter(|p| !p.is_empty()) {
        if let Some(e) = installed.iter().find(|e| e.id == p) {
            return Some(e);
        }
    }
    sys.emulators
        .iter()
        .find_map(|id| installed.iter().find(|e| e.id == *id))
}

// -----------------------------------------------------------------------------
// CORE-URI RETROARCH ȘI BIOS
// -----------------------------------------------------------------------------

fn retroarch_config_dirs(kind: &InstallKind) -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    match kind {
        InstallKind::Flatpak => vec![home.join(".var/app/org.libretro.RetroArch/config/retroarch")],
        _ => vec![home.join(".config/retroarch")],
    }
}

fn retroarch_core_dirs(kind: &InstallKind) -> Vec<PathBuf> {
    let mut dirs_out: Vec<PathBuf> = retroarch_config_dirs(kind).into_iter().map(|d| d.join("cores")).collect();
    if *kind != InstallKind::Flatpak {
        dirs_out.push(PathBuf::from("/usr/lib/libretro"));
        dirs_out.push(PathBuf::from("/usr/lib/x86_64-linux-gnu/libretro"));
        dirs_out.push(PathBuf::from("/usr/lib64/libretro"));
    }
    dirs_out
}

/// Setări adăugate peste configurația RetroArch la lansarea din NexusDeck: Select+Start închide
/// emulatorul direct (fără confirmare), ca întoarcerea în Big Picture să meargă doar din controller.
const RETROARCH_NEXUSDECK_CFG: &str = "# Generat de NexusDeck la fiecare lansare. Nu modifica manual.\n\
input_quit_gamepad_combo = \"4\"\n\
quit_press_twice = \"false\"\n";

/// Scrie fișierul de setări în folderul de configurare al RetroArch-ului (accesibil și din Flatpak).
fn retroarch_nexusdeck_config(kind: &InstallKind) -> Option<PathBuf> {
    let dir = retroarch_config_dirs(kind).into_iter().next()?;
    fs::create_dir_all(&dir).ok()?;
    let path = dir.join("nexusdeck.cfg");
    if fs::read_to_string(&path).ok().as_deref() != Some(RETROARCH_NEXUSDECK_CFG) {
        fs::write(&path, RETROARCH_NEXUSDECK_CFG).ok()?;
    }
    Some(path)
}

/// Calea core-ului RetroArch pentru sistem (cel ales sau primul găsit din listă).
pub fn find_retroarch_core(sys: &SystemDef, preferred: Option<&str>, kind: &InstallKind) -> Option<PathBuf> {
    let ext = if cfg!(target_os = "windows") { "dll" } else { "so" };
    let mut candidates: Vec<&str> = Vec::new();
    if let Some(p) = preferred.filter(|p| !p.is_empty()) {
        candidates.push(p);
    }
    candidates.extend(sys.cores.iter().copied());
    let dirs_list = retroarch_core_dirs(kind);
    candidates.iter().find_map(|core| {
        dirs_list
            .iter()
            .map(|d| d.join(format!("{}_libretro.{}", core, ext)))
            .find(|p| p.is_file())
    })
}

/// Folderele în care căutăm BIOS-urile (RetroArch `system`, plus folderele emulatoarelor dedicate).
fn bios_dirs(sys: &SystemDef) -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    let mut out = vec![
        home.join(".config/retroarch/system"),
        home.join(".var/app/org.libretro.RetroArch/config/retroarch/system"),
    ];
    match sys.id {
        "psx" => {
            out.push(home.join(".local/share/duckstation/bios"));
            out.push(home.join(".var/app/org.duckstation.DuckStation/config/duckstation/bios"));
        }
        "ps2" => {
            out.push(home.join(".config/PCSX2/bios"));
            out.push(home.join(".var/app/net.pcsx2.PCSX2/config/PCSX2/bios"));
        }
        _ => {}
    }
    out
}

/// Folderul în care emulatorul folosit pentru sistem își caută BIOS-ul.
pub fn bios_target_dir(system_id: &str) -> Result<PathBuf, String> {
    let sys = system_def(system_id).ok_or("Sistem necunoscut.")?;
    if sys.bios_any.is_empty() {
        return Err("Sistemul nu are nevoie de BIOS.".into());
    }
    let cfg = load_config();
    let installed = detect_emulators();
    let preferred = cfg.systems.get(sys.id).and_then(|c| c.emulator.clone());
    let emu = resolve_emulator(sys, preferred.as_deref(), &installed)
        .ok_or("Niciun emulator instalat pentru acest sistem.")?;
    let home = dirs::home_dir().ok_or("Folderul home nu a fost găsit.")?;
    let flatpak = emu.kind == InstallKind::Flatpak;
    Ok(match emu.id.as_str() {
        "retroarch" => retroarch_config_dirs(&emu.kind)
            .into_iter()
            .next()
            .ok_or("Folderul RetroArch nu a fost găsit.")?
            .join("system"),
        "duckstation" if flatpak => home.join(".var/app/org.duckstation.DuckStation/config/duckstation/bios"),
        "duckstation" => home.join(".local/share/duckstation/bios"),
        "pcsx2" if flatpak => home.join(".var/app/net.pcsx2.PCSX2/config/PCSX2/bios"),
        "pcsx2" => home.join(".config/PCSX2/bios"),
        _ => return Err("Emulatorul ales nu folosește un folder de BIOS cunoscut.".into()),
    })
}

/// Numele sub care se copiază BIOS-ul: emulatoarele caută numele exacte cu litere mici
/// (scph5501.bin), deci le normalizăm; la PS2 (orice nume) îl lăsăm neschimbat.
fn bios_dest_name(sys: &SystemDef, file_name: &str) -> String {
    if sys.bios_any == ["*"] {
        file_name.to_string()
    } else {
        file_name.to_lowercase()
    }
}

/// Copiază un fișier BIOS ales de utilizator în folderul emulatorului. Întoarce calea finală.
pub fn import_bios(system_id: &str, src: &Path) -> Result<PathBuf, String> {
    let sys = system_def(system_id).ok_or("Sistem necunoscut.")?;
    let meta = fs::metadata(src).map_err(|e| format!("{}: {}", src.display(), e))?;
    // Un BIOS PS1 are 512 KB, unul PS2 4 MB; altceva e aproape sigur un fișier greșit
    if !meta.is_file() || meta.len() < 64 * 1024 || meta.len() > 32 * 1024 * 1024 {
        return Err("Fișierul nu pare un BIOS (dimensiune neobișnuită).".into());
    }
    let file_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Nume de fișier invalid.")?;
    let dir = bios_target_dir(system_id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {}", dir.display(), e))?;
    let dest = dir.join(bios_dest_name(sys, file_name));
    let tmp = dir.join(format!(".{}.nexusdeck-tmp", bios_dest_name(sys, file_name)));
    fs::copy(src, &tmp).map_err(|e| format!("{}: {}", dest.display(), e))?;
    fs::rename(&tmp, &dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{}: {}", dest.display(), e)
    })?;
    Ok(dest)
}

/// None = sistemul nu are nevoie de BIOS; Some(true/false) = găsit / lipsă.
pub fn bios_status(sys: &SystemDef) -> Option<bool> {
    if sys.bios_any.is_empty() {
        return None;
    }
    let dirs_list = bios_dirs(sys);
    let wildcard = sys.bios_any == ["*"];
    let found = dirs_list.iter().any(|d| {
        if wildcard {
            // PCSX2 acceptă orice dump de BIOS din folderul lui
            fs::read_dir(d)
                .map(|it| it.flatten().any(|e| e.path().is_file()))
                .unwrap_or(false)
        } else {
            sys.bios_any.iter().any(|f| {
                d.join(f).is_file() || d.join(f.to_lowercase()).is_file() || d.join(f.to_uppercase()).is_file()
            })
        }
    });
    Some(found)
}

// -----------------------------------------------------------------------------
// SCANAREA ROM-URILOR
// -----------------------------------------------------------------------------

/// Titlul afișat: numele fișierului fără extensie și fără etichetele de tip (USA), [!], (Rev 1).
/// Indicatorul de disc „(Disc 2)” se păstrează, ca discurile să rămână distinguibile.
pub fn clean_rom_title(file_stem: &str) -> String {
    let mut out = String::new();
    let mut depth_round = 0usize;
    let mut depth_square = 0usize;
    let mut group = String::new();
    for c in file_stem.chars() {
        match c {
            '(' => {
                depth_round += 1;
                group.clear();
            }
            ')' if depth_round > 0 => {
                depth_round -= 1;
                if group.to_lowercase().starts_with("disc") || group.to_lowercase().starts_with("disk") {
                    out.push_str(&format!(" ({})", group.trim()));
                }
            }
            '[' => depth_square += 1,
            ']' if depth_square > 0 => depth_square -= 1,
            _ if depth_round > 0 => group.push(c),
            _ if depth_square > 0 => {}
            '_' => out.push(' '),
            _ => out.push(c),
        }
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        file_stem.to_string()
    } else {
        collapsed
    }
}

/// Coperta de pe thumbnails.libretro.com (gratuit, fără cheie API). Numele se potrivesc cu
/// set-urile No-Intro/Redump; caracterele interzise se înlocuiesc cu `_`, ca în RetroArch.
pub fn libretro_cover_url(sys: &SystemDef, file_stem: &str) -> String {
    let safe: String = file_stem
        .chars()
        .map(|c| if "&*/:`<>?\\|\"".contains(c) { '_' } else { c })
        .collect();
    format!(
        "https://thumbnails.libretro.com/{}/Named_Boxarts/{}.png",
        urlencoding::encode(sys.libretro_playlist),
        urlencoding::encode(&safe)
    )
}

/// ID stabil pentru un ROM (FNV-1a pe calea relativă), ca rescanările să nu dubleze jocurile.
pub fn rom_game_id(system_id: &str, rel_path: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in rel_path.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("emu_{}_{:016x}", system_id, hash)
}

#[derive(Serialize, Debug, Clone)]
pub struct ScannedRom {
    pub id: String,
    pub title: String,
    pub path: String,
    pub system: String,
    pub cover_url: String,
}

/// Fișierele de disc referite dintr-un .m3u / .cue (ca să nu apară separat în bibliotecă).
fn referenced_files(playlist: &Path) -> Vec<PathBuf> {
    let Ok(text) = fs::read_to_string(playlist) else { return Vec::new() };
    let base = playlist.parent().unwrap_or(Path::new("."));
    let is_cue = playlist
        .extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case("cue"))
        .unwrap_or(false);
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            if is_cue {
                // FILE "Game (Track 1).bin" BINARY
                let start = line.find('"')?;
                let end = line[start + 1..].find('"')? + start + 1;
                if !line.to_uppercase().starts_with("FILE") {
                    return None;
                }
                Some(base.join(&line[start + 1..end]))
            } else {
                Some(base.join(line))
            }
        })
        .collect()
}

fn walk_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        let p = e.path();
        let hidden = e.file_name().to_string_lossy().starts_with('.');
        if hidden {
            continue;
        }
        if ft.is_dir() {
            walk_files(&p, depth + 1, out);
        } else if ft.is_file() {
            out.push(p);
        }
    }
}

pub fn scan_system(sys: &SystemDef, folder: &Path) -> Vec<ScannedRom> {
    if !folder.is_dir() {
        return Vec::new();
    }
    let mut files = Vec::new();
    walk_files(folder, 0, &mut files);

    let ext_of = |p: &Path| p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let candidates: Vec<PathBuf> = files
        .into_iter()
        .filter(|p| sys.extensions.contains(&ext_of(p).as_str()))
        .collect();

    // Discurile referite din .m3u / .cue nu se afișează separat
    let mut hidden: HashSet<PathBuf> = HashSet::new();
    for p in &candidates {
        let ext = ext_of(p);
        if ext == "m3u" || ext == "cue" {
            for r in referenced_files(p) {
                hidden.insert(fs::canonicalize(&r).unwrap_or(r));
            }
        }
    }

    let mut roms: Vec<ScannedRom> = candidates
        .into_iter()
        .filter(|p| !hidden.contains(&fs::canonicalize(p).unwrap_or_else(|_| p.clone())))
        .map(|p| {
            let mut stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            // Jocurile Xbox 360 extrase au toate `default.xex`: numele e cel al folderului
            if stem.eq_ignore_ascii_case("default") {
                if let Some(dir) = p.parent().filter(|d| *d != folder).and_then(|d| d.file_name()) {
                    stem = dir.to_string_lossy().to_string();
                }
            }
            let rel = p.strip_prefix(folder).unwrap_or(&p).to_string_lossy().to_string();
            ScannedRom {
                id: rom_game_id(sys.id, &rel),
                title: clean_rom_title(&stem),
                path: p.to_string_lossy().to_string(),
                system: sys.id.to_string(),
                cover_url: libretro_cover_url(sys, &stem),
            }
        })
        .collect();
    roms.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    roms
}

// -----------------------------------------------------------------------------
// LANSARE
// -----------------------------------------------------------------------------

/// Argumentele emulatorului cu ROM-ul înlocuit. Argumentele utilizatorului merg înaintea ROM-ului
/// (și a separatorului `--`): după ele, DuckStation / PCSX2 le-ar fi tratat ca fișiere de deschis.
fn fill_emulator_args(template: &[&str], rom_path: &str, extra_args: &[String], is_wine: bool) -> Vec<String> {
    let mut out = Vec::new();
    let mut extras_added = extra_args.is_empty();
    for a in template {
        if !extras_added && (*a == "{rom}" || *a == "--") {
            out.extend(extra_args.iter().cloned());
            extras_added = true;
        }
        out.push(if *a != "{rom}" {
            a.to_string()
        } else if is_wine {
            wine_path(rom_path)
        } else {
            rom_path.to_string()
        });
    }
    out
}

/// Comanda de lansare pentru un ROM: (program, argumente).
pub fn build_launch_command(
    system_id: &str,
    rom_path: &str,
    emulator_override: Option<&str>,
    core_override: Option<&str>,
    extra_args: &[String],
) -> Result<(String, Vec<String>, String), String> {
    let sys = system_def(system_id).ok_or_else(|| format!("Sistem necunoscut: {}", system_id))?;
    let cfg = load_config();
    let sys_cfg = cfg.systems.get(sys.id).cloned().unwrap_or_default();
    let installed = detect_emulators();

    let preferred = emulator_override
        .filter(|e| !e.is_empty())
        .or(sys_cfg.emulator.as_deref());
    let emu = resolve_emulator(sys, preferred, &installed).ok_or_else(|| {
        let names: Vec<&str> = sys
            .emulators
            .iter()
            .filter_map(|id| emulator_def(id).map(|d| d.name))
            .collect();
        format!(
            "Niciun emulator instalat pentru {}. Instalează unul dintre: {}.",
            sys.name,
            names.join(", ")
        )
    })?;
    let def = emulator_def(&emu.id).ok_or("Emulator necunoscut")?;

    let is_wine = emu.kind == InstallKind::Wine;
    let (program, mut args): (String, Vec<String>) = match emu.kind {
        InstallKind::Flatpak => ("flatpak".into(), vec!["run".into(), emu.target.clone()]),
        InstallKind::Wine => {
            // Un prefix propriu pentru emulator; prin `env`, ca setările să ajungă la umu-run / wine
            let prefix = dirs::data_dir()
                .ok_or("Folderul de date nu a fost găsit.")?
                .join("nexusdeck/prefixes")
                .join(&emu.id);
            fs::create_dir_all(&prefix).map_err(|e| format!("{}: {}", prefix.display(), e))?;
            let mut a = vec![format!("WINEPREFIX={}", prefix.display())];
            if find_in_path("umu-run").is_some() {
                a.push("GAMEID=umu-default".into());
                a.push("umu-run".into());
            } else if find_in_path("wine").is_some() {
                a.push("wine".into());
            } else {
                return Err(format!(
                    "{} e un program Windows: pentru el e nevoie de umu-run (recomandat) sau Wine.",
                    emu.name
                ));
            }
            a.push(emu.target.clone());
            ("env".into(), a)
        }
        _ => (emu.target.clone(), Vec::new()),
    };

    if emu.id == "retroarch" {
        let core_pref = core_override.filter(|c| !c.is_empty()).or(sys_cfg.core.as_deref());
        let core = find_retroarch_core(sys, core_pref, &emu.kind).ok_or_else(|| {
            format!(
                "RetroArch nu are instalat niciun core pentru {} ({}). Instalează-l din RetroArch: Online Updater → Core Downloader.",
                sys.name,
                sys.cores.join(", ")
            )
        })?;
        args.push("-L".into());
        args.push(core.to_string_lossy().to_string());
        if let Some(extra) = retroarch_nexusdeck_config(&emu.kind) {
            args.push("--appendconfig".into());
            args.push(extra.to_string_lossy().to_string());
        }
    }

    args.extend(fill_emulator_args(def.args, rom_path, extra_args, is_wine));
    Ok((program, args, emu.name.clone()))
}

// -----------------------------------------------------------------------------
// FOLDERE DE ROM-URI ȘI CORE-URI RETROARCH
// -----------------------------------------------------------------------------

/// Creează folderele lipsă pentru toate sistemele. Întoarce câte foldere au fost create.
pub fn create_missing_rom_folders() -> Result<usize, String> {
    let cfg = load_config();
    let mut created = 0;
    for sys in SYSTEMS {
        let folder = system_folder(&cfg, sys);
        if !folder.is_dir() {
            fs::create_dir_all(&folder).map_err(|e| format!("{}: {}", folder.display(), e))?;
            created += 1;
        }
    }
    Ok(created)
}

/// Folderul de ROM-uri al unui sistem (creat dacă lipsește), pentru a fi deschis în managerul de fișiere.
pub fn ensure_system_folder(system_id: &str) -> Result<PathBuf, String> {
    let sys = system_def(system_id).ok_or("Sistem necunoscut.")?;
    let folder = system_folder(&load_config(), sys);
    fs::create_dir_all(&folder).map_err(|e| format!("{}: {}", folder.display(), e))?;
    Ok(folder)
}

/// Folderul de core-uri al RetroArch-ului instalat (Flatpak sau nativ / AppImage).
pub fn retroarch_cores_dir() -> Result<PathBuf, String> {
    let installed = detect_emulators();
    let ra = installed
        .iter()
        .find(|e| e.id == "retroarch")
        .ok_or("RetroArch nu este instalat.")?;
    retroarch_config_dirs(&ra.kind)
        .into_iter()
        .next()
        .map(|d| d.join("cores"))
        .ok_or_else(|| "Nu s-a putut determina folderul RetroArch.".to_string())
}

/// Core-urile de încercat pentru un sistem: cel ales în configurație, apoi recomandările.
pub fn core_candidates(system_id: &str) -> Vec<String> {
    let Some(sys) = system_def(system_id) else { return Vec::new() };
    let cfg = load_config();
    let mut out: Vec<String> = Vec::new();
    if let Some(c) = cfg.systems.get(system_id).and_then(|c| c.core.clone()).filter(|c| !c.trim().is_empty()) {
        out.push(c);
    }
    for c in sys.cores {
        if !out.iter().any(|o| o == c) {
            out.push(c.to_string());
        }
    }
    out
}

/// URL-ul oficial (buildbot libretro) al unui core, pentru platforma curentă.
pub fn core_download_url(core: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("https://buildbot.libretro.com/nightly/windows/x86_64/latest/{}_libretro.dll.zip", core)
    } else {
        format!("https://buildbot.libretro.com/nightly/linux/x86_64/latest/{}_libretro.so.zip", core)
    }
}

/// Extrage core-ul din arhiva descărcată în `cores_dir` (scriere atomică). Acceptă doar fișierul
/// așteptat (`<core>_libretro.so`), ca o arhivă neașteptată să nu poată scrie altceva pe disc.
pub fn install_core_from_zip(zip_bytes: &[u8], core: &str, cores_dir: &Path) -> Result<PathBuf, String> {
    let ext = if cfg!(target_os = "windows") { "dll" } else { "so" };
    let expected = format!("{}_libretro.{}", core, ext);
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes))
        .map_err(|e| format!("Arhivă invalidă: {}", e))?;
    let mut entry = archive
        .by_name(&expected)
        .map_err(|_| format!("Arhiva nu conține {}", expected))?;
    fs::create_dir_all(cores_dir).map_err(|e| e.to_string())?;
    let dest = cores_dir.join(&expected);
    let tmp = cores_dir.join(format!(".{}.nexusdeck-tmp", expected));
    {
        let mut out = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(dest)
}

// -----------------------------------------------------------------------------
// INSTALARE (Flatpak, de pe Flathub)
// -----------------------------------------------------------------------------

/// Instalează emulatorul pentru utilizatorul curent (fără parolă de administrator), de pe Flathub.
/// `on_line` primește fiecare linie de progres. Întoarce ID-ul Flatpak instalat.
pub fn install_emulator_flatpak(id: &str, mut on_line: impl FnMut(&str)) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    if cfg!(target_os = "windows") {
        return Err("Instalarea automată a emulatoarelor e disponibilă doar pe Linux.".into());
    }
    let def = emulator_def(id).ok_or_else(|| format!("Emulator necunoscut: {}", id))?;
    let flatpak_id = *def.flatpaks.first().ok_or("Emulatorul nu are pachet Flatpak.")?;
    if find_in_path("flatpak").is_none() {
        return Err("Flatpak nu este instalat. Instalează-l din managerul de pachete al distribuției (ex. `sudo pacman -S flatpak`).".into());
    }

    // Depozitul Flathub pentru utilizator (nu face nimic dacă există deja)
    on_line("Flathub…");
    let _ = Command::new("flatpak")
        .args(["remote-add", "--user", "--if-not-exists", "flathub", "https://dl.flathub.org/repo/flathub.flatpakrepo"])
        .output();

    let mut child = Command::new("flatpak")
        .args(["install", "--user", "--noninteractive", "-y", "flathub", flatpak_id])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Nu s-a putut porni flatpak: {}", e))?;

    // stderr se citește pe un thread separat, ca pipe-ul să nu se umple
    let stderr_handle = child.stderr.take().map(|err| {
        std::thread::spawn(move || {
            BufReader::new(err)
                .lines()
                .map_while(Result::ok)
                .collect::<Vec<_>>()
        })
    });

    if let Some(out) = child.stdout.take() {
        // flatpak rescrie linia de progres cu \r: tratăm și \r ca separator
        let mut reader = BufReader::new(out);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            let mut byte = [0u8; 1];
            let mut got_any = false;
            loop {
                match std::io::Read::read(&mut reader, &mut byte) {
                    Ok(1) => {
                        got_any = true;
                        if byte[0] == b'\n' || byte[0] == b'\r' {
                            break;
                        }
                        buf.push(byte[0]);
                    }
                    _ => break,
                }
            }
            if !got_any {
                break;
            }
            let line = String::from_utf8_lossy(&buf).trim().to_string();
            if !line.is_empty() {
                on_line(&line);
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    let err_lines = stderr_handle.and_then(|h| h.join().ok()).unwrap_or_default();
    if status.success() {
        Ok(flatpak_id.to_string())
    } else {
        let detail = err_lines
            .iter()
            .rev()
            .find(|l| !l.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| "eroare necunoscută".into());
        Err(format!("Instalarea {} a eșuat: {}", def.name, detail))
    }
}

// -----------------------------------------------------------------------------
// PREZENTARE PENTRU INTERFAȚĂ
// -----------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SystemOverview {
    pub id: String,
    pub name: String,
    pub short: String,
    pub folder: String,
    pub folder_exists: bool,
    /// Emulatorul folosit efectiv (None = niciunul instalat)
    pub emulator: Option<String>,
    /// Emulatoarele potrivite pentru sistem care sunt instalate
    pub available_emulators: Vec<String>,
    /// None = nu e nevoie de BIOS
    pub bios_ok: Option<bool>,
    /// Numele de fișier acceptate pentru BIOS (gol = orice nume, ca la PS2)
    pub bios_files: Vec<String>,
    pub has_retroarch_core: Option<bool>,
    /// Core-urile RetroArch potrivite pentru sistem, în ordinea preferinței
    pub cores: Vec<String>,
}

#[derive(Serialize)]
pub struct EmulationOverview {
    pub rom_root: String,
    /// Configurația salvată (alegerile utilizatorului), ca interfața s-o poată modifica și salva
    pub config: EmulationConfig,
    /// Toate emulatoarele cunoscute: (id, nume), ca interfața să arate și ce lipsește
    pub known_emulators: Vec<(String, String)>,
    /// Se pot instala emulatoare din aplicație (Flatpak prezent pe sistem)
    pub flatpak_available: bool,
    /// Emulatoarele care se pot instala din aplicație (au pachet Flatpak)
    pub installable: Vec<String>,
    pub emulators: Vec<InstalledEmulator>,
    pub systems: Vec<SystemOverview>,
}

pub fn overview() -> EmulationOverview {
    let cfg = load_config();
    let installed = detect_emulators();
    let systems = SYSTEMS
        .iter()
        .map(|sys| {
            let sys_cfg = cfg.systems.get(sys.id).cloned().unwrap_or_default();
            let folder = system_folder(&cfg, sys);
            let emu = resolve_emulator(sys, sys_cfg.emulator.as_deref(), &installed);
            let has_core = emu.filter(|e| e.id == "retroarch").map(|e| {
                find_retroarch_core(sys, sys_cfg.core.as_deref(), &e.kind).is_some()
            });
            SystemOverview {
                id: sys.id.into(),
                name: sys.name.into(),
                short: sys.short.into(),
                folder: folder.to_string_lossy().to_string(),
                folder_exists: folder.is_dir(),
                emulator: emu.map(|e| e.id.clone()),
                available_emulators: sys
                    .emulators
                    .iter()
                    .filter(|id| installed.iter().any(|e| e.id == **id))
                    .map(|s| s.to_string())
                    .collect(),
                bios_ok: bios_status(sys),
                bios_files: sys.bios_any.iter().filter(|f| **f != "*").map(|f| f.to_string()).collect(),
                has_retroarch_core: has_core,
                cores: sys.cores.iter().map(|c| c.to_string()).collect(),
            }
        })
        .collect();
    EmulationOverview {
        rom_root: cfg.rom_root.clone(),
        known_emulators: EMULATORS.iter().map(|e| (e.id.to_string(), e.name.to_string())).collect(),
        flatpak_available: !cfg!(target_os = "windows") && find_in_path("flatpak").is_some(),
        installable: EMULATORS.iter().filter(|e| !e.flatpaks.is_empty()).map(|e| e.id.to_string()).collect(),
        config: cfg,
        emulators: installed,
        systems,
    }
}

pub fn scan_all() -> Vec<ScannedRom> {
    let cfg = load_config();
    SYSTEMS
        .iter()
        .flat_map(|sys| scan_system(sys, &system_folder(&cfg, sys)))
        .collect()
}

// -----------------------------------------------------------------------------
// TESTE
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_args_go_before_the_rom() {
        let extra = vec!["-bios".to_string(), "x.bin".to_string()];
        assert_eq!(
            fill_emulator_args(&["-fullscreen", "-batch", "--", "{rom}"], "/r/a.chd", &extra, false),
            ["-fullscreen", "-batch", "-bios", "x.bin", "--", "/r/a.chd"]
        );
        assert_eq!(fill_emulator_args(&["-f", "{rom}"], "/r/a.sfc", &[], false), ["-f", "/r/a.sfc"]);
    }

    #[test]
    fn wine_paths_and_xex_titles() {
        assert_eq!(wine_path("/home/a/ROMs/xbox360/Halo 3.iso"), "Z:\\home\\a\\ROMs\\xbox360\\Halo 3.iso");
        let dir = std::env::temp_dir().join(format!("nd_x360_{}", std::process::id()));
        let game = dir.join("Halo 3");
        fs::create_dir_all(&game).unwrap();
        fs::write(game.join("default.xex"), b"x").unwrap();
        let roms = scan_system(system_def("xbox360").unwrap(), &dir);
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(roms.len(), 1);
        assert_eq!(roms[0].title, "Halo 3");
    }

    #[test]
    fn bios_names_are_normalized_only_when_emulator_expects_exact_names() {
        let psx = system_def("psx").unwrap();
        let ps2 = system_def("ps2").unwrap();
        assert_eq!(bios_dest_name(psx, "SCPH5501.BIN"), "scph5501.bin");
        assert_eq!(bios_dest_name(ps2, "SCPH-70012_BIOS_V12.bin"), "SCPH-70012_BIOS_V12.bin");
    }

    #[test]
    fn cleans_rom_titles() {
        assert_eq!(clean_rom_title("Super Mario World (USA)"), "Super Mario World");
        assert_eq!(clean_rom_title("Chrono Trigger (USA) [!]"), "Chrono Trigger");
        assert_eq!(clean_rom_title("Final Fantasy VII (USA) (Disc 2)"), "Final Fantasy VII (Disc 2)");
        assert_eq!(clean_rom_title("Metroid_Fusion (Europe) (En,Fr,De)"), "Metroid Fusion");
    }

    #[test]
    fn stable_ids_and_cover_urls() {
        assert_eq!(rom_game_id("snes", "a.sfc"), rom_game_id("snes", "a.sfc"));
        assert_ne!(rom_game_id("snes", "a.sfc"), rom_game_id("snes", "b.sfc"));
        let url = libretro_cover_url(system_def("snes").unwrap(), "Super Mario World (USA)");
        assert!(url.starts_with("https://thumbnails.libretro.com/Nintendo%20-%20Super%20Nintendo"));
        assert!(url.ends_with("/Named_Boxarts/Super%20Mario%20World%20%28USA%29.png"));
    }

    #[test]
    fn scan_hides_discs_referenced_by_m3u_and_cue() {
        let base = std::env::temp_dir().join(format!("nexusdeck_roms_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let psx = base.join("psx/FF7");
        fs::create_dir_all(&psx).unwrap();
        fs::write(psx.join("FF7 (Disc 1).cue"), "FILE \"FF7 (Disc 1).bin\" BINARY\n").unwrap();
        fs::write(psx.join("FF7 (Disc 2).cue"), "FILE \"FF7 (Disc 2).bin\" BINARY\n").unwrap();
        fs::write(psx.join("FF7 (Disc 1).bin"), b"x").unwrap();
        fs::write(psx.join("FF7 (Disc 2).bin"), b"x").unwrap();
        fs::write(psx.join("Final Fantasy VII (USA).m3u"), "FF7 (Disc 1).cue\nFF7 (Disc 2).cue\n").unwrap();
        fs::write(base.join("psx/Crash Bandicoot (USA).chd"), b"x").unwrap();
        fs::write(base.join("psx/readme.txt"), b"x").unwrap();

        let roms = scan_system(system_def("psx").unwrap(), &base.join("psx"));
        let titles: Vec<&str> = roms.iter().map(|r| r.title.as_str()).collect();
        assert_eq!(titles, vec!["Crash Bandicoot", "Final Fantasy VII"]);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn core_zip_extracts_only_expected_file() {
        use std::io::Write;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zw = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            zw.start_file("snes9x_libretro.so", opts).unwrap();
            zw.write_all(b"ELF-core").unwrap();
            zw.finish().unwrap();
        }
        let dir = std::env::temp_dir().join(format!("nexusdeck_cores_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = install_core_from_zip(buf.get_ref(), "snes9x", &dir).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"ELF-core");
        assert!(install_core_from_zip(buf.get_ref(), "mgba", &dir).is_err());
        assert_eq!(core_candidates("snes")[0], "snes9x");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn emulator_resolution_prefers_user_choice_then_system_order() {
        let installed = vec![
            InstalledEmulator { id: "retroarch".into(), name: "RetroArch".into(), kind: InstallKind::Native, target: "/usr/bin/retroarch".into() },
            InstalledEmulator { id: "duckstation".into(), name: "DuckStation".into(), kind: InstallKind::Flatpak, target: "org.duckstation.DuckStation".into() },
        ];
        let psx = system_def("psx").unwrap();
        assert_eq!(resolve_emulator(psx, None, &installed).unwrap().id, "duckstation");
        assert_eq!(resolve_emulator(psx, Some("retroarch"), &installed).unwrap().id, "retroarch");
        // emulator ales dar neinstalat: revine la ordinea sistemului
        assert_eq!(resolve_emulator(psx, Some("pcsx2"), &installed).unwrap().id, "duckstation");
        assert!(resolve_emulator(system_def("ps2").unwrap(), None, &installed).is_none());
    }
}
