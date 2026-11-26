//! Jurnalul ultimei lansări pentru fiecare joc: comanda folosită, mediul setat de NexusDeck,
//! tot ce scrie jocul / runner-ul pe stderr și felul în care s-a încheiat procesul.
//!
//! Fișierele stau în `<data>/nexusdeck/logs/<joc>.log` (pe Linux `~/.local/share/nexusdeck/logs`),
//! câte unul per joc, suprascris la fiecare lansare. La citire, datele de autentificare
//! (token-uri Epic etc.) sunt mascate, ca jurnalul să poată fi trimis cuiva fără grijă.

use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

/// Jurnalul unei lansări nu crește la nesfârșit (unele jocuri Wine scriu continuu pe stderr)
const MAX_LOG_BYTES: usize = 4 * 1024 * 1024;
/// Cât se trimite interfeței: finalul jurnalului, unde sunt de obicei erorile
const MAX_VIEW_BYTES: usize = 512 * 1024;

pub struct LaunchLog {
    inner: Mutex<Inner>,
}

struct Inner {
    path: PathBuf,
    file: Option<File>,
    written: usize,
    truncated: bool,
}

fn logs_dir() -> Option<PathBuf> {
    Some(dirs::data_dir()?.join("nexusdeck").join("logs"))
}

/// Numele fișierului: ID-ul jocului, doar cu caractere sigure
fn log_path(game_id: &str) -> Option<PathBuf> {
    let safe: String = game_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    if safe.trim_matches(['.', '_']).is_empty() {
        return None;
    }
    Some(logs_dir()?.join(format!("{}.log", safe)))
}

fn now_text() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_utc(secs)
}

/// `AAAA-LL-ZZ HH:MM:SS UTC`, fără dependențe de dată/oră (algoritmul „civil from days”)
fn format_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC",
        year, month, day, rem / 3600, (rem % 3600) / 60, rem % 60
    )
}

fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:=,+@%".contains(c)) {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

fn is_secret_key(key: &str) -> bool {
    let k = key.to_ascii_uppercase();
    ["TOKEN", "PASSWORD", "SECRET", "API_KEY", "APIKEY", "AUTH"].iter().any(|s| k.contains(s))
}

impl LaunchLog {
    /// Începe jurnalul unei lansări: antetul cu jocul, comanda, folderul de lucru și mediul setat.
    pub fn start(game_id: &str, title: &str, cmd: &Command) -> Option<LaunchLog> {
        let path = log_path(game_id)?;
        fs::create_dir_all(path.parent()?).ok()?;
        let mut file = OpenOptions::new().create(true).write(true).truncate(true).open(&path).ok()?;

        let mut header = String::new();
        header.push_str(&format!("=== NexusDeck — {} ({}) ===\n", title, game_id));
        header.push_str(&format!("Pornit: {}\n", now_text()));
        let mut command_line = vec![quote_arg(&cmd.get_program().to_string_lossy())];
        command_line.extend(cmd.get_args().map(|a| quote_arg(&a.to_string_lossy())));
        header.push_str(&format!("Comandă: {}\n", command_line.join(" ")));
        if let Some(dir) = cmd.get_current_dir() {
            header.push_str(&format!("Folder de lucru: {}\n", dir.display()));
        }
        let mut envs: Vec<String> = cmd
            .get_envs()
            .map(|(k, v)| {
                let key = k.to_string_lossy().to_string();
                match v {
                    None => format!("  -{}", key),
                    Some(_) if is_secret_key(&key) => format!("  {}=<ascuns>", key),
                    Some(val) => format!("  {}={}", key, val.to_string_lossy()),
                }
            })
            .collect();
        envs.sort();
        if !envs.is_empty() {
            header.push_str("Mediu setat de NexusDeck:\n");
            header.push_str(&envs.join("\n"));
            header.push('\n');
        }
        header.push_str("--- ieșirea jocului (stderr) ---\n");
        file.write_all(header.as_bytes()).ok()?;

        Some(LaunchLog {
            inner: Mutex::new(Inner { path, file: Some(file), written: header.len(), truncated: false }),
        })
    }

    pub fn append(&self, bytes: &[u8]) {
        let Ok(mut inner) = self.inner.lock() else { return };
        if inner.truncated {
            return;
        }
        let room = MAX_LOG_BYTES.saturating_sub(inner.written);
        let take = bytes.len().min(room);
        if let Some(f) = inner.file.as_mut() {
            let _ = f.write_all(&bytes[..take]);
        }
        inner.written += take;
        if take < bytes.len() {
            inner.truncated = true;
            if let Some(f) = inner.file.as_mut() {
                let _ = f.write_all(b"\n[... jurnal trunchiat: limita de 4 MB atinsa ...]\n");
            }
        }
    }

    /// Încheie jurnalul cu felul în care s-a terminat sesiunea și maschează datele de autentificare
    /// și în fișierul de pe disc (în timpul scrierii nu se poate: un token poate fi tăiat între bucăți).
    pub fn finish(&self, summary: &str) {
        let Ok(mut inner) = self.inner.lock() else { return };
        let Some(mut f) = inner.file.take() else { return };
        let _ = f.write_all(format!("\n=== {} ({}) ===\n", summary, now_text()).as_bytes());
        let _ = f.flush();
        drop(f);
        if let Ok(data) = fs::read(&inner.path) {
            let text = String::from_utf8_lossy(&data);
            let clean = redact(&text);
            if clean != text {
                let _ = fs::write(&inner.path, clean);
            }
        }
    }
}

/// Lansare care a eșuat înainte să pornească vreun proces (runner lipsă, fișier inexistent...)
pub fn write_failed_start(game_id: &str, title: &str, error: &str) {
    let Some(path) = log_path(game_id) else { return };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let text = format!(
        "=== NexusDeck — {} ({}) ===\nPornit: {}\n\n=== Lansarea a eșuat înainte de pornirea jocului ===\n{}\n",
        title,
        game_id,
        now_text(),
        error
    );
    let _ = fs::write(path, text);
}

/// Maschează datele de autentificare: argumentele Epic (-AUTH_PASSWORD=…, -epicusername=…),
/// token-urile OAuth și antetele Authorization. Valoarea e înlocuită până la primul spațiu / ghilimea.
pub fn redact(text: &str) -> String {
    const KEYS: &[&str] = &[
        "-auth_password=",
        "-auth_login=",
        "-epicusername=",
        "-epicuserid=",
        "-epicsandboxid=",
        "access_token",
        "refresh_token",
        "exchange_code",
        "authorization: bearer ",
        "authorization: basic ",
    ];
    let lower = text.to_ascii_lowercase();
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let hit = KEYS.iter().find(|k| lower[i..].starts_with(**k));
        let Some(key) = hit else {
            let ch = text[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        };
        out.push_str(&text[i..i + key.len()]);
        i += key.len();
        // separatori dintre cheie și valoare: `=`, `:`, ghilimele, spații (ex. "access_token": "…")
        while i < text.len() && matches!(bytes[i], b'=' | b':' | b'"' | b'\'' | b' ') {
            out.push(bytes[i] as char);
            i += 1;
        }
        let start = i;
        while i < text.len() && !matches!(bytes[i], b' ' | b'"' | b'\'' | b',' | b'&' | b'\n' | b'\r' | b'\t' | b'}') {
            i += 1;
        }
        if i > start {
            out.push_str("<ascuns>");
        }
    }
    out
}

#[derive(Serialize)]
pub struct LaunchLogView {
    pub path: String,
    pub content: String,
    /// Secunde Unix ale ultimei modificări
    pub modified: u64,
    /// Jurnalul a fost scurtat pentru afișare (se arată doar finalul)
    pub clipped: bool,
}

pub fn read(game_id: &str) -> Option<LaunchLogView> {
    let path = log_path(game_id)?;
    let data = fs::read(&path).ok()?;
    let modified = fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let clipped = data.len() > MAX_VIEW_BYTES;
    let slice = if clipped { &data[data.len() - MAX_VIEW_BYTES..] } else { &data[..] };
    Some(LaunchLogView {
        path: path.to_string_lossy().to_string(),
        content: redact(&String::from_utf8_lossy(slice)),
        modified,
        clipped,
    })
}

pub fn path_for(game_id: &str) -> Option<PathBuf> {
    log_path(game_id).filter(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_epic_credentials_and_tokens() {
        let line = r#"Game.exe -AUTH_LOGIN=unused -AUTH_PASSWORD=abc123def -epicusername="Andrei" -epicuserid=0a1b2c {"access_token": "eg1~XYZ", "x": 1} Authorization: bearer tok.en"#;
        let out = redact(line);
        assert!(!out.contains("abc123def"));
        assert!(!out.contains("Andrei"));
        assert!(!out.contains("0a1b2c"));
        assert!(!out.contains("eg1~XYZ"));
        assert!(!out.contains("tok.en"));
        assert!(out.contains("-AUTH_PASSWORD=<ascuns>"));
        assert!(out.contains(r#""x": 1"#));
        // Textul obișnuit (și cel non-ASCII) rămâne neatins
        assert_eq!(redact("err: fișier lipsă"), "err: fișier lipsă");
    }

    #[test]
    fn formats_utc_dates() {
        assert_eq!(format_utc(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(format_utc(1_795_683_331), "2026-11-26 08:55:31 UTC");
    }

    #[test]
    fn unsafe_ids_cannot_escape_the_logs_folder() {
        let p = log_path("../../etc/passwd").unwrap();
        assert_eq!(p.file_name().unwrap().to_string_lossy(), ".._.._etc_passwd.log");
        assert!(log_path("..").is_none());
    }
}
