// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, Size, State, WindowEvent,
};

use flate2::read::GzDecoder;
use tar::Archive;
mod backup;
mod quick_settings;



// Registrul global pentru PID-urile jocurilor
pub struct RunningProcesses(pub Arc<Mutex<HashMap<String, u32>>>);

#[derive(Clone, serde::Serialize)]
struct GameStatusPayload {
    game_id: String,
    status: String, // "starting", "playing", "stopped"
    playtime_seconds: u64,
}

#[derive(Clone, serde::Serialize)]
struct GameLaunchFailedPayload {
    game_id: String,
    message: String,
}

// Pentru fiecare joc lansat: momentul de start al sesiunii de joc + un număr de generație.
// Generația distinge două lansări succesive ale aceluiași joc: monitorul unei lansări vechi
// nu mai poate șterge intrarea sau emite „stopped” pentru lansarea nouă.
static LAUNCH_META: OnceLock<Mutex<HashMap<String, (Instant, u64)>>> = OnceLock::new();
static LAUNCH_COUNTER: AtomicU64 = AtomicU64::new(0);

// Un proces care pică în intervalul ăsta cu cod != 0 este considerat lansare eșuată
const QUICK_EXIT_WINDOW: std::time::Duration = std::time::Duration::from_secs(15);
// Cât așteptăm ca Steam/Lutris/etc. să pornească efectiv jocul după xdg-open
const URI_DETECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
// Câți octeți din finalul stderr păstrăm pentru mesajul de eroare
const STDERR_TAIL_BYTES: usize = 8192;

fn launch_meta() -> &'static Mutex<HashMap<String, (Instant, u64)>> {
    LAUNCH_META.get_or_init(|| Mutex::new(HashMap::new()))
}

// `default`: un câmp lipsă (ex. dintr-o versiune mai veche a fișierului) nu mai invalidează
// toată biblioteca. `extra` păstrează câmpurile pe care le setează doar UI-ul (ex. `is_installed`),
// care altfel s-ar pierde la fiecare salvare.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Game {
    pub id: String,
    pub title: String,
    pub exe_path: String,
    pub runner_path: String,
    pub wine_prefix: Option<String>,
    #[serde(default)]
    pub save_path: Option<String>,
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
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
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


/// Nume de foldere care adună MAI MULTE jocuri/prefixe (sau sunt foldere de sistem/utilizator).
/// Nu le ștergem niciodată ca întreg, chiar dacă o cale salvată greșit (ex. exe direct în ~/Games)
/// ar indica spre ele.
const PROTECTED_DIR_NAMES: &[&str] = &[
    "games", "prefixes", "epic", "gog", "heroic", "lutris", "steam", ".steam", "steamapps",
    "common", "compatdata", "shadercache", "wine", ".wine", "bottles", "runners", ".nexusdeck",
    "drive_c", "pfx", "program files", "program files (x86)", "users", "windows",
    "desktop", "documents", "downloads", ".local", "share", ".config", ".var",
];

/// true dacă ștergerea recursivă a lui `dir` ar putea lua cu ea mai mult decât un singur joc:
/// rădăcina, home-ul sau un strămoș al lui, un folder direct din home, un punct de montare
/// tipic sau un folder-colecție (vezi PROTECTED_DIR_NAMES).
fn is_unsafe_delete_target(dir: &Path) -> bool {
    let canon = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    if !canon.is_absolute() {
        return true;
    }
    let depth = canon.components().count(); // `/` numără ca o componentă
    if depth <= 3 {
        return true; // /, /home, /mnt/disk, /opt/x ...
    }
    if let Some(home) = dirs::home_dir() {
        let home = fs::canonicalize(&home).unwrap_or(home);
        if home.starts_with(&canon) || canon.parent() == Some(home.as_path()) {
            return true;
        }
        // /run/media/<user>/<disc>, /media/<user>/<disc>: rădăcina unui disc montat
        if !canon.starts_with(&home)
            && (canon.starts_with("/run/media") || canon.starts_with("/media"))
            && depth <= 5
        {
            return true;
        }
    }
    let name = canon
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    PROTECTED_DIR_NAMES.contains(&name.as_str())
}

/// remove_dir_all doar dacă ținta trece de verificările de mai sus.
fn remove_dir_if_safe(dir: &Path) {
    if dir.is_dir() && !is_unsafe_delete_target(dir) {
        let _ = fs::remove_dir_all(dir);
    }
}

#[tauri::command]
async fn uninstall_game_files(exe_path: String, wine_prefix: Option<String>) -> Result<(), String> {
    // remove_dir_all poate dura mult (jocuri de zeci de GB). Într-un `fn` simplu ar rula
    // pe thread-ul principal și ar îngheța fereastra.
    tauri::async_runtime::spawn_blocking(move || uninstall_game_files_blocking(exe_path, wine_prefix))
        .await
        .map_err(|e| e.to_string())?
}

fn uninstall_game_files_blocking(exe_path: String, wine_prefix: Option<String>) -> Result<(), String> {
    if !exe_path.is_empty() && !exe_path.starts_with("steam://") {
        let path = std::path::Path::new(&exe_path);
        if let Some(parent) = path.parent() {
            let path_str = parent.to_string_lossy();
            if path_str.len() > 10 && (path_str.contains("Games") || path_str.contains("wine") || path_str.contains("prefix") || path_str.contains("lutris")) {
                remove_dir_if_safe(parent);
            }
        }
    }

    if let Some(prefix) = wine_prefix {
        let prefix = resolve_tilde(prefix.trim());
        if !prefix.is_empty() && prefix.len() > 5 {
            remove_dir_if_safe(std::path::Path::new(&prefix));
        }
    }

    Ok(())
}


#[derive(Serialize, Deserialize, Clone)]
pub struct GitHubReleaseAsset {
    pub name: String,
    pub browser_download_url: String,
    pub size: u64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GitHubRelease {
    pub tag_name: String,
    pub published_at: String,
    pub assets: Vec<GitHubReleaseAsset>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AvailableRunnerRelease {
    pub tag_name: String,
    pub published_at: String,
    pub download_url: String,
    pub asset_name: String,
    pub size_mb: u64,
    pub installed: bool,
}

#[tauri::command]
async fn fetch_available_runners() -> Result<Vec<AvailableRunnerRelease>, String> {
    let client = reqwest::Client::builder()
    .user_agent("NexusDeck-Launcher/1.0")
    .build()
    .map_err(|e| e.to_string())?;

    let resp = client
    .get("https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases?per_page=12")
    .send()
    .await
    .map_err(|e| format!("Eroare rețea GitHub: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API a returnat status: {}", resp.status()));
    }

    let releases: Vec<GitHubRelease> = resp
    .json()
    .await
    .map_err(|e| format!("Eroare parsare JSON: {}", e))?;

    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let custom_dir = PathBuf::from(&home).join(".nexusdeck").join("runners");

    let mut results = Vec::new();
    for rel in releases {
        if let Some(asset) = rel.assets.iter().find(|a| a.name.ends_with(".tar.gz")) {
            let folder_name = asset.name.trim_end_matches(".tar.gz");
            let installed = custom_dir.join(folder_name).exists();

            results.push(AvailableRunnerRelease {
                tag_name: rel.tag_name,
                published_at: rel.published_at.split('T').next().unwrap_or("").to_string(),
                         download_url: asset.browser_download_url.clone(),
                         asset_name: asset.name.clone(),
                         size_mb: asset.size / (1024 * 1024),
                         installed,
            });
        }
    }

    Ok(results)
}

/// Acceptăm arhive de runner doar de pe pagina de release-uri a proiectului GE-Proton.
/// (GitHub redirecționează apoi spre CDN-ul lui; verificăm doar URL-ul inițial.)
fn is_allowed_runner_url(url: &str) -> bool {
    match reqwest::Url::parse(url) {
        Ok(u) => {
            u.scheme() == "https"
                && u.host_str() == Some("github.com")
                && u.path().starts_with("/GloriousEggroll/proton-ge-custom/releases/download/")
        }
        Err(_) => false,
    }
}

/// Descarcă arhiva direct pe disc (nu o ține în memorie) și raportează progresul real.
async fn download_runner_archive(
    app: &AppHandle,
    tag_name: &str,
    asset_name: &str,
    url: &str,
    dest: &Path,
) -> Result<(), String> {
    use std::io::Write;

    let client = reqwest::Client::builder()
        .user_agent("NexusDeck-Launcher/1.0")
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Eroare descărcare: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Descărcare eșuată (HTTP {})", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let file = fs::File::create(dest).map_err(|e| format!("Nu s-a putut crea fișierul temporar: {}", e))?;
    // Buffer mare: scrierile pe disc au loc o dată pe ~1 MiB, nu la fiecare pachet de rețea
    let mut writer = std::io::BufWriter::with_capacity(1 << 20, file);

    let mut downloaded: u64 = 0;
    let mut last_percent: i64 = -1;

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("Eroare citire arhivă: {}", e))?
    {
        writer
            .write_all(&chunk)
            .map_err(|e| format!("Eroare scriere pe disc: {}", e))?;
        downloaded += chunk.len() as u64;

        if total > 0 {
            let percent = (downloaded * 100 / total) as i64;
            if percent != last_percent {
                last_percent = percent;
                let _ = app.emit(
                    "runner-install-progress",
                    serde_json::json!({
                        "tag": tag_name,
                        "stage": "downloading",
                        "percent": percent,
                        "message": format!("Se descarcă {}... {}%", asset_name, percent)
                    }),
                );
            }
        }
    }

    writer
        .flush()
        .map_err(|e| format!("Eroare scriere pe disc: {}", e))?;

    if total > 0 && downloaded != total {
        return Err("Descărcare incompletă. Încearcă din nou.".to_string());
    }
    Ok(())
}

/// Dezarhivează într-un folder temporar și abia apoi mută rezultatul în `runners/`:
/// o eroare la jumătate nu mai lasă un runner pe jumătate instalat, care ar apărea ca „instalat".
fn extract_runner_archive(
    archive_path: &Path,
    extract_dir: &Path,
    runners_dir: &Path,
) -> Result<(), String> {
    let _ = fs::remove_dir_all(extract_dir);
    fs::create_dir_all(extract_dir).map_err(|e| e.to_string())?;

    let file = fs::File::open(archive_path).map_err(|e| format!("Eroare citire arhivă: {}", e))?;
    let tar = GzDecoder::new(std::io::BufReader::new(file));
    let mut archive = Archive::new(tar);
    archive
        .unpack(extract_dir)
        .map_err(|e| format!("Eroare dezarhivare: {}", e))?;

    let mut moved = 0usize;
    for entry in fs::read_dir(extract_dir).map_err(|e| e.to_string())?.flatten() {
        let dest = runners_dir.join(entry.file_name());
        // Reinstalare: o înlocuim pe cea veche abia acum, după ce noua versiune s-a extras cu succes
        if dest.is_dir() {
            fs::remove_dir_all(&dest).map_err(|e| format!("Nu s-a putut înlocui versiunea veche: {}", e))?;
        } else if dest.exists() {
            fs::remove_file(&dest).map_err(|e| e.to_string())?;
        }
        fs::rename(entry.path(), &dest)
            .map_err(|e| format!("Nu s-a putut finaliza instalarea: {}", e))?;
        moved += 1;
    }

    if moved == 0 {
        return Err("Arhiva descărcată este goală.".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn install_runner_release(
    app: AppHandle,
    tag_name: String,
    download_url: String,
    asset_name: String,
) -> Result<String, String> {
    if !is_allowed_runner_url(&download_url) {
        return Err("URL de descărcare nepermis.".to_string());
    }

    // Tag-ul intră în numele fișierelor temporare: păstrăm doar caractere sigure
    let safe_tag: String = tag_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect();
    if safe_tag.is_empty() {
        return Err("Tag invalid.".to_string());
    }

    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let runners_dir = PathBuf::from(&home).join(".nexusdeck").join("runners");
    fs::create_dir_all(&runners_dir).map_err(|e| e.to_string())?;

    let archive_path = runners_dir.join(format!(".download-{}.tar.gz", safe_tag));
    let extract_dir = runners_dir.join(format!(".extract-{}", safe_tag));

    let _ = app.emit(
        "runner-install-progress",
        serde_json::json!({
            "tag": tag_name,
            "stage": "downloading",
            "percent": 0,
            "message": format!("Se descarcă {}...", asset_name)
        }),
    );

    if let Err(e) =
        download_runner_archive(&app, &tag_name, &asset_name, &download_url, &archive_path).await
    {
        let _ = fs::remove_file(&archive_path);
        return Err(e);
    }

    let _ = app.emit(
        "runner-install-progress",
        serde_json::json!({
            "tag": tag_name,
            "stage": "extracting",
            "message": "Se dezarhivează în ~/.nexusdeck/runners..."
        }),
    );

    let (archive_for_task, extract_for_task, runners_for_task) =
        (archive_path.clone(), extract_dir.clone(), runners_dir.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        extract_runner_archive(&archive_for_task, &extract_for_task, &runners_for_task)
    })
    .await
    .map_err(|e| e.to_string());

    // Curățenie, indiferent de rezultat
    let _ = fs::remove_file(&archive_path);
    let _ = fs::remove_dir_all(&extract_dir);

    result??;

    Ok(format!("{} a fost instalat cu succes!", tag_name))
}

#[tauri::command]
async fn delete_custom_runner(runner_path: String) -> Result<(), String> {
    // remove_dir_all pe un runner de ~1 GB nu are ce căuta pe thread-ul principal
    tauri::async_runtime::spawn_blocking(move || delete_custom_runner_blocking(runner_path))
        .await
        .map_err(|e| e.to_string())?
}

fn delete_custom_runner_blocking(runner_path: String) -> Result<(), String> {
    let not_allowed = || "Poți șterge doar runner-ii instalați în ~/.nexusdeck/runners.".to_string();

    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let allowed_base = PathBuf::from(&home).join(".nexusdeck").join("runners");
    let raw_target = PathBuf::from(&runner_path);

    // `starts_with` compară lexical: `~/.nexusdeck/runners/..` ar trece de verificare de mai jos
    // și ar șterge tot `~/.nexusdeck`. Refuzăm orice cale cu componente `..`.
    if raw_target
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(not_allowed());
    }

    // Dacă primim .../GE-Proton9-20/files/bin/wine, urcăm la folderul GE-Proton9-20
    let target = raw_target
    .ancestors()
    .find(|p| p.parent() == Some(allowed_base.as_path()))
    .map(|p| p.to_path_buf())
    .unwrap_or(raw_target);

    if !target.starts_with(&allowed_base) || target == allowed_base {
        return Err(not_allowed());
    }

    if target.exists() {
        // A doua verificare, pe calea reală: un symlink din runners/ nu trebuie să ne scoată din folder
        if let (Ok(canon_target), Ok(canon_base)) =
            (fs::canonicalize(&target), fs::canonicalize(&allowed_base))
        {
            if !canon_target.starts_with(&canon_base) || canon_target == canon_base {
                return Err(not_allowed());
            }
        }
        fs::remove_dir_all(&target).map_err(|e| format!("Nu s-a putut șterge: {}", e))?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct BpDeviceStatus {
    pub network_type: String, // "wifi" | "ethernet" | "offline"
    pub network_name: String, // SSID-ul Wi-Fi, "Ethernet" sau "Offline"
    pub wifi_signal: u8,
    pub has_battery: bool,
    pub battery_percent: u8,
    pub is_charging: bool,
}

#[tauri::command]
async fn get_bp_device_status() -> BpDeviceStatus {
    tauri::async_runtime::spawn_blocking(move || {
        let mut network_type = "offline".to_string();
        let mut network_name = "Offline".to_string();
        let mut wifi_signal: u8 = 0;
        let mut has_battery = false;
        let mut battery_percent: u8 = 0;
        let mut is_charging = false;

        #[cfg(target_os = "linux")]
        {
            if let Ok(entries) = std::fs::read_dir("/sys/class/net") {
                for entry in entries.flatten() {
                    let iface = entry.file_name().to_string_lossy().to_string();
                    if iface == "lo"
                        || iface.starts_with("docker")
                        || iface.starts_with("br-")
                        || iface.starts_with("veth")
                        || iface.starts_with("virbr")
                        || iface.starts_with("tun")
                        || iface.starts_with("wg")
                        {
                            continue;
                        }

                        let operstate = std::fs::read_to_string(format!("/sys/class/net/{}/operstate", iface))
                        .unwrap_or_default()
                        .trim()
                        .to_string();

                        if operstate == "up" {
                            let is_wireless = std::path::Path::new(&format!("/sys/class/net/{}/wireless", iface)).exists();
                            if is_wireless {
                                network_type = "wifi".to_string();

                                // 1. Citire instantă a semnalului din /proc/net/wireless (< 0.1ms)
                                if let Ok(wireless_info) = std::fs::read_to_string("/proc/net/wireless") {
                                    for line in wireless_info.lines().skip(2) {
                                        let trimmed = line.trim();
                                        if let Some(rest) = trimmed.strip_prefix(&format!("{}:", iface)) {
                                            let cols: Vec<&str> = rest.split_whitespace().collect();
                                            if let Some(link_str) = cols.get(1) {
                                                let link_val = link_str.trim_end_matches('.').parse::<f32>().unwrap_or(0.0);
                                                wifi_signal = ((link_val / 70.0) * 100.0).round().clamp(0.0, 100.0) as u8;
                                            }
                                            break;
                                        }
                                    }
                                }

                                // 2. Citire instantă SSID cu `iw dev <iface> link` (fără D-Bus / nmcli)
                                let ssid = std::process::Command::new("iw")
                                .args(["dev", &iface, "link"])
                                .output()
                                .ok()
                                .and_then(|o| String::from_utf8(o.stdout).ok())
                                .and_then(|out| {
                                    out.lines()
                                    .find_map(|l| l.trim().strip_prefix("SSID:").map(|s| s.trim().to_string()))
                                })
                                .filter(|s| !s.is_empty())
                                .or_else(|| {
                                    std::process::Command::new("iwgetid")
                                    .args(["-r", &iface])
                                    .output()
                                    .ok()
                                    .and_then(|o| String::from_utf8(o.stdout).ok())
                                    .map(|s| s.trim().to_string())
                                    .filter(|s| !s.is_empty())
                                })
                                .unwrap_or_else(|| "Wi-Fi".to_string());

                                network_name = ssid;
                                break;
                            } else {
                                network_type = "ethernet".to_string();
                                network_name = "Ethernet".to_string();
                            }
                        }
                }
            }

            if let Ok(entries) = std::fs::read_dir("/sys/class/power_supply") {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with("BAT") {
                        let base = format!("/sys/class/power_supply/{}", name);
                        if let Ok(cap_str) = std::fs::read_to_string(format!("{}/capacity", base)) {
                            if let Ok(cap) = cap_str.trim().parse::<u8>() {
                                has_battery = true;
                                battery_percent = cap.min(100);
                                let status = std::fs::read_to_string(format!("{}/status", base))
                                .unwrap_or_default()
                                .trim()
                                .to_lowercase();
                                is_charging = status == "charging" || status == "full";
                                break;
                            }
                        }
                    }
                }
            }
        }

        #[cfg(target_os = "windows")]
        {
            network_type = "ethernet".to_string();
            network_name = "Online".to_string();
        }

        BpDeviceStatus {
            network_type,
            network_name,
            wifi_signal,
            has_battery,
            battery_percent,
            is_charging,
        }
    })
    .await
    .unwrap_or(BpDeviceStatus {
        network_type: "offline".to_string(),
               network_name: "Offline".to_string(),
               wifi_signal: 0,
               has_battery: false,
               battery_percent: 0,
               is_charging: false,
    })
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


#[derive(Serialize)]
pub struct SystemDependency {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub required_for: String,
    pub packages: HashMap<String, String>, // distro_family -> package_name
}

#[derive(Serialize)]
pub struct DependenciesCheckResult {
    pub is_linux: bool,
    pub distro_id: String,
    pub distro_name: String,
    pub pkg_manager: String, // "pacman" | "apt" | "dnf" | "zypper" | "unknown"
    pub all_installed: bool,
    pub dependencies: Vec<SystemDependency>,
}

#[cfg(target_os = "linux")]
fn detect_linux_distro() -> (String, String, String) {
    let content = fs::read_to_string("/etc/os-release").unwrap_or_default();
    let mut id = String::new();
    let mut id_like = String::new();
    let mut pretty_name = String::from("Linux");

    for line in content.lines() {
        if let Some(val) = line.strip_prefix("ID=") {
            id = val.trim_matches('"').to_lowercase();
        } else if let Some(val) = line.strip_prefix("ID_LIKE=") {
            id_like = val.trim_matches('"').to_lowercase();
        } else if let Some(val) = line.strip_prefix("PRETTY_NAME=") {
            pretty_name = val.trim_matches('"').to_string();
        }
    }

    let combined = format!("{} {}", id, id_like);
    let pkg_manager = if combined.contains("arch")
    || combined.contains("cachyos")
    || combined.contains("endeavouros")
    || combined.contains("manjaro")
    || combined.contains("steamos")
    {
        "pacman"
    } else if combined.contains("debian")
        || combined.contains("ubuntu")
        || combined.contains("mint")
        || combined.contains("pop")
        {
            "apt"
        } else if combined.contains("fedora") || combined.contains("rhel") || combined.contains("nobara") {
            "dnf"
        } else if combined.contains("suse") || combined.contains("opensuse") {
            "zypper"
        } else if command_exists("pacman") {
            "pacman"
        } else if command_exists("apt-get") {
            "apt"
        } else if command_exists("dnf") {
            "dnf"
        } else if command_exists("zypper") {
            "zypper"
        } else {
            "unknown"
        };

        (id, pretty_name, pkg_manager.to_string())
}

#[tauri::command]
async fn check_system_dependencies() -> Result<DependenciesCheckResult, String> {
    #[cfg(not(target_os = "linux"))]
    {
        return Ok(DependenciesCheckResult {
            is_linux: false,
            distro_id: "windows".to_string(),
                  distro_name: "Windows".to_string(),
                  pkg_manager: "none".to_string(),
                  all_installed: true,
                  dependencies: Vec::new(),
        });
    }

    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            let (distro_id, distro_name, pkg_manager) = detect_linux_distro();

            let deps_spec = vec![
                (
                    "wine",
                 "Wine",
                 command_exists("wine") || Path::new("/usr/bin/wine").exists(),
                 "Windows Games & Installers",
                 [("pacman", "wine"), ("apt", "wine"), ("dnf", "wine"), ("zypper", "wine")],
                ),
                (
                    "winetricks",
                 "Winetricks",
                 command_exists("winetricks"),
                 "Prefix DLLs & Dependencies",
                 [("pacman", "winetricks"), ("apt", "winetricks"), ("dnf", "winetricks"), ("zypper", "winetricks")],
                ),
                (
                    "gamemode",
                 "Feral GameMode",
                 command_exists("gamemoderun"),
                 "CPU & GPU Performance Boost",
                 [("pacman", "gamemode"), ("apt", "gamemode"), ("dnf", "gamemode"), ("zypper", "gamemode")],
                ),
                (
                    "mangohud",
                 "MangoHud",
                 command_exists("mangohud"),
                 "In-Game FPS & Hardware Overlay",
                 [("pacman", "mangohud"), ("apt", "mangohud"), ("dnf", "mangohud"), ("zypper", "mangohud")],
                ),
                (
                    "legendary",
                 "Legendary CLI",
                 command_exists("legendary"),
                 "Epic Games Downloads & Launch",
                 [("pacman", "legendary"), ("apt", "legendary"), ("dnf", "legendary"), ("zypper", "legendary")],
                ),
            ];

            let mut dependencies = Vec::new();
            let mut all_installed = true;

            for (id, name, installed, required_for, pkg_pairs) in deps_spec {
                if !installed {
                    all_installed = false;
                }
                let mut packages = HashMap::new();
                for (mgr, pkg) in pkg_pairs {
                    packages.insert(mgr.to_string(), pkg.to_string());
                }

                dependencies.push(SystemDependency {
                    id: id.to_string(),
                                  name: name.to_string(),
                                  installed,
                                  required_for: required_for.to_string(),
                                  packages,
                });
            }

            Ok(DependenciesCheckResult {
                is_linux: true,
                distro_id,
                distro_name,
                pkg_manager,
                all_installed,
                dependencies,
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

// Scriptul rulat sub pkexec: instalează fiecare pachet separat și raportează ce a eșuat pe ultima
// linie de stdout (`NEXUS_FAILED:pkg1 pkg2`). Numele de pachete sunt deja validate (doar
// litere, cifre, `-`, `_`, `.`), deci pot intra în script fără ghilimele suplimentare.
#[cfg(target_os = "linux")]
fn build_dependency_install_script(pkg_manager: &str, packages: &[String]) -> Option<String> {
    let (pre, install_cmd) = match pkg_manager {
        "pacman" => ("", "pacman -S --noconfirm --needed"),
        "apt" => ("apt-get update >&2 || true\n", "DEBIAN_FRONTEND=noninteractive apt-get install -y"),
        "dnf" => ("", "dnf install -y"),
        "zypper" => ("", "zypper --non-interactive install"),
        _ => return None,
    };
    Some(format!(
        "{pre}failed=\"\"\nfor p in {pkgs}; do\n  {cmd} \"$p\" >&2 || failed=\"$failed $p\"\ndone\nprintf 'NEXUS_FAILED:%s\\n' \"$failed\"\n",
        pre = pre,
        pkgs = packages.join(" "),
        cmd = install_cmd
    ))
}

#[cfg(target_os = "linux")]
fn parse_failed_packages(stdout: &str) -> Option<Vec<String>> {
    stdout
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix("NEXUS_FAILED:"))
        .map(|rest| rest.split_whitespace().map(String::from).collect())
}

#[tauri::command]
async fn install_system_dependencies(
    pkg_manager: String,
    packages: Vec<String>,
) -> Result<String, String> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (pkg_manager, packages);
        return Err("Această funcție este disponibilă doar pe Linux.".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        if packages.is_empty() {
            return Ok("Nu există pachete selectate pentru instalare.".to_string());
        }

        // Validare strictă a numelor de pachete (prevenim injectarea de comenzi)
        let safe_packages: Vec<String> = packages
        .into_iter()
        .filter(|p| {
            // primul caracter alfanumeric: un nume de tip `-R` ar fi interpretat de managerul de pachete ca opțiune
            p.chars().next().map_or(false, |c| c.is_ascii_alphanumeric())
                && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        })
        .collect();

        if safe_packages.is_empty() {
            return Err("Lista de pachete este invalidă.".to_string());
        }

        if !command_exists("pkexec") {
            return Err("Utilitarul 'pkexec' (Polkit) nu este instalat. Rulează comanda manual în terminal.".to_string());
        }

        let Some(script) = build_dependency_install_script(&pkg_manager, &safe_packages) else {
            return Err("Manager de pachete nesuportat pentru instalare automată.".to_string());
        };

        tauri::async_runtime::spawn_blocking(move || {
            // Un singur pkexec (o singură parolă), dar fiecare pachet se instalează separat:
            // un pachet care nu există în depozitele distribuției nu mai anulează restul.
            let output = Command::new("pkexec")
                .args(["sh", "-c", &script])
                .output()
                .map_err(|e| format!("Eroare la lansarea pkexec: {}", e))?;

            let stderr = String::from_utf8_lossy(&output.stderr);

            if !output.status.success() {
                if output.status.code() == Some(126) || output.status.code() == Some(127) || stderr.contains("dismissed") {
                    return Err("Autentificarea a fost anulată de utilizator.".to_string());
                }
                let detail = stderr.lines().last().unwrap_or("Eroare necunoscută");
                return Err(format!("Instalarea a eșuat: {}", detail));
            }

            let stdout = String::from_utf8_lossy(&output.stdout);
            match parse_failed_packages(&stdout) {
                Some(failed) if failed.is_empty() => {
                    Ok("Toate dependențele selectate au fost instalate cu succes!".to_string())
                }
                Some(failed) => {
                    let mut msg = format!(
                        "Nu s-au putut instala: {}. Restul pachetelor selectate au fost instalate.",
                        failed.join(", ")
                    );
                    if failed.iter().any(|p| p == "legendary") {
                        msg.push_str(" legendary nu există în toate depozitele; instalează-l cu `pipx install legendary-gl`.");
                    }
                    Err(msg)
                }
                None => {
                    let detail = stderr.lines().last().unwrap_or("Eroare necunoscută");
                    Err(format!("Instalarea a eșuat: {}", detail))
                }
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

// -----------------------------------------------------------------------------
// COMENZI ÎN BATCH: RATING-URI PROTONDB ȘI TITLURI STEAM
// -----------------------------------------------------------------------------

/// Câte cereri de rețea rulează simultan (mai multe = risc de rate limit de la Steam / PCGamingWiki)
const NETWORK_CONCURRENCY: usize = 4;

#[derive(Deserialize)]
pub struct ProtonDbRatingRequest {
    pub id: String,
    pub title: String,
    pub app_id: Option<String>,
}

#[derive(Serialize)]
pub struct ProtonDbRatingResult {
    pub tier: Option<String>,
    pub app_id: Option<String>,
}

async fn rate_one_game(
    http: &tauri::State<'_, AppHttpClient>,
    game: &ProtonDbRatingRequest,
) -> ProtonDbRatingResult {
    let mut app_id = game
        .app_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);

    // Joc fără Steam App ID (Epic, GOG, Lutris): îl căutăm după titlu
    if app_id.is_none() {
        app_id = resolve_steam_app_id(http.clone(), game.title.clone())
            .await
            .ok()
            .flatten();
    }

    let tier = match app_id.clone() {
        Some(id) => get_protondb_tier(http.clone(), id).await.ok().flatten(),
        None => None,
    };

    ProtonDbRatingResult { tier, app_id }
}

/// Rezolvă rating-ul ProtonDB pentru mai multe jocuri deodată, cu concurență limitată.
/// Întoarce o intrare pentru FIECARE joc procesat; `tier: None` înseamnă "nu s-au găsit date".
/// Dacă nu există conexiune la internet, întoarce eroare (nu marchează nimic ca "fără date").
#[tauri::command]
async fn fetch_protondb_ratings(
    app: AppHandle,
    state: tauri::State<'_, AppHttpClient>,
    games: Vec<ProtonDbRatingRequest>,
) -> Result<HashMap<String, ProtonDbRatingResult>, String> {
    if games.is_empty() {
        return Ok(HashMap::new());
    }

    // O singură cerere de verificare: dacă picăm aici suntem offline, iar rezultatele
    // "negative" de mai jos ar fi false.
    state
        .client
        .get("https://store.steampowered.com/api/appdetails?appids=480&filters=basic")
        .send()
        .await
        .map_err(|e| format!("Fără conexiune la Steam/ProtonDB: {}", e))?;

    let total = games.len();
    let queue = Arc::new(games);
    let next_index = Arc::new(AtomicUsize::new(0));
    let results: Arc<Mutex<HashMap<String, ProtonDbRatingResult>>> =
        Arc::new(Mutex::new(HashMap::with_capacity(total)));

    let mut workers = Vec::new();
    for _ in 0..NETWORK_CONCURRENCY.min(total) {
        let app = app.clone();
        let queue = Arc::clone(&queue);
        let next_index = Arc::clone(&next_index);
        let results = Arc::clone(&results);

        workers.push(tauri::async_runtime::spawn(async move {
            let http = app.state::<AppHttpClient>();
            loop {
                let i = next_index.fetch_add(1, Ordering::Relaxed);
                let Some(game) = queue.get(i) else {
                    break;
                };
                let rating = rate_one_game(&http, game).await;
                if let Ok(mut map) = results.lock() {
                    map.insert(game.id.clone(), rating);
                }
            }
        }));
    }

    for worker in workers {
        let _ = worker.await;
    }

    let map = match results.lock() {
        Ok(mut guard) => std::mem::take(&mut *guard),
        Err(_) => HashMap::new(),
    };
    Ok(map)
}

#[derive(Serialize)]
pub struct SteamTitleInfo {
    pub name: String,
    pub cover_url: Option<String>,
}

/// Rezolvă numele (și coperta) pentru mai multe Steam App ID-uri deodată.
/// Întoarce doar ID-urile pentru care s-a găsit un nume.
#[tauri::command]
async fn resolve_steam_titles(
    app: AppHandle,
    app_ids: Vec<String>,
) -> Result<HashMap<String, SteamTitleInfo>, String> {
    let mut ids: Vec<String> = app_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()))
        .collect();
    ids.sort();
    ids.dedup();

    if ids.is_empty() {
        return Ok(HashMap::new());
    }

    let total = ids.len();
    let queue = Arc::new(ids);
    let next_index = Arc::new(AtomicUsize::new(0));
    let results: Arc<Mutex<HashMap<String, SteamTitleInfo>>> =
        Arc::new(Mutex::new(HashMap::with_capacity(total)));

    let mut workers = Vec::new();
    for _ in 0..NETWORK_CONCURRENCY.min(total) {
        let app = app.clone();
        let queue = Arc::clone(&queue);
        let next_index = Arc::clone(&next_index);
        let results = Arc::clone(&results);

        workers.push(tauri::async_runtime::spawn(async move {
            let http = app.state::<AppHttpClient>();
            loop {
                let i = next_index.fetch_add(1, Ordering::Relaxed);
                let Some(id) = queue.get(i) else {
                    break;
                };
                let name = get_steam_app_title(http.clone(), id.clone())
                    .await
                    .ok()
                    .flatten();
                if let Some(name) = name {
                    let info = SteamTitleInfo {
                        name,
                        cover_url: Some(format!(
                            "https://cdn.cloudflare.steamstatic.com/steam/apps/{}/library_600x900.jpg",
                            id
                        )),
                    };
                    if let Ok(mut map) = results.lock() {
                        map.insert(id.clone(), info);
                    }
                }
            }
        }));
    }

    for worker in workers {
        let _ = worker.await;
    }

    let map = match results.lock() {
        Ok(mut guard) => std::mem::take(&mut *guard),
        Err(_) => HashMap::new(),
    };
    Ok(map)
}

/// Pornește un proces pe care nu-l mai urmărim și îl „culege" (wait) pe un thread separat.
/// Un `Child` abandonat fără wait() rămâne proces zombie după ce se închide, până la ieșirea din aplicație.
fn spawn_and_reap(cmd: &mut Command) -> std::io::Result<()> {
    let mut child = cmd.spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("URL invalid.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        spawn_and_reap(Command::new("cmd").args(["/C", "start", "", &url]))
        .map_err(|e| e.to_string())?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        spawn_and_reap(Command::new("xdg-open").arg(&url))
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
async fn get_system_stats(state: tauri::State<'_, AppSystemStats>) -> Result<SystemStats, String> {
    let mut sys = state.sys.lock().map_err(|e| e.to_string())?;
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    let cpu_usage = sys.global_cpu_usage();
    let ram_used = sys.used_memory() as f32 / 1024.0 / 1024.0 / 1024.0;
    let ram_total = sys.total_memory() as f32 / 1024.0 / 1024.0 / 1024.0;

    Ok(SystemStats {
        cpu_usage: (cpu_usage * 10.0).round() / 10.0,
       ram_used_gb: (ram_used * 10.0).round() / 10.0,
       ram_total_gb: (ram_total * 10.0).round() / 10.0,
    })
}

fn collect_available_runners() -> Vec<RunnerInfo> {
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

    // 1. Runner-ii descărcați prin NexusDeck (~/.nexusdeck/runners)
    let nexus_runners_dir = PathBuf::from(format!("{}/.nexusdeck/runners", home));
    if let Ok(entries) = fs::read_dir(nexus_runners_dir) {
        for entry in entries.flatten() {
            let wine_bin = entry.path().join("files/bin/wine");
            if wine_bin.exists() {
                runners.push(RunnerInfo {
                    name: format!("NexusDeck GE: {}", entry.file_name().to_string_lossy()),
                             path: wine_bin.to_string_lossy().to_string(),
                });
            }
        }
    }

    // 2. Lutris runners
    let lutris_dir = PathBuf::from(format!("{}/.local/share/lutris/runners/wine", home));
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

    // 3. Steam compatibilitytools.d
    let proton_dir = PathBuf::from(format!("{}/.steam/root/compatibilitytools.d", home));
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

    runners
}

#[tauri::command]
async fn get_available_runners() -> Result<Vec<RunnerInfo>, String> {
    tauri::async_runtime::spawn_blocking(collect_available_runners)
    .await
    .map_err(|e| e.to_string())
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
                                               save_path: None,
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
 extra: Default::default(),
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
                       save_path: None,
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
 extra: Default::default(),
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
                                           save_path: None,
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
 extra: Default::default(),
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

/// Serializează scrierile games.json: două salvări simultane foloseau același fișier .tmp
/// și puteau lăsa pe disc un JSON amestecat.
static GAMES_FILE_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
async fn save_games(app: AppHandle, games: Vec<Game>) -> Result<(), String> {
    // Doar intrările meniului de tray (max. 6 perechi id/titlu), nu o clonă a întregii biblioteci
    let tray_entries = tray_quick_launch_entries(&games);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = GAMES_FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let file_path = get_games_file_path();
        let temp_path = file_path.with_extension("json.tmp");

        // Compact (nu indentat): fișier mai mic, serializare și scriere mai rapide
        let json = serde_json::to_vec(&games).map_err(|e| e.to_string())?;
        fs::write(&temp_path, json).map_err(|e| e.to_string())?;
        fs::rename(temp_path, file_path).map_err(|e| e.to_string())?;

        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())??;

    apply_tray_entries(&app, tray_entries);

    Ok(())
}

#[tauri::command]
async fn load_saved_games() -> Result<Vec<Game>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file_path = get_games_file_path();
        if !file_path.exists() {
            return Ok(Vec::new());
        }

        let _guard = GAMES_FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let content = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;

        // Fiecare joc separat: o singură intrare invalidă nu mai golește toată biblioteca
        // (înainte, orice eroare de parsare întorcea listă goală, iar prima salvare
        // de după suprascria definitiv games.json).
        let parsed: Result<Vec<serde_json::Value>, _> = serde_json::from_str(&content);
        let (games, lossy) = match parsed {
            Ok(values) => {
                let total = values.len();
                let games: Vec<Game> = values
                    .into_iter()
                    .filter_map(|v| serde_json::from_value(v).ok())
                    .collect();
                let lossy = games.len() != total;
                (games, lossy)
            }
            Err(_) => (Vec::new(), true),
        };

        if lossy {
            // Păstrăm originalul, ca biblioteca să poată fi recuperată manual
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let backup = file_path.with_extension(format!("json.corrupt-{}", ts));
            let _ = fs::copy(&file_path, &backup);
            eprintln!("games.json conținea intrări invalide; copie salvată în {:?}", backup);
        }

        Ok(games)
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
    // Cheia de mai jos era un placeholder: fiecare căutare făcea o cerere sortită eșecului (401)
    // înainte de fallback-ul Steam. SteamGridDB se folosește doar cu o cheie reală.
    let api_key = std::env::var("STEAMGRIDDB_API_KEY").unwrap_or_default();

    // 1. Căutăm ID-ul jocului după titlu pe SteamGridDB
    let search_url = format!(
        "https://www.steamgriddb.com/api/v2/search/autocomplete/{}",
        urlencoding::encode(clean_title)
    );

    let client = &state.client;

    let req = if api_key.trim().is_empty() {
        Err(())
    } else {
        client.get(&search_url)
    .header("Authorization", format!("Bearer {}", api_key))
    .send()
    .await
    .map_err(|_| ())
    };

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

    // Dialogul blochează thread-ul apelant până îl închide utilizatorul: îl ținem în pool-ul
    // de thread-uri blocante, nu pe un worker al runtime-ului async.
    tauri::async_runtime::spawn_blocking(move || {
        let file_path = app
        .dialog()
        .file()
        .add_filter("Executables", &["exe", "sh", "bin", "AppImage", "EXE", "SH"])
        .blocking_pick_file();

        file_path.map(|p| p.to_string())
    })
    .await
    .map_err(|e| e.to_string())
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

    /// Scrie un fișier cu token-uri vizibil doar utilizatorului curent (0600). Cu `fs::write`
    /// simplu ar fi primit permisiunile implicite (de obicei 0644, citibil de orice cont local).
    fn write_private_file(path: &Path, contents: &str) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(path)?;
            // Fișierele existente își păstrează vechile permisiuni la `open`: le reparăm explicit
            f.set_permissions(fs::Permissions::from_mode(0o600))?;
            f.write_all(contents.as_bytes())
        }
        #[cfg(not(unix))]
        {
            fs::write(path, contents)
        }
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
        let local_installs = tauri::async_runtime::spawn_blocking(detect_local_epic_installs)
            .await
            .unwrap_or_default();
        let mut raw_records: Vec<serde_json::Value> = Vec::new();
        let mut seen_apps = std::collections::HashSet::new();
        let mut cursor: Option<String> = None;

        // 1. Preluăm toate item-urile din librăria contului Epic.
        // Plafon de pagini: un cursor care se repetă (răspuns greșit de la API) nu mai buclează la infinit.
        let mut pages = 0usize;
        loop {
            pages += 1;
            if pages > 500 {
                break;
            }
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
                       save_path: None,
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
 extra: Default::default(),
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
            let _ = write_private_file(&get_epic_session_path(), &serialized);
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
                let _ = write_private_file(&session_path, &serialized);
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
        /// true din momentul în care install_epic_game acceptă cererea până la finalul thread-ului.
        /// `active_pid` devine Some abia după spawn: fără rezervarea asta, un dublu-click pornea
        /// două instalări simultane.
        pub install_running: Arc<AtomicBool>,
        /// Pauză/anulare cerută înainte să existe PID-ul lui legendary (în fereastra de pornire).
        pub stop_requested: Arc<AtomicBool>,
    }

    /// Eliberează rezervarea instalării la ieșirea din thread, pe orice ramură (inclusiv panic).
    struct InstallSlotGuard(Arc<AtomicBool>);
    impl Drop for InstallSlotGuard {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
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

        write_private_file(&user_json_path, &serialized)
        .map_err(|e| format!("Nu s-a putut scrie user.json pentru legendary: {}", e))?;

        Ok(())
    }

    #[tauri::command]
    async fn check_legendary_status() -> LegendaryStatus {
        // `legendary --version` pornește un interpretor Python (sute de ms)
        tauri::async_runtime::spawn_blocking(check_legendary_status_blocking)
            .await
            .unwrap_or_else(|_| LegendaryStatus {
                installed: false,
                default_dir: String::new(),
                version: String::new(),
            })
    }

    fn check_legendary_status_blocking() -> LegendaryStatus {
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
    async fn check_steam_install_status(app_id: String) -> SteamInstallStatus {
        // Apelat periodic din JS: citește fișiere, deci nu pe thread-ul principal
        tauri::async_runtime::spawn_blocking(move || check_steam_install_status_blocking(app_id))
            .await
            .unwrap_or_else(|_| SteamInstallStatus {
                state: "not_found".into(),
                percent: 0.0,
            })
    }

    fn check_steam_install_status_blocking(app_id: String) -> SteamInstallStatus {
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

                // StateFlags e un câmp de biți: 4 = complet instalat; 2/256/512/1024 = update necesar
                // / în curs / pe pauză / pornit. Un joc instalat și pornit imediat are 4|64 = "68",
                // iar comparația exactă cu "4" îl raporta „în descărcare” la nesfârșit.
                let flags: u32 = state_flags.trim().parse().unwrap_or(0);
                let fully_installed = flags & 4 != 0 && flags & (2 | 256 | 512 | 1024) == 0;
                if fully_installed {
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

        tauri::async_runtime::spawn_blocking(move || {
            let folder_path = app.dialog().file().blocking_pick_folder();
            folder_path.map(|p| p.to_string())
        })
        .await
        .map_err(|e| e.to_string())
    }

    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct ExportedGameData {
        pub title: String,
        pub runner_name: Option<String>,
        pub launch_args: Option<String>,
        pub env_vars: Option<HashMap<String, String>>,
        pub use_gamemode: bool,
        pub use_mangohud: bool,
        pub cover_url: Option<String>,
        pub banner_url: Option<String>,
        pub genre: Option<String>,
        pub source: Option<String>,
        pub tags: Option<Vec<String>>,
        pub steam_app_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub gamescope: Option<serde_json::Value>,
    }

    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct GameProfileFile {
        pub schema: String,
        pub app_version: String,
        pub exported_at: u64,
        pub profile: ExportedGameData,
    }

    #[tauri::command]
    async fn export_game_profile(
        app: AppHandle,
        game: Game,
        runner_name: Option<String>,
    ) -> Result<bool, String> {
        use tauri_plugin_dialog::DialogExt;

        let safe_filename: String = game
        .title
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
        let default_name = format!(
            "{}.nexusprofile.json",
            if safe_filename.is_empty() { "game" } else { &safe_filename }
        );

        let file_path = tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
            .file()
            .set_file_name(&default_name)
            .add_filter("NexusDeck Game Profile", &["nexusprofile.json", "json"])
            .blocking_save_file()
        })
        .await
        .map_err(|e| e.to_string())?;

        let Some(path) = file_path else {
            return Ok(false); // Utilizatorul a anulat dialogul
        };

        let dest_path = path
        .into_path()
        .map_err(|_| "Cale de salvare invalidă.".to_string())?;

        let exported_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

        let payload = GameProfileFile {
            schema: "nexusdeck-game-profile-v1".to_string(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            exported_at,
            profile: ExportedGameData {
                title: game.title,
                runner_name,
                launch_args: game.launch_args,
                env_vars: game.env_vars,
                use_gamemode: game.use_gamemode,
                use_mangohud: game.use_mangohud,
                cover_url: game.cover_url,
                banner_url: game.banner_url,
                genre: game.genre,
                source: game.source,
                tags: game.tags,
                steam_app_id: game.steam_app_id,
                gamescope: game.extra.get("gamescope").cloned(),
            },
        };

        let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
        fs::write(&dest_path, json).map_err(|e| format!("Nu s-a putut scrie fișierul: {}", e))?;

        Ok(true)
    }

    #[tauri::command]
    async fn import_game_profile(app: AppHandle) -> Result<Option<ExportedGameData>, String> {
        use tauri_plugin_dialog::DialogExt;

        let file_path = tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
            .file()
            .add_filter("NexusDeck Game Profile", &["json"])
            .blocking_pick_file()
        })
        .await
        .map_err(|e| e.to_string())?;

        let Some(path) = file_path else {
            return Ok(None); // Utilizatorul a anulat dialogul
        };

        let src_path = path
        .into_path()
        .map_err(|_| "Cale fișier invalidă.".to_string())?;

        let content = fs::read_to_string(&src_path)
        .map_err(|e| format!("Nu s-a putut citi fișierul: {}", e))?;

        let parsed: GameProfileFile = serde_json::from_str(&content)
        .map_err(|_| "Fișierul selectat nu este un profil NexusDeck valid.".to_string())?;

        if parsed.schema != "nexusdeck-game-profile-v1" {
            return Err("Versiune de profil nesuportată.".to_string());
        }

        Ok(Some(parsed.profile))
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
        // Interogarea mount-urilor (statvfs) poate agăța pe un mount de rețea căzut:
        // o pornim în pool-ul blocant, în paralel cu `legendary info`.
        let disk_task = tauri::async_runtime::spawn_blocking(move || get_available_disk_bytes(&install_dir));

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

        let available_bytes = disk_task.await.unwrap_or(0);

        let has_enough_space = required_bytes == 0 || available_bytes >= required_bytes;

        Ok(EpicDiskSpaceInfo {
            required_bytes,
            available_bytes,
            has_enough_space,
        })
    }

    /// Numele de folder pe care legendary le poate folosi pentru un joc (în minuscule):
    /// FolderName din metadate, titlul și app_name-ul.
    fn epic_expected_folder_names(clean_app_name: &str) -> Vec<String> {
        let mut names = vec![clean_app_name.to_lowercase()];
        if let Some(leg_dir) = get_legendary_config_dir() {
            let meta_path = leg_dir.join("metadata").join(format!("{}.json", clean_app_name));
            if let Ok(raw) = fs::read_to_string(meta_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                    let candidates = [
                        json["metadata"]["customAttributes"]["FolderName"]["value"].as_str(),
                        json["app_title"].as_str(),
                        json["metadata"]["title"].as_str(),
                    ];
                    for c in candidates.into_iter().flatten() {
                        let c = c.trim().to_lowercase();
                        if !c.is_empty() && !names.contains(&c) {
                            names.push(c);
                        }
                    }
                }
            }
        }
        names
    }

    /// Căile jocurilor Epic încă înregistrate ca instalate în legendary (nu se șterg niciodată la curățenie).
    fn legendary_installed_paths() -> std::collections::HashSet<PathBuf> {
        let mut set = std::collections::HashSet::new();
        if let Some(leg_dir) = get_legendary_config_dir() {
            if let Ok(raw) = fs::read_to_string(leg_dir.join("installed.json")) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(obj) = json.as_object() {
                        for rec in obj.values() {
                            if let Some(path) = rec["install_path"].as_str() {
                                let p = PathBuf::from(path);
                                set.insert(fs::canonicalize(&p).unwrap_or(p));
                            }
                        }
                    }
                }
            }
        }
        set
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
            let canon = fs::canonicalize(&subdir).unwrap_or_else(|_| subdir.clone());
            // „Folderul nou” detectat în timpul descărcării poate fi, în cazuri rare, al altui joc
            // instalat între timp în același loc: pe acela nu-l atingem.
            if subdir.is_dir() && !legendary_installed_paths().contains(&canon) {
                remove_dir_if_safe(&subdir);
            }
        }

        // 2. Fallback: subfolderul ACESTUI joc din install_dir, dacă a rămas o descărcare neterminată.
        // Înainte se ștergea orice subfolder cu `.egstore` — dar legendary pune `.egstore` în fiecare
        // joc instalat, deci anularea unei descărcări ștergea și celelalte jocuri Epic din același folder.
        if let Some(dir) = install_dir {
            let resolved = resolve_tilde(dir);
            let expected_names = epic_expected_folder_names(clean_app_name);
            let protected = legendary_installed_paths();
            if let Ok(entries) = fs::read_dir(&resolved) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    let canon = fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
                    if p.is_dir()
                        && p.join(".egstore").exists()
                        && expected_names.contains(&name)
                        && !protected.contains(&canon)
                    {
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
        // Rezervare atomică: verificarea și marcarea se fac într-un singur pas
        if state
            .install_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
            || state.active_pid.lock().unwrap_or_else(|e| e.into_inner()).is_some()
        {
            return Err("Există deja o descărcare în desfășurare.".into());
        }
        let slot = InstallSlotGuard(state.install_running.clone());
        state.stop_requested.store(false, Ordering::SeqCst);

        {
            let mut paused_guard = state.is_paused.lock().unwrap_or_else(|e| e.into_inner());
            *paused_guard = false;
        }

        // La o eroare aici, `slot` iese din scope și eliberează rezervarea
        sync_session_to_legendary()?;

        let clean_app_name = app_name.trim_start_matches("epic_").to_string();
        let resolved_dir = resolve_tilde(&install_dir);
        fs::create_dir_all(&resolved_dir)
        .map_err(|e| format!("Nu s-a putut crea folderul de instalare: {}", e))?;

        let pid_arc = state.active_pid.clone();
        let paused_arc = state.is_paused.clone();
        let subdir_arc = state.active_game_subdir.clone();
        let stop_arc = state.stop_requested.clone();

        std::thread::spawn(move || {
            let _slot = slot;
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

            // Pauză/anulare apăsată cât timp legendary încă pornea: o aplicăm acum
            if stop_arc.swap(false, Ordering::SeqCst) {
                let pid = pid_arc.lock().unwrap().take();
                if let Some(pid) = pid {
                    terminate_download_pid(pid);
                }
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

                    if let Some(ref exe_str) = detected_exe {
                        let home_dir = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
                        let prefix_dir = home_dir
                        .join("Games")
                        .join("Prefixes")
                        .join("Epic")
                        .join(&clean_app_name);
                        let _ = fs::create_dir_all(&prefix_dir);
                        let prefix_str = prefix_dir.to_string_lossy().to_string();

                        let runners = collect_available_runners();
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
                                        .args(["run", "wineboot", "-u"])
                                        .env("STEAM_COMPAT_DATA_PATH", &prefix_str)
                                        .env("STEAM_COMPAT_CLIENT_INSTALL_PATH", &steam_root)
                                        .status();
                                        // Dacă e joc Rockstar (RDR2, GTA V), instalăm automat Epic Games Launcher în prefix
                                        let install_folder = Path::new(exe_str).parent();
                                        if is_rockstar_epic_game(&clean_app_name, install_folder) {
                                            let _ = app_handle.emit(
                                                "epic-install-progress",
                                                EpicInstallProgress {
                                                    status: "downloading".into(),
                                                                    app_name: clean_app_name.clone(),
                                                                    title: game_title.clone(),
                                                                    percent: 99.5,
                                                                    speed: "Setup...".into(),
                                                                    eta: String::new(),
                                                                    message: "Installing Epic Games Launcher inside prefix (required for Rockstar games)...".into(),
                                                                    exe_path: None,
                                                                    wine_prefix: None,
                                                                    runner_path: None,
                                                },
                                            );

                                            if let Err(e) = setup_epic_launcher_in_prefix(&prefix_str, &proton_script) {
                                                eprintln!("Warning: Failed to setup Epic Games Launcher in prefix: {}", e);
                                            }
                                        }
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
        } else if state.install_running.load(Ordering::SeqCst) {
            // legendary nu are încă PID: thread-ul de instalare îl oprește imediat după spawn
            state.stop_requested.store(true, Ordering::SeqCst);
        }
        Ok(())
    }

#[tauri::command]
    async fn cancel_epic_install(
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
        if pid.is_none() && state.install_running.load(Ordering::SeqCst) {
            // Instalarea e încă în faza de pornire: thread-ul ei va opri legendary și va curăța
            state.stop_requested.store(true, Ordering::SeqCst);
            return Ok(());
        }
        let subdir_arc = state.active_game_subdir.clone();

        // `legendary uninstall` + remove_dir_all (descărcări de GB) pot dura mult:
        // nu pe thread-ul principal.
        tauri::async_runtime::spawn_blocking(move || {
            if let Some(pid) = pid {
                terminate_download_pid(pid);
            } else if let Some(raw_app) = app_name {
                let clean_app_name = raw_app.trim_start_matches("epic_").to_string();
                let known_subdir = subdir_arc.lock().unwrap().take();
                cleanup_epic_partial_files(&clean_app_name, install_dir.as_deref(), known_subdir);
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[tauri::command]
    async fn uninstall_epic_game(app_name: String, exe_path: String) -> Result<(), String> {
        // `legendary uninstall` (Python) + remove_dir_all: nu pe thread-ul principal
        tauri::async_runtime::spawn_blocking(move || uninstall_epic_game_blocking(app_name, exe_path))
            .await
            .map_err(|e| e.to_string())?
    }

    fn uninstall_epic_game_blocking(app_name: String, exe_path: String) -> Result<(), String> {
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
            if candidate != home_dir {
                remove_dir_if_safe(p);
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
fn starts_with_ci(haystack: &[u8], prefix: &[u8]) -> bool {
    haystack.len() >= prefix.len() && haystack[..prefix.len()].eq_ignore_ascii_case(prefix)
}

// `appid=730` nu trebuie să se potrivească cu `appid=7300`: după needle nu poate urma o cifră.
#[cfg(target_os = "linux")]
fn contains_with_digit_boundary(haystack: &str, needle: &str) -> bool {
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(needle) {
        let at = from + rel;
        let end = at + needle.len();
        match haystack[end..].chars().next() {
            Some(c) if c.is_ascii_digit() => {}
            _ => return true,
        }
        // needle începe cu un caracter ASCII, deci at + 1 e mereu la limită de caracter
        from = at + 1;
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

    // Pregătite o singură dată (înainte, se alocau în interiorul buclei, pentru
    // fiecare variabilă de mediu a fiecărui proces din sistem)
    let steam_env_app = steam_app_id.as_ref().map(|id| format!("SteamAppId={}", id).into_bytes());
    let steam_env_game = steam_app_id.as_ref().map(|id| format!("SteamGameId={}", id).into_bytes());
    let steam_cmd = steam_app_id.as_ref().map(|id| format!("appid={}", id));

    let lutris_slug = exe_path
    .strip_prefix("lutris:rungame/")
    .or_else(|| exe_path.strip_prefix("lutris:rungameid/"))
    .map(|s| s.trim_matches('/').to_lowercase());

    let prefix_norm = wine_prefix.trim_end_matches('/').to_lowercase();
    let prefix_active = !prefix_norm.is_empty() && prefix_norm.len() > 4;

    // environ se citește doar dacă vreo verificare chiar are nevoie de el
    let need_environ = steam_app_id.is_some() || prefix_active;

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

            // Octeți bruți, fără a construi un Vec<String> pentru tot mediul procesului
            let environ: Vec<u8> = if need_environ {
                fs::read(proc_dir.join("environ")).unwrap_or_default()
            } else {
                Vec::new()
            };

            if let (Some(env_app), Some(env_game), Some(cmd_needle)) =
                (&steam_env_app, &steam_env_game, &steam_cmd)
            {
                let env_match = environ
                    .split(|&b| b == 0)
                    .any(|var| var == env_app.as_slice() || var == env_game.as_slice());

                if env_match || contains_with_digit_boundary(&cmdline, cmd_needle.as_str()) {
                    matched_pids.push(pid);
                    continue;
                }
            }

            if prefix_active {
                // exe/cwd sunt folosite doar aici, deci nu le mai citim când nu avem prefix
                let exe_link = fs::read_link(proc_dir.join("exe"))
                .map(|p| p.to_string_lossy().to_lowercase())
                .unwrap_or_default();

                let cwd_link = fs::read_link(proc_dir.join("cwd"))
                .map(|p| p.to_string_lossy().to_lowercase())
                .unwrap_or_default();

                let env_prefix_match = environ.split(|&b| b == 0).any(|var| {
                    (starts_with_ci(var, b"wineprefix=")
                        || starts_with_ci(var, b"steam_compat_data_path="))
                    && String::from_utf8_lossy(var).to_lowercase().contains(&prefix_norm)
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

// Verificare ieftină (un singur fișier mic): procesul există și nu e zombie.
// Un zombie are cmdline gol, deci îl tratăm ca terminat, exact ca scanarea completă.
#[cfg(target_os = "linux")]
fn pid_is_alive(pid: u32) -> bool {
    fs::read(format!("/proc/{}/cmdline", pid))
    .map(|bytes| !bytes.is_empty())
    .unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
fn pid_is_alive(_pid: u32) -> bool {
    false
}

#[cfg(not(target_os = "linux"))]
fn find_matching_game_pids(_exe_path: &str, _wine_prefix: &str) -> Vec<u32> {
    Vec::new()
}

// ppid -> copii, dintr-o singură trecere prin /proc
#[cfg(target_os = "linux")]
fn build_children_map() -> HashMap<u32, Vec<u32>> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let Ok(entries) = fs::read_dir("/proc") else {
        return children;
    };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(bytes) = fs::read(entry.path().join("stat")) else {
            continue;
        };
        let stat = String::from_utf8_lossy(&bytes);
        // Formatul: `pid (comm) stare ppid ...`; comm poate conține spații și paranteze,
        // deci pornim de la ULTIMA paranteză închisă.
        let Some(idx) = stat.rfind(')') else {
            continue;
        };
        let mut fields = stat[idx + 1..].split_whitespace();
        let _state = fields.next();
        if let Some(ppid) = fields.next().and_then(|s| s.parse::<u32>().ok()) {
            children.entry(ppid).or_default().push(pid);
        }
    }
    children
}

#[cfg(target_os = "linux")]
fn descendants_of(children: &HashMap<u32, Vec<u32>>, root: u32) -> Vec<u32> {
    let mut result: Vec<u32> = Vec::new();
    let mut stack = vec![root];
    while let Some(parent) = stack.pop() {
        if let Some(kids) = children.get(&parent) {
            for &kid in kids {
                if kid != root && !result.contains(&kid) {
                    result.push(kid);
                    stack.push(kid);
                }
            }
        }
    }
    result
}

#[cfg(not(target_os = "linux"))]
fn build_children_map() -> HashMap<u32, Vec<u32>> {
    HashMap::new()
}

#[cfg(not(target_os = "linux"))]
fn descendants_of(_children: &HashMap<u32, Vec<u32>>, _root: u32) -> Vec<u32> {
    Vec::new()
}

// -----------------------------------------------------------------------------
// GAMESCOPE
// -----------------------------------------------------------------------------

/// Argumentele gamescope din setările jocului (aceleași opțiuni ca în Lutris), sau None dacă e oprit.
fn gamescope_args(cfg: &serde_json::Value) -> Option<Vec<String>> {
    if !cfg["enabled"].as_bool().unwrap_or(false) {
        return None;
    }
    let mut args: Vec<String> = Vec::new();

    // „Game Resolution” = rezoluția internă a jocului (-w/-h), ca în Lutris
    if let Some(res) = cfg["resolution"].as_str() {
        let lower = res.trim().to_lowercase();
        if let Some((w, h)) = lower.split_once('x') {
            let (w, h) = (w.trim(), h.trim());
            if let (Ok(w), Ok(h)) = (w.parse::<u32>(), h.parse::<u32>()) {
                if (320..=16384).contains(&w) && (200..=16384).contains(&h) {
                    args.extend(["-w".into(), w.to_string(), "-h".into(), h.to_string()]);
                }
            }
        }
    }

    match cfg["window_mode"].as_str().unwrap_or("fullscreen") {
        "borderless" => args.push("-b".into()),
        "windowed" => {}
        _ => args.push("-f".into()),
    }

    if let Some(fps) = cfg["fps_limit"].as_u64().filter(|f| (1..=1000).contains(f)) {
        args.extend(["-r".into(), fps.to_string()]);
    }

    if cfg["hdr"].as_bool().unwrap_or(false) {
        args.push("--hdr-enabled".into());
    }
    Some(args)
}

/// Pune comanda jocului „în interiorul” lui gamescope: `gamescope <opțiuni> -- <program> <argumente>`,
/// păstrând variabilele de mediu și folderul de lucru.
fn wrap_with_gamescope(cmd: Command, gs_args: Vec<String>, hdr: bool) -> Command {
    let mut wrapped = Command::new("gamescope");
    wrapped.args(&gs_args).arg("--").arg(cmd.get_program()).args(cmd.get_args());
    for (key, value) in cmd.get_envs() {
        match value {
            Some(v) => {
                wrapped.env(key, v);
            }
            None => {
                wrapped.env_remove(key);
            }
        }
    }
    if let Some(dir) = cmd.get_current_dir() {
        wrapped.current_dir(dir);
    }
    if hdr {
        // DXVK / vkd3d-proton expun HDR jocului doar cu aceste variabile
        wrapped.env("DXVK_HDR", "1");
        wrapped.env("ENABLE_HDR_WSI", "1");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // gamescope rămâne procesul urmărit; oprirea lui oprește și jocul
        wrapped.process_group(0);
    }
    wrapped
}

// Prefixul efectiv al unui joc Epic: cel setat de utilizator sau cel implicit.
// Folosit și la lansare, și la oprire, ca să vorbească despre același director.
fn epic_effective_prefix(game_id: &str, raw_prefix: &str) -> String {
    let raw = raw_prefix.trim();
    if !raw.is_empty() {
        resolve_tilde(raw)
    } else {
        format!(
            "{}/Games/Prefixes/Epic/{}",
            std::env::var("HOME").unwrap_or_default(),
            game_id.trim_start_matches("epic_")
        )
    }
}

// Împarte argumentele de lansare ca un shell simplu: spațiile separă, ghilimelele simple/duble
// grupează. Backslash scapă DOAR ghilimelele (`\"` și `\'`); în rest rămâne literal, ca
// să nu strice căi Windows de tip `C:\Games\x` date jocurilor rulate sub Wine.
fn split_launch_args(input: &str) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut has_token = false;
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.peek().copied() {
                Some(n) if n == '"' || n == '\'' => {
                    cur.push(n);
                    chars.next();
                    has_token = true;
                }
                _ => {
                    cur.push('\\');
                    has_token = true;
                }
            },
            '\'' if !in_double => {
                in_single = !in_single;
                has_token = true;
            }
            '"' if !in_single => {
                in_double = !in_double;
                has_token = true;
            }
            c if c.is_whitespace() && !in_single && !in_double => {
                if has_token {
                    args.push(std::mem::take(&mut cur));
                    has_token = false;
                }
            }
            c => {
                cur.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        args.push(cur);
    }
    args
}

// -----------------------------------------------------------------------------
// DXVK / VKD3D-PROTON PENTRU JOCURILE LANSATE PRIN WINE (ca în Lutris)
// -----------------------------------------------------------------------------

const DXVK_DLLS: &[&str] = &["d3d9", "d3d10core", "d3d11", "dxgi"];
const VKD3D_DLLS: &[&str] = &["d3d12", "d3d12core"];
/// vkd3d-proton își face swapchain-ul doar prin dxgi.dll din DXVK (ca în Proton/Lutris).
/// Cu dxgi-ul încorporat în Wine, crearea swapchain-ului D3D12 pică (E_FAIL, ecran alb).
const VKD3D_DXGI_DLLS: &[&str] = &["dxgi"];

/// Ce straturi de traducere grafică vrea jocul, din variabilele lui de mediu
/// (DXVK: bifa „Enable DXVK”; VKD3D: activ implicit, oprit cu NEXUS_DISABLE_VKD3D=1).
fn graphics_layers_wanted(env_vars: &Option<HashMap<String, String>>) -> (bool, bool) {
    let get = |k: &str| env_vars.as_ref().and_then(|e| e.get(k)).map(|v| v.trim().to_string());
    let dxvk = get("DXVK_ENABLE").as_deref() == Some("true") || get("DXVK_ENABLED").as_deref() == Some("1");
    let vkd3d = get("NEXUS_DISABLE_VKD3D").as_deref() != Some("1");
    (dxvk, vkd3d)
}

/// WINEDLLOVERRIDES final: DLL-urile DXVK/VKD3D pe „native, apoi builtin”, plus ce a scris
/// utilizatorul. Un DLL pe care utilizatorul l-a setat explicit nu mai apare și la noi
/// (fără intrări duplicate, a căror prioritate în Wine nu e garantată).
fn build_dll_overrides(user: Option<&str>, dxvk: bool, vkd3d: bool) -> Option<String> {
    let user = user.map(str::trim).filter(|u| !u.is_empty());
    let user_dlls: std::collections::HashSet<String> = user
        .map(|u| {
            u.split(';')
                .filter_map(|entry| entry.split('=').next())
                .flat_map(|names| names.split(','))
                .map(|n| n.trim().to_lowercase())
                .filter(|n| !n.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let mut ours: Vec<&str> = Vec::new();
    if dxvk {
        ours.extend(DXVK_DLLS);
    }
    if vkd3d {
        ours.extend(VKD3D_DLLS);
        for d in VKD3D_DXGI_DLLS {
            if !ours.contains(d) {
                ours.push(d);
            }
        }
    }
    ours.retain(|d| !user_dlls.contains(*d));

    let mut parts: Vec<String> = Vec::new();
    if !ours.is_empty() {
        parts.push(format!("{}=n,b", ours.join(",")));
    }
    if let Some(u) = user {
        parts.push(u.to_string());
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(";"))
    }
}

/// true dacă fișierul e unul din DLL-urile „substitut” pe care Wine le pune în system32
/// pentru propriile implementări (nu un DLL real, ca vkd3d-proton sau DXVK).
fn is_wine_placeholder_dll(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = fs::File::open(path) else {
        return false;
    };
    let mut head = [0u8; 512];
    let n = f.read(&mut head).unwrap_or(0);
    let head = &head[..n];
    let has = |needle: &[u8]| head.windows(needle.len()).any(|w| w == needle);
    has(b"Wine builtin DLL") || has(b"Wine placeholder DLL")
}

/// Folderele cu DLL-urile unui strat (subdir = "vkd3d-proton" / "dxvk"), pe 64 și 32 de biți:
/// întâi din runner (GE-Proton le include), apoi din runtime-ul Lutris.
fn find_layer_dirs(runner_path: &str, subdir: &str, lutris_name: &str) -> Option<(PathBuf, Option<PathBuf>)> {
    let mut candidates: Vec<(PathBuf, PathBuf)> = Vec::new();
    // .../GE-Proton9-20/files/bin/wine -> .../files ; .../lutris/runners/wine/<ver>/bin/wine -> .../<ver>
    if let Some(root) = Path::new(runner_path).parent().and_then(|p| p.parent()) {
        candidates.push((
            root.join("lib/wine").join(subdir).join("x86_64-windows"),
            root.join("lib/wine").join(subdir).join("i386-windows"),
        ));
        candidates.push((root.join("lib64/wine").join(subdir), root.join("lib/wine").join(subdir)));
    }
    if let Some(home) = dirs::home_dir() {
        let rt = home.join(".local/share/lutris/runtime").join(lutris_name);
        if let Ok(entries) = fs::read_dir(&rt) {
            let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
            versions.sort();
            if let Some(latest) = versions.pop() {
                candidates.push((latest.join("x64"), latest.join("x32")));
            }
        }
    }
    candidates.into_iter().find(|(x64, _)| x64.is_dir()).map(|(x64, x32)| {
        let x32 = if x32.is_dir() { Some(x32) } else { None };
        (x64, x32)
    })
}

/// Copiază DLL-urile stratului în prefix doar unde lipsesc sau unde e substitutul lui Wine.
/// Un DLL real existent (pus de Lutris, de winetricks sau de utilizator) nu se atinge.
fn install_layer_into_prefix(prefix: &Path, dlls: &[&str], x64_src: &Path, x32_src: Option<&Path>) {
    let windows = prefix.join("drive_c/windows");
    if !windows.is_dir() {
        return; // prefix neinițializat încă: Wine îl creează la prima rulare, copiem data viitoare
    }
    let syswow64 = windows.join("syswow64");
    let is_64bit_prefix = syswow64.is_dir();
    let targets: Vec<(PathBuf, Option<&Path>)> = if is_64bit_prefix {
        vec![(windows.join("system32"), Some(x64_src)), (syswow64, x32_src)]
    } else {
        vec![(windows.join("system32"), x32_src)]
    };

    for (dest_dir, src_dir) in targets {
        let Some(src_dir) = src_dir else { continue };
        for dll in dlls {
            let src = src_dir.join(format!("{}.dll", dll));
            if !src.is_file() {
                continue;
            }
            let dest = dest_dir.join(format!("{}.dll", dll));
            if dest.exists() && !is_wine_placeholder_dll(&dest) {
                continue;
            }
            let tmp = dest_dir.join(format!(".{}.dll.nexusdeck-tmp", dll));
            if fs::copy(&src, &tmp).is_ok() && fs::rename(&tmp, &dest).is_err() {
                let _ = fs::remove_file(&tmp);
            }
        }
    }
}

/// Pentru log: DLL-ul din system32 al prefixului e lipsă, substitutul Wine sau un DLL real.
fn describe_prefix_dll(prefix: &Path, dll: &str) -> &'static str {
    let path = prefix.join("drive_c/windows/system32").join(format!("{}.dll", dll));
    if !path.exists() {
        "lipsă"
    } else if is_wine_placeholder_dll(&path) {
        "substitut Wine (builtin)"
    } else {
        "nativ (vkd3d-proton/DXVK)"
    }
}

fn ensure_graphics_layers(runner_path: &str, prefix: &Path, dxvk: bool, vkd3d: bool) {
    if vkd3d {
        if let Some((x64, x32)) = find_layer_dirs(runner_path, "vkd3d-proton", "vkd3d") {
            install_layer_into_prefix(prefix, VKD3D_DLLS, &x64, x32.as_deref());
        }
    }
    if dxvk || vkd3d {
        if let Some((x64, x32)) = find_layer_dirs(runner_path, "dxvk", "dxvk") {
            let dlls: &[&str] = if dxvk { DXVK_DLLS } else { VKD3D_DXGI_DLLS };
            install_layer_into_prefix(prefix, dlls, &x64, x32.as_deref());
        }
    }
}

#[cfg(unix)]
fn describe_exit(status: &std::process::ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;
    if let Some(code) = status.code() {
        format!("cod de ieșire {}", code)
    } else if let Some(sig) = status.signal() {
        format!("oprit de semnalul {}", sig)
    } else {
        "terminat anormal".to_string()
    }
}

#[cfg(not(unix))]
fn describe_exit(status: &std::process::ExitStatus) -> String {
    match status.code() {
        Some(code) => format!("cod de ieșire {}", code),
        None => "terminat anormal".to_string(),
    }
}

// Ultimele rânduri utile din stderr (fără zgomotul `fixme:` al lui Wine)
fn stderr_tail_text(tail: &Arc<Mutex<Vec<u8>>>) -> String {
    let bytes = tail.lock().map(|t| t.clone()).unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with("fixme:") && !l.contains(":fixme:"))
        .collect();
    let start = lines.len().saturating_sub(6);
    lines[start..].join("\n")
}

// Lansarea mai este cea curentă pentru acest joc? (false după oprire manuală sau relansare)
fn launch_is_current(game_id: &str, generation: u64) -> bool {
    launch_meta()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(game_id)
        .map(|&(_, g)| g == generation)
        .unwrap_or(false)
}

// Încheie sesiunea doar dacă lansarea e încă cea curentă. Returnează true dacă a încheiat-o.
fn finish_launch(
    app: &AppHandle,
    running: &Arc<Mutex<HashMap<String, u32>>>,
    game_id: &str,
    generation: u64,
    elapsed: u64,
) -> bool {
    let mut meta = launch_meta().lock().unwrap_or_else(|e| e.into_inner());
    let is_mine = meta.get(game_id).map(|&(_, g)| g == generation).unwrap_or(false);
    if !is_mine {
        return false;
    }
    meta.remove(game_id);
    running.lock().unwrap_or_else(|e| e.into_inner()).remove(game_id);
    drop(meta);

    let _ = app.emit(
        "game-status-changed",
        GameStatusPayload {
            game_id: game_id.to_string(),
            status: "stopped".to_string(),
            playtime_seconds: elapsed,
        },
    );
    true
}

// Actualizează PID-ul urmărit doar dacă lansarea e încă cea curentă (altfel un kill manual
// ar fi „anulat” de monitorul care reinserează PID-ul).
fn update_tracked_pid(
    running: &Arc<Mutex<HashMap<String, u32>>>,
    game_id: &str,
    generation: u64,
    pid: u32,
    reset_play_start: bool,
) -> bool {
    let mut meta = launch_meta().lock().unwrap_or_else(|e| e.into_inner());
    match meta.get_mut(game_id) {
        Some(entry) if entry.1 == generation => {
            if reset_play_start {
                entry.0 = Instant::now();
            }
            running
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(game_id.to_string(), pid);
            true
        }
        _ => false,
    }
}

#[tauri::command]
async fn launch_game(
    app_handle: AppHandle,
    game: serde_json::Value,
    state: State<'_, RunningProcesses>,
) -> Result<String, String> {
    // Pregătirea lansării face I/O și rulează procese (legendary, curl, msiexec la prima
    // lansare Epic): nu are ce căuta pe un worker al runtime-ului async.
    let running = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || launch_game_blocking(app_handle, game, running))
        .await
        .map_err(|e| e.to_string())?
}

// Dacă lansarea eșuează înainte să existe un proces, UI-ul a primit deja „starting”:
// îl readucem la „stopped”, ca butonul să nu rămână blocat pe „Se pornește…”.
fn launch_game_blocking(
    app_handle: AppHandle,
    game: serde_json::Value,
    running: Arc<Mutex<HashMap<String, u32>>>,
) -> Result<String, String> {
    let game_id = game["id"].as_str().unwrap_or("").to_string();
    let result = launch_game_inner(app_handle.clone(), game, running);
    if result.is_err() && !game_id.is_empty() {
        let _ = app_handle.emit(
            "game-status-changed",
            GameStatusPayload {
                game_id,
                status: "stopped".to_string(),
                playtime_seconds: 0,
            },
        );
    }
    result
}

fn launch_game_inner(
    app_handle: AppHandle,
    game: serde_json::Value,
    running: Arc<Mutex<HashMap<String, u32>>>,
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
        if !command_exists("legendary") {
            return Err("`legendary` nu este instalat. Instalează-l (de ex. `pip install legendary-gl` sau din depozitele distribuției) ca să poți lansa jocuri Epic.".to_string());
        }
        let _ = sync_session_to_legendary();

        let home = std::env::var("HOME").unwrap_or_default();
        let effective_prefix = epic_effective_prefix(&game_id, raw_wine_prefix);
        let _ = fs::create_dir_all(&effective_prefix);

        wine_prefix = effective_prefix.clone();
        exe_path = resolve_tilde(raw_exe_path);

        let exp_proton = format!(
            "{}/.local/share/Steam/steamapps/common/Proton - Experimental/files/bin/wine",
            home
        );
        let effective_runner = if !raw_runner_path.is_empty() && raw_runner_path != "/usr/bin/wine" {
            resolve_tilde(raw_runner_path)
        } else if Path::new(&exp_proton).exists() {
            exp_proton
        } else {
            collect_available_runners()
            .into_iter()
            .rev()
            .find(|r| r.name.starts_with("Proton GE") || r.name.starts_with("Lutris"))
            .map(|r| r.path)
            .unwrap_or_else(|| "/usr/bin/wine".to_string())
        };

        let pfx_sub = Path::new(&effective_prefix).join("pfx");
        let target_pfx = if pfx_sub.exists() {
            pfx_sub.to_string_lossy().to_string()
        } else {
            effective_prefix.clone()
        };
        let _ = Command::new("legendary")
        .args(["eos-overlay", "enable", "--prefix", &target_pfx])
        .output();

        if use_gamemode && command_exists("gamemoderun") {
            cmd = Command::new("gamemoderun");
            cmd.arg("legendary");
        } else {
            cmd = Command::new("legendary");
        }
        cmd.arg("--enable-eos").arg("launch").arg(clean_app_name);

        let install_dir_path = Path::new(&exe_path).parent();
        let is_rockstar = is_rockstar_epic_game(clean_app_name, install_dir_path);

        let mut used_proton = false;
        if effective_runner.contains("compatibilitytools.d")
            || effective_runner.contains("steamapps/common/Proton")
            || effective_runner.contains(".nexusdeck/runners")
            {
                if let Some(proton_root) = Path::new(&effective_runner)
                    .parent()
                    .and_then(|p| p.parent())
                    .and_then(|p| p.parent())
                    {
                        let proton_script = proton_root.join("proton");
                        if proton_script.exists() {
                            let steam_root = format!("{}/.local/share/Steam", home);

                            if is_rockstar {
                                let _ = setup_epic_launcher_in_prefix(&effective_prefix, &proton_script);

                                let rgl_installed = Path::new(&effective_prefix)
                                .join("pfx/drive_c/Program Files/Rockstar Games/Launcher/Launcher.exe")
                                .exists();
                                if !rgl_installed {
                                    if let Some(dir) = install_dir_path {
                                        let rgl_setup = dir.join("Redistributables/Rockstar-Games-Launcher.exe");
                                        if rgl_setup.exists() {
                                            let _ = Command::new(&proton_script)
                                            .args(["run"])
                                            .arg(&rgl_setup)
                                            .arg("/S")
                                            .env("STEAM_COMPAT_DATA_PATH", &effective_prefix)
                                            .env("STEAM_COMPAT_CLIENT_INSTALL_PATH", &steam_root)
                                            .status();
                                        }
                                    }
                                }

                                let egl_exe = Path::new(&effective_prefix)
                                .join("pfx/drive_c/Program Files (x86)/Epic Games/Launcher/Portal/Binaries/Win64/EpicGamesLauncher.exe");
                                if egl_exe.exists() {
                                    let _ = spawn_and_reap(
                                        Command::new(&proton_script)
                                        .arg("run")
                                        .arg(&egl_exe)
                                        .args(["-silent", "-SkipBuildPatchPrereq"])
                                        .env("STEAM_COMPAT_DATA_PATH", &effective_prefix)
                                        .env("STEAM_COMPAT_CLIENT_INSTALL_PATH", &steam_root)
                                        .env("WINEDLLOVERRIDES", "dxgi=n,b;lsteamclient=d"),
                                    );
                                    std::thread::sleep(std::time::Duration::from_secs(4));
                                }
                            }

                            cmd.arg("--no-wine")
                            .arg("--wrapper")
                            .arg(format!("'{}' run", proton_script.to_string_lossy()));

                            if let Some(game_dir) = install_dir_path {
                                cmd.env("STEAM_COMPAT_INSTALL_PATH", game_dir);
                            }
                            cmd.env("STEAM_COMPAT_DATA_PATH", &effective_prefix);
                            cmd.env("STEAM_COMPAT_CLIENT_INSTALL_PATH", &steam_root);
                            cmd.env_remove("SteamAppId");
                            cmd.env_remove("SteamGameId");
                            cmd.env(
                                "WINEDLLOVERRIDES",
                                if is_rockstar { "dxgi=n,b;lsteamclient=d" } else { "lsteamclient=d" },
                            );
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
                    let explicit_runner = !runner_path.is_empty()
                        && runner_path != "native"
                        && runner_path != "/usr/bin/wine"
                        && !runner_path.starts_with("lutris_");
                    if explicit_runner && command_exists(&runner_path) {
                        runner_path.clone()
                    } else if explicit_runner {
                        // Înainte: fallback tăcut pe Wine-ul de sistem. Jocul pornea cu alt Wine decât
                        // cel ales (ex. wine-staging în loc de GE-Proton) și pica fără nicio explicație.
                        return Err(format!(
                            "Runner-ul ales pentru acest joc nu există pe disc:\n{}\nAlege alt runner în setările jocului (ex. o versiune GE-Proton instalată).",
                            runner_path
                        ));
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
                    // DirectX prin Vulkan, ca în Lutris: fără override-uri, Wine folosea propriul
                    // d3d12 (limitat), iar jocuri DX12 ca EA FC picau cu E_INVALIDARG la încărcare.
                    let (want_dxvk, want_vkd3d) = graphics_layers_wanted(&env_vars);
                    let effective_prefix = if wine_prefix.is_empty() {
                        dirs::home_dir().map(|h| h.join(".wine")).unwrap_or_default()
                    } else {
                        PathBuf::from(&wine_prefix)
                    };
                    ensure_graphics_layers(&runner, &effective_prefix, want_dxvk, want_vkd3d);

                    let user_overrides = env_vars.as_ref().and_then(|e| e.get("WINEDLLOVERRIDES")).map(|s| s.as_str());
                    let overrides = build_dll_overrides(user_overrides, want_dxvk, want_vkd3d);
                    // Diagnostic: ce rulează efectiv (vizibil în terminalul din care a pornit NexusDeck)
                    eprintln!(
                        "[NexusDeck] launch: runner={} | WINEPREFIX={} | WINEDLLOVERRIDES={} | d3d12 în prefix: {} | dxgi în prefix: {}",
                        runner,
                        effective_prefix.display(),
                        overrides.as_deref().unwrap_or("-"),
                        describe_prefix_dll(&effective_prefix, "d3d12"),
                        describe_prefix_dll(&effective_prefix, "dxgi")
                    );
                    if let Some(overrides) = overrides {
                        cmd.env("WINEDLLOVERRIDES", overrides);
                    }
                    cmd.env_remove("NEXUS_DISABLE_VKD3D");
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
            if is_uri {
                // `xdg-open steam://… -foo` nu transmite -foo jocului (xdg-open ar eșua sau l-ar ignora).
                // Opțiunile de lansare ale jocurilor Steam/Lutris se setează în clientul respectiv.
                eprintln!("Argumentele de lansare sunt ignorate pentru {}", exe_path);
            } else {
                if is_epic {
                    cmd.arg("--");
                }
                cmd.args(split_launch_args(args));
            }
        }
    }

    // URI-uri care doar deschid o pagină/acțiune în client (instalare, magazin): nu pornesc un joc
    // care să poată fi detectat, deci nu are sens să le urmărim minute întregi.
    let is_action_uri = is_uri
        && ["steam://install/", "steam://nav/", "steam://open/", "steam://store/"]
            .iter()
            .any(|prefix| exe_path.starts_with(prefix));

    // Gamescope: doar când NexusDeck pornește chiar jocul (nu și pentru steam:// / lutris:,
    // unde ar porni doar clientul în compozitor)
    if !is_uri {
        if let Some(gs_args) = gamescope_args(&game["gamescope"]) {
            if !command_exists("gamescope") {
                return Err("Gamescope este activat pentru acest joc, dar `gamescope` nu este instalat.".to_string());
            }
            let hdr = game["gamescope"]["hdr"].as_bool().unwrap_or(false);
            eprintln!("[NexusDeck] gamescope {}", gs_args.join(" "));
            cmd = wrap_with_gamescope(cmd, gs_args, hdr);
        }
    }

    // stderr merge printr-un pipe drenat continuu (altfel jocul s-ar bloca când pipe-ul se umple):
    // păstrăm coada ca să putem explica de ce a eșuat o lansare care pică imediat.
    cmd.stderr(Stdio::piped());

    let start_time = Instant::now();
    let mut child = cmd.spawn().map_err(|e| format!("Eroare la lansare: {}", e))?;
    let pid = child.id();

    let stderr_tail: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(mut err_pipe) = child.stderr.take() {
        let tail = stderr_tail.clone();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let mut chunk = [0u8; 4096];
            loop {
                match err_pipe.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        let _ = std::io::stderr().write_all(&chunk[..n]);
                        if let Ok(mut t) = tail.lock() {
                            t.extend_from_slice(&chunk[..n]);
                            if t.len() > STDERR_TAIL_BYTES {
                                let excess = t.len() - STDERR_TAIL_BYTES;
                                t.drain(..excess);
                            }
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });
    }

    let launch_gen = LAUNCH_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
    {
        let mut meta = launch_meta().lock().unwrap_or_else(|e| e.into_inner());
        meta.insert(game_id.clone(), (start_time, launch_gen));
        running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(game_id.clone(), pid);
    }

    let _ = app_handle.emit(
        "game-status-changed",
        GameStatusPayload {
            game_id: game_id.clone(),
                            status: "playing".to_string(),
                            playtime_seconds: 0,
        },
    );

    let state_arc = running.clone();
    let game_id_clone = game_id.clone();
    let handle_clone = app_handle.clone();
    let exe_path_clone = exe_path.clone();
    let wine_prefix_clone = wine_prefix.clone();

    std::thread::spawn(move || {
        let exit_status = child.wait().ok();

        // Proces care pică imediat cu cod != 0 = lansare eșuată (runner lipsă, prefix stricat,
        // legendary neautentificat etc.). O oprire manuală nu ajunge aici: kill-ul a invalidat
        // deja generația, deci `finish_launch` întoarce false.
        if let Some(status) = exit_status.as_ref() {
            if !status.success() && start_time.elapsed() < QUICK_EXIT_WINDOW {
                if launch_is_current(&game_id_clone, launch_gen) {
                    // lăsăm thread-ului de stderr un moment să citească ultimele rânduri
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    let tail = stderr_tail_text(&stderr_tail);
                    let mut message = format!("Lansarea a eșuat ({})", describe_exit(status));
                    if !tail.is_empty() {
                        message.push_str(":\n");
                        message.push_str(&tail);
                    }
                    if finish_launch(&handle_clone, &state_arc, &game_id_clone, launch_gen, 0) {
                        let _ = handle_clone.emit(
                            "game-launch-failed",
                            GameLaunchFailedPayload {
                                game_id: game_id_clone.clone(),
                                message,
                            },
                        );
                    }
                }
                return;
            }
        }

        // Instalarea unui joc Steam trece tot prin launch_game, dar nu există un joc de urmărit:
        // sesiunea se încheie imediat ce xdg-open a predat URI-ul clientului.
        if is_action_uri {
            finish_launch(&handle_clone, &state_arc, &game_id_clone, launch_gen, 0);
            return;
        }

        // Timpul de joc se măsoară de la pornirea reală a jocului, nu de la xdg-open
        let mut play_start = start_time;

        if is_uri {
            let detect_start = Instant::now();
            let mut detected_pid: Option<u32> = None;

            // Primele ~40 s scanăm des, apoi mai rar: Steam poate avea de făcut update-uri
            // sau de pornit clientul de la zero, iar scanarea /proc nu e gratuită.
            while detect_start.elapsed() < URI_DETECT_TIMEOUT {
                let waited = detect_start.elapsed();
                std::thread::sleep(std::time::Duration::from_secs(if waited.as_secs() < 40 {
                    2
                } else {
                    5
                }));

                if !launch_is_current(&game_id_clone, launch_gen) {
                    return;
                }

                let pids = find_matching_game_pids(&exe_path_clone, &wine_prefix_clone);
                if let Some(&real_pid) = pids.first() {
                    if !update_tracked_pid(&state_arc, &game_id_clone, launch_gen, real_pid, true) {
                        return;
                    }
                    detected_pid = Some(real_pid);
                    play_start = Instant::now();
                    break;
                }
            }

            let Some(first_pid) = detected_pid else {
                if finish_launch(&handle_clone, &state_arc, &game_id_clone, launch_gen, 0) {
                    let _ = handle_clone.emit(
                        "game-launch-failed",
                        GameLaunchFailedPayload {
                            game_id: game_id_clone.clone(),
                            message: "Nu am detectat pornirea jocului în 5 minute; starea de rulare a fost resetată.".to_string(),
                        },
                    );
                }
                return;
            };

            // O scanare completă citește cmdline/environ/exe/cwd pentru TOATE procesele din
            // sistem. Cât timp PID-ul urmărit trăiește, ne mulțumim să verificăm doar pe el;
            // rescanăm când dispare (ca să aflăm dacă mai există alte procese ale jocului)
            // și, ca plasă de siguranță, la fiecare 30 s.
            let mut tracked_pid = first_pid;
            let mut last_scan = Instant::now();
            // Jocurile își schimbă uneori procesul (launcher -> executabil real, update, redistribuibile):
            // sesiunea se încheie abia după 3 scanări consecutive fără niciun proces.
            let mut misses = 0u32;

            loop {
                std::thread::sleep(std::time::Duration::from_secs(2));

                if !launch_is_current(&game_id_clone, launch_gen) {
                    return;
                }

                if last_scan.elapsed() < std::time::Duration::from_secs(30) && pid_is_alive(tracked_pid) {
                    continue;
                }

                let pids = find_matching_game_pids(&exe_path_clone, &wine_prefix_clone);
                last_scan = Instant::now();
                if let Some(&active_pid) = pids.first() {
                    misses = 0;
                    tracked_pid = active_pid;
                    if !update_tracked_pid(&state_arc, &game_id_clone, launch_gen, active_pid, false) {
                        return;
                    }
                } else {
                    misses += 1;
                    if misses >= 3 {
                        break;
                    }
                }
            }
        }

        let elapsed = play_start.elapsed().as_secs();
        finish_launch(&handle_clone, &state_arc, &game_id_clone, launch_gen, elapsed);
    });
    Ok(format!("Joc lansat cu PID {}", pid))
}

fn is_rockstar_epic_game(app_name: &str, install_dir: Option<&Path>) -> bool {
    let known_rockstar_ids = [
        "Heather",                          // Red Dead Redemption 2
        "9d2d0eb64d5c44529cece33fe2a46482", // GTA V Legacy
        "0584d2013f0149a791e7b9bad0eec102", // GTA V Enhanced
    ];
    if known_rockstar_ids.iter().any(|&id| id.eq_ignore_ascii_case(app_name)) {
        return true;
    }

    if let Some(dir) = install_dir {
        if dir.join("Redistributables").join("Rockstar-Games-Launcher.exe").exists() {
            return true;
        }
    }

    false
}

fn setup_epic_launcher_in_prefix(prefix_path: &str, proton_script: &Path) -> Result<(), String> {
    let egl_exe = Path::new(prefix_path)
    .join("pfx/drive_c/Program Files (x86)/Epic Games/Launcher/Portal/Binaries/Win64/EpicGamesLauncher.exe");

    if egl_exe.exists() {
        return Ok(());
    }

    let home = std::env::var("HOME").unwrap_or_default();
    let cache_dir = Path::new(&home).join(".cache/nexusdeck");
    let _ = fs::create_dir_all(&cache_dir);
    let msi_path = cache_dir.join("EpicGamesLauncherInstaller.msi");

    // 1. Descarcă installer-ul în cache dacă nu există deja
    if !msi_path.exists() {
        let url = "https://launcher-public-service-prod06.ol.epicgames.com/launcher/api/installer/download/EpicGamesLauncherInstaller.msi";
        let status = Command::new("curl")
        .args(["-L", "-s", "-S", "-o"])
        .arg(&msi_path)
        .arg(url)
        .status()
        .map_err(|e| format!("Eroare curl la descărcarea Epic Launcher: {}", e))?;

        if !status.success() {
            return Err("Nu s-a putut descărca EpicGamesLauncherInstaller.msi".to_string());
        }
    }

    // 2. Inițializează prefixul și instalează silențios (/qn) Epic Games Launcher
    let steam_root = format!("{}/.local/share/Steam", home);
    let _ = fs::create_dir_all(prefix_path);

    let install_status = Command::new(proton_script)
    .args(["run", "msiexec", "/i"])
    .arg(&msi_path)
    .arg("/qn")
    .env("STEAM_COMPAT_DATA_PATH", prefix_path)
    .env("STEAM_COMPAT_CLIENT_INSTALL_PATH", &steam_root)
    .status()
    .map_err(|e| format!("Eroare la rularea msiexec în Proton: {}", e))?;

    if !install_status.success() {
        return Err("Instalarea silențioasă Epic Games Launcher a eșuat.".to_string());
    }

    Ok(())
}

#[tauri::command]
async fn kill_game_process(
    app_handle: AppHandle,
    game_id: String,
    state: State<'_, RunningProcesses>,
) -> Result<String, String> {
    // Rulează `kill`, citește games.json și scanează /proc: nu pe thread-ul principal.
    let running = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || kill_game_process_blocking(app_handle, game_id, running))
        .await
        .map_err(|e| e.to_string())?
}

fn kill_game_process_blocking(
    app_handle: AppHandle,
    game_id: String,
    running: Arc<Mutex<HashMap<String, u32>>>,
) -> Result<String, String> {
    // Invalidăm lansarea (monitorul se retrage singur) și scoatem PID-ul, sub același lock,
    // ca să nu apară două „stopped” sau un PID reinserat după kill.
    let (removed_pid, elapsed) = {
        let mut meta = launch_meta().lock().unwrap_or_else(|e| e.into_inner());
        let elapsed = meta
            .remove(&game_id)
            .map(|(start, _)| start.elapsed().as_secs())
            .unwrap_or(0);
        let pid = running.lock().unwrap_or_else(|e| e.into_inner()).remove(&game_id);
        (pid, elapsed)
    };

    #[allow(unused_mut)]
    let mut killed_any = removed_pid.is_some();

    #[cfg(target_os = "windows")]
    {
        if let Some(pid) = removed_pid {
            // /T oprește tot arborele de procese, nu doar launcher-ul
            let _ = Command::new("taskkill")
            .args(&["/F", "/T", "/PID", &pid.to_string()])
            .output();
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let self_pid = std::process::id();
        let children = build_children_map();
        let mut to_kill: Vec<u32> = Vec::new();

        // PID-ul urmărit poate fi învechit (xdg-open terminat, număr refolosit de alt proces):
        // îl atingem doar dacă mai există în /proc.
        if let Some(pid) = removed_pid {
            if pid > 1 && Path::new(&format!("/proc/{}", pid)).exists() {
                to_kill.extend(descendants_of(&children, pid));
                to_kill.push(pid);
            }
        }

        // Procesele care aparțin jocului după steam appid / lutris slug / prefix Wine.
        // Pentru Epic prefixul poate fi cel implicit (nesalvat în games.json): îl calculăm
        // exact ca la lansare, altfel procesele Wine/Proton rămâneau pornite.
        if let Ok(content) = fs::read_to_string(get_games_file_path()) {
            if let Ok(games) = serde_json::from_str::<Vec<Game>>(&content) {
                if let Some(g) = games.iter().find(|g| g.id == game_id) {
                    let is_epic = g.source.as_deref().map(|s| s.eq_ignore_ascii_case("epic")).unwrap_or(false)
                        || g.id.starts_with("epic_");
                    let raw_prefix = g.wine_prefix.as_deref().unwrap_or("");
                    let prefix = if is_epic {
                        epic_effective_prefix(&g.id, raw_prefix)
                    } else {
                        resolve_tilde(raw_prefix)
                    };
                    for pid in find_matching_game_pids(&g.exe_path, &prefix) {
                        to_kill.extend(descendants_of(&children, pid));
                        to_kill.push(pid);
                    }
                }
            }
        }

        to_kill.retain(|&p| p > 1 && p != self_pid);
        to_kill.sort_unstable();
        to_kill.dedup();

        if !to_kill.is_empty() {
            killed_any = true;
            let _ = Command::new("kill")
            .arg("-9")
            .args(to_kill.iter().map(|p| p.to_string()))
            .output();
        }
    }

    // Timpul jucat până la oprirea manuală se contorizează (înainte se trimitea mereu 0)
    let _ = app_handle.emit(
        "game-status-changed",
        GameStatusPayload {
            game_id,
            status: "stopped".to_string(),
                            playtime_seconds: elapsed,
        },
    );

    if killed_any {
        match removed_pid {
            Some(pid) => Ok(format!("Procesul {} a fost oprit.", pid)),
            None => Ok("Procesele jocului au fost oprite.".to_string()),
        }
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
        // Doar caractere sigure: un titlu ca ".." sau gol dădea ~/Games sau ~/Games/Prefixes
        // (folderul comun al TUTUROR prefixelor) ca prefix al jocului.
        let mut sanitized_title: String = game_title
            .trim()
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
            .collect();
        sanitized_title = sanitized_title.trim_start_matches('.').to_string();
        if sanitized_title.trim_matches('_').is_empty() {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            sanitized_title = format!("game_{}", ts);
        }
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
            // file_type() nu urmează symlink-urile: o buclă de linkuri nu mai poate bloca scanarea
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                walk_find_exes(&path, candidates);
            } else if ft.is_file()
                && path
                    .extension()
                    .map_or(false, |ext| ext.to_string_lossy().eq_ignore_ascii_case("exe"))
            {
                // `GAME.EXE` (frecvent la jocurile vechi) era ignorat
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
            let clean_title = game_title.trim().to_lowercase();

            let common_dirs = vec![
                PathBuf::from(format!("{}/.local/share/Steam/steamapps/common", home_dir)),
                PathBuf::from(format!("{}/.steam/steam/steamapps/common", home_dir)),
                PathBuf::from(format!("{}/.steam/root/steam/steamapps/common", home_dir)),
                PathBuf::from(format!("{}/.local/share/lutris/games", home_dir)),
                PathBuf::from(format!("{}/Games", home_dir)),
            ];

            'outer: for common_dir in common_dirs {
                // Titlu gol: `contains("")` e mereu adevărat și se deschidea primul folder găsit
                if clean_title.is_empty() {
                    break;
                }
                if common_dir.exists() {
                    if let Ok(entries) = fs::read_dir(&common_dir) {
                        for entry in entries.flatten() {
                            let folder_name = entry.file_name().to_string_lossy().to_lowercase();
                            // Foldere cu nume foarte scurte ("x", "ai") se potriveau cu aproape orice titlu
                            if folder_name == clean_title
                                || (clean_title.len() >= 3 && folder_name.contains(&clean_title))
                                || (folder_name.len() >= 4 && clean_title.contains(&folder_name))
                            {
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
        spawn_and_reap(Command::new("explorer").arg(&target))
        .map_err(|e| format!("Nu s-a putut deschide folderul pe Windows: {}", e))?;
    } else {
        spawn_and_reap(Command::new("xdg-open").arg(&target))
        .map_err(|e| format!("Nu s-a putut deschide folderul pe Linux: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
fn run_exe_in_prefix(exe_path: String, wine_prefix: Option<String>, runner_path: Option<String>) -> Result<(), String> {
    let runner = resolve_tilde(runner_path.unwrap_or_default().trim());
    let runner = if runner.is_empty() || runner == "native" || runner.starts_with("lutris_") || !command_exists(&runner) {
        "/usr/bin/wine".to_string()
    } else {
        runner
    };
    let mut cmd = Command::new(&runner);

    if let Some(prefix) = wine_prefix {
        let prefix = resolve_tilde(prefix.trim());
        if !prefix.is_empty() {
            // Prefixele Proton țin Wine-ul efectiv în <prefix>/pfx (ca la run_wine_tool);
            // altfel `~` neexpandat sau folderul greșit creau un prefix nou, gol
            let pfx_sub = Path::new(&prefix).join("pfx");
            let effective = if pfx_sub.join("drive_c").exists() {
                pfx_sub.to_string_lossy().to_string()
            } else {
                prefix
            };
            cmd.env("WINEPREFIX", effective);
        }
    }

    cmd.arg(resolve_tilde(exe_path.trim()));
    spawn_and_reap(&mut cmd).map_err(|e| format!("Eroare la rularea executabilului în prefix: {}", e))?;

    Ok(())
}

#[tauri::command]
fn run_wine_tool(
    tool: String,
    wine_prefix: Option<String>,
    runner_path: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = (tool, wine_prefix, runner_path);
        return Err("Wine Tools sunt disponibile doar pe Linux.".to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let raw_prefix = wine_prefix.unwrap_or_default();
        let resolved_prefix = resolve_tilde(raw_prefix.trim());

        if resolved_prefix.is_empty() {
            return Err("Jocul nu are un Wine/Proton Prefix configurat.".to_string());
        }

        // Proton ține prefixul efectiv în <prefix>/pfx, iar Wine clasic direct în <prefix>
        let pfx_sub = Path::new(&resolved_prefix).join("pfx");
        let effective_wineprefix = if pfx_sub.exists() {
            pfx_sub.to_string_lossy().to_string()
        } else {
            resolved_prefix.clone()
        };
        let _ = fs::create_dir_all(&effective_wineprefix);

        let raw_runner = runner_path.unwrap_or_default();
        let resolved_runner = resolve_tilde(raw_runner.trim());
        let is_proton = resolved_runner.contains("compatibilitytools.d")
        || resolved_runner.contains("steamapps/common/Proton")
        || resolved_runner.contains(".nexusdeck/runners");

        let proton_script = if is_proton {
            Path::new(&resolved_runner)
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .map(|root| root.join("proton"))
            .filter(|p| p.exists())
        } else {
            None
        };

        let wine_bin = if !resolved_runner.is_empty()
        && resolved_runner != "native"
        && !resolved_runner.starts_with("lutris_")
        && command_exists(&resolved_runner)
        {
            resolved_runner.clone()
        } else if command_exists("wine") {
            "wine".to_string()
        } else {
            "/usr/bin/wine".to_string()
        };

        let steam_root = format!("{}/.local/share/Steam", home);

        match tool.as_str() {
            "winetricks" => {
                if !command_exists("winetricks") {
                    return Err("Utilitarul 'winetricks' nu este instalat pe sistem.".to_string());
                }
                let mut cmd = Command::new("winetricks");
                cmd.env("WINEPREFIX", &effective_wineprefix)
                .env("WINE", &wine_bin)
                .arg("--gui");
                if is_proton {
                    cmd.env("STEAM_COMPAT_DATA_PATH", &resolved_prefix)
                    .env("STEAM_COMPAT_CLIENT_INSTALL_PATH", &steam_root);
                }
                spawn_and_reap(&mut cmd)
                .map_err(|e| format!("Nu s-a putut porni Winetricks: {}", e))?;
            }
            "bash" => {
                let terminals = [
                    ("konsole", vec!["--workdir", &effective_wineprefix]),
                    ("gnome-terminal", vec!["--working-directory", &effective_wineprefix]),
                    ("xfce4-terminal", vec!["--working-directory", &effective_wineprefix]),
                    ("kitty", vec!["--directory", &effective_wineprefix]),
                    ("alacritty", vec!["--working-directory", &effective_wineprefix]),
                    ("xterm", vec![]),
                ];

                let found = terminals
                .iter()
                .find(|(bin, _)| command_exists(bin))
                .ok_or_else(|| "Nu s-a găsit niciun emulator de terminal (konsole, gnome-terminal, kitty, alacritty, xterm).".to_string())?;

                let mut cmd = Command::new(found.0);
                cmd.args(&found.1)
                .current_dir(&effective_wineprefix)
                .env("WINEPREFIX", &effective_wineprefix)
                .env("WINE", &wine_bin);
                if is_proton {
                    cmd.env("STEAM_COMPAT_DATA_PATH", &resolved_prefix)
                    .env("STEAM_COMPAT_CLIENT_INSTALL_PATH", &steam_root);
                }
                spawn_and_reap(&mut cmd)
                .map_err(|e| format!("Nu s-a putut deschide terminalul: {}", e))?;
            }
            "taskmgr" | "control" | "regedit" | "winecfg" | "wineconsole" => {
                let mut cmd = if let Some(ref p_script) = proton_script {
                    let mut c = Command::new(p_script);
                    c.args(["run", tool.as_str()])
                    .env("STEAM_COMPAT_DATA_PATH", &resolved_prefix)
                    .env("STEAM_COMPAT_CLIENT_INSTALL_PATH", &steam_root);
                    c
                } else {
                    let mut c = Command::new(&wine_bin);
                    c.arg(tool.as_str())
                    .env("WINEPREFIX", &effective_wineprefix);
                    c
                };
                spawn_and_reap(&mut cmd)
                .map_err(|e| format!("Eroare la lansarea {}: {}", tool, e))?;
            }
            _ => return Err(format!("Tool necunoscut: {}", tool)),
        }

        Ok(())
    }
}

#[tauri::command]
fn set_fullscreen(window: tauri::Window, fullscreen: bool) {
    let _ = window.set_fullscreen(fullscreen);
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TraySettings {
    pub close_to_tray: bool,
    pub start_in_background: bool,
}

impl Default for TraySettings {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            start_in_background: false,
        }
    }
}

pub struct AppTrayState {
    pub settings: Mutex<TraySettings>,
    /// False dacă tray-ul n-a putut fi creat (ex. lipsește biblioteca appindicator):
    /// atunci nu mai ascundem fereastra la închidere, fiindcă n-ar mai putea fi redeschisă.
    pub tray_available: AtomicBool,
    /// Ultimele intrări "Quick Launch" aplicate; meniul se reconstruiește doar când se schimbă.
    pub last_quick_entries: Mutex<Vec<(String, String)>>,
}

fn get_tray_settings_path() -> PathBuf {
    get_config_dir().join("tray_settings.json")
}

fn load_tray_settings_from_disk() -> TraySettings {
    fs::read_to_string(get_tray_settings_path())
    .ok()
    .and_then(|s| serde_json::from_str(&s).ok())
    .unwrap_or_default()
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Primele 6 jocuri instalate, ordonate după timp de joc (descrescător), apoi alfabetic: (id, titlu).
fn tray_quick_launch_entries(games: &[Game]) -> Vec<(String, String)> {
    let mut installed: Vec<&Game> = games
        .iter()
        .filter(|g| {
            let exe = g.exe_path.trim();
            // Jocurile Steam dezinstalate au `steam://install/<id>`: din tray ar porni o instalare
            !g.hidden.unwrap_or(false)
                && !exe.is_empty()
                && !exe.starts_with("steam://install/")
                && g.extra.get("is_installed").and_then(|v| v.as_bool()) != Some(false)
        })
        .collect();

    // Cheia (inclusiv titlul în minuscule) se calculează o singură dată per joc,
    // nu la fiecare comparație din sortare.
    installed.sort_by_cached_key(|g| {
        (
            std::cmp::Reverse(g.playtime_minutes.unwrap_or(0)),
            g.title.to_lowercase(),
        )
    });

    installed
        .into_iter()
        .take(6)
        .map(|g| (g.id.clone(), g.title.clone()))
        .collect()
}

fn build_tray_menu_from_entries(
    app: &AppHandle,
    entries: &[(String, String)],
) -> tauri::Result<Menu<tauri::Wry>> {
    let show_item = MenuItem::with_id(app, "tray_show", "Open NexusDeck", true, None::<&str>)?;

    let quick_submenu = if entries.is_empty() {
        let empty_item = MenuItem::with_id(app, "tray_empty", "No installed games", false, None::<&str>)?;
        Submenu::with_items(app, "Quick Launch", true, &[&empty_item])?
    } else {
        let mut game_items: Vec<MenuItem<tauri::Wry>> = Vec::new();
        for (id, title) in entries {
            let item = MenuItem::with_id(
                app,
                format!("quick_launch:{}", id),
                title,
                true,
                None::<&str>,
            )?;
            game_items.push(item);
        }
        let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = game_items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();
        Submenu::with_items(app, "Quick Launch", true, &refs)?
    };

    let sep = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "tray_quit", "Quit NexusDeck", true, None::<&str>)?;

    Menu::with_items(app, &[&show_item, &quick_submenu, &sep, &quit_item])
}

/// Aplică meniul de tray doar dacă intrările s-au schimbat față de ultima aplicare
/// (save_games e apelat des, iar reconstruirea meniului e scumpă).
fn apply_tray_entries(app: &AppHandle, entries: Vec<(String, String)>) {
    let state = app.state::<AppTrayState>();
    {
        let Ok(mut last) = state.last_quick_entries.lock() else {
            return;
        };
        if *last == entries {
            return;
        }
        *last = entries.clone();
    }

    if let Some(tray) = app.tray_by_id("main-tray") {
        if let Ok(menu) = build_tray_menu_from_entries(app, &entries) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn create_tray(app: &AppHandle, games: &[Game]) -> tauri::Result<()> {
    let entries = tray_quick_launch_entries(games);
    let tray_menu = build_tray_menu_from_entries(app, &entries)?;

    let mut tray_builder = TrayIconBuilder::with_id("main-tray")
        .menu(&tray_menu)
        .tooltip("NexusDeck Game Launcher")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "tray_show" {
                show_main_window(app);
            } else if id == "tray_quit" {
                app.exit(0);
            } else if let Some(game_id) = id.strip_prefix("quick_launch:") {
                let target_id = game_id.to_string();
                let app_clone = app.clone();
                std::thread::spawn(move || {
                    let state = app_clone.state::<RunningProcesses>();

                    // Același joc nu se pornește a doua oară
                    let already_running = state
                        .0
                        .lock()
                        .map(|running| running.contains_key(&target_id))
                        .unwrap_or(false);
                    if already_running {
                        return;
                    }

                    let Ok(content) = fs::read_to_string(get_games_file_path()) else {
                        return;
                    };
                    let Ok(games) = serde_json::from_str::<Vec<Game>>(&content) else {
                        return;
                    };
                    let Some(game) = games.into_iter().find(|g| g.id == target_id) else {
                        return;
                    };
                    let Ok(game_val) = serde_json::to_value(&game) else {
                        return;
                    };

                    if let Err(e) =
                        launch_game_blocking(app_clone.clone(), game_val, state.0.clone())
                    {
                        eprintln!("Quick launch eșuat: {}", e);
                        // Din tray nu există un invoke() care să primească eroarea:
                        // o trimitem frontend-ului ca eveniment (apare ca toast).
                        let _ = app_clone.emit(
                            "game-launch-failed",
                            GameLaunchFailedPayload {
                                game_id: target_id.clone(),
                                message: e,
                            },
                        );
                    }
                });
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }

    tray_builder.build(app)?;

    if let Ok(mut last) = app.state::<AppTrayState>().last_quick_entries.lock() {
        *last = entries;
    }
    Ok(())
}

#[tauri::command]
fn get_tray_settings(state: State<'_, AppTrayState>) -> Result<TraySettings, String> {
    let guard = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(guard.clone())
}

#[tauri::command]
fn update_tray_settings(
    state: State<'_, AppTrayState>,
    close_to_tray: bool,
    start_in_background: bool,
) -> Result<(), String> {
    let new_settings = TraySettings {
        close_to_tray,
        start_in_background,
    };
    if let Ok(mut guard) = state.settings.lock() {
        *guard = new_settings.clone();
    }
    let json = serde_json::to_string_pretty(&new_settings).map_err(|e| e.to_string())?;
    fs::write(get_tray_settings_path(), json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn refresh_tray_menu(app: AppHandle, games: Vec<Game>) -> Result<(), String> {
    apply_tray_entries(&app, tray_quick_launch_entries(&games));
    Ok(())
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

    let initial_tray_settings = load_tray_settings_from_disk();

    tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        show_main_window(app);
    }))
    .manage(AppSystemStats {
        sys: Mutex::new(sys),
    })
    .manage(AppHttpClient { client })
    .manage(RunningProcesses(Arc::new(Mutex::new(HashMap::new()))))
    .manage(DownloadState {
        active_pid: Arc::new(Mutex::new(None)),
            is_paused: Arc::new(Mutex::new(false)),
            install_running: Arc::new(AtomicBool::new(false)),
            stop_requested: Arc::new(AtomicBool::new(false)),
            active_game_subdir: Arc::new(Mutex::new(None)),
    })
    .manage(AppTrayState {
        settings: Mutex::new(initial_tray_settings.clone()),
        tray_available: AtomicBool::new(true),
        last_quick_entries: Mutex::new(Vec::new()),
    })
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .setup(move |app| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_min_size(Some(Size::Logical(LogicalSize {
                width: 1380.0,
                height: 800.0,
            })));

            let start_hidden = initial_tray_settings.start_in_background
            || std::env::args().any(|a| a == "--minimized" || a == "--background");
            if start_hidden {
                let _ = window.hide();
            }
        }

        let saved_games: Vec<Game> = fs::read_to_string(get_games_file_path())
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();

        // Tray-ul e opțional: dacă nu se poate crea (de ex. lipsește appindicator), aplicația
        // pornește oricum, iar fereastra nu mai e ascunsă la închidere.
        let tray_created = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            create_tray(app.handle(), &saved_games)
        })) {
            Ok(Ok(())) => true,
            Ok(Err(e)) => {
                eprintln!("Tray indisponibil: {}", e);
                false
            }
            Err(_) => {
                eprintln!("Tray indisponibil: inițializarea a eșuat (lipsește biblioteca appindicator?).");
                false
            }
        };

        if !tray_created {
            app.state::<AppTrayState>()
                .tray_available
                .store(false, Ordering::Relaxed);
            // Fereastra a putut fi ascunsă mai sus (start în fundal): o arătăm, altfel n-ar mai exista cale de acces
            show_main_window(app.handle());
        }

        Ok(())
    })
    .on_window_event(|window, event| {
        if window.label() == "main" {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let tray_state = window.app_handle().state::<AppTrayState>();
                let keep_running = tray_state.tray_available.load(Ordering::Relaxed)
                    && tray_state
                        .settings
                        .lock()
                        .map(|s| s.close_to_tray)
                        .unwrap_or(true);

                if keep_running {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        }
    })
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
        run_wine_tool,
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
        fetch_protondb_ratings,
        resolve_steam_titles,
        open_external_url,
        get_tray_settings,
        update_tray_settings,
        refresh_tray_menu,
        fetch_available_runners,
        install_runner_release,
        delete_custom_runner,
        get_bp_device_status,
        export_game_profile,
        import_game_profile,
        check_system_dependencies,
        install_system_dependencies,
        backup::create_game_backup,
        backup::list_game_backups,
        backup::restore_game_backup,
        backup::delete_game_backup,
        backup::detect_game_save_path,
        quick_settings::get_quick_system_settings,
        quick_settings::set_system_volume,
        quick_settings::toggle_system_mute,
        quick_settings::set_screen_brightness,
        quick_settings::toggle_wifi,
        quick_settings::toggle_bluetooth,
        quick_settings::system_power_action,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsafe_delete_targets_are_refused() {
        let home = dirs::home_dir().unwrap();
        for p in ["/", "/home", "/mnt/disk", "/run/media/u/disk"] {
            assert!(is_unsafe_delete_target(Path::new(p)), "{}", p);
        }
        assert!(is_unsafe_delete_target(&home));
        assert!(is_unsafe_delete_target(&home.join("Games")));
        assert!(is_unsafe_delete_target(&home.join("Downloads")));
        assert!(is_unsafe_delete_target(&home.join("Games/Prefixes")));
        assert!(is_unsafe_delete_target(&home.join(".local/share/Steam/steamapps/common")));
        assert!(!is_unsafe_delete_target(&home.join("Games/Prefixes/Epic/Fortnite")));
        assert!(!is_unsafe_delete_target(&home.join(".local/share/Steam/steamapps/common/Portal 2")));
        assert!(!is_unsafe_delete_target(Path::new("/mnt/disk/Games/Witcher3")));
    }

    #[test]
    fn game_tolerates_missing_and_unknown_fields() {
        let g: Game = serde_json::from_str(r#"{"id":"x","title":"T","is_installed":false}"#).unwrap();
        assert_eq!(g.id, "x");
        assert!(!g.use_gamemode);
        let out = serde_json::to_value(&g).unwrap();
        assert_eq!(out["is_installed"], serde_json::json!(false));
    }

    #[test]
    fn dll_overrides_merge_with_user_entries() {
        assert_eq!(build_dll_overrides(None, false, true).as_deref(), Some("d3d12,d3d12core,dxgi=n,b"));
        assert_eq!(build_dll_overrides(None, false, false), None);
        assert_eq!(
            build_dll_overrides(Some("d3d12=b;mscoree=d"), true, true).as_deref(),
            Some("d3d9,d3d10core,d3d11,dxgi,d3d12core=n,b;d3d12=b;mscoree=d")
        );
    }

    #[test]
    fn layers_are_copied_only_over_placeholders() {
        let base = std::env::temp_dir().join(format!("nexusdeck_layers_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let src64 = base.join("src/x86_64-windows");
        let src32 = base.join("src/i386-windows");
        let sys32 = base.join("pfx/drive_c/windows/system32");
        let wow = base.join("pfx/drive_c/windows/syswow64");
        for d in [&src64, &src32, &sys32, &wow] {
            fs::create_dir_all(d).unwrap();
        }
        fs::write(src64.join("d3d12.dll"), b"vkd3d-proton 64").unwrap();
        fs::write(src64.join("d3d12core.dll"), b"vkd3d-proton core 64").unwrap();
        fs::write(src32.join("d3d12.dll"), b"vkd3d-proton 32").unwrap();
        let mut placeholder = vec![0u8; 0x40];
        placeholder.extend_from_slice(b"Wine builtin DLL");
        fs::write(sys32.join("d3d12.dll"), &placeholder).unwrap(); // substitut Wine: se înlocuiește
        fs::write(sys32.join("d3d12core.dll"), b"real dll from lutris").unwrap(); // real: rămâne

        install_layer_into_prefix(&base.join("pfx"), VKD3D_DLLS, &src64, Some(&src32));

        assert_eq!(fs::read(sys32.join("d3d12.dll")).unwrap(), b"vkd3d-proton 64");
        assert_eq!(fs::read(sys32.join("d3d12core.dll")).unwrap(), b"real dll from lutris");
        assert_eq!(fs::read(wow.join("d3d12.dll")).unwrap(), b"vkd3d-proton 32");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn gamescope_args_follow_lutris_options() {
        let off = serde_json::json!({ "enabled": false, "resolution": "1920x1080" });
        assert_eq!(gamescope_args(&off), None);
        let on = serde_json::json!({ "enabled": true, "hdr": true, "resolution": "2560x1440", "window_mode": "borderless", "fps_limit": 120 });
        assert_eq!(
            gamescope_args(&on).unwrap(),
            vec!["-w", "2560", "-h", "1440", "-b", "-r", "120", "--hdr-enabled"]
        );
        let bad = serde_json::json!({ "enabled": true, "resolution": "abc", "window_mode": "x" });
        assert_eq!(gamescope_args(&bad).unwrap(), vec!["-f"]);
    }

    #[test]
    fn gamescope_wraps_program_args_env_and_cwd() {
        let mut cmd = Command::new("wine");
        cmd.arg("C:\\game.exe").env("WINEPREFIX", "/p").current_dir("/tmp");
        let w = wrap_with_gamescope(cmd, vec!["-f".into()], false);
        assert_eq!(w.get_program(), "gamescope");
        let args: Vec<_> = w.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(args, vec!["-f", "--", "wine", "C:\\game.exe"]);
        assert!(w.get_envs().any(|(k, v)| k == "WINEPREFIX" && v.map(|v| v == "/p").unwrap_or(false)));
        assert_eq!(w.get_current_dir().map(|d| d.to_path_buf()), Some(PathBuf::from("/tmp")));
    }

    #[test]
    fn split_launch_args_keeps_windows_paths() {
        assert_eq!(
            split_launch_args(r#"-a "b c" C:\Games\x"#),
            vec!["-a", "b c", r"C:\Games\x"]
        );
    }
}
