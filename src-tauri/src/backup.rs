use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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

/// Manifestul e citit, modificat și rescris. Două operații simultane (de ex. dublu click pe
/// "Create Backup") s-ar suprascrie reciproc și ar lăsa zip-uri orfane, necontorizate.
/// Toate comenzile care ating manifestul iau acest lock; funcțiile `*_internal` NU îl iau
/// (restore apelează create_backup_internal cât ține deja lock-ul).
static BACKUP_LOCK: Mutex<()> = Mutex::new(());

/// Contor pentru ID-uri unice chiar și în aceeași milisecundă.
static BACKUP_SEQ: AtomicU64 = AtomicU64::new(0);

const AUTO_LABEL: &str = "AUTO_PRE_RESTORE";

/// Intrare rezervată în zip: datele de modificare originale ale fișierelor (secunde Unix).
/// Formatul ZIP le-ar pierde la restaurare, iar unele jocuri aleg "cea mai recentă salvare" după dată.
const META_ENTRY: &str = ".nexusdeck_meta.json";

/// Plafon pentru dimensiunea necomprimată a unui backup (protecție împotriva unui save_path greșit).
const MAX_BACKUP_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Foldere direct din home care nu pot fi folderul de salvări al unui singur joc.
const UNSAFE_HOME_CHILDREN: &[&str] = &[
    "documents", "downloads", "desktop", "pictures", "music", "videos", "games",
    ".local", ".config", ".cache", ".var", ".steam", ".wine",
];

/// Câte snapshot-uri automate (înainte de restore) păstrăm per joc.
const MAX_AUTO_SNAPSHOTS: usize = 5;

/// Câte fișiere inspectăm cel mult într-un folder candidat la auto-detectare.
const MAX_FILES_SCANNED: usize = 5000;

fn lock_backups() -> MutexGuard<'static, ()> {
    BACKUP_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn io_err<E: std::fmt::Display>(e: E) -> String {
    format!("ERR_IO:{}", e)
}

/// Expandează doar `~` și `~/...` (nu și `~utilizator`, care ar produce o cale greșită).
fn resolve_tilde(path_str: &str) -> PathBuf {
    let trimmed = path_str.trim();
    if trimmed == "~" || trimmed.starts_with("~/") {
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

/// Doar calculează calea (nu creează nimic pe disc).
fn game_backup_dir_path(game_id: &str) -> PathBuf {
    let mut dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("nexusdeck");
    dir.push("backups");
    dir.push(sanitize_id(game_id));
    dir
}

fn get_game_backup_dir(game_id: &str) -> Result<PathBuf, String> {
    let dir = game_backup_dir_path(game_id);
    fs::create_dir_all(&dir).map_err(io_err)?;
    Ok(dir)
}

fn manifest_path(backup_dir: &Path) -> PathBuf {
    backup_dir.join("manifest.json")
}

fn read_manifest(backup_dir: &Path) -> BackupManifest {
    let path = manifest_path(backup_dir);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        // Nu există încă (primul backup) sau nu poate fi citit: reconstruim din ce e pe disc
        Err(_) => return rebuild_manifest_from_disk(backup_dir),
    };
    match serde_json::from_str::<BackupManifest>(&raw) {
        Ok(m) => m,
        Err(_) => {
            // Înainte: manifest corupt => listă goală, iar următorul backup rescria manifestul
            // doar cu el însuși. Toate backup-urile vechi dispăreau din aplicație (zip-urile rămâneau
            // orfane). Păstrăm fișierul stricat și refacem lista din zip-uri.
            let _ = fs::copy(&path, path.with_extension(format!("json.corrupt-{}", now_unix())));
            rebuild_manifest_from_disk(backup_dir)
        }
    }
}

/// Lista de backup-uri refăcută din fișierele `bkp_*.zip` din folder (eticheta se pierde,
/// restul se recalculează din fișier).
fn rebuild_manifest_from_disk(backup_dir: &Path) -> BackupManifest {
    let mut entries = Vec::new();
    let game_id = backup_dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let Ok(dir) = fs::read_dir(backup_dir) else {
        return BackupManifest { entries };
    };
    for item in dir.flatten() {
        let filename = item.file_name().to_string_lossy().to_string();
        let Some(id) = filename.strip_suffix(".zip") else {
            continue;
        };
        if !id.starts_with("bkp_") {
            continue;
        }
        let Ok(meta) = item.metadata() else { continue };
        let file_count = File::open(item.path())
            .ok()
            .and_then(|f| ZipArchive::new(f).ok())
            .map(|a| a.file_names().filter(|n| *n != META_ENTRY).count())
            .unwrap_or(0);
        if file_count == 0 {
            continue; // zip nevalid sau gol: nu are ce restaura
        }
        let created_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        entries.push(BackupEntry {
            id: id.to_string(),
            game_id: game_id.clone(),
            filename,
            label: String::new(),
            created_at,
            size_bytes: meta.len(),
            file_count,
        });
    }
    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    BackupManifest { entries }
}

fn write_manifest(backup_dir: &Path, manifest: &BackupManifest) -> Result<(), String> {
    let path = manifest_path(backup_dir);
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(manifest).map_err(io_err)?;
    fs::write(&tmp, json).map_err(io_err)?;
    fs::rename(tmp, path).map_err(io_err)?;
    Ok(())
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// ID unic: milisecunde + contor (formatul vechi `bkp_{secunde}_{nr_fișiere}` putea coincide
/// pentru două backup-uri din aceeași secundă, iar al doilea zip îl suprascria pe primul).
fn new_backup_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = BACKUP_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("bkp_{}_{}", millis, seq)
}

/// Refuză directoare care nu pot fi folderul de salvări al unui joc: rădăcina sistemului,
/// home-ul utilizatorului sau un strămoș al lui (ex. `/home`). Un `~` sau `/` introdus din greșeală
/// ar încerca să arhiveze (sau să suprascrie) tot contul.
fn ensure_sane_save_dir(dir: &Path) -> Result<(), String> {
    let canon = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    if canon.parent().is_none() {
        return Err("ERR_SAVE_DIR_UNSAFE".to_string());
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            let home_canon = fs::canonicalize(&home).unwrap_or_else(|_| PathBuf::from(&home));
            if home_canon.starts_with(&canon) {
                return Err("ERR_SAVE_DIR_UNSAFE".to_string());
            }
            // Foldere generale din home (~/Documents, ~/.local ...): un restore ar scrie peste
            // fișiere care nu țin de joc. Folderele de joc direct în home (~/.factorio) rămân permise.
            if canon.parent() == Some(home_canon.as_path()) {
                let name = canon
                    .file_name()
                    .map(|n| n.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if UNSAFE_HOME_CHILDREN.contains(&name.as_str()) {
                    return Err("ERR_SAVE_DIR_UNSAFE".to_string());
                }
            }
        }
    }
    Ok(())
}

/// Colectează fișierele de arhivat și verifică plafonul de dimensiune.
fn collect_backup_files(src_dir: &Path) -> Result<Vec<(PathBuf, String)>, String> {
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    let mut total_bytes: u64 = 0;

    for entry in WalkDir::new(src_dir)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        // O singură interogare de metadate; urmează symlink-urile către fișiere, ca înainte
        let Ok(meta) = fs::metadata(path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let Ok(rel) = path.strip_prefix(src_dir) else {
            continue;
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if rel_str.is_empty() {
            continue;
        }

        total_bytes = total_bytes.saturating_add(meta.len());
        if total_bytes > MAX_BACKUP_BYTES {
            return Err("ERR_SAVE_DIR_TOO_LARGE".to_string());
        }
        files.push((path.to_path_buf(), rel_str));
    }

    Ok(files)
}

/// Scrie arhiva zip la `zip_path`; întoarce numărul de fișiere efectiv arhivate.
/// Fișierele sunt citite în flux (nu integral în memorie), iar cele dispărute între timp sunt omise.
fn write_zip(zip_path: &Path, files: &[(PathBuf, String)]) -> Result<usize, String> {
    let file = File::create(zip_path).map_err(io_err)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(3))
        .unix_permissions(0o644);

    let mut written: usize = 0;
    let mut mtimes: BTreeMap<String, u64> = BTreeMap::new();
    for (abs_path, rel_name) in files {
        // Deschidem ÎNAINTE de start_file: un fișier șters între timp nu lasă o intrare goală
        let Ok(source) = File::open(abs_path) else {
            continue;
        };
        if let Some(secs) = source
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
        {
            mtimes.insert(rel_name.clone(), secs);
        }
        let mut reader = BufReader::new(source);

        zip.start_file(rel_name.as_str(), options).map_err(io_err)?;
        std::io::copy(&mut reader, &mut zip).map_err(io_err)?;
        written += 1;
    }

    // Datele de modificare originale, într-o intrare rezervată (la restore le punem înapoi)
    if !mtimes.is_empty() {
        if let Ok(json) = serde_json::to_vec(&mtimes) {
            zip.start_file(META_ENTRY, options).map_err(io_err)?;
            let mut bytes: &[u8] = &json;
            std::io::copy(&mut bytes, &mut zip).map_err(io_err)?;
        }
    }

    zip.finish().map_err(io_err)?;
    Ok(written)
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
    ensure_sane_save_dir(&src_dir)?;

    let files_to_zip = collect_backup_files(&src_dir)?;
    if files_to_zip.is_empty() {
        return Err("ERR_SAVE_DIR_EMPTY".to_string());
    }

    let backup_dir = get_game_backup_dir(game_id)?;
    let ts = now_unix();

    let mut id = new_backup_id();
    while backup_dir.join(format!("{}.zip", id)).exists() {
        id = new_backup_id();
    }
    let filename = format!("{}.zip", id);
    let zip_path = backup_dir.join(&filename);

    // Scriem într-un fișier temporar și îl redenumim la final: o eroare la jumătate
    // (disc plin, fișier ilizibil) nu lasă un zip parțial, fără intrare în manifest.
    let tmp_path = backup_dir.join(format!("{}.zip.tmp", id));
    let file_count = match write_zip(&tmp_path, &files_to_zip) {
        Ok(n) => n,
        Err(e) => {
            let _ = fs::remove_file(&tmp_path);
            return Err(e);
        }
    };
    if file_count == 0 {
        let _ = fs::remove_file(&tmp_path);
        return Err("ERR_SAVE_DIR_EMPTY".to_string());
    }
    if let Err(e) = fs::rename(&tmp_path, &zip_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(io_err(e));
    }

    let size_bytes = fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
    let entry = BackupEntry {
        id,
        game_id: game_id.to_string(),
        filename,
        label: label.unwrap_or_default().trim().to_string(),
        created_at: ts,
        size_bytes,
        file_count,
    };

    let mut manifest = read_manifest(&backup_dir);
    manifest.entries.insert(0, entry.clone());
    write_manifest(&backup_dir, &manifest)?;

    Ok(entry)
}

/// Păstrează doar cele mai recente `MAX_AUTO_SNAPSHOTS` snapshot-uri automate (cele create
/// înainte de un restore); altfel s-ar acumula la nesfârșit, câte unul la fiecare restore.
fn prune_auto_snapshots(backup_dir: &Path, keep_id: Option<&str>) {
    let mut manifest = read_manifest(backup_dir);
    let mut entries = std::mem::take(&mut manifest.entries);
    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at)); // cele mai noi primele

    let mut kept_autos: usize = 0;
    let mut removed_any = false;
    let mut retained: Vec<BackupEntry> = Vec::with_capacity(entries.len());

    for entry in entries {
        // Backup-ul care tocmai se restaurează nu se șterge, chiar dacă e un snapshot automat vechi:
        // altfel restaurarea celui de-al 5-lea snapshot îl elimina din listă (și de pe disc).
        if entry.label == AUTO_LABEL && keep_id != Some(entry.id.as_str()) {
            if kept_autos >= MAX_AUTO_SNAPSHOTS {
                let _ = fs::remove_file(backup_dir.join(&entry.filename));
                removed_any = true;
                continue;
            }
            kept_autos += 1;
        }
        retained.push(entry);
    }

    manifest.entries = retained;
    if removed_any {
        let _ = write_manifest(backup_dir, &manifest);
    }
}

fn restore_backup_internal(
    game_id: &str,
    backup_id: &str,
    save_path: &str,
) -> Result<(), String> {
    let backup_dir = get_game_backup_dir(game_id)?;
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

    let target_dir = resolve_tilde(save_path);
    ensure_sane_save_dir(&target_dir)?;

    // Pasul 1: validăm TOATĂ arhiva înainte să atingem vreun fișier existent. O singură intrare
    // invalidă nu mai poate lăsa folderul de salvări restaurat pe jumătate.
    let file = File::open(&zip_path).map_err(io_err)?;
    let mut archive = ZipArchive::new(file).map_err(io_err)?;

    let mut plan: Vec<(usize, PathBuf, bool, String)> = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let zip_file = archive.by_index(i).map_err(io_err)?;
        if zip_file.name() == META_ENTRY {
            continue; // intrare internă, nu face parte din salvările jocului
        }
        let enclosed = zip_file
            .enclosed_name()
            .ok_or_else(|| "ERR_INVALID_ARCHIVE".to_string())?;

        if enclosed.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err("ERR_INVALID_ARCHIVE".to_string());
        }

        plan.push((i, target_dir.join(&enclosed), zip_file.is_dir(), zip_file.name().to_string()));
    }

    fs::create_dir_all(&target_dir).map_err(io_err)?;

    // Pasul 2: snapshot de siguranță înainte de suprascriere. Dacă NU reușim să-l facem
    // (disc plin etc.), nu mai suprascriem nimic: fără plasa de siguranță, restore-ul e riscant.
    let has_existing_files = fs::read_dir(&target_dir)
        .map(|mut it| it.next().is_some())
        .unwrap_or(false);
    if has_existing_files {
        match create_backup_internal(game_id, save_path, Some(AUTO_LABEL.to_string())) {
            Ok(_) => prune_auto_snapshots(&backup_dir, Some(backup_id)),
            // Doar foldere goale: nu există nimic de protejat
            Err(e) if e == "ERR_SAVE_DIR_EMPTY" => {}
            Err(e) => return Err(e),
        }
    }

    // Datele de modificare originale (lipsesc la backup-urile mai vechi: atunci nu se restabilește nimic)
    let mtimes: HashMap<String, u64> = match archive.by_name(META_ENTRY) {
        Ok(mut meta_file) => {
            let mut buf = Vec::new();
            match meta_file.read_to_end(&mut buf) {
                Ok(_) => serde_json::from_slice(&buf).unwrap_or_default(),
                Err(_) => HashMap::new(),
            }
        }
        Err(_) => HashMap::new(),
    };

    // Pasul 3: extragere
    for (index, out_path, is_dir, name) in plan {
        let mut zip_file = archive.by_index(index).map_err(io_err)?;
        if is_dir {
            fs::create_dir_all(&out_path).map_err(io_err)?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(io_err)?;
            }
            // Scriem lângă fișierul final și redenumim la sfârșit:
            //  - un disc plin / o eroare la jumătate nu mai lasă o salvare trunchiată (coruptă);
            //  - dacă în folder există un symlink cu același nume, rename îl înlocuiește, în loc ca
            //    File::create să-l urmeze și să suprascrie un fișier din afara folderului de salvări.
            let file_name = out_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let tmp_path = out_path.with_file_name(format!(".{}.nexusdeck-tmp", file_name));
            let write_result = (|| -> Result<(), String> {
                let mut out_file = File::create(&tmp_path).map_err(io_err)?;
                std::io::copy(&mut zip_file, &mut out_file).map_err(io_err)?;
                out_file.sync_all().map_err(io_err)?;
                // Altfel toate fișierele ar căpăta data restaurării, iar un joc care alege
                // "cea mai recentă salvare" după dată ar putea alege greșit.
                if let Some(secs) = mtimes.get(&name) {
                    let _ = out_file.set_modified(UNIX_EPOCH + Duration::from_secs(*secs));
                }
                Ok(())
            })();
            if let Err(e) = write_result.and_then(|_| fs::rename(&tmp_path, &out_path).map_err(io_err)) {
                let _ = fs::remove_file(&tmp_path);
                return Err(e);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn create_game_backup(
    game_id: String,
    save_path: String,
    label: Option<String>,
) -> Result<BackupEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_backups();
        create_backup_internal(&game_id, &save_path, label)
    })
    .await
    .map_err(io_err)?
}

#[tauri::command]
pub async fn list_game_backups(game_id: String) -> Result<Vec<BackupEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Doar listăm: nu creăm foldere goale pentru jocuri care nu au backup-uri
        let backup_dir = game_backup_dir_path(&game_id);
        if !backup_dir.exists() {
            return Ok(Vec::new());
        }

        let _guard = lock_backups();
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
    .map_err(io_err)?
}

#[tauri::command]
pub async fn restore_game_backup(
    game_id: String,
    backup_id: String,
    save_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_backups();
        restore_backup_internal(&game_id, &backup_id, &save_path)
    })
    .await
    .map_err(io_err)?
}

#[tauri::command]
pub async fn delete_game_backup(game_id: String, backup_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_backups();
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
    .map_err(io_err)?
}

/// Foldere create de Wine/Proton, de drivere sau de Windows însuși; nu sunt salvări de joc.
const IGNORED_SAVE_DIRS: &[&str] = &[
    "microsoft",
    "windows",
    "internet explorer",
    "common files",
    "temp",
    "cache",
    "crashdumps",
    "crashreports",
    "nvidia",
    "amd",
    "intel",
    "epic",
    "rockstar games",
    "steam",
    "directx",
    "wine",
    "mono",
    "gecko",
    "d3dscache",
    "mesa_shader_cache",
    "mesa_shader_cache_db",
    "dxvk-cache",
    "vkd3d-proton",
    "packages",
    "programs",
];

/// Foldere care conțin salvările MAI MULTOR jocuri: coborâm un nivel și evaluăm fiecare joc separat.
/// Altfel, "My Games" ar fi returnat ca folder de salvări, iar un restore ar suprascrie și alte jocuri.
const CONTAINER_SAVE_DIRS: &[&str] = &[
    "my games",
    "paradox interactive",
    "electronic arts",
    "ea games",
];

fn is_ignored_save_dir(name_lower: &str) -> bool {
    name_lower.starts_with('.') || IGNORED_SAVE_DIRS.contains(&name_lower)
}

/// Cel mai recent moment de modificare dintr-un folder (adâncime maximă 3, număr limitat de fișiere).
fn latest_modified(dir: &Path) -> Option<SystemTime> {
    WalkDir::new(dir)
        .max_depth(3)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .take(MAX_FILES_SCANNED)
        .filter_map(|e| e.metadata().ok()?.modified().ok())
        .max()
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

        // Joc Steam fără wine_prefix explicit: compatdata/<app_id> (instalare nativă, ~/.steam sau Flatpak)
        if prefix_roots.is_empty() {
            if let Some(ref app_id) = steam_app_id {
                let app_id = app_id.trim();
                if !app_id.is_empty() && app_id.chars().all(|c| c.is_ascii_digit()) {
                    let steam_roots = [
                        format!("{}/.local/share/Steam", home),
                        format!("{}/.steam/steam", home),
                        format!("{}/.var/app/com.valvesoftware.Steam/.local/share/Steam", home),
                    ];
                    for root in steam_roots.iter() {
                        let drive_c = PathBuf::from(root)
                            .join("steamapps/compatdata")
                            .join(app_id)
                            .join("pfx/drive_c");
                        if drive_c.exists() {
                            prefix_roots.push(drive_c);
                            break;
                        }
                    }
                }
            }
        }

        // 1) Adunăm folderele candidate
        let mut candidates: Vec<PathBuf> = Vec::new();
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

                for base in search_bases.iter() {
                    let Ok(entries) = fs::read_dir(base) else {
                        continue;
                    };
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if !path.is_dir() {
                            continue;
                        }
                        let name_lower = entry.file_name().to_string_lossy().to_lowercase();
                        if is_ignored_save_dir(&name_lower) {
                            continue;
                        }

                        if CONTAINER_SAVE_DIRS.contains(&name_lower.as_str()) {
                            if let Ok(children) = fs::read_dir(&path) {
                                for child in children.flatten() {
                                    let child_path = child.path();
                                    if !child_path.is_dir() {
                                        continue;
                                    }
                                    let child_name =
                                        child.file_name().to_string_lossy().to_lowercase();
                                    if is_ignored_save_dir(&child_name) {
                                        continue;
                                    }
                                    candidates.push(child_path);
                                }
                            }
                        } else {
                            candidates.push(path);
                        }
                    }
                }
            }
        }

        // 2) Alegem candidatul cu cea mai recentă modificare
        let mut best_candidate: Option<(SystemTime, PathBuf)> = None;
        for path in candidates {
            if let Some(mod_time) = latest_modified(&path) {
                let is_better = best_candidate
                    .as_ref()
                    .map_or(true, |(best_t, _)| mod_time > *best_t);
                if is_better {
                    best_candidate = Some((mod_time, path));
                }
            }
        }

        Ok(best_candidate.map(|(_, p)| p.to_string_lossy().to_string()))
    })
    .await
    .map_err(io_err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nexusdeck_bkp_test_{}_{}", tag, new_backup_id()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn make_zip(dir: &Path, id: &str) {
        let src = dir.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("save.dat"), b"data").unwrap();
        let files = collect_backup_files(&src).unwrap();
        write_zip(&dir.join(format!("{}.zip", id)), &files).unwrap();
    }

    #[test]
    fn corrupt_manifest_is_rebuilt_from_zips() {
        let dir = temp_dir("manifest");
        make_zip(&dir, "bkp_1_0");
        make_zip(&dir, "bkp_2_1");
        fs::write(manifest_path(&dir), b"{ not json").unwrap();
        let m = read_manifest(&dir);
        assert_eq!(m.entries.len(), 2);
        assert!(m.entries.iter().all(|e| e.file_count == 1));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_keeps_backup_being_restored() {
        let dir = temp_dir("prune");
        let mut entries = Vec::new();
        for i in 0..7u64 {
            let id = format!("bkp_{}_0", i);
            make_zip(&dir, &id);
            entries.push(BackupEntry {
                id: id.clone(),
                game_id: "g".into(),
                filename: format!("{}.zip", id),
                label: AUTO_LABEL.into(),
                created_at: i,
                size_bytes: 1,
                file_count: 1,
            });
        }
        write_manifest(&dir, &BackupManifest { entries }).unwrap();
        prune_auto_snapshots(&dir, Some("bkp_0_0")); // cel mai vechi
        let ids: Vec<String> = read_manifest(&dir).entries.into_iter().map(|e| e.id).collect();
        assert!(ids.contains(&"bkp_0_0".to_string()));
        assert_eq!(ids.len(), MAX_AUTO_SNAPSHOTS + 1);
        assert!(dir.join("bkp_0_0.zip").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(unix)]
    fn restore_roundtrip_replaces_symlink_instead_of_following_it() {
        let root = temp_dir("roundtrip");
        // Backup-urile ajung în $XDG_CONFIG_HOME/nexusdeck/backups (doar acest test îl folosește)
        std::env::set_var("XDG_CONFIG_HOME", root.join("config"));
        let saves = root.join("saves");
        fs::create_dir_all(&saves).unwrap();
        fs::write(saves.join("slot1.sav"), b"original").unwrap();

        let entry = create_backup_internal("game_rt", saves.to_str().unwrap(), None).unwrap();

        // Între timp salvarea devine un symlink spre un fișier din afara folderului
        let outside = root.join("outside.txt");
        fs::write(&outside, b"must stay intact").unwrap();
        fs::remove_file(saves.join("slot1.sav")).unwrap();
        std::os::unix::fs::symlink(&outside, saves.join("slot1.sav")).unwrap();

        restore_backup_internal("game_rt", &entry.id, saves.to_str().unwrap()).unwrap();

        assert_eq!(fs::read(saves.join("slot1.sav")).unwrap(), b"original");
        assert!(!fs::symlink_metadata(saves.join("slot1.sav")).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(&outside).unwrap(), b"must stay intact");
        // nu rămân fișiere temporare
        assert!(fs::read_dir(&saves).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().contains("nexusdeck-tmp")));
        let _ = fs::remove_dir_all(&root);
    }
}
