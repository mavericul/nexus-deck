// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
use tauri::{AppHandle, Emitter, State};

// Registrul global pentru PID-urile jocurilor
pub struct RunningProcesses(pub Arc<Mutex<HashMap<String, u32>>>);

#[derive(Clone, serde::Serialize)]
struct GameStatusPayload {
    game_id: String,
    status: String, // "starting", "playing", "stopped"
    playtime_seconds: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Game {
    pub id: String,
    pub title: String,
    pub exe_path: String,
    pub runner_path: String,
    pub wine_prefix: Option<String>,
    pub launch_args: Option<String>,
    pub env_vars: Option<HashMap<String, String>>,
    pub use_gamemode: bool,
    pub use_mangohud: bool,
    pub cover_url: Option<String>,
    pub banner_url: Option<String>,
    pub genre: Option<String>,
    pub source: Option<String>,
    pub favorite: Option<bool>,
    pub hidden: Option<bool>,
    pub tags: Option<Vec<String>>,
    pub playtime_minutes: Option<u64>,
}

#[derive(Serialize)]
pub struct InstallResult {
    pub success: bool,
    pub detected_exe: Option<String>,
    pub wine_prefix: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SystemStats {
    pub cpu_usage: f32,
    pub ram_used_gb: f32,
    pub ram_total_gb: f32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RunnerInfo {
    pub name: String,
    pub path: String,
}

pub struct AppSystemStats {
    pub sys: Mutex<System>,
}

pub struct AppHttpClient {
    pub client: reqwest::Client,
}

fn get_config_dir() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("nexusdeck");
    let _ = fs::create_dir_all(&path);
    path
}

fn get_games_file_path() -> PathBuf {
    let mut path = get_config_dir();
    path.push("games.json");
    path
}

// -----------------------------------------------------------------------------
// COMMANDS
// -----------------------------------------------------------------------------


#[tauri::command]
fn uninstall_game_files(exe_path: String, wine_prefix: Option<String>) -> Result<(), String> {
    if !exe_path.is_empty() && !exe_path.starts_with("steam://") {
        let path = std::path::Path::new(&exe_path);
        if let Some(parent) = path.parent() {
            let path_str = parent.to_string_lossy();
            if path_str.len() > 10 && (path_str.contains("Games") || path_str.contains("wine") || path_str.contains("prefix") || path_str.contains("lutris")) {
                let _ = std::fs::remove_dir_all(parent);
            }
        }
    }

    if let Some(prefix) = wine_prefix {
        if !prefix.is_empty() && prefix.len() > 5 {
            let prefix_path = std::path::Path::new(&prefix);
            if prefix_path.exists() {
                let _ = std::fs::remove_dir_all(prefix_path);
            }
        }
    }

    Ok(())
}

#[tauri::command]
async fn get_steam_app_title(
    state: tauri::State<'_, AppHttpClient>,
    app_id: String,
) -> Result<Option<String>, String> {
    match app_id.as_str() {
        "7" => return Ok(Some("Steamworks Common Redistributables".to_string())),
        "218" => return Ok(Some("Source SDK Base 2007".to_string())),
        "480" => return Ok(Some("Spacewar".to_string())),
        "760" => return Ok(Some("Steam Community".to_string())),
        "1007" => return Ok(Some("Steam Client".to_string())),
        _ => {}
    }

    let store_url = format!(
        "https://store.steampowered.com/api/appdetails?appids={}&filters=basic",
        app_id
    );

    if let Ok(res) = state.client.get(&store_url).send().await {
        if let Ok(json) = res.json::<serde_json::Value>().await {
            if let Some(app_data) = json.get(&app_id) {
                let success = app_data.get("success").and_then(|s| s.as_bool()).unwrap_or(false);
                if success {
                    if let Some(data) = app_data.get("data") {
                        if let Some(name) = data.get("name").and_then(|n| n.as_str()) {
                            return Ok(Some(name.to_string()));
                        }
                    }
                }
            }
        }
    }

    let community_url = format!("https://steamcommunity.com/actions/SearchApps/{}", app_id);
    if let Ok(res) = state.client.get(&community_url).send().await {
        if let Ok(json) = res.json::<serde_json::Value>().await {
            if let Some(arr) = json.as_array() {
                for item in arr {
                    let id_match = item.get("appid").and_then(|i| i.as_str()).unwrap_or("");
                    if id_match == app_id {
                        if let Some(name) = item.get("name").and_then(|n| n.as_str()) {
                            return Ok(Some(name.to_string()));
                        }
                    }
                }
            }
        }
    }

    Ok(None)
}

#[tauri::command]
fn get_system_stats(state: tauri::State<'_, AppSystemStats>) -> SystemStats {
    let mut sys = state.sys.lock().unwrap();

    sys.refresh_cpu_usage();
    sys.refresh_memory();

    let cpu_usage = sys.global_cpu_usage();
    let ram_used = sys.used_memory() as f32 / 1024.0 / 1024.0 / 1024.0;
    let ram_total = sys.total_memory() as f32 / 1024.0 / 1024.0 / 1024.0;

    SystemStats {
        cpu_usage: (cpu_usage * 10.0).round() / 10.0,
        ram_used_gb: (ram_used * 10.0).round() / 10.0,
        ram_total_gb: (ram_total * 10.0).round() / 10.0,
    }
}

#[tauri::command]
fn get_available_runners() -> Vec<RunnerInfo> {
    if cfg!(target_os = "windows") {
        return vec![RunnerInfo {
            name: "Native Windows".to_string(),
            path: "native".to_string(),
        }];
    }

    let mut runners = Vec::new();
    runners.push(RunnerInfo {
        name: "System Wine".to_string(),
                 path: "/usr/bin/wine".to_string(),
    });

    let home = std::env::var("HOME").unwrap_or_default();

    let lutris_dir = PathBuf::from(format!("{}/.local/share/lutris/runners/wine", home));
    if lutris_dir.exists() {
        if let Ok(entries) = fs::read_dir(lutris_dir) {
            for entry in entries.flatten() {
                let path = entry.path().join("bin/wine");
                if path.exists() {
                    runners.push(RunnerInfo {
                        name: format!("Lutris: {}", entry.file_name().to_string_lossy()),
                                 path: path.to_string_lossy().to_string(),
                    });
                }
            }
        }
    }

    let proton_dir = PathBuf::from(format!("{}/.steam/root/compatibilitytools.d", home));
    if proton_dir.exists() {
        if let Ok(entries) = fs::read_dir(proton_dir) {
            for entry in entries.flatten() {
                let path = entry.path().join("files/bin/wine");
                if path.exists() {
                    runners.push(RunnerInfo {
                        name: format!("Proton GE: {}", entry.file_name().to_string_lossy()),
                                 path: path.to_string_lossy().to_string(),
                    });
                }
            }
        }
    }

    runners
}

struct BinVdfReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BinVdfReader<'a> {
    fn new(data: &'a [u8], pos: usize) -> Self {
        Self { data, pos }
    }

    fn read_u8(&mut self) -> Option<u8> {
        let b = *self.data.get(self.pos)?;
        self.pos += 1;
        Some(b)
    }

    fn read_u32(&mut self) -> Option<u32> {
        let bytes = self.data.get(self.pos..self.pos + 4)?;
        self.pos += 4;
        Some(u32::from_le_bytes(bytes.try_into().ok()?))
    }

    fn read_i64(&mut self) -> Option<i64> {
        let bytes = self.data.get(self.pos..self.pos + 8)?;
        self.pos += 8;
        Some(i64::from_le_bytes(bytes.try_into().ok()?))
    }

    fn skip(&mut self, n: usize) -> bool {
        if self.pos.saturating_add(n) <= self.data.len() {
            self.pos += n;
            true
        } else {
            false
        }
    }

    fn read_cstring(&mut self) -> Option<String> {
        let start = self.pos;
        while self.pos < self.data.len() && self.data[self.pos] != 0 {
            self.pos += 1;
        }
        if self.pos >= self.data.len() {
            return None;
        }
        let s = String::from_utf8_lossy(&self.data[start..self.pos]).to_string();
        self.pos += 1;
        Some(s)
    }

    fn skip_wstring(&mut self) -> bool {
        while self.pos + 1 < self.data.len() {
            if self.data[self.pos] == 0 && self.data[self.pos + 1] == 0 {
                self.pos += 2;
                return true;
            }
            self.pos += 2;
        }
        false
    }

    fn read_key(&mut self, string_table: Option<&[String]>) -> Option<String> {
        if let Some(table) = string_table {
            let idx = self.read_u32()? as usize;
            Some(table.get(idx).cloned().unwrap_or_default())
        } else {
            self.read_cstring()
        }
    }
}

fn parse_steam_shortcuts_vdf(
    path: &Path,
    shortcut_ids: &mut std::collections::HashSet<u64>,
    shortcut_names: &mut std::collections::HashSet<String>,
) {
    let Ok(data) = fs::read(path) else {
        return;
    };
    let mut r = BinVdfReader::new(&data, 0);

    fn walk(
        r: &mut BinVdfReader,
        shortcut_ids: &mut std::collections::HashSet<u64>,
        shortcut_names: &mut std::collections::HashSet<String>,
    ) -> bool {
        while let Some(vtype) = r.read_u8() {
            if vtype == 0x08 {
                return true;
            }
            let Some(key) = r.read_cstring() else {
                return false;
            };
            match vtype {
                0x00 => {
                    if !walk(r, shortcut_ids, shortcut_names) {
                        return false;
                    }
                }
                0x01 => {
                    let Some(val) = r.read_cstring() else {
                        return false;
                    };
                    if key.eq_ignore_ascii_case("appname") && !val.trim().is_empty() {
                        shortcut_names.insert(val.trim().to_lowercase());
                    }
                }
                0x02 => {
                    let Some(val) = r.read_u32() else {
                        return false;
                    };
                    if key.eq_ignore_ascii_case("appid") && val != 0 {
                        let id64 = val as u64;
                        shortcut_ids.insert(id64);
                        shortcut_ids.insert(id64 & 0x7FFF_FFFF);
                        shortcut_ids.insert((id64 << 32) | 0x0200_0000);
                    }
                }
                0x03 | 0x04 | 0x06 => {
                    if !r.skip(4) {
                        return false;
                    }
                }
                0x05 => {
                    if !r.skip_wstring() {
                        return false;
                    }
                }
                0x07 | 0x0A => {
                    if !r.skip(8) {
                        return false;
                    }
                }
                _ => return false,
            }
        }
        true
    }

    walk(&mut r, shortcut_ids, shortcut_names);
}

fn parse_steam_appinfo_vdf(path: &Path) -> HashMap<u32, (String, String)> {
    let mut result = HashMap::new();
    let Ok(data) = fs::read(path) else {
        return result;
    };
    let mut r = BinVdfReader::new(&data, 0);
    let Some(magic) = r.read_u32() else {
        return result;
    };
    let Some(_universe) = r.read_u32() else {
        return result;
    };

    let string_table: Option<Vec<String>> = if magic == 0x0756_4429 {
        let Some(offset) = r.read_i64() else {
            return result;
        };
        if offset <= 0 || (offset as usize) >= data.len() {
            return result;
        }
        let mut st_reader = BinVdfReader::new(&data, offset as usize);
        let Some(count) = st_reader.read_u32() else {
            return result;
        };
        let mut strings = Vec::with_capacity(count.min(200_000) as usize);
        for _ in 0..count {
            let Some(s) = st_reader.read_cstring() else {
                break;
            };
            strings.push(s);
        }
        Some(strings)
    } else if magic == 0x0756_4427 || magic == 0x0756_4428 {
        None
    } else {
        return result;
    };

    fn walk_app_vdf(
        r: &mut BinVdfReader,
        end_pos: usize,
        string_table: Option<&[String]>,
        in_common: bool,
        name_out: &mut String,
        type_out: &mut String,
    ) -> bool {
        while r.pos < end_pos {
            let Some(vtype) = r.read_u8() else {
                return false;
            };
            if vtype == 0x08 {
                return true;
            }
            let Some(key) = r.read_key(string_table) else {
                return false;
            };
            match vtype {
                0x00 => {
                    let is_common = in_common || key.eq_ignore_ascii_case("common");
                    if !walk_app_vdf(r, end_pos, string_table, is_common, name_out, type_out) {
                        return false;
                    }
                }
                0x01 => {
                    let Some(val) = r.read_cstring() else {
                        return false;
                    };
                    if in_common {
                        if key.eq_ignore_ascii_case("name") && name_out.is_empty() {
                            *name_out = val;
                        } else if key.eq_ignore_ascii_case("type") && type_out.is_empty() {
                            *type_out = val.to_lowercase();
                        }
                    }
                }
                0x02 | 0x03 | 0x04 | 0x06 => {
                    if !r.skip(4) {
                        return false;
                    }
                }
                0x05 => {
                    if !r.skip_wstring() {
                        return false;
                    }
                }
                0x07 | 0x0A => {
                    if !r.skip(8) {
                        return false;
                    }
                }
                _ => return false,
            }
        }
        true
    }

    loop {
        let Some(app_id) = r.read_u32() else {
            break;
        };
        if app_id == 0 {
            break;
        }
        let Some(size) = r.read_u32() else {
            break;
        };
        let next_entry = r.pos.saturating_add(size as usize);
        if next_entry > data.len() || size < 60 {
            break;
        }
        r.pos += 60;

        let mut app_name = String::new();
        let mut app_type = String::new();
        walk_app_vdf(
            &mut r,
            next_entry,
            string_table.as_deref(),
                     false,
                     &mut app_name,
                     &mut app_type,
        );

        if !app_name.is_empty() {
            result.insert(app_id, (app_name, app_type));
        }
        r.pos = next_entry;
    }

    result
}

fn parse_steam_packageinfo_vdf(path: &Path) -> std::collections::HashSet<u32> {
    let mut app_ids = std::collections::HashSet::new();
    let Ok(data) = fs::read(path) else {
        return app_ids;
    };
    let mut r = BinVdfReader::new(&data, 0);
    let Some(magic) = r.read_u32() else {
        return app_ids;
    };
    let Some(_universe) = r.read_u32() else {
        return app_ids;
    };

    let has_pics_token = magic >= 0x0656_5528;

    fn walk_pkg_vdf(
        r: &mut BinVdfReader,
        in_appids: bool,
        app_ids: &mut std::collections::HashSet<u32>,
    ) -> bool {
        while let Some(vtype) = r.read_u8() {
            if vtype == 0x08 {
                return true;
            }
            let Some(key) = r.read_cstring() else {
                return false;
            };
            match vtype {
                0x00 => {
                    let is_appids = in_appids || key.eq_ignore_ascii_case("appids");
                    if !walk_pkg_vdf(r, is_appids, app_ids) {
                        return false;
                    }
                }
                0x01 => {
                    if r.read_cstring().is_none() {
                        return false;
                    }
                }
                0x02 => {
                    let Some(val) = r.read_u32() else {
                        return false;
                    };
                    if in_appids && val != 0 {
                        app_ids.insert(val);
                    }
                }
                0x03 | 0x04 | 0x06 => {
                    if !r.skip(4) {
                        return false;
                    }
                }
                0x05 => {
                    if !r.skip_wstring() {
                        return false;
                    }
                }
                0x07 | 0x0A => {
                    if !r.skip(8) {
                        return false;
                    }
                }
                _ => return false,
            }
        }
        true
    }

    loop {
        let Some(pkg_id) = r.read_u32() else {
            break;
        };
        if pkg_id == 0xFFFF_FFFF {
            break;
        }
        let header_skip = if has_pics_token { 32 } else { 24 };
        if !r.skip(header_skip) {
            break;
        }
        if !walk_pkg_vdf(&mut r, false, &mut app_ids) {
            break;
        }
    }

    app_ids
}

fn is_valid_steam_game_id(id_str: &str, shortcut_ids: &std::collections::HashSet<u64>) -> bool {
    let Ok(id) = id_str.parse::<u64>() else {
        return false;
    };

    if id == 0 || id >= 2_147_483_648 || shortcut_ids.contains(&id) {
        return false;
    }

    !matches!(
        id,
        7 | 218 | 480 | 228980 | 1070560 | 1391110 | 1493710 | 1628350 | 1826330 | 2348590 | 2805730
    )
}

fn parse_vdf_apps_section(
    content: &str,
    shortcut_ids: &std::collections::HashSet<u64>,
) -> Vec<String> {
    let mut ids = Vec::new();
    let mut brace_depth: usize = 0;
    let mut pending_apps_block = false;
    let mut apps_block_depth: Option<usize> = None;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if line.eq_ignore_ascii_case("\"apps\"") {
            pending_apps_block = true;
            continue;
        }

        if line == "{" {
            brace_depth += 1;
            if pending_apps_block {
                apps_block_depth = Some(brace_depth);
                pending_apps_block = false;
            }
            continue;
        }

        if line == "}" {
            if apps_block_depth == Some(brace_depth) {
                apps_block_depth = None;
            }
            brace_depth = brace_depth.saturating_sub(1);
            continue;
        }

        pending_apps_block = false;

        if apps_block_depth == Some(brace_depth)
            && line.starts_with('"')
            && line.ends_with('"')
            && line.len() > 2
            {
                let inner = &line[1..line.len() - 1];
                if !inner.contains('"') && is_valid_steam_game_id(inner, shortcut_ids) {
                    ids.push(inner.to_string());
                }
            }
    }

    ids
}

#[tauri::command]
async fn scan_external_launchers() -> Result<Vec<Game>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut games = Vec::new();
        let home = std::env::var("HOME").unwrap_or_default();

        let base_steam_roots = vec![
            PathBuf::from(format!("{}/.local/share/Steam", home)),
                                         PathBuf::from(format!("{}/.steam/root", home)),
                                         PathBuf::from(format!("{}/.steam/steam", home)),
                                         PathBuf::from(format!("{}/.var/app/com.valvesoftware.Steam/.local/share/Steam", home)),
        ];

        let mut shortcut_ids: std::collections::HashSet<u64> = std::collections::HashSet::new();
        let mut shortcut_names: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut app_metadata: HashMap<u32, (String, String)> = HashMap::new();
        let mut package_app_ids: std::collections::HashSet<u32> = std::collections::HashSet::new();

        let mut seen_roots = std::collections::HashSet::new();
        for root in &base_steam_roots {
            if !root.exists() {
                continue;
            }
            let canon_root = fs::canonicalize(root).unwrap_or_else(|_| root.clone());
            if !seen_roots.insert(canon_root) {
                continue;
            }

            let appinfo_path = root.join("appcache/appinfo.vdf");
            if appinfo_path.exists() && app_metadata.is_empty() {
                app_metadata = parse_steam_appinfo_vdf(&appinfo_path);
            }

            let pkginfo_path = root.join("appcache/packageinfo.vdf");
            if pkginfo_path.exists() && package_app_ids.is_empty() {
                package_app_ids = parse_steam_packageinfo_vdf(&pkginfo_path);
            }

            let userdata = root.join("userdata");
            if let Ok(users) = fs::read_dir(&userdata) {
                for user in users.flatten() {
                    let shortcuts_path = user.path().join("config/shortcuts.vdf");
                    if shortcuts_path.exists() {
                        parse_steam_shortcuts_vdf(
                            &shortcuts_path,
                            &mut shortcut_ids,
                            &mut shortcut_names,
                        );
                    }
                }
            }
        }

        let mut steamapps_dirs: Vec<PathBuf> = Vec::new();
        let mut seen_canonical_dirs = std::collections::HashSet::new();

        let mut add_steamapps_dir = |dir: PathBuf| {
            if dir.exists() {
                let canon = fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
                if seen_canonical_dirs.insert(canon) {
                    steamapps_dirs.push(dir);
                }
            }
        };

        for root in &base_steam_roots {
            let main_steamapps = root.join("steamapps");
            add_steamapps_dir(main_steamapps.clone());

            let lib_folders_vdf = main_steamapps.join("libraryfolders.vdf");
            if let Ok(content) = fs::read_to_string(&lib_folders_vdf) {
                for line in content.lines() {
                    if line.contains("\"path\"") {
                        let parts: Vec<&str> = line.split('"').collect();
                        if parts.len() >= 4 {
                            add_steamapps_dir(PathBuf::from(parts[3]).join("steamapps"));
                        }
                    }
                }
            }
        }

        let mut found_app_ids = std::collections::HashSet::new();

        for steam_apps in &steamapps_dirs {
            if let Ok(entries) = fs::read_dir(steam_apps) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with("appmanifest_") && name.ends_with(".acf") {
                        if let Ok(content) = fs::read_to_string(entry.path()) {
                            let mut title = String::new();
                            let mut app_id = String::new();
                            let mut install_dir = String::new();

                            for line in content.lines() {
                                if line.contains("\"name\"") {
                                    let parts: Vec<&str> = line.split('"').collect();
                                    if parts.len() >= 4 {
                                        title = parts[3].to_string();
                                    }
                                }
                                if line.contains("\"appid\"") {
                                    let parts: Vec<&str> = line.split('"').collect();
                                    if parts.len() >= 4 {
                                        app_id = parts[3].to_string();
                                    }
                                }
                                if line.contains("\"installdir\"") {
                                    let parts: Vec<&str> = line.split('"').collect();
                                    if parts.len() >= 4 {
                                        install_dir = parts[3].to_string();
                                    }
                                }
                            }

                            if !title.is_empty()
                                && is_valid_steam_game_id(&app_id, &shortcut_ids)
                                && !shortcut_names.contains(&title.trim().to_lowercase())
                                && found_app_ids.insert(app_id.clone())
                                {
                                    let steam_folder = if !install_dir.is_empty() {
                                        Some(format!("{}/common/{}", steam_apps.to_string_lossy(), install_dir))
                                    } else {
                                        Some(format!("{}/common/{}", steam_apps.to_string_lossy(), title))
                                    };

                                    games.push(Game {
                                        id: format!("steam_{}", app_id),
                                               title,
                                               exe_path: format!("steam://rungameid/{}", app_id),
                                               runner_path: "steam".to_string(),
                                               wine_prefix: steam_folder,
                                               launch_args: None,
                                               env_vars: None,
                                               use_gamemode: true,
                                               use_mangohud: false,
                                               cover_url: Some(format!(
                                                   "https://cdn.cloudflare.steamstatic.com/steam/apps/{}/library_600x900.jpg",
                                                   app_id
                                               )),
                                               banner_url: None,
                                               genre: Some("Action".to_string()),
                                               source: Some("steam".to_string()),
                                               favorite: Some(false),
                                               hidden: Some(false),
                                               tags: Some(vec![]),
                                               playtime_minutes: Some(0),
                                    });
                                }
                        }
                    }
                }
            }
        }

        let mut candidate_uninstalled_ids: Vec<String> = Vec::new();
        let mut seen_candidates = found_app_ids.clone();

        for &pkg_app_id in &package_app_ids {
            let id_str = pkg_app_id.to_string();
            if is_valid_steam_game_id(&id_str, &shortcut_ids) && seen_candidates.insert(id_str.clone()) {
                candidate_uninstalled_ids.push(id_str);
            }
        }

        let mut seen_userdata = std::collections::HashSet::new();
        for root in &base_steam_roots {
            let userdata = root.join("userdata");
            if !userdata.exists() {
                continue;
            }
            let canon = fs::canonicalize(&userdata).unwrap_or_else(|_| userdata.clone());
            if !seen_userdata.insert(canon) {
                continue;
            }

            if let Ok(users) = fs::read_dir(&userdata) {
                for user in users.flatten() {
                    let user_dir = user.path();

                    let vdf_files = [
                        user_dir.join("config/localconfig.vdf"),
                                         user_dir.join("7/remote/sharedconfig.vdf"),
                    ];
                    for vdf in &vdf_files {
                        if let Ok(content) = fs::read_to_string(vdf) {
                            for app_id in parse_vdf_apps_section(&content, &shortcut_ids) {
                                if seen_candidates.insert(app_id.clone()) {
                                    candidate_uninstalled_ids.push(app_id);
                                }
                            }
                        }
                    }

                    let lib_cache = user_dir.join("config/librarycache");
                    if let Ok(entries) = fs::read_dir(lib_cache) {
                        for entry in entries.flatten() {
                            let fname = entry.file_name().to_string_lossy().to_string();
                            if let Some(stem) = fname.strip_suffix(".json") {
                                if is_valid_steam_game_id(stem, &shortcut_ids)
                                    && seen_candidates.insert(stem.to_string())
                                    {
                                        candidate_uninstalled_ids.push(stem.to_string());
                                    }
                            }
                        }
                    }
                }
            }
        }

        for app_id in candidate_uninstalled_ids {
            let Ok(num_id) = app_id.parse::<u32>() else {
                continue;
            };

            let resolved_title = if !app_metadata.is_empty() {
                match app_metadata.get(&num_id) {
                    Some((name, app_type)) if app_type == "game" => {
                        if shortcut_names.contains(&name.trim().to_lowercase()) {
                            continue;
                        }
                        name.clone()
                    }
                    _ => continue,
                }
            } else {
                format!("Steam Game {}", app_id)
            };

            games.push(Game {
                id: format!("steam_{}", app_id),
                       title: resolved_title,
                       exe_path: String::new(),
                       runner_path: "steam".to_string(),
                       wine_prefix: None,
                       launch_args: None,
                       env_vars: None,
                       use_gamemode: true,
                       use_mangohud: false,
                       cover_url: Some(format!(
                           "https://cdn.cloudflare.steamstatic.com/steam/apps/{}/library_600x900.jpg",
                           app_id
                       )),
                       banner_url: None,
                       genre: Some("Action".to_string()),
                       source: Some("steam".to_string()),
                       favorite: Some(false),
                       hidden: Some(false),
                       tags: Some(vec![]),
                       playtime_minutes: Some(0),
            });
        }

        #[cfg(target_os = "linux")]
        {
            let lutris_db = PathBuf::from(format!("{}/.local/share/lutris/pga.db", home));
            if lutris_db.exists() {
                if let Ok(conn) = rusqlite::Connection::open_with_flags(
                    lutris_db,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                ) {
                    if let Ok(mut stmt) = conn.prepare(
                        "SELECT id, name, slug, runner, directory FROM games WHERE installed = 1",
                    ) {
                        let game_iter = stmt.query_map([], |row| {
                            let id: i32 = row.get(0)?;
                            let name: String = row.get(1)?;
                            let slug: String = row.get(2)?;
                            let runner: String = row.get(3)?;
                            let directory: Option<String> = row.get(4).ok().flatten();
                            Ok((id, name, slug, runner, directory))
                        });

                        if let Ok(iter) = game_iter {
                            for g in iter.flatten() {
                                let (id, name, slug, runner, directory) = g;
                                games.push(Game {
                                    id: format!("lutris_{}", id),
                                           title: name,
                                           exe_path: format!("lutris:rungame/{}", slug),
                                           runner_path: format!("lutris_{}", runner),
                                           wine_prefix: directory,
                                           launch_args: None,
                                           env_vars: None,
                                           use_gamemode: true,
                                           use_mangohud: false,
                                           cover_url: None,
                                           banner_url: None,
                                           genre: Some("Action".to_string()),
                                           source: Some("lutris".to_string()),
                                           favorite: Some(false),
                                           hidden: Some(false),
                                           tags: Some(vec![]),
                                           playtime_minutes: Some(0),
                                });
                            }
                        }
                    }
                }
            }
        }

        Ok(games)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_games(games: Vec<Game>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file_path = get_games_file_path();
        let temp_path = file_path.with_extension("json.tmp");

        let json = serde_json::to_string_pretty(&games).map_err(|e| e.to_string())?;
        fs::write(&temp_path, json).map_err(|e| e.to_string())?;
        fs::rename(temp_path, file_path).map_err(|e| e.to_string())?;

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn load_saved_games() -> Result<Vec<Game>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file_path = get_games_file_path();
        if !file_path.exists() {
            return Ok(Vec::new());
        }

        if let Ok(content) = fs::read_to_string(file_path) {
            if let Ok(games) = serde_json::from_str(&content) {
                return Ok(games);
            }
        }

        Ok(Vec::new())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn search_cover_art(
    state: tauri::State<'_, AppHttpClient>,
    title: String,
) -> Result<Option<String>, String> {
    let clean_title = title
    .split("v0.")
    .next().unwrap_or(&title)
    .split("v1.")
    .next().unwrap_or(&title)
    .trim();

    // Poți folosi o cheie publică sau poți introduce propria cheie de SteamGridDB
    // Notă: SteamGridDB oferă o cheie de test/publică sau utilizatorii își pot genera una gratuit.
    let api_key = "b5d7d3d2e1c3a4f5e6b7c8d9e0f1a2b3"; // Exemplu / poți pune cheia ta de SteamGridDB aici

    // 1. Căutăm ID-ul jocului după titlu pe SteamGridDB
    let search_url = format!(
        "https://www.steamgriddb.com/api/v2/search/autocomplete/{}",
        urlencoding::encode(clean_title)
    );

    let client = &state.client;

    let req = client.get(&search_url)
    .header("Authorization", format!("Bearer {}", api_key))
    .send()
    .await;

    if let Ok(res) = req {
        if let Ok(json) = res.json::<serde_json::Value>().await {
            if let Some(data) = json.get("data").and_then(|d| d.as_array()) {
                if let Some(first_game) = data.first() {
                    if let Some(game_id) = first_game.get("id").and_then(|id| id.as_i64()) {

                        // 2. Dacă am găsit jocul, cerem cea mai bună posteră/ocopertă (Grid 600x900)
                        let grids_url = format!(
                            "https://www.steamgriddb.com/api/v2/grids/game/{}?dimensions=600x900",
                            game_id
                        );

                        if let Ok(grid_res) = client.get(&grids_url)
                            .header("Authorization", format!("Bearer {}", api_key))
                            .send()
                            .await
                            {
                                if let Ok(grid_json) = grid_res.json::<serde_json::Value>().await {
                                    if let Some(grids_data) = grid_json.get("data").and_then(|d| d.as_array()) {
                                        if let Some(first_grid) = grids_data.first() {
                                            if let Some(url) = first_grid.get("url").and_then(|u| u.as_str()) {
                                                return Ok(Some(url.to_string()));
                                            }
                                        }
                                    }
                                }
                            }
                    }
                }
            }
        }
    }

    // Fallback: Dacă SteamGridDB nu întoarce nimic, încercăm vechea metodă prin Steam Store API
    let fallback_url = format!(
        "https://store.steampowered.com/api/storesearch/?term={}&l=english&cc=US",
        urlencoding::encode(clean_title)
    );

    if let Ok(res) = client.get(&fallback_url).send().await {
        if let Ok(json) = res.json::<serde_json::Value>().await {
            if let Some(items) = json.get("items").and_then(|i| i.as_array()) {
                if let Some(first) = items.first() {
                    if let Some(id) = first.get("id").and_then(|id| id.as_i64()) {
                        return Ok(Some(format!(
                            "https://cdn.cloudflare.steamstatic.com/steam/apps/{}/library_600x900.jpg",
                            id
                        )));
                    }
                }
            }
        }
    }

    Ok(None)
}

#[tauri::command]
async fn select_file_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app
    .dialog()
    .file()
    .add_filter("Executables", &["exe", "sh", "bin", "AppImage", "EXE", "SH"])
    .blocking_pick_file();

    Ok(file_path.map(|p| p.to_string()))
}

#[tauri::command]
fn login_epic_games(_auth_code: String) -> Result<String, String> {
    Ok("Epic Games authentication integration in progress.".into())
}

fn resolve_tilde(path_str: &str) -> String {
    if path_str.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            return path_str.replacen('~', &home, 1);
        }
    }
    path_str.to_string()
}

fn command_exists(bin: &str) -> bool {
    if bin.contains('/') {
        return Path::new(bin).exists();
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            if Path::new(dir).join(bin).exists() {
                return true;
            }
        }
    }
    false
}

#[cfg(target_os = "linux")]
fn find_matching_game_pids(exe_path: &str, wine_prefix: &str) -> Vec<u32> {
    let mut matched_pids = Vec::new();
    let self_pid = std::process::id();

    let steam_app_id = exe_path
    .strip_prefix("steam://rungameid/")
    .or_else(|| exe_path.strip_prefix("steam://run/"))
    .map(|s| s.trim_matches('/').to_string());

    let lutris_slug = exe_path
    .strip_prefix("lutris:rungame/")
    .or_else(|| exe_path.strip_prefix("lutris:rungameid/"))
    .map(|s| s.trim_matches('/').to_lowercase());

    let prefix_norm = wine_prefix.trim_end_matches('/').to_lowercase();

    let Ok(entries) = fs::read_dir("/proc") else {
        return matched_pids;
    };

    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if pid == self_pid {
            continue;
        }

        let proc_dir = entry.path();

        let cmdline = fs::read(proc_dir.join("cmdline"))
        .map(|bytes| {
            bytes
            .split(|&b| b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).to_lowercase())
            .collect::<Vec<_>>()
            .join(" ")
        })
        .unwrap_or_default();

        if cmdline.is_empty()
            || cmdline.contains("xdg-open")
            || cmdline.contains("steamwebhelper")
            {
                continue;
            }

            let environ = fs::read(proc_dir.join("environ"))
            .map(|bytes| {
                bytes
                .split(|&b| b == 0)
                .filter(|s| !s.is_empty())
                .map(|s| String::from_utf8_lossy(s).to_string())
                .collect::<Vec<_>>()
            })
            .unwrap_or_default();

            let exe_link = fs::read_link(proc_dir.join("exe"))
            .map(|p| p.to_string_lossy().to_lowercase())
            .unwrap_or_default();

            let cwd_link = fs::read_link(proc_dir.join("cwd"))
            .map(|p| p.to_string_lossy().to_lowercase())
            .unwrap_or_default();

            if let Some(ref app_id) = steam_app_id {
                let env_match = environ.iter().any(|var| {
                    var == &format!("SteamAppId={}", app_id)
                    || var == &format!("SteamGameId={}", app_id)
                });
                let cmd_match = cmdline.contains(&format!("appid={}", app_id));

                if env_match || cmd_match {
                    matched_pids.push(pid);
                    continue;
                }
            }

            if !prefix_norm.is_empty() && prefix_norm.len() > 4 {
                let env_prefix_match = environ.iter().any(|var| {
                    let lower = var.to_lowercase();
                    lower.starts_with("wineprefix=") && lower.contains(&prefix_norm)
                });

                if env_prefix_match
                    || exe_link.starts_with(&prefix_norm)
                    || cwd_link.starts_with(&prefix_norm)
                    || cmdline.contains(&prefix_norm)
                    {
                        matched_pids.push(pid);
                        continue;
                    }
            }

            if let Some(ref slug) = lutris_slug {
                if !slug.is_empty() && cmdline.contains(slug) && !cmdline.ends_with("lutris") {
                    matched_pids.push(pid);
                }
            }
    }

    matched_pids
}

#[cfg(not(target_os = "linux"))]
fn find_matching_game_pids(_exe_path: &str, _wine_prefix: &str) -> Vec<u32> {
    Vec::new()
}

#[tauri::command]
async fn launch_game(
    app_handle: AppHandle,
    game: serde_json::Value,
    state: State<'_, RunningProcesses>,
) -> Result<String, String> {
    let game_id = game["id"].as_str().unwrap_or("").to_string();
    let raw_exe_path = game["exe_path"].as_str().unwrap_or("").trim();
    let raw_runner_path = game["runner_path"].as_str().unwrap_or("").trim();
    let raw_wine_prefix = game["wine_prefix"].as_str().unwrap_or("").trim();
    let use_gamemode = game["use_gamemode"].as_bool().unwrap_or(false);
    let use_mangohud = game["use_mangohud"].as_bool().unwrap_or(false);
    let env_vars: Option<HashMap<String, String>> = game.get("env_vars")
    .and_then(|v| serde_json::from_value(v.clone()).ok());

    if game_id.is_empty() || raw_exe_path.is_empty() {
        return Err("Cale executabil sau ID invalid!".to_string());
    }

    let exe_path = resolve_tilde(raw_exe_path);
    let runner_path = resolve_tilde(raw_runner_path);
    let wine_prefix = resolve_tilde(raw_wine_prefix);

    let _ = app_handle.emit(
        "game-status-changed",
        GameStatusPayload {
            game_id: game_id.clone(),
                            status: "starting".to_string(),
                            playtime_seconds: 0,
        },
    );

    let mut cmd;
    let is_uri = exe_path.contains("://") || exe_path.starts_with("lutris:");

    if is_uri {
        #[cfg(target_os = "windows")]
        {
            cmd = Command::new("cmd");
            cmd.args(["/C", "start", "", &exe_path]);
        }

        #[cfg(not(target_os = "windows"))]
        {
            if !command_exists("xdg-open") {
                return Err("Utilitarul 'xdg-open' lipsește de pe sistem.".to_string());
            }
            cmd = Command::new("xdg-open");
            cmd.arg(&exe_path);
        }
    } else {
        if !command_exists(&exe_path) {
            return Err(format!("Executabilul nu există pe disc: {}", exe_path));
        }

        #[cfg(target_os = "windows")]
        {
            cmd = Command::new(&exe_path);
            if let Some(parent) = Path::new(&exe_path).parent() {
                if parent.exists() {
                    cmd.current_dir(parent);
                }
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            let mut is_wine = false;

            let runner = if exe_path.to_lowercase().ends_with(".exe") {
                is_wine = true;
                if !runner_path.is_empty() && runner_path != "native" && !runner_path.starts_with("lutris_") && command_exists(&runner_path) {
                    runner_path.clone()
                } else if command_exists("wine") {
                    "wine".to_string()
                } else if Path::new("/usr/bin/wine").exists() {
                    "/usr/bin/wine".to_string()
                } else {
                    return Err("Nu s-a găsit niciun runner Wine/Proton valid.".to_string());
                }
            } else {
                exe_path.clone()
            };

            if use_gamemode && command_exists("gamemoderun") {
                cmd = Command::new("gamemoderun");
                cmd.arg(&runner);
            } else {
                cmd = Command::new(&runner);
            }

            // 3. Injectăm setările standard ca variabile de mediu
            if use_mangohud {
                cmd.env("MANGOHUD", "1");
                cmd.env("MANGOHUD_DLSYM", "1"); // Asigură atașarea dinamică pe unele jocuri Wine/Vulkan
                cmd.env("MANGOHUD_VULKAN_DLSYM", "1");
            }
            if is_wine && !wine_prefix.is_empty() {
                cmd.env("WINEPREFIX", &wine_prefix);
            }

            if let Some(envs) = &env_vars {
                for (key, value) in envs {
                    cmd.env(key, value);
                }
            }

            if is_wine {
                cmd.arg(&exe_path);
            }

            if let Some(parent) = Path::new(&exe_path).parent() {
                if parent.exists() {
                    cmd.current_dir(parent);
                }
            }
        }

        if let Some(args) = game["launch_args"].as_str() {
            if !args.trim().is_empty() {
                cmd.args(args.split_whitespace());
            }
        }
    }

    let start_time = Instant::now();
    let mut child = cmd.spawn().map_err(|e| format!("Eroare la lansare: {}", e))?;
    let pid = child.id();

    {
        let mut processes = state.0.lock().unwrap();
        processes.insert(game_id.clone(), pid);
    }

    let _ = app_handle.emit(
        "game-status-changed",
        GameStatusPayload {
            game_id: game_id.clone(),
                            status: "playing".to_string(),
                            playtime_seconds: 0,
        },
    );

    let state_arc = state.0.clone();
    let game_id_clone = game_id.clone();
    let handle_clone = app_handle.clone();
    let exe_path_clone = exe_path.clone();
    let wine_prefix_clone = wine_prefix.clone();

    std::thread::spawn(move || {
        let _ = child.wait();

        if is_uri {
            let mut game_detected = false;
            for _ in 0..30 {
                std::thread::sleep(std::time::Duration::from_secs(2));

                if !state_arc.lock().unwrap().contains_key(&game_id_clone) {
                    return;
                }

                let pids = find_matching_game_pids(&exe_path_clone, &wine_prefix_clone);
                if let Some(&real_pid) = pids.first() {
                    state_arc
                    .lock()
                    .unwrap()
                    .insert(game_id_clone.clone(), real_pid);
                    game_detected = true;
                    break;
                }
            }

            if game_detected {
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(2));

                    if !state_arc.lock().unwrap().contains_key(&game_id_clone) {
                        return;
                    }

                    let pids = find_matching_game_pids(&exe_path_clone, &wine_prefix_clone);
                    if let Some(&active_pid) = pids.first() {
                        state_arc
                        .lock()
                        .unwrap()
                        .insert(game_id_clone.clone(), active_pid);
                    } else {
                        break;
                    }
                }
            }
        }

        let elapsed = start_time.elapsed().as_secs();

        let was_running = state_arc.lock().unwrap().remove(&game_id_clone).is_some();
        if was_running {
            let _ = handle_clone.emit(
                "game-status-changed",
                GameStatusPayload {
                    game_id: game_id_clone,
                    status: "stopped".to_string(),
                                      playtime_seconds: elapsed,
                },
            );
        }
    });

    Ok(format!("Joc lansat cu PID {}", pid))
}

#[tauri::command]
fn kill_game_process(
    app_handle: AppHandle,
    game_id: String,
    state: State<'_, RunningProcesses>,
) -> Result<String, String> {
    let removed_pid = state.0.lock().unwrap().remove(&game_id);

    #[cfg(target_os = "windows")]
    {
        if let Some(pid) = removed_pid {
            let _ = Command::new("taskkill")
            .args(&["/F", "/PID", &pid.to_string()])
            .output();
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(pid) = removed_pid {
            let _ = Command::new("kill")
            .args(&["-9", &pid.to_string()])
            .output();
        }

        if let Ok(content) = fs::read_to_string(get_games_file_path()) {
            if let Ok(games) = serde_json::from_str::<Vec<Game>>(&content) {
                if let Some(g) = games.iter().find(|g| g.id == game_id) {
                    let prefix = resolve_tilde(g.wine_prefix.as_deref().unwrap_or(""));
                    for pid in find_matching_game_pids(&g.exe_path, &prefix) {
                        let _ = Command::new("kill")
                        .args(&["-9", &pid.to_string()])
                        .output();
                    }
                }
            }
        }
    }

    let _ = app_handle.emit(
        "game-status-changed",
        GameStatusPayload {
            game_id,
            status: "stopped".to_string(),
                            playtime_seconds: 0,
        },
    );

    if let Some(pid) = removed_pid {
        Ok(format!("Procesul {} a fost oprit.", pid))
    } else {
        Err("Procesul nu a fost găsit.".to_string())
    }
}

#[tauri::command]
async fn run_game_installer(
    installer_path: String,
    game_title: String,
    runner_path: String,
) -> Result<InstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home_dir = dirs::home_dir().ok_or("Nu s-a putut detecta directorul HOME")?;
        let sanitized_title = game_title.replace(" ", "_").replace("/", "_");
        let prefix_dir = home_dir.join("Games").join("Prefixes").join(&sanitized_title);

        if let Err(e) = fs::create_dir_all(&prefix_dir) {
            return Err(format!("Eroare la crearea directorului prefix: {}", e));
        }

        let prefix_str = prefix_dir.to_string_lossy().to_string();

        let runner = if runner_path.is_empty() || runner_path.contains("Proton") || runner_path.contains("compatibilitytools") {
            "/usr/bin/wine".to_string()
        } else {
            runner_path
        };

        let installer_file = PathBuf::from(&installer_path);
        let mut cmd = Command::new(&runner);
        cmd.env("WINEPREFIX", &prefix_str);

        if let Some(parent) = installer_file.parent() {
            cmd.current_dir(parent);
        }

        cmd.arg(&installer_path);

        let _ = cmd.status().map_err(|e| format!("Eroare la rularea installer-ului: {}", e))?;

        let runner_path_buf = PathBuf::from(&runner);
        let wineserver_bin = if let Some(parent) = runner_path_buf.parent() {
            let candidate = parent.join("wineserver");
            if candidate.exists() { candidate } else { PathBuf::from("wineserver") }
        } else {
            PathBuf::from("wineserver")
        };

        let _ = Command::new(wineserver_bin)
        .arg("-w")
        .env("WINEPREFIX", &prefix_str)
        .status();

        let drive_c = prefix_dir.join("drive_c");
        let detected = scan_for_game_exe(&drive_c);

        match detected {
            Some(exe_path) => Ok(InstallResult {
                success: true,
                detected_exe: Some(exe_path.to_string_lossy().to_string()),
                                 wine_prefix: prefix_str,
                                 message: "Instalare finalizată cu succes!".into(),
            }),
            None => Ok(InstallResult {
                success: false,
                detected_exe: None,
                wine_prefix: prefix_str,
                message: "Instalarea a fost anulată sau nu s-a găsit niciun executabil nou.".into(),
            }),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn scan_for_game_exe(drive_c: &Path) -> Option<PathBuf> {
    let program_files = vec![
        drive_c.join("Program Files"),
        drive_c.join("Program Files (x86)"),
        drive_c.join("GOG Games"),
        drive_c.join("Games"),
    ];

    let mut candidates = Vec::new();

    for pf in program_files {
        if pf.exists() {
            walk_find_exes(&pf, &mut candidates);
        }
    }

    candidates.retain(|path| {
        let path_str = path.to_string_lossy().to_lowercase();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();

        !path_str.contains("windows nt")
        && !path_str.contains("common files")
        && !path_str.contains("internet explorer")
        && !path_str.contains("windows media player")
        && !path_str.contains("system32")
        && !path_str.contains("syswow64")
        && !name.contains("unins")
        && !name.contains("setup")
        && !name.contains("dxsetup")
        && !name.contains("vc_redist")
        && !name.contains("crash")
        && !name.contains("iexplore")
        && !name.contains("wordpad")
        && !name.contains("notepad")
        && !name.contains("wmplayer")
        && !name.contains("winebrowser")
        && !name.contains("rundll32")
    });

    candidates.sort_by(|a, b| {
        let meta_a = fs::metadata(a).and_then(|m| m.modified()).ok();
        let meta_b = fs::metadata(b).and_then(|m| m.modified()).ok();
        meta_b.cmp(&meta_a)
    });

    candidates.into_iter().next()
}

fn walk_find_exes(dir: &Path, candidates: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk_find_exes(&path, candidates);
            } else if path.extension().map_or(false, |ext| ext == "exe") {
                candidates.push(path);
            }
        }
    }
}

#[tauri::command]
fn open_game_folder(exe_path: String, wine_prefix: Option<String>, title: Option<String>) -> Result<(), String> {
    let home_dir = std::env::var("HOME").unwrap_or_default();
    let mut path_to_open: Option<PathBuf> = None;

    if let Some(ref prefix) = wine_prefix {
        if !prefix.is_empty() {
            let resolved = if prefix.starts_with("~") {
                prefix.replacen("~", &home_dir, 1)
            } else {
                prefix.clone()
            };
            let p = PathBuf::from(&resolved);
            if p.exists() {
                path_to_open = Some(p);
            }
        }
    }

    if path_to_open.is_none() && !exe_path.starts_with("steam://") && !exe_path.starts_with("lutris:") {
        let resolved = if exe_path.starts_with("~") {
            exe_path.replacen("~", &home_dir, 1)
        } else {
            exe_path.clone()
        };
        let p = PathBuf::from(&resolved);
        if p.exists() {
            path_to_open = Some(if p.is_file() {
                p.parent().unwrap_or(&p).to_path_buf()
            } else {
                p
            });
        }
    }

    if path_to_open.is_none() {
        if let Some(ref game_title) = title {
            let clean_title = game_title.to_lowercase();

            let common_dirs = vec![
                PathBuf::from(format!("{}/.local/share/Steam/steamapps/common", home_dir)),
                PathBuf::from(format!("{}/.steam/steam/steamapps/common", home_dir)),
                PathBuf::from(format!("{}/.steam/root/steam/steamapps/common", home_dir)),
                PathBuf::from(format!("{}/.local/share/lutris/games", home_dir)),
                PathBuf::from(format!("{}/Games", home_dir)),
            ];

            'outer: for common_dir in common_dirs {
                if common_dir.exists() {
                    if let Ok(entries) = fs::read_dir(&common_dir) {
                        for entry in entries.flatten() {
                            let folder_name = entry.file_name().to_string_lossy().to_lowercase();
                            if folder_name == clean_title || folder_name.contains(&clean_title) || clean_title.contains(&folder_name) {
                                path_to_open = Some(entry.path());
                                break 'outer;
                            }
                        }
                    }
                }
            }
        }
    }

    let target = path_to_open.ok_or_else(|| "Directorul jocului nu a putut fi găsit pe disc.".to_string())?;

    if cfg!(target_os = "windows") {
        Command::new("explorer")
        .arg(&target)
        .spawn()
        .map_err(|e| format!("Nu s-a putut deschide folderul pe Windows: {}", e))?;
    } else {
        Command::new("xdg-open")
        .arg(&target)
        .spawn()
        .map_err(|e| format!("Nu s-a putut deschide folderul pe Linux: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
fn run_exe_in_prefix(exe_path: String, wine_prefix: Option<String>, runner_path: Option<String>) -> Result<(), String> {
    let runner = runner_path.unwrap_or_else(|| "/usr/bin/wine".to_string());
    let mut cmd = Command::new(if runner.is_empty() { "/usr/bin/wine" } else { &runner });

    if let Some(prefix) = wine_prefix {
        if !prefix.is_empty() {
            cmd.env("WINEPREFIX", prefix);
        }
    }

    cmd.arg(exe_path);
    cmd.spawn().map_err(|e| format!("Eroare la rularea executabilului în prefix: {}", e))?;

    Ok(())
}

#[tauri::command]
fn set_fullscreen(window: tauri::Window, fullscreen: bool) {
    let _ = window.set_fullscreen(fullscreen);
}

// -----------------------------------------------------------------------------
// MAIN ENTRY
// -----------------------------------------------------------------------------

fn main() {
    let sys = System::new_with_specifics(
        RefreshKind::new()
        .with_cpu(CpuRefreshKind::new().with_cpu_usage())
        .with_memory(MemoryRefreshKind::new().with_ram()),
    );

    let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(10))
    .build()
    .unwrap_or_default();

    tauri::Builder::default()
    .manage(AppSystemStats {
        sys: Mutex::new(sys),
    })
    .manage(AppHttpClient { client })
    .manage(RunningProcesses(Arc::new(Mutex::new(HashMap::new()))))
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![
        get_system_stats,
        get_available_runners,
        scan_external_launchers,
        kill_game_process,
        save_games,
        load_saved_games,
        select_file_dialog,
        launch_game,
        uninstall_game_files,
        search_cover_art,
        run_game_installer,
        open_game_folder,
        run_exe_in_prefix,
        set_fullscreen,
        get_steam_app_title,
        login_epic_games
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
