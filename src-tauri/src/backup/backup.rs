use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BackupEntry {
    pub id: String,
    pub game_id: String,
    pub filename: String,
    pub label: String, // "" (manual) sau "AUTO_PRE_RESTORE"
    pub created_at: u64,
    pub size_bytes: u64,
    pub file_count: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct BackupManifest {
    pub entries: Vec<BackupEntry>,
}

fn resolve_tilde(path_str: &str) -> PathBuf {
    let trimmed = path_str.trim();
    if trimmed.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(trimmed.replacen('~', &home, 1));
        }
    }
    PathBuf::from(trimmed)
}

fn sanitize_id(raw: &str) -> String {
    let cleaned: String = raw
    .chars()
    .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
    .collect();
    if cleaned.is_empty() {
        "unknown_game".to_string()
    } else {
        cleaned
    }
}

fn get_game_backup_dir(game_id: &str) -> Result<PathBuf, String> {
    let mut dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("nexusdeck");
    dir.push("backups");
    dir.push(sanitize_id(game_id));
    fs::create_dir_all(&dir).map_err(|e| format!("ERR_IO:{}", e))?;
    Ok(dir)
}

fn manifest_path(backup_dir: &Path) -> PathBuf {
    backup_dir.join("manifest.json")
}

fn read_manifest(backup_dir: &Path) -> BackupManifest {
    let path = manifest_path(backup_dir);
    fs::read_to_string(path)
    .ok()
    .and_then(|s| serde_json::from_str::<BackupManifest>(&s).ok())
    .unwrap_or(BackupManifest { entries: Vec::new() })
}

fn write_manifest(backup_dir: &Path, manifest: &BackupManifest) -> Result<(), String> {
    let path = manifest_path(backup_dir);
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(manifest).map_err(|e| format!("ERR_IO:{}", e))?;
    fs::write(&tmp, json).map_err(|e| format!("ERR_IO:{}", e))?;
    fs::rename(tmp, path).map_err(|e| format!("ERR_IO:{}", e))?;
    Ok(())
}

fn now_unix() -> u64 {
    SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0)
}

fn create_backup_internal(
    game_id: &str,
    save_path: &str,
    label: Option<String>,
) -> Result<BackupEntry, String> {
    let src_dir = resolve_tilde(save_path);
    if !src_dir.exists() || !src_dir.is_dir() {
        return Err("ERR_SAVE_DIR_MISSING".to_string());
    }

    let mut files_to_zip: Vec<(PathBuf, String)> = Vec::new();
    for entry in WalkDir::new(&src_dir).follow_links(false).into_iter().flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Ok(rel) = path.strip_prefix(&src_dir) {
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                if !rel_str.is_empty() {
                    files_to_zip.push((path.to_path_buf(), rel_str));
                }
            }
        }
    }

    if files_to_zip.is_empty() {
        return Err("ERR_SAVE_DIR_EMPTY".to_string());
    }

    let backup_dir = get_game_backup_dir(game_id)?;
    let ts = now_unix();
    let id = format!("bkp_{}_{}", ts, files_to_zip.len());
    let filename = format!("{}.zip", id);
    let zip_path = backup_dir.join(&filename);

    let file = File::create(&zip_path).map_err(|e| format!("ERR_IO:{}", e))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
    .compression_method(CompressionMethod::Deflated)
    .unix_permissions(0o644);

    let mut buffer = Vec::new();
    for (abs_path, rel_name) in &files_to_zip {
        zip.start_file(rel_name, options)
        .map_err(|e| format!("ERR_IO:{}", e))?;
        let mut f = File::open(abs_path).map_err(|e| format!("ERR_IO:{}", e))?;
        buffer.clear();
        f.read_to_end(&mut buffer)
        .map_err(|e| format!("ERR_IO:{}", e))?;
        zip.write_all(&buffer)
        .map_err(|e| format!("ERR_IO:{}", e))?;
    }

    zip.finish().map_err(|e| format!("ERR_IO:{}", e))?;

    let size_bytes = fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
    let entry = BackupEntry {
        id,
        game_id: game_id.to_string(),
        filename,
        label: label.unwrap_or_default().trim().to_string(),
        created_at: ts,
        size_bytes,
        file_count: files_to_zip.len(),
    };

    let mut manifest = read_manifest(&backup_dir);
    manifest.entries.insert(0, entry.clone());
    write_manifest(&backup_dir, &manifest)?;

    Ok(entry)
}

#[tauri::command]
pub async fn create_game_backup(
    game_id: String,
    save_path: String,
    label: Option<String>,
) -> Result<BackupEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_backup_internal(&game_id, &save_path, label)
    })
    .await
    .map_err(|e| format!("ERR_IO:{}", e))?
}

#[tauri::command]
pub async fn list_game_backups(game_id: String) -> Result<Vec<BackupEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let backup_dir = get_game_backup_dir(&game_id)?;
        let mut manifest = read_manifest(&backup_dir);

        // Curăță automat intrările ale căror fișiere .zip au fost șterse manual de pe disc
        let before = manifest.entries.len();
        manifest
        .entries
        .retain(|e| backup_dir.join(&e.filename).exists());
        if manifest.entries.len() != before {
            let _ = write_manifest(&backup_dir, &manifest);
        }

        manifest.entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(manifest.entries)
    })
    .await
    .map_err(|e| format!("ERR_IO:{}", e))?
}

#[tauri::command]
pub async fn restore_game_backup(
    game_id: String,
    backup_id: String,
    save_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let backup_dir = get_game_backup_dir(&game_id)?;
        let manifest = read_manifest(&backup_dir);
        let entry = manifest
        .entries
        .iter()
        .find(|e| e.id == backup_id)
        .ok_or_else(|| "ERR_BACKUP_NOT_FOUND".to_string())?;

        let zip_path = backup_dir.join(&entry.filename);
        if !zip_path.exists() {
            return Err("ERR_BACKUP_NOT_FOUND".to_string());
        }

        let target_dir = resolve_tilde(&save_path);
        fs::create_dir_all(&target_dir).map_err(|e| format!("ERR_IO:{}", e))?;

        // Snapshot automat de siguranță înainte de suprascriere (dacă există fișiere în save_path)
        let has_existing_files = fs::read_dir(&target_dir)
        .map(|mut it| it.next().is_some())
        .unwrap_or(false);
        if has_existing_files {
            let _ = create_backup_internal(
                &game_id,
                &save_path,
                Some("AUTO_PRE_RESTORE".to_string()),
            );
        }

        let file = File::open(&zip_path).map_err(|e| format!("ERR_IO:{}", e))?;
        let mut archive = ZipArchive::new(file).map_err(|e| format!("ERR_IO:{}", e))?;

        for i in 0..archive.len() {
            let mut zip_file = archive.by_index(i).map_err(|e| format!("ERR_IO:{}", e))?;
            let enclosed = zip_file
            .enclosed_name()
            .ok_or_else(|| "ERR_INVALID_ARCHIVE".to_string())?;

            // Protecție suplimentară împotriva path traversal
            if enclosed
                .components()
                .any(|c| matches!(c, Component::ParentDir))
                {
                    return Err("ERR_INVALID_ARCHIVE".to_string());
                }

                let out_path = target_dir.join(enclosed);
            if zip_file.is_dir() {
                fs::create_dir_all(&out_path).map_err(|e| format!("ERR_IO:{}", e))?;
            } else {
                if let Some(parent) = out_path.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("ERR_IO:{}", e))?;
                }
                let mut out_file = File::create(&out_path).map_err(|e| format!("ERR_IO:{}", e))?;
                std::io::copy(&mut zip_file, &mut out_file)
                .map_err(|e| format!("ERR_IO:{}", e))?;
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("ERR_IO:{}", e))?
}

#[tauri::command]
pub async fn delete_game_backup(game_id: String, backup_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let backup_dir = get_game_backup_dir(&game_id)?;
        let mut manifest = read_manifest(&backup_dir);

        if let Some(pos) = manifest.entries.iter().position(|e| e.id == backup_id) {
            let entry = manifest.entries.remove(pos);
            let zip_path = backup_dir.join(&entry.filename);
            if zip_path.exists() {
                let _ = fs::remove_file(zip_path);
            }
            write_manifest(&backup_dir, &manifest)?;
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("ERR_IO:{}", e))?
}

/// Caută automat foldere candidate de salvări în prefixul Wine/Proton sau Steam compatdata
#[tauri::command]
pub async fn detect_game_save_path(
    wine_prefix: Option<String>,
    steam_app_id: Option<String>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var("HOME").unwrap_or_default();
        let mut prefix_roots: Vec<PathBuf> = Vec::new();

        if let Some(ref raw_pfx) = wine_prefix {
            if !raw_pfx.trim().is_empty() {
                let p = resolve_tilde(raw_pfx);
                if p.join("pfx/drive_c").exists() {
                    prefix_roots.push(p.join("pfx/drive_c"));
                } else if p.join("drive_c").exists() {
                    prefix_roots.push(p.join("drive_c"));
                }
            }
        }

        // Dacă e joc Steam fără wine_prefix explicit, verificăm compatdata/<app_id>
        if prefix_roots.is_empty() {
            if let Some(ref app_id) = steam_app_id {
                if !app_id.trim().is_empty() {
                    let steam_compat = PathBuf::from(format!(
                        "{}/.local/share/Steam/steamapps/compatdata/{}/pfx/drive_c",
                        home,
                        app_id.trim()
                    ));
                    if steam_compat.exists() {
                        prefix_roots.push(steam_compat);
                    }
                }
            }
        }

        let ignored_dirs = [
            "microsoft",
            "windows",
            "internet explorer",
            "common files",
            "temp",
            "cache",
            "crashdumps",
            "nvidia",
            "amd",
            "intel",
            "epic",
            "rockstar games",
            "steam",
            "directx",
        ];

        let mut best_candidate: Option<(SystemTime, PathBuf)> = None;

        for drive_c in prefix_roots {
            let users_dir = drive_c.join("users");
            let Ok(users) = fs::read_dir(&users_dir) else {
                continue;
            };

            for user in users.flatten() {
                let uname = user.file_name().to_string_lossy().to_lowercase();
                if uname == "public" || uname == "default" {
                    continue;
                }
                let uroot = user.path();
                let search_bases = [
                    uroot.join("Documents"),
                                         uroot.join("Saved Games"),
                                         uroot.join("AppData/Local"),
                                         uroot.join("AppData/LocalLow"),
                                         uroot.join("AppData/Roaming"),
                ];

                for base in search_bases {
                    if !base.exists() {
                        continue;
                    }
                    if let Ok(entries) = fs::read_dir(&base) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            if !path.is_dir() {
                                continue;
                            }
                            let name_lower = entry.file_name().to_string_lossy().to_lowercase();
                            if name_lower.starts_with('.')
                                || ignored_dirs.iter().any(|&ig| name_lower == ig)
                                {
                                    continue;
                                }

                                // Căutăm cel mai recent fișier modificat (până la adâncime 3)
                                let latest_mod = WalkDir::new(&path)
                                .max_depth(3)
                                .into_iter()
                                .flatten()
                                .filter(|e| e.path().is_file())
                                .filter_map(|e| e.metadata().ok()?.modified().ok())
                                .max();

                                if let Some(mod_time) = latest_mod {
                                    if best_candidate
                                        .as_ref()
                                        .map_or(true, |(best_t, _)| mod_time > *best_t)
                                        {
                                            best_candidate = Some((mod_time, path));
                                        }
                                }
                        }
                    }
                }
            }
        }

        Ok(best_candidate.map(|(_, p)| p.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| format!("ERR_IO:{}", e))?
}
