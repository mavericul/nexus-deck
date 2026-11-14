// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
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
    pub steam_app_id: Option<String>,
    pub protondb_tier: Option<String>,
    pub protondb_updated_at: Option<u64>,
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

fn normalize_game_title(s: &str) -> String {
    s.to_lowercase()
    .replace('™', "")
    .replace('®', "")
    .replace('©', "")
    .chars()
    .map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' })
    .collect::<String>()
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
}

fn strip_edition_suffix(norm: &str) -> String {
    let suffixes = [
        " premium edition",
        " standard edition",
        " definitive edition",
        " game of the year edition",
        " game of the year",
        " goty edition",
        " goty",
        " complete edition",
        " deluxe edition",
        " gold edition",
        " director s cut",
        " directors cut",
        " enhanced edition",
        " enhanced",
        " ultimate edition",
    ];
    let mut cleaned = norm.to_string();
    for suffix in suffixes {
        if let Some(stripped) = cleaned.strip_suffix(suffix) {
            cleaned = stripped.trim().to_string();
        }
    }
    cleaned
}

fn titles_match(candidate: &str, target_norm: &str, target_base: &str) -> bool {
    let cand_norm = normalize_game_title(candidate);
    if cand_norm.is_empty() {
        return false;
    }
    let cand_base = strip_edition_suffix(&cand_norm);
    cand_norm == target_norm
    || cand_norm == target_base
    || cand_base == target_norm
    || cand_base == target_base
}

fn extract_pcgw_steam_appid(wikitext: &str) -> Option<String> {
    let lower = wikitext.to_lowercase();
    let idx = lower.find("steam appid")?;
    let after_key = &wikitext[idx + "steam appid".len()..];
    let eq_idx = after_key.find('=')?;
    let after_eq = &after_key[eq_idx + 1..];
    let line_end = after_eq.find(['\n', '|', '}']).unwrap_or(after_eq.len());
    let val_str = after_eq[..line_end].trim();

    for part in val_str.split(',') {
        let digits: String = part
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
        if !digits.is_empty() {
            return Some(digits);
        }
    }
    None
}

#[tauri::command]
async fn resolve_steam_app_id(
    state: tauri::State<'_, AppHttpClient>,
    title: String,
) -> Result<Option<String>, String> {
    let norm = normalize_game_title(&title);
    if norm.is_empty() {
        return Ok(None);
    }
    let base_title = strip_edition_suffix(&norm);

    // 1. Mapări instant pentru jocuri delistate de pe Steam sau ediții speciale Epic
    let known_id: Option<&str> = match base_title.as_str() {
        "fall guys" | "fall guys ultimate knockout" => Some("1097150"),
        "rocket league" => Some("252950"),
        "grand theft auto v" | "gta v" | "gta 5" => Some("271590"),
        "grand theft auto v enhanced" => Some("3240220"),
        _ => None,
    };

    if let Some(id) = known_id {
        return Ok(Some(id.to_string()));
    }

    // 2. Steam Store Search (jocuri active pe Steam)
    let mut search_terms = vec![base_title.clone()];
    if norm != base_title {
        search_terms.push(norm.clone());
    }

    for term in &search_terms {
        let store_url = format!(
            "https://store.steampowered.com/api/storesearch/?term={}&l=english&cc=US",
            urlencoding::encode(term)
        );
        if let Ok(res) = state.client.get(&store_url).send().await {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                if let Some(items) = json["items"].as_array() {
                    for item in items {
                        let name = item["name"].as_str().unwrap_or("");
                        if titles_match(name, &norm, &base_title) {
                            if let Some(id) = item["id"].as_i64() {
                                return Ok(Some(id.to_string()));
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. PCGamingWiki MediaWiki API cu redirects=1 (rezolvă orice joc PC, inclusiv delisted)
    let clean_wiki_title = title
    .replace('™', "")
    .replace('®', "")
    .replace('©', "")
    .trim()
    .to_string();

    let pcgw_url = format!(
        "https://www.pcgamingwiki.com/w/api.php?action=query&titles={}&redirects=1&prop=revisions&rvprop=content&rvsection=0&format=json",
        urlencoding::encode(&clean_wiki_title)
    );

    if let Ok(res) = state.client.get(&pcgw_url).send().await {
        if let Ok(json) = res.json::<serde_json::Value>().await {
            if let Some(pages) = json["query"]["pages"].as_object() {
                for (page_id, page_val) in pages {
                    if page_id == "-1" {
                        continue;
                    }
                    if let Some(revs) = page_val["revisions"].as_array() {
                        if let Some(first_rev) = revs.first() {
                            if let Some(wikitext) = first_rev["*"].as_str() {
                                if let Some(app_id) = extract_pcgw_steam_appid(wikitext) {
                                    return Ok(Some(app_id));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(None)
}

#[tauri::command]
async fn get_protondb_tier(
    state: tauri::State<'_, AppHttpClient>,
    app_id: String,
) -> Result<Option<String>, String> {
    let clean_id = app_id.trim();
    if clean_id.is_empty() {
        return Ok(None);
    }

    let pdb_url = format!(
        "https://www.protondb.com/api/v1/reports/summaries/{}.json",
        clean_id
    );

    if let Ok(res) = state.client.get(&pdb_url).send().await {
        if res.status().is_success() {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                for key in ["tier", "trendingTier", "bestReportedTier"] {
                    if let Some(t) = json[key].as_str() {
                        let lower = t.to_lowercase();
                        if matches!(
                            lower.as_str(),
                                    "platinum" | "gold" | "silver" | "bronze" | "borked"
                        ) {
                            return Ok(Some(lower));
                        }
                    }
                }
            }
        }
    }

    let store_url = format!(
        "https://store.steampowered.com/api/appdetails?appids={}&filters=platforms",
        clean_id
    );

    if let Ok(res) = state.client.get(&store_url).send().await {
        if let Ok(json) = res.json::<serde_json::Value>().await {
            if json[clean_id]["data"]["platforms"]["linux"]
                .as_bool()
                .unwrap_or(false)
                {
                    return Ok(Some("native".to_string()));
                }
        }
    }

    Ok(None)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("URL invalid.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn()
        .map_err(|e| e.to_string())?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    }

    Ok(())
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
                                               steam_app_id: Some(app_id.clone()),
                                               protondb_tier: None,
                                               protondb_updated_at: None,
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
                       steam_app_id: Some(app_id),
                       protondb_tier: None,
                       protondb_updated_at: None,
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
                                           steam_app_id: None,
                                           protondb_tier: None,
                                           protondb_updated_at: None,
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

const EPIC_BASIC_AUTH: &str =
"Basic MzRhMDJjZjhmNDQxNGUyOWIxNTkyMTg3NmRhMzZmOWE6ZGFhZmJjY2M3Mzc3NDUwMzlkZmZlNTNkOTRmYzc2Y2Y=";

    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct EpicSession {
        pub access_token: String,
        pub refresh_token: String,
        pub account_id: String,
        pub display_name: String,
    }

    #[derive(Serialize, Debug)]
    pub struct EpicSyncResult {
        pub display_name: String,
        pub games: Vec<Game>,
    }

    fn get_epic_session_path() -> PathBuf {
        get_config_dir().join("epic_session.json")
    }

    fn detect_local_epic_installs() -> HashMap<String, (String, Option<String>)> {
        // Map: app_name -> (exe_path, wine_prefix)
        let mut installed = HashMap::new();

        #[cfg(target_os = "windows")]
        {
            let manifests_dir = PathBuf::from(r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests");
            if let Ok(entries) = fs::read_dir(manifests_dir) {
                for entry in entries.flatten() {
                    if entry.path().extension().and_then(|e| e.to_str()) == Some("item") {
                        if let Ok(content) = fs::read_to_string(entry.path()) {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                                let app_name = json["AppName"].as_str().unwrap_or_default();
                                let install_loc = json["InstallLocation"].as_str().unwrap_or_default();
                                let launch_exe = json["LaunchExecutable"].as_str().unwrap_or_default();
                                if !app_name.is_empty() && !install_loc.is_empty() && !launch_exe.is_empty() {
                                    let full_exe = PathBuf::from(install_loc).join(launch_exe);
                                    if full_exe.exists() {
                                        installed.insert(
                                            app_name.to_string(),
                                                         (full_exe.to_string_lossy().to_string(), None),
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            let home = std::env::var("HOME").unwrap_or_default();
            let candidate_files = [
                PathBuf::from(format!("{}/.config/legendary/installed.json", home)),
                PathBuf::from(format!(
                    "{}/.config/heroic/legendaryConfig/legendary/installed.json",
                    home
                )),
            ];

            for file in candidate_files {
                if let Ok(content) = fs::read_to_string(&file) {
                    if let Ok(serde_json::Value::Object(map)) =
                        serde_json::from_str::<serde_json::Value>(&content)
                        {
                            for (app_name, info) in map {
                                let install_path = info["install_path"].as_str().unwrap_or_default();
                                let executable = info["executable"].as_str().unwrap_or_default();
                                if !install_path.is_empty() && !executable.is_empty() {
                                    let full_exe = PathBuf::from(install_path).join(executable);
                                    if full_exe.exists() {
                                        installed.insert(
                                            app_name,
                                            (full_exe.to_string_lossy().to_string(), None),
                                        );
                                    }
                                }
                            }
                        }
                }
            }
        }

        installed
    }

    async fn fetch_epic_library_with_token(
        client: &reqwest::Client,
        access_token: &str,
    ) -> Result<Vec<Game>, String> {
        let local_installs = detect_local_epic_installs();
        let mut raw_records: Vec<serde_json::Value> = Vec::new();
        let mut seen_apps = std::collections::HashSet::new();
        let mut cursor: Option<String> = None;

        // 1. Preluăm toate item-urile din librăria contului Epic
        loop {
            let mut url =
            "https://library-service.live.use1a.on.epicgames.com/library/api/public/items?includeMetadata=true"
            .to_string();
            if let Some(ref c) = cursor {
                url.push_str(&format!("&cursor={}", urlencoding::encode(c)));
            }

            let res = client
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| format!("Eroare la descărcarea librăriei Epic: {}", e))?;

            if !res.status().is_success() {
                let status = res.status();
                let body = res.text().await.unwrap_or_default();
                return Err(format!("Epic Library API a returnat {}: {}", status, body));
            }

            let json: serde_json::Value = res
            .json()
            .await
            .map_err(|e| format!("Răspuns JSON invalid de la Epic: {}", e))?;

            if let Some(records) = json["records"].as_array() {
                for rec in records {
                    let namespace = rec["namespace"].as_str().unwrap_or_default();
                    let app_name = rec["appName"].as_str().unwrap_or_default();
                    if namespace.is_empty()
                        || namespace == "ue"
                        || app_name.is_empty()
                        || !seen_apps.insert(app_name.to_string())
                        {
                            continue;
                        }
                        raw_records.push(rec.clone());
                }
            }

            match json["responseMetadata"]["nextCursor"].as_str() {
                Some(next) if !next.is_empty() => cursor = Some(next.to_string()),
                _ => break,
            }
        }

        // 2. Grupăm ID-urile pe namespace pentru a prelua titlurile și coperțile din Catalog API
        let mut ns_to_ids: HashMap<String, Vec<String>> = HashMap::new();
        for rec in &raw_records {
            let ns = rec["namespace"].as_str().unwrap_or_default();
            let cat_id = rec["catalogItemId"].as_str().unwrap_or_default();
            if !ns.is_empty() && !cat_id.is_empty() {
                ns_to_ids
                .entry(ns.to_string())
                .or_default()
                .push(cat_id.to_string());
            }
        }

        let mut catalog_items: HashMap<String, serde_json::Value> = HashMap::new();
        for (ns, ids) in ns_to_ids {
            for chunk in ids.chunks(50) {
                let query_ids: Vec<String> = chunk
                .iter()
                .map(|id| format!("id={}", urlencoding::encode(id)))
                .collect();
                let catalog_url = format!(
                    "https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/{}/bulk/items?{}&includeDLCDetails=true&includeMainGameDetails=true&country=US&locale=en",
                    urlencoding::encode(&ns),
                                          query_ids.join("&")
                );

                if let Ok(res) = client
                    .get(&catalog_url)
                    .bearer_auth(access_token)
                    .send()
                    .await
                    {
                        if let Ok(serde_json::Value::Object(map)) = res.json::<serde_json::Value>().await {
                            for (item_id, item_val) in map {
                                catalog_items.insert(item_id, item_val);
                            }
                        }
                    }
            }
        }

        // 3. Construim lista finală de jocuri
        let mut games = Vec::new();
        for rec in raw_records {
            let app_name = rec["appName"].as_str().unwrap_or_default();
            let cat_id = rec["catalogItemId"].as_str().unwrap_or_default();
            let cat_meta = catalog_items.get(cat_id);
            let rec_meta = &rec["metadata"];

            // Excludem DLC-urile care aparțin unui joc principal
            if let Some(cm) = cat_meta {
                if cm.get("mainGameItem").map_or(false, |v| v.is_object()) {
                    continue;
                }
            }

            let categories = cat_meta
            .and_then(|cm| cm["categories"].as_array())
            .or_else(|| rec_meta["categories"].as_array());

            if let Some(cats) = categories {
                if !cats.is_empty() {
                    let is_non_game = cats.iter().any(|c| {
                        let p = c["path"].as_str().unwrap_or_default();
                        p == "addons" || p == "mods" || p == "engines" || p == "plugins"
                    });
                    let has_game_cat = cats.iter().any(|c| {
                        let p = c["path"].as_str().unwrap_or_default();
                        p == "games" || p.starts_with("games/") || p == "applications" || p == "freegames"
                    });
                    if is_non_game && !has_game_cat {
                        continue;
                    }
                }
            }

            let title = cat_meta
            .and_then(|cm| cm["title"].as_str())
            .or_else(|| rec_meta["title"].as_str())
            .or_else(|| rec["sandboxName"].as_str())
            .unwrap_or(app_name)
            .trim();

            if title.is_empty() {
                continue;
            }

            let mut cover_url: Option<String> = None;
            let mut banner_url: Option<String> = None;

            let images = cat_meta
            .and_then(|cm| cm["keyImages"].as_array())
            .or_else(|| rec_meta["keyImages"].as_array());

            if let Some(imgs) = images {
                for img in imgs {
                    let img_type = img["type"].as_str().unwrap_or_default();
                    let img_url = img["url"].as_str().unwrap_or_default();
                    if img_url.is_empty() {
                        continue;
                    }
                    if img_type == "DieselGameBoxTall" || img_type == "OfferImageTall" {
                        cover_url = Some(img_url.to_string());
                    } else if img_type == "DieselGameBox" || img_type == "DieselGameBoxWide" {
                        banner_url = Some(img_url.to_string());
                    }
                }
                if cover_url.is_none() {
                    cover_url = banner_url.clone();
                }
            }

            let (exe_path, wine_prefix) = local_installs
            .get(app_name)
            .cloned()
            .unwrap_or_else(|| (String::new(), None));

            games.push(Game {
                id: format!("epic_{}", app_name),
                       title: title.to_string(),
                       exe_path,
                       runner_path: if cfg!(target_os = "windows") {
                           "native".to_string()
                       } else {
                           "/usr/bin/wine".to_string()
                       },
                       wine_prefix,
                       launch_args: None,
                       env_vars: None,
                       use_gamemode: true,
                       use_mangohud: false,
                       cover_url,
                       banner_url,
                       genre: Some("Action".to_string()),
                       source: Some("epic".to_string()),
                       favorite: Some(false),
                       hidden: Some(false),
                       tags: Some(vec![]),
                       playtime_minutes: Some(0),
                       steam_app_id: None,
                       protondb_tier: None,
                       protondb_updated_at: None,
            });
        }

        Ok(games)
    }

    #[tauri::command]
    async fn login_epic_games(
        state: tauri::State<'_, AppHttpClient>,
        auth_code: String,
    ) -> Result<EpicSyncResult, String> {
        let trimmed = auth_code.trim();
        // Permite utilizatorului să lipească fie codul brut, fie întregul JSON returnat de Epic
        let clean_code = if trimmed.starts_with('{') {
        let parsed: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|_| "JSON-ul lipit nu este valid.".to_string())?;
        parsed["authorizationCode"]
        .as_str()
        .or_else(|| parsed["sid"].as_str())
        .ok_or("Nu s-a găsit câmpul 'authorizationCode' în JSON.")?
        .to_string()
        } else {
            trimmed.trim_matches('"').to_string()
        };

        if clean_code.is_empty() {
            return Err("Codul de autorizare este gol.".to_string());
        }

        let params = [
            ("grant_type", "authorization_code"),
            ("code", clean_code.as_str()),
            ("token_type", "eg1"),
        ];

        let res = state
        .client
        .post("https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token")
        .header("Authorization", EPIC_BASIC_AUTH)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Eroare de conectare la Epic Games: {}", e))?;

        let token_json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Eroare la citirea răspunsului OAuth: {}", e))?;

        if let Some(err_msg) = token_json["errorMessage"].as_str() {
            return Err(format!("Autentificare Epic eșuată: {}", err_msg));
        }

        let access_token = token_json["access_token"]
        .as_str()
        .ok_or("Lipsește access_token din răspunsul Epic.")?
        .to_string();
        let refresh_token = token_json["refresh_token"]
        .as_str()
        .unwrap_or_default()
        .to_string();
        let account_id = token_json["account_id"]
        .as_str()
        .unwrap_or_default()
        .to_string();
        let display_name = token_json["displayName"]
        .as_str()
        .unwrap_or("Epic User")
        .to_string();

        let session = EpicSession {
            access_token: access_token.clone(),
            refresh_token,
            account_id,
            display_name: display_name.clone(),
        };

        if let Ok(serialized) = serde_json::to_string_pretty(&session) {
            let _ = fs::write(get_epic_session_path(), serialized);
        }

        let games = fetch_epic_library_with_token(&state.client, &access_token).await?;

        Ok(EpicSyncResult {
            display_name,
            games,
        })
    }

    #[tauri::command]
    async fn sync_epic_games(
        state: tauri::State<'_, AppHttpClient>,
    ) -> Result<EpicSyncResult, String> {
        let session_path = get_epic_session_path();
        let content = fs::read_to_string(&session_path)
        .map_err(|_| "Nu ești autentificat în Epic Games. Te rugăm să te loghezi mai întâi.".to_string())?;
        let mut session: EpicSession = serde_json::from_str(&content)
        .map_err(|_| "Fișierul de sesiune Epic este corupt.".to_string())?;

        // Reînnoim token-ul folosind refresh_token
        let params = [
            ("grant_type", "refresh_token"),
            ("refresh_token", session.refresh_token.as_str()),
            ("token_type", "eg1"),
        ];

        let res = state
        .client
        .post("https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token")
        .header("Authorization", EPIC_BASIC_AUTH)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Eroare la reînnoirea sesiunii Epic: {}", e))?;

        let token_json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Răspuns invalid la refresh token: {}", e))?;

        if let Some(new_access) = token_json["access_token"].as_str() {
            session.access_token = new_access.to_string();
            if let Some(new_refresh) = token_json["refresh_token"].as_str() {
                session.refresh_token = new_refresh.to_string();
            }
            if let Ok(serialized) = serde_json::to_string_pretty(&session) {
                let _ = fs::write(&session_path, serialized);
            }
        } else {
            return Err("Sesiunea Epic a expirat. Te rugăm să te autentifici din nou.".to_string());
        }

        let games = fetch_epic_library_with_token(&state.client, &session.access_token).await?;

        Ok(EpicSyncResult {
            display_name: session.display_name,
            games,
        })
    }

    pub struct DownloadState {
        pub active_pid: Arc<Mutex<Option<u32>>>,
        pub is_paused: Arc<Mutex<bool>>,
        pub active_game_subdir: Arc<Mutex<Option<PathBuf>>>,
    }

    #[derive(Serialize, Clone)]
    struct EpicInstallProgress {
        status: String, // "starting" | "downloading" | "paused" | "completed" | "error" | "cancelled"
        app_name: String,
        title: String,
        percent: f32,
        speed: String,
        eta: String,
        message: String,
        exe_path: Option<String>,
        wine_prefix: Option<String>,
        runner_path: Option<String>,
    }

    #[derive(Serialize)]
    struct EpicDiskSpaceInfo {
        required_bytes: u64,
        available_bytes: u64,
        has_enough_space: bool,
    }

    #[derive(Serialize)]
    struct LegendaryStatus {
        installed: bool,
        default_dir: String,
            version: String,
    }

    fn get_legendary_config_dir() -> Option<PathBuf> {
        dirs::home_dir().map(|h| h.join(".config").join("legendary"))
    }


    /// Sincronizează sesiunea din ~/.config/nexusdeck/epic_session.json în ~/.config/legendary/user.json
    fn sync_session_to_legendary() -> Result<(), String> {
        let session_file = get_epic_session_path();
        if !session_file.exists() {
            return Err("Nu există o sesiune Epic activă. Conectează-te mai întâi la Epic Games.".into());
        }

        let raw = fs::read_to_string(&session_file)
        .map_err(|e| format!("Eroare la citirea epic_session.json: {}", e))?;
        let session: EpicSession = serde_json::from_str(&raw)
        .map_err(|e| format!("Fișierul epic_session.json este invalid: {}", e))?;

        let leg_dir = get_legendary_config_dir()
        .ok_or_else(|| "Nu s-a putut determina folderul HOME.".to_string())?;
        fs::create_dir_all(&leg_dir)
        .map_err(|e| format!("Nu s-a putut crea ~/.config/legendary: {}", e))?;

        let user_json_path = leg_dir.join("user.json");

        // Dacă legendary are deja un user.json valid pentru același cont (cu token reînnoit), nu îl suprascriem
        if let Ok(existing_raw) = fs::read_to_string(&user_json_path) {
            if let Ok(existing_json) = serde_json::from_str::<serde_json::Value>(&existing_raw) {
                if existing_json["account_id"].as_str() == Some(session.account_id.as_str())
                    && existing_json["expires_at"].as_str().is_some()
                    {
                        return Ok(());
                    }
            }
        }

        // Formatul OAuth complet așteptat de legendary (expires_at în trecut forțează auto-refresh)
        let legendary_user = serde_json::json!({
            "access_token": session.access_token,
            "refresh_token": session.refresh_token,
            "account_id": session.account_id,
            "displayName": session.display_name,
            "token_type": "eg1",
            "client_id": "34a02cf8f4414e29b15921876da36f9a",
            "expires_in": 0,
            "expires_at": "2000-01-01T00:00:00.000Z",
            "refresh_expires": 115200,
            "refresh_expires_at": "2099-01-01T00:00:00.000Z",
            "internal_client": true,
            "client_service": "launcher",
            "app": "launcher",
            "in_app_id": session.account_id
        });

        let serialized = serde_json::to_string_pretty(&legendary_user)
        .map_err(|e| format!("Eroare la serializarea user.json: {}", e))?;

        fs::write(&user_json_path, serialized)
        .map_err(|e| format!("Nu s-a putut scrie user.json pentru legendary: {}", e))?;

        Ok(())
    }

    #[tauri::command]
    fn check_legendary_status() -> LegendaryStatus {
        let default_dir = dirs::home_dir()
        .map(|h| h.join("Games").join("Epic").to_string_lossy().to_string())
        .unwrap_or_else(|| "C:\\Games\\Epic".to_string());

        match Command::new("legendary").arg("--version").output() {
            Ok(out) if out.status.success() => LegendaryStatus {
                installed: true,
                default_dir,
                version: String::from_utf8_lossy(&out.stdout).trim().to_string(),
            },
            _ => LegendaryStatus {
                installed: false,
                default_dir,
                version: String::new(),
            },
        }
    }

    #[derive(Serialize)]
    struct SteamInstallStatus {
        state: String, // "installed" | "downloading" | "not_found"
        percent: f32,
    }

    #[tauri::command]
    fn check_steam_install_status(app_id: String) -> SteamInstallStatus {
        let home = std::env::var("HOME").unwrap_or_default();
        let base_roots = [
            PathBuf::from(format!("{}/.local/share/Steam", home)),
            PathBuf::from(format!("{}/.steam/root", home)),
            PathBuf::from(format!("{}/.steam/steam", home)),
            PathBuf::from(format!(
                "{}/.var/app/com.valvesoftware.Steam/.local/share/Steam",
                home
            )),
        ];

        let mut steamapps_dirs: Vec<PathBuf> = Vec::new();
        for root in &base_roots {
            let main_sa = root.join("steamapps");
            if main_sa.exists() {
                steamapps_dirs.push(main_sa.clone());
                if let Ok(content) = fs::read_to_string(main_sa.join("libraryfolders.vdf")) {
                    for line in content.lines() {
                        if line.contains("\"path\"") {
                            let parts: Vec<&str> = line.split('"').collect();
                            if parts.len() >= 4 {
                                let lib_sa = PathBuf::from(parts[3]).join("steamapps");
                                if lib_sa.exists() {
                                    steamapps_dirs.push(lib_sa);
                                }
                            }
                        }
                    }
                }
            }
        }

        let manifest_name = format!("appmanifest_{}.acf", app_id);
        for sa_dir in steamapps_dirs {
            let acf_path = sa_dir.join(&manifest_name);
            if let Ok(content) = fs::read_to_string(&acf_path) {
                let mut state_flags = String::new();
                let mut bytes_downloaded: u64 = 0;
                let mut bytes_to_download: u64 = 0;

                for line in content.lines() {
                    let parts: Vec<&str> = line.split('"').collect();
                    if parts.len() >= 4 {
                        match parts[1] {
                            "StateFlags" => state_flags = parts[3].to_string(),
                            "BytesDownloaded" => bytes_downloaded = parts[3].parse().unwrap_or(0),
                            "BytesToDownload" => bytes_to_download = parts[3].parse().unwrap_or(0),
                            _ => {}
                        }
                    }
                }

                if state_flags == "4" {
                    return SteamInstallStatus {
                        state: "installed".into(),
                        percent: 100.0,
                    };
                }

                let percent = if bytes_to_download > 0 {
                    (bytes_downloaded as f32 / bytes_to_download as f32) * 100.0
                } else {
                    0.0
                };

                return SteamInstallStatus {
                    state: "downloading".into(),
                    percent,
                };
            }
        }

        SteamInstallStatus {
            state: "not_found".into(),
            percent: 0.0,
        }
    }

    #[tauri::command]
    async fn select_folder_dialog(app: AppHandle) -> Result<Option<String>, String> {
        use tauri_plugin_dialog::DialogExt;

        let folder_path = app.dialog().file().blocking_pick_folder();
        Ok(folder_path.map(|p| p.to_string()))
    }

    fn get_available_disk_bytes(target_dir: &str) -> u64 {
        let resolved = resolve_tilde(target_dir);
        let mut check_path = PathBuf::from(&resolved);
        while !check_path.exists() {
            if let Some(parent) = check_path.parent() {
                check_path = parent.to_path_buf();
            } else {
                break;
            }
        }
        let canon = fs::canonicalize(&check_path).unwrap_or(check_path);

        let disks = sysinfo::Disks::new_with_refreshed_list();
        let mut best_match: Option<(usize, u64)> = None;

        for disk in disks.list() {
            let mount = disk.mount_point();
            if canon.starts_with(mount) {
                let len = mount.as_os_str().len();
                if best_match.map_or(true, |(best_len, _)| len > best_len) {
                    best_match = Some((len, disk.available_space()));
                }
            }
        }

        best_match.map(|(_, space)| space).unwrap_or(0)
    }

    #[tauri::command]
    async fn get_epic_game_disk_info(
        app_name: String,
        install_dir: String,
    ) -> Result<EpicDiskSpaceInfo, String> {
        let clean_app_name = app_name.trim_start_matches("epic_").to_string();
        let available_bytes = get_available_disk_bytes(&install_dir);

        let required_bytes = tauri::async_runtime::spawn_blocking(move || {
            let _ = sync_session_to_legendary();
            let output = Command::new("legendary")
            .args(["info", &clean_app_name, "--json"])
            .output();

            if let Ok(out) = output {
                if out.status.success() {
                    if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                        return json["manifest"]["disk_size"]
                        .as_u64()
                        .or_else(|| json["game"]["disk_size"].as_u64())
                        .or_else(|| json["disk_size"].as_u64())
                        .unwrap_or(0);
                    }
                }
            }
            0
        })
        .await
        .unwrap_or(0);

        let has_enough_space = required_bytes == 0 || available_bytes >= required_bytes;

        Ok(EpicDiskSpaceInfo {
            required_bytes,
            available_bytes,
            has_enough_space,
        })
    }

    fn cleanup_epic_partial_files(
        clean_app_name: &str,
        install_dir: Option<&str>,
        known_subdir: Option<PathBuf>,
    ) {
        let _ = Command::new("legendary")
        .args(["uninstall", clean_app_name, "-y"])
        .output();

        // 1. Șterge subfolderul exact detectat în timpul descărcării
        if let Some(subdir) = known_subdir {
            if subdir.exists() && subdir.is_dir() {
                let _ = fs::remove_dir_all(&subdir);
            }
        }

        // 2. Fallback: verifică în install_dir orice subfolder care conține .egstore (descărcare neterminată)
        if let Some(dir) = install_dir {
            let resolved = resolve_tilde(dir);
            if let Ok(entries) = fs::read_dir(&resolved) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_dir() && p.join(".egstore").exists() {
                        let _ = fs::remove_dir_all(&p);
                    }
                }
            }
        }

        // 3. Curăță fișierele temporare și resume din ~/.config/legendary/tmp
        if let Some(config_dir) = dirs::config_dir() {
            let tmp_dir = config_dir.join("legendary").join("tmp");
            if let Ok(entries) = fs::read_dir(&tmp_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(|s| s.contains(clean_app_name))
                        .unwrap_or(false)
                        {
                            if path.is_dir() {
                                let _ = fs::remove_dir_all(&path);
                            } else {
                                let _ = fs::remove_file(&path);
                            }
                        }
                }
            }
        }
    }

    #[tauri::command]
    fn install_epic_game(
        app_handle: AppHandle,
        state: State<'_, DownloadState>,
        app_name: String,
        game_title: String,
        install_dir: String,
    ) -> Result<(), String> {
        {
            let guard = state.active_pid.lock().unwrap();
            if guard.is_some() {
                return Err("Există deja o descărcare în desfășurare.".into());
            }
        }

        {
            let mut paused_guard = state.is_paused.lock().unwrap();
            *paused_guard = false;
        }

        sync_session_to_legendary()?;

        let clean_app_name = app_name.trim_start_matches("epic_").to_string();
        let resolved_dir = resolve_tilde(&install_dir);
        fs::create_dir_all(&resolved_dir)
        .map_err(|e| format!("Nu s-a putut crea folderul de instalare: {}", e))?;

        let pid_arc = state.active_pid.clone();
        let paused_arc = state.is_paused.clone();
        let subdir_arc = state.active_game_subdir.clone();

        std::thread::spawn(move || {
            let _ = app_handle.emit(
                "epic-install-progress",
                EpicInstallProgress {
                    status: "starting".into(),
                                    app_name: clean_app_name.clone(),
                                    title: game_title.clone(),
                                    percent: 0.0,
                                    speed: "Preparing...".into(),
                                    message: "Se inițializează descărcarea...".into(),
                                    exe_path: None,
                                    wine_prefix: None,
                                    runner_path: None,
                                    eta: String::new(),
                },
            );

            let local_before = detect_local_epic_installs();
            if let Some((existing_exe, _)) = local_before.get(&clean_app_name) {
                if !std::path::Path::new(existing_exe).exists() {
                    let _ = Command::new("legendary")
                    .args(["uninstall", &clean_app_name, "--keep-files", "-y"])
                    .output();
                }
            }

            #[cfg(unix)]
            use std::os::unix::process::CommandExt;

            let existing_subdirs: std::collections::HashSet<PathBuf> = fs::read_dir(&resolved_dir)
            .map(|entries| {
                entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
            })
            .unwrap_or_default();

            let mut cmd = Command::new("legendary");
            cmd.args([
                "install",
                &clean_app_name,
                "--base-path",
                &resolved_dir,
                "-y",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

            #[cfg(unix)]
            cmd.process_group(0);

            let mut child = match cmd.spawn() {
                Ok(c) => c,
                           Err(e) => {
                               let _ = app_handle.emit(
                                   "epic-install-progress",
                                   EpicInstallProgress {
                                       status: "error".into(),
                                                       app_name: clean_app_name,
                                                       title: game_title,
                                                       percent: 0.0,
                                                       speed: String::new(),
                                                       message: format!("Nu s-a putut porni legendary: {}", e),
                                                       exe_path: None,
                                                       wine_prefix: None,
                                                       runner_path: None,
                                                       eta: String::new(),
                                   },
                               );
                               return;
                           }
            };

            {
                let mut guard = pid_arc.lock().unwrap();
                *guard = Some(child.id());
            }

            let mut recent_logs: Vec<String> = Vec::new();
            let mut last_percent: f32 = 0.0;

            if let Some(stderr) = child.stderr.take() {
                let reader = BufReader::new(stderr);
                let mut current_speed = String::from("0.0 MiB/s");
                let mut current_eta = String::from("--:--");

                for line in reader.lines().map_while(Result::ok) {
                    if pid_arc.lock().unwrap().is_none() {
                        break;
                    }

                    // Detectăm și salvăm subfolderul nou creat de legendary în resolved_dir
                    if subdir_arc.lock().unwrap().is_none() {
                        if let Ok(entries) = fs::read_dir(&resolved_dir) {
                            for entry in entries.flatten() {
                                let p = entry.path();
                                if p.is_dir() && !existing_subdirs.contains(&p) {
                                    *subdir_arc.lock().unwrap() = Some(p);
                                    break;
                                }
                            }
                        }
                    }

                    let trimmed = line.trim().to_string();
                    if !trimmed.is_empty() {
                        recent_logs.push(trimmed);
                        if recent_logs.len() > 6 {
                            recent_logs.remove(0);
                        }
                    }

                    if let Some(idx) = line.find("Progress:") {
                        let rest = &line[idx + 9..];
                        if let Some(pct_end) = rest.find('%') {
                            if let Ok(pct) = rest[..pct_end].trim().parse::<f32>() {
                                last_percent = pct;
                            }
                        }
                        if let Some(eta_idx) = rest.find("ETA:") {
                            let eta_part = rest[eta_idx + 4..].trim();
                            let eta_token = eta_part
                            .split(|c: char| c.is_whitespace() || c == ',' || c == ')')
                            .next()
                            .unwrap_or("--:--")
                            .trim();
                            if !eta_token.is_empty() {
                                current_eta = eta_token.to_string();
                            }
                        }
                    } else if line.contains("+ Download") {
                        if let Some(dash) = line.find('-') {
                            let speed_part = line[dash + 1..].trim();
                            if let Some(raw_idx) = speed_part.find("(raw)") {
                                current_speed = speed_part[..raw_idx].trim().to_string();
                            }
                        }
                    }

                    if line.contains("Progress:") || line.contains("+ Download") {
                        let _ = app_handle.emit(
                            "epic-install-progress",
                            EpicInstallProgress {
                                status: "downloading".into(),
                                                app_name: clean_app_name.clone(),
                                                title: game_title.clone(),
                                                percent: last_percent,
                                                speed: current_speed.clone(),
                                                eta: current_eta.clone(),
                                                message: line.clone(),
                                                exe_path: None,
                                                wine_prefix: None,
                                                runner_path: None,
                            },
                        );
                    }
                }
            }

            let exit_status = child.wait();
            let was_stopped = {
                let mut guard = pid_arc.lock().unwrap();
                let stopped = guard.is_none();
                *guard = None;
                stopped
            };
            let was_paused = {
                let mut p_guard = paused_arc.lock().unwrap();
                let p = *p_guard;
                *p_guard = false;
                p
            };

            if was_stopped && was_paused {
                let _ = app_handle.emit(
                    "epic-install-progress",
                    EpicInstallProgress {
                        status: "paused".into(),
                                        app_name: clean_app_name,
                                        title: game_title,
                                        percent: last_percent,
                                        speed: "Paused".into(),
                                        message: "Descărcare pusă pe pauză.".into(),
                                        exe_path: None,
                                        wine_prefix: None,
                                        runner_path: None,
                                        eta: String::new(),
                    },
                );
                return;
            }

            if was_stopped {
                let known_subdir = subdir_arc.lock().unwrap().take();
                cleanup_epic_partial_files(&clean_app_name, Some(&resolved_dir), known_subdir);

                let _ = app_handle.emit(
                    "epic-install-progress",
                    EpicInstallProgress {
                        status: "cancelled".into(),
                                        app_name: clean_app_name,
                                        title: game_title,
                                        percent: 0.0,
                                        speed: String::new(),
                                        message: "Descărcare anulată și fișierele parțiale au fost șterse.".into(),
                                        exe_path: None,
                                        wine_prefix: None,
                                        runner_path: None,
                                        eta: String::new(),
                    },
                );
                return;
            }

            // S-a terminat normal: resetăm active_game_subdir
            *subdir_arc.lock().unwrap() = None;

            match exit_status {
                Ok(s) if s.success() => {
                    let local_installs = detect_local_epic_installs();
                    let detected_exe = local_installs
                    .get(&clean_app_name)
                    .map(|(exe, _)| exe.clone())
                    .filter(|exe| std::path::Path::new(exe).exists());

                    if detected_exe.is_some() {
                        let home_dir = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
                        let prefix_dir = home_dir
                        .join("Games")
                        .join("Prefixes")
                        .join("Epic")
                        .join(&clean_app_name);
                        let _ = fs::create_dir_all(&prefix_dir);
                        let prefix_str = prefix_dir.to_string_lossy().to_string();

                        let runners = get_available_runners();
                        let best_runner = runners
                        .iter()
                        .find(|r| r.name.starts_with("Proton GE"))
                        .or_else(|| runners.iter().find(|r| r.name.starts_with("Lutris")))
                        .or_else(|| runners.first())
                        .map(|r| r.path.clone())
                        .unwrap_or_else(|| "/usr/bin/wine".to_string());

                        let _ = app_handle.emit(
                            "epic-install-progress",
                            EpicInstallProgress {
                                status: "downloading".into(),
                                                app_name: clean_app_name.clone(),
                                                title: game_title.clone(),
                                                percent: 99.0,
                                                speed: "Setup...".into(),
                                                eta: String::new(),
                                                message: "Se creează și se inițializează prefixul Wine/Proton...".into(),
                                                exe_path: None,
                                                wine_prefix: None,
                                                runner_path: None,
                            },
                        );

                        if best_runner.contains("compatibilitytools.d") {
                            if let Some(proton_root) = Path::new(&best_runner)
                                .parent()
                                .and_then(|p| p.parent())
                                .and_then(|p| p.parent())
                                {
                                    let proton_script = proton_root.join("proton");
                                    if proton_script.exists() {
                                        let steam_root = home_dir.join(".local/share/Steam");
                                        let _ = Command::new(&proton_script)
                                        .arg("run")
                                        .arg("wineboot")
                                        .arg("-u")
                                        .env("STEAM_COMPAT_DATA_PATH", &prefix_str)
                                        .env("STEAM_COMPAT_CLIENT_INSTALL_PATH", &steam_root)
                                        .env("PROTON_EAC_RUNTIME", "1")
                                        .status();
                                    }
                                }
                        } else {
                            let _ = Command::new(&best_runner)
                            .arg("wineboot")
                            .arg("-u")
                            .env("WINEPREFIX", &prefix_str)
                            .status();
                        }

                        let _ = app_handle.emit(
                            "epic-install-progress",
                            EpicInstallProgress {
                                status: "completed".into(),
                                                app_name: clean_app_name,
                                                title: game_title,
                                                percent: 100.0,
                                                speed: "Done".into(),
                                                message: "Instalare și configurare prefix finalizate!".into(),
                                                exe_path: detected_exe,
                                                wine_prefix: Some(prefix_str),
                                                runner_path: Some(best_runner),
                                                eta: String::new(),
                            },
                        );
                    } else {
                        let _ = app_handle.emit(
                            "epic-install-progress",
                            EpicInstallProgress {
                                status: "error".into(),
                                                app_name: clean_app_name,
                                                title: game_title,
                                                percent: 0.0,
                                                speed: String::new(),
                                                eta: String::new(),
                                                message: "Instalarea nu a putut fi verificată pe disc. Dezinstalează și reîncearcă.".into(),
                                                exe_path: None,
                                                wine_prefix: None,
                                                runner_path: None,
                            },
                        );
                    }
                }
                _ => {
                    let detail = recent_logs
                    .into_iter()
                    .rev()
                    .take(2)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join(" | ");

                    let err_msg = if detail.is_empty() {
                        "Instalarea a eșuat (cod ieșire non-zero).".to_string()
                    } else {
                        format!("Eroare legendary: {}", detail)
                    };

                    let _ = app_handle.emit(
                        "epic-install-progress",
                        EpicInstallProgress {
                            status: "error".into(),
                                            app_name: clean_app_name,
                                            title: game_title,
                                            percent: 0.0,
                                            speed: String::new(),
                                            message: err_msg,
                                            exe_path: None,
                                            wine_prefix: None,
                                            runner_path: None,
                                            eta: String::new(),
                        },
                    );
                }
            }
        });
        Ok(())
    }

    fn terminate_download_pid(pid: u32) {
        #[cfg(target_os = "windows")]
        let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();

        #[cfg(not(target_os = "windows"))]
        {
            let pgid = format!("-{}", pid);
            let _ = Command::new("kill").args(["-9", &pgid]).status();
            let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
        }
    }

    #[tauri::command]
    fn pause_epic_install(state: State<'_, DownloadState>) -> Result<(), String> {
        {
            let mut p_guard = state.is_paused.lock().unwrap();
            *p_guard = true;
        }
        let pid = {
            let mut guard = state.active_pid.lock().unwrap();
            guard.take()
        };
        if let Some(pid) = pid {
            terminate_download_pid(pid);
        }
        Ok(())
    }

#[tauri::command]
    fn cancel_epic_install(
        state: State<'_, DownloadState>,
        app_name: Option<String>,
        install_dir: Option<String>,
    ) -> Result<(), String> {
        {
            let mut p_guard = state.is_paused.lock().unwrap();
            *p_guard = false;
        }
        let pid = {
            let mut guard = state.active_pid.lock().unwrap();
            guard.take()
        };

        if let Some(pid) = pid {
            terminate_download_pid(pid);
        } else if let Some(raw_app) = app_name {
            let clean_app_name = raw_app.trim_start_matches("epic_").to_string();
            let known_subdir = state.active_game_subdir.lock().unwrap().take();
            cleanup_epic_partial_files(&clean_app_name, install_dir.as_deref(), known_subdir);
        }

        Ok(())
    }
    #[tauri::command]
    fn uninstall_epic_game(app_name: String, exe_path: String) -> Result<(), String> {
        let clean_app_name = app_name.trim_start_matches("epic_").to_string();

        // 1. Citim calea de instalare din ~/.config/legendary/installed.json înainte de ștergere
        let mut legendary_install_path: Option<String> = None;
        if let Some(leg_dir) = get_legendary_config_dir() {
            let installed_json = leg_dir.join("installed.json");
            if let Ok(raw) = fs::read_to_string(&installed_json) {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(path) = parsed[&clean_app_name]["install_path"].as_str() {
                        legendary_install_path = Some(path.to_string());
                    }
                }
            }
        }

        // 2. Rulăm legendary uninstall pentru a curăța metadata și fișierele oficiale
        let _ = Command::new("legendary")
        .args(["uninstall", &clean_app_name, "-y"])
        .output();

        // 3. Curățăm manual folderul dacă au rămas fișiere dintr-o descărcare întreruptă
        let home_dir = std::env::var("HOME").unwrap_or_default();
        let exe_parent = if exe_path.is_empty() {
            None
        } else {
            std::path::Path::new(&exe_path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
        };

        for candidate in [legendary_install_path, exe_parent].into_iter().flatten() {
            let p = std::path::Path::new(&candidate);
            if p.exists()
                && p.is_dir()
                && candidate != "/"
                && candidate != home_dir
                && candidate.len() > home_dir.len() + 2
                {
                    let _ = fs::remove_dir_all(p);
                }
        }

        Ok(())
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
                    (lower.starts_with("wineprefix=") || lower.starts_with("steam_compat_data_path="))
                    && lower.contains(&prefix_norm)
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
    let source = game["source"].as_str().unwrap_or("").to_lowercase();
    let raw_exe_path = game["exe_path"].as_str().unwrap_or("").trim();
    let raw_runner_path = game["runner_path"].as_str().unwrap_or("").trim();
    let raw_wine_prefix = game["wine_prefix"].as_str().unwrap_or("").trim();
    let use_gamemode = game["use_gamemode"].as_bool().unwrap_or(false);
    let use_mangohud = game["use_mangohud"].as_bool().unwrap_or(false);
    let env_vars: Option<HashMap<String, String>> = game.get("env_vars")
    .and_then(|v| serde_json::from_value(v.clone()).ok());

    if game_id.is_empty() {
        return Err("ID joc invalid!".to_string());
    }

    let _ = app_handle.emit(
        "game-status-changed",
        GameStatusPayload {
            game_id: game_id.clone(),
                            status: "starting".to_string(),
                            playtime_seconds: 0,
        },
    );

    let mut cmd;
    let is_epic = source == "epic" || game_id.starts_with("epic_");
    let mut is_uri = false;
    let exe_path;
    let wine_prefix;

    if is_epic {
        let clean_app_name = game_id.trim_start_matches("epic_");
        let _ = sync_session_to_legendary();

        let home = std::env::var("HOME").unwrap_or_default();
        let effective_prefix = if !raw_wine_prefix.is_empty() {
            resolve_tilde(raw_wine_prefix)
        } else {
            format!("{}/Games/Prefixes/Epic/{}", home, clean_app_name)
        };
        let _ = fs::create_dir_all(&effective_prefix);

        wine_prefix = effective_prefix.clone();
        exe_path = resolve_tilde(raw_exe_path);

        let effective_runner = if !raw_runner_path.is_empty() && raw_runner_path != "/usr/bin/wine" {
            resolve_tilde(raw_runner_path)
        } else {
            get_available_runners()
            .into_iter()
            .find(|r| r.name.starts_with("Proton GE") || r.name.starts_with("Lutris"))
            .map(|r| r.path)
            .unwrap_or_else(|| "/usr/bin/wine".to_string())
        };

        if use_gamemode && command_exists("gamemoderun") {
            cmd = Command::new("gamemoderun");
            cmd.arg("legendary");
        } else {
            cmd = Command::new("legendary");
        }
        cmd.arg("launch").arg(clean_app_name);

        // Dacă runner-ul e Proton GE, folosim scriptul `proton` cu STEAM_COMPAT_DATA_PATH
        let mut used_proton = false;
        if effective_runner.contains("compatibilitytools.d") {
            if let Some(proton_root) = Path::new(&effective_runner)
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
                {
                    let proton_script = proton_root.join("proton");
                    if proton_script.exists() {
                        let steam_root = format!("{}/.local/share/Steam", home);
                        cmd.arg("--no-wine")
                        .arg("--wrapper")
                        .arg(format!("'{}' run", proton_script.to_string_lossy()));
                        cmd.env("STEAM_COMPAT_DATA_PATH", &effective_prefix);
                        cmd.env("STEAM_COMPAT_CLIENT_INSTALL_PATH", &steam_root);
                        cmd.env("PROTON_EAC_RUNTIME", "1");
                        cmd.env("PROTON_BATTLEYE_RUNTIME", "1");
                        used_proton = true;
                    }
                }
        }

        if !used_proton {
            cmd.arg("--wine").arg(&effective_runner);
            cmd.env("WINEPREFIX", &effective_prefix);
        }

        cmd.env("EASY_ANTI_CHEAT_RUNTIME", "1");
        cmd.env("WINEESYNC", "1");
        cmd.env("WINEFSYNC", "1");

        if use_mangohud {
            cmd.env("MANGOHUD", "1");
            cmd.env("MANGOHUD_DLSYM", "1");
            cmd.env("MANGOHUD_VULKAN_DLSYM", "1");
        }

        if let Some(envs) = &env_vars {
            for (key, value) in envs {
                cmd.env(key, value);
            }
        }
    } else {
        if raw_exe_path.is_empty() {
            return Err("Cale executabil sau ID invalid!".to_string());
        }

        exe_path = resolve_tilde(raw_exe_path);
        let runner_path = resolve_tilde(raw_runner_path);
        wine_prefix = resolve_tilde(raw_wine_prefix);
        is_uri = exe_path.contains("://") || exe_path.starts_with("lutris:");

        if is_uri || is_epic {
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

                if use_mangohud {
                    cmd.env("MANGOHUD", "1");
                    cmd.env("MANGOHUD_DLSYM", "1");
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
        }
    }

    if let Some(args) = game["launch_args"].as_str() {
        if !args.trim().is_empty() {
            cmd.args(args.split_whitespace());
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
    .user_agent(&format!("NexusDeck/{} (Linux Game Launcher)", env!("CARGO_PKG_VERSION")))
    .timeout(std::time::Duration::from_secs(10))
    .build()
    .unwrap_or_default();

    tauri::Builder::default()
    .manage(AppSystemStats {
        sys: Mutex::new(sys),
    })
    .manage(AppHttpClient { client })
    .manage(RunningProcesses(Arc::new(Mutex::new(HashMap::new()))))
    .manage(DownloadState {
        active_pid: Arc::new(Mutex::new(None)),
            is_paused: Arc::new(Mutex::new(false)),
            active_game_subdir: Arc::new(Mutex::new(None)),
    })
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
        select_folder_dialog,
        launch_game,
        uninstall_game_files,
        search_cover_art,
        run_game_installer,
        open_game_folder,
        run_exe_in_prefix,
        set_fullscreen,
        get_steam_app_title,
        login_epic_games,
        sync_epic_games,
        check_legendary_status,
        install_epic_game,
        get_epic_game_disk_info,
        pause_epic_install,
        cancel_epic_install,
        check_steam_install_status,
        uninstall_epic_game,
        resolve_steam_app_id,
        get_protondb_tier,
        open_external_url
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
