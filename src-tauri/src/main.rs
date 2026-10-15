// Prevents additional console window on Windows in release, do not remove!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use sysinfo::System;

#[derive(serde::Serialize)]
pub struct InstallResult {
    pub success: bool,
    pub detected_exe: Option<String>,
    pub wine_prefix: String,
    pub message: String,
}

#[tauri::command]
async fn run_game_installer(
    installer_path: String,
    game_title: String,
    runner_path: String,
) -> Result<InstallResult, String> {
    let home_dir = dirs::home_dir().ok_or("Nu s-a putut detecta directorul HOME")?;
    let sanitized_title = game_title.replace(" ", "_").replace("/", "_");
    let prefix_dir = home_dir.join("Games").join("Prefixes").join(&sanitized_title);

    if let Err(e) = fs::create_dir_all(&prefix_dir) {
        return Err(format!("Eroare la crearea directorului prefix: {}", e));
    }

    let prefix_str = prefix_dir.to_string_lossy().to_string();
    let runner = if runner_path.is_empty() { "/usr/bin/wine".to_string() } else { runner_path };

    let mut cmd = Command::new(&runner);
    cmd.env("WINEPREFIX", &prefix_str);
    cmd.arg(&installer_path);

    let status = cmd.status().map_err(|e| format!("Eroare la rularea installer-ului: {}", e))?;

    if !status.success() {
        return Ok(InstallResult {
            success: false,
            detected_exe: None,
            wine_prefix: prefix_str,
            message: "Installer-ul s-a închis cu eroare sau a fost anulat.".into(),
        });
    }

    let drive_c = prefix_dir.join("drive_c");
    let detected = scan_for_game_exe(&drive_c);

    Ok(InstallResult {
        success: true,
       detected_exe: detected.map(|p| p.to_string_lossy().to_string()),
       wine_prefix: prefix_str,
       message: "Instalare finalizată cu succes!".into(),
    })
}

fn scan_for_game_exe(drive_c: &Path) -> Option<PathBuf> {
    let program_files = vec![
        drive_c.join("Program Files"),
        drive_c.join("Program Files (x86)"),
        drive_c.join("GOG Games"),
    ];

    let mut candidates = Vec::new();

    for pf in program_files {
        if pf.exists() {
            walk_find_exes(&pf, &mut candidates);
        }
    }

    candidates.into_iter().find(|path| {
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
        !name.contains("unins")
        && !name.contains("setup")
        && !name.contains("dxsetup")
        && !name.contains("vc_redist")
        && !name.contains("crash")
    })
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

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Game {
    pub id: String,
    pub title: String,
    pub exe_path: String,
    pub runner_path: String,
    pub wine_prefix: Option<String>,
    pub launch_args: Option<String>,
    pub use_gamemode: bool,
    pub use_mangohud: bool,
    pub cover_url: Option<String>,
    pub banner_url: Option<String>,
    pub genre: Option<String>,
    pub source: Option<String>,
    pub favorite: Option<bool>,
    pub hidden: Option<bool>,
    pub tags: Option<Vec<String>>,
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

pub struct AppSystemStats {
    pub sys: Mutex<System>,
}

#[tauri::command]
fn get_system_stats(state: tauri::State<'_, AppSystemStats>) -> SystemStats {
    let mut sys = state.sys.lock().unwrap();

    sys.refresh_cpu_usage();
    sys.refresh_memory();

    let cpu_usage = sys.global_cpu_info().cpu_usage();
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

#[tauri::command]
fn scan_external_launchers() -> Vec<Game> {
    let mut games = Vec::new();
    let home = std::env::var("HOME").unwrap_or_default();

    let steam_apps = PathBuf::from(format!("{}/.steam/root/steam/steamapps", home));
    if steam_apps.exists() {
        if let Ok(entries) = fs::read_dir(&steam_apps) {
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

                        if !title.is_empty() && !app_id.is_empty() {
                            let steam_folder = if !install_dir.is_empty() {
                                Some(format!("{}/.steam/root/steam/steamapps/common/{}", home, install_dir))
                            } else {
                                Some(format!("{}/.steam/root/steam/steamapps/common/{}", home, title))
                            };

                            games.push(Game {
                                id: format!("steam_{}", app_id),
                                       title,
                                       exe_path: format!("steam://rungameid/{}", app_id),
                                       runner_path: "steam".to_string(),
                                       wine_prefix: steam_folder,
                                       launch_args: None,
                                       use_gamemode: true,
                                       use_mangohud: false,
                                       cover_url: Some(format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{}/library_600x900.jpg", app_id)),
                                       banner_url: None,
                                       genre: Some("Action".to_string()),
                                       source: Some("steam".to_string()),
                                       favorite: Some(false),
                                       hidden: Some(false),
                                       tags: Some(vec![]),
                            });
                        }
                    }
                }
            }
        }
    }

    let lutris_db = PathBuf::from(format!("{}/.local/share/lutris/pga.db", home));
    if lutris_db.exists() {
        if let Ok(conn) = rusqlite::Connection::open(lutris_db) {
            if let Ok(mut stmt) = conn.prepare("SELECT id, name, slug, runner, directory FROM games WHERE installed = 1") {
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
                        let exe_path = format!("lutris:rungame/{}", slug);

                        games.push(Game {
                            id: format!("lutris_{}", id),
                                   title: name,
                                   exe_path,
                                   runner_path: format!("lutris_{}", runner),
                                   wine_prefix: directory,
                                   launch_args: None,
                                   use_gamemode: true,
                                   use_mangohud: false,
                                   cover_url: None,
                                   banner_url: None,
                                   genre: Some("Action".to_string()),
                                   source: Some("lutris".to_string()),
                                   favorite: Some(false),
                                   hidden: Some(false),
                                   tags: Some(vec![]),
                        });
                    }
                }
            }
        }
    }

    games
}

#[tauri::command]
fn save_games(games: Vec<Game>) -> Result<(), String> {
    let file_path = get_games_file_path();
    let json = serde_json::to_string_pretty(&games).map_err(|e| e.to_string())?;
    fs::write(file_path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_saved_games() -> Vec<Game> {
    let file_path = get_games_file_path();
    if !file_path.exists() {
        return Vec::new();
    }

    if let Ok(content) = fs::read_to_string(file_path) {
        if let Ok(games) = serde_json::from_str(&content) {
            return games;
        }
    }

    Vec::new()
}

#[tauri::command]
async fn search_cover_art(title: String) -> Result<Option<String>, String> {
    let clean_title = title
    .split("v0.")
    .next().unwrap_or(&title)
    .split("v1.")
    .next().unwrap_or(&title)
    .trim();

    let url = format!(
        "https://store.steampowered.com/api/storesearch/?term={}&l=english&cc=US",
        urlencoding::encode(clean_title)
    );

    let client = reqwest::Client::new();
    if let Ok(res) = client.get(&url).send().await {
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
fn launch_game(game: Game) -> Result<String, String> {
    let mut cmd_str = String::new();

    if game.use_gamemode {
        cmd_str.push_str("gamemoderun ");
    }

    if game.use_mangohud {
        cmd_str.push_str("mangohud ");
    }

    if game.exe_path.starts_with("steam://") || game.exe_path.starts_with("lutris:") {
        cmd_str.push_str(&format!("xdg-open '{}'", game.exe_path));
    } else {
        if game.runner_path != "/usr/bin/wine" && !game.runner_path.is_empty() {
            cmd_str.push_str(&format!("'{}' ", game.runner_path));
        } else {
            cmd_str.push_str("wine ");
        }

        cmd_str.push_str(&format!("'{}'", game.exe_path));

        if let Some(args) = game.launch_args {
            if !args.is_empty() {
                cmd_str.push_str(&format!(" {}", args));
            }
        }
    }

    let mut command = Command::new("bash");
    command.arg("-c").arg(&cmd_str);

    if let Some(prefix) = game.wine_prefix {
        if !prefix.is_empty() {
            command.env("WINEPREFIX", prefix);
        }
    }

    command.spawn().map_err(|e| e.to_string())?;

    Ok(format!("Launched command: {}", cmd_str))
}

#[tauri::command]
fn open_game_folder(exe_path: String, wine_prefix: Option<String>, title: Option<String>) -> Result<(), String> {
    let home_dir = std::env::var("HOME").unwrap_or_default();
    let mut path_to_open: Option<PathBuf> = None;

    // 1. Verificam daca folderul specificat in wine_prefix (folderul jocului) exista pe disc
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

    // 2. Daca exe_path este o cale de fisier fizica reala (nu URI)
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

    // 3. Cautare inteligenta pe disc dupa titlul jocului in directoarele comune Steam/Lutris
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

    Command::new("xdg-open")
    .arg(&target)
    .spawn()
    .map_err(|e| format!("Nu s-a putut deschide folderul: {}", e))?;

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

fn main() {
    let mut sys = System::new_all();
    sys.refresh_all();

    tauri::Builder::default()
    .manage(AppSystemStats {
        sys: Mutex::new(sys),
    })
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![
        get_system_stats,
        get_available_runners,
        scan_external_launchers,
        save_games,
        load_saved_games,
        select_file_dialog,
        launch_game,
        search_cover_art,
        run_game_installer,
        open_game_folder,
        run_exe_in_prefix
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
