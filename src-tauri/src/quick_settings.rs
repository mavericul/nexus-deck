use serde::Serialize;
use std::fs;
use std::path::Path;
use std::process::Command;

#[derive(Serialize, Debug, Clone)]
pub struct QuickSystemSettings {
    pub volume: u8,
    pub muted: bool,
    pub has_brightness: bool,
    pub brightness: u8,
    pub wifi_enabled: bool,
    pub wifi_ssid: String,
    pub bt_enabled: bool,
}

fn run_cmd(bin: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(bin).args(args).output().ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

fn run_cmd_ok(bin: &str, args: &[&str]) -> bool {
    Command::new(bin)
    .args(args)
    .status()
    .map(|s| s.success())
    .unwrap_or(false)
}

// ==========================================
// AUDIO HELPERS (PipeWire -> PulseAudio -> ALSA)
// ==========================================
fn get_audio_state() -> (u8, bool) {
    // 1. PipeWire (wpctl) -> output ex: "Volume: 0.75" sau "Volume: 0.75 [MUTED]"
    if let Some(out) = run_cmd("wpctl", &["get-volume", "@DEFAULT_AUDIO_SINK@"]) {
        let muted = out.contains("[MUTED]");
        if let Some(val_str) = out
            .split_whitespace()
            .find_map(|tok| tok.parse::<f32>().ok())
            {
                let pct = (val_str * 100.0).round().clamp(0.0, 100.0) as u8;
                return (pct, muted);
            }
    }

    // 2. PulseAudio / pipewire-pulse (pactl)
    if let Some(vol_out) = run_cmd("pactl", &["get-sink-volume", "@DEFAULT_SINK@"]) {
        let muted = run_cmd("pactl", &["get-sink-mute", "@DEFAULT_SINK@"])
        .map(|m| m.to_lowercase().contains("yes"))
        .unwrap_or(false);

        if let Some(pct_tok) = vol_out
            .split_whitespace()
            .find(|t| t.ends_with('%'))
            .and_then(|t| t.trim_end_matches('%').parse::<u8>().ok())
            {
                return (pct_tok.min(100), muted);
            }
    }

    // 3. ALSA fallback (amixer)
    if let Some(out) = run_cmd("amixer", &["sget", "Master"]) {
        let muted = out.contains("[off]");
        for tok in out.split_whitespace() {
            if tok.starts_with('[') && tok.ends_with("%]") {
                let inner = &tok[1..tok.len() - 2];
                if let Ok(pct) = inner.parse::<u8>() {
                    return (pct.min(100), muted);
                }
            }
        }
    }

    (75, false)
}

// ==========================================
// BRIGHTNESS HELPERS (/sys/class/backlight)
// ==========================================
fn find_backlight_dir() -> Option<std::path::PathBuf> {
    let base = Path::new("/sys/class/backlight");
    let entries = fs::read_dir(base).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.join("brightness").exists() && p.join("max_brightness").exists() {
            return Some(p);
        }
    }
    None
}

fn get_brightness_state() -> (bool, u8) {
    if let Some(dir) = find_backlight_dir() {
        let cur = fs::read_to_string(dir.join("brightness"))
        .ok()
        .and_then(|s| s.trim().parse::<f32>().ok());
        let max = fs::read_to_string(dir.join("max_brightness"))
        .ok()
        .and_then(|s| s.trim().parse::<f32>().ok());

        if let (Some(c), Some(m)) = (cur, max) {
            if m > 0.0 {
                let pct = ((c / m) * 100.0).round().clamp(1.0, 100.0) as u8;
                return (true, pct);
            }
        }
    }
    (false, 100)
}

// ==========================================
// NETWORK & BLUETOOTH HELPERS
// ==========================================
fn get_wifi_state() -> (bool, String) {
    let enabled = run_cmd("nmcli", &["radio", "wifi"])
    .map(|s| s.eq_ignore_ascii_case("enabled"))
    .unwrap_or(true);

    // Un singur apel instant (fără scanare Wi-Fi) pentru conexiunea activă
    if let Some(out) = run_cmd("nmcli", &["-t", "-f", "TYPE,STATE,CONNECTION", "dev"]) {
        for line in out.lines() {
            let mut parts = line.splitn(3, ':');
            let dev_type = parts.next().unwrap_or("");
            let state = parts.next().unwrap_or("");
            let conn = parts.next().unwrap_or("").trim();

            if dev_type == "wifi" && state == "connected" && !conn.is_empty() {
                return (true, conn.to_string());
            }
            if dev_type == "ethernet" && state == "connected" {
                return (enabled, if conn.is_empty() { "Ethernet".to_string() } else { conn.to_string() });
            }
        }
    }

    if !enabled {
        (false, "Off".to_string())
    } else {
        (true, "Disconnected".to_string())
    }
}

fn get_bluetooth_state() -> bool {
    // Citire instantă (<0.05ms) din sysfs rfkill, fără a porni bluetoothctl
    if let Ok(entries) = fs::read_dir("/sys/class/rfkill") {
        let mut found_bt = false;
        for entry in entries.flatten() {
            let p = entry.path();
            if let Ok(kind) = fs::read_to_string(p.join("type")) {
                if kind.trim() == "bluetooth" {
                    found_bt = true;
                    let soft = fs::read_to_string(p.join("soft")).unwrap_or_default();
                    let hard = fs::read_to_string(p.join("hard")).unwrap_or_default();
                    if soft.trim() == "0" && hard.trim() == "0" {
                        return true;
                    }
                }
            }
        }
        if found_bt {
            return false;
        }
    }

    // Fallback doar dacă sistemul nu expune rfkill
    if let Some(out) = run_cmd("bluetoothctl", &["show"]) {
        if let Some(line) = out.lines().find(|l| l.trim().starts_with("Powered:")) {
            return line.contains("yes");
        }
    }
    false
}

// ==========================================
// TAURI COMMANDS
// ==========================================

#[tauri::command]
pub async fn get_quick_system_settings() -> Result<QuickSystemSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "linux")]
        {
            let (volume, muted) = get_audio_state();
            let (has_brightness, brightness) = get_brightness_state();
            let (wifi_enabled, wifi_ssid) = get_wifi_state();
            let bt_enabled = get_bluetooth_state();

            Ok(QuickSystemSettings {
                volume,
                muted,
                has_brightness,
                brightness,
                wifi_enabled,
                wifi_ssid,
                bt_enabled,
            })
        }

        #[cfg(not(target_os = "linux"))]
        {
            Ok(QuickSystemSettings {
                volume: 80,
                muted: false,
                has_brightness: false,
                brightness: 100,
                wifi_enabled: true,
                wifi_ssid: "Connected".to_string(),
               bt_enabled: true,
            })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn set_system_volume(percent: u8) -> Result<(), String> {
    let clamped = percent.min(100);
    let wp_arg = format!("{}%", clamped);

    if run_cmd_ok("wpctl", &["set-volume", "@DEFAULT_AUDIO_SINK@", &wp_arg]) {
        let _ = run_cmd_ok("wpctl", &["set-mute", "@DEFAULT_AUDIO_SINK@", "0"]);
        return Ok(());
    }
    if run_cmd_ok("pactl", &["set-sink-volume", "@DEFAULT_SINK@", &wp_arg]) {
        let _ = run_cmd_ok("pactl", &["set-sink-mute", "@DEFAULT_SINK@", "0"]);
        return Ok(());
    }
    if run_cmd_ok("amixer", &["sset", "Master", &wp_arg, "unmute"]) {
        return Ok(());
    }

    Err("No supported audio mixer found (wpctl, pactl, amixer)".into())
}

#[tauri::command]
pub fn toggle_system_mute(muted: bool) -> Result<(), String> {
    let wp_flag = if muted { "1" } else { "0" };
    if run_cmd_ok("wpctl", &["set-mute", "@DEFAULT_AUDIO_SINK@", wp_flag]) {
        return Ok(());
    }

    let pa_flag = if muted { "1" } else { "0" };
    if run_cmd_ok("pactl", &["set-sink-mute", "@DEFAULT_SINK@", pa_flag]) {
        return Ok(());
    }

    let alsa_flag = if muted { "mute" } else { "unmute" };
    if run_cmd_ok("amixer", &["sset", "Master", alsa_flag]) {
        return Ok(());
    }

    Err("Failed to toggle mute".into())
}

#[tauri::command]
pub fn set_screen_brightness(percent: u8) -> Result<(), String> {
    let clamped = percent.clamp(5, 100);
    let pct_arg = format!("{}%", clamped);

    // 1. brightnessctl (standard pe SteamOS, Arch, Fedora, Ubuntu)
    if run_cmd_ok("brightnessctl", &["set", &pct_arg]) {
        return Ok(());
    }

    // 2. xbacklight (X11 fallback)
    if run_cmd_ok("xbacklight", &["-set", &clamped.to_string()]) {
        return Ok(());
    }

    // 3. Scriere directă în sysfs dacă userul este în grupul `video`
    if let Some(dir) = find_backlight_dir() {
        if let Ok(max_str) = fs::read_to_string(dir.join("max_brightness")) {
            if let Ok(max_val) = max_str.trim().parse::<f32>() {
                let target = ((clamped as f32 / 100.0) * max_val).round() as u32;
                if fs::write(dir.join("brightness"), target.to_string()).is_ok() {
                    return Ok(());
                }
            }
        }
    }

    Err("Could not set brightness (install brightnessctl or check video permissions)".into())
}

#[tauri::command]
pub fn toggle_wifi(enabled: bool) -> Result<(), String> {
    let state = if enabled { "on" } else { "off" };
    if run_cmd_ok("nmcli", &["radio", "wifi", state]) {
        return Ok(());
    }

    let rf_action = if enabled { "unblock" } else { "block" };
    if run_cmd_ok("rfkill", &[rf_action, "wifi"]) {
        return Ok(());
    }

    Err("Failed to toggle Wi-Fi (nmcli / rfkill unavailable)".into())
}

#[tauri::command]
pub fn toggle_bluetooth(enabled: bool) -> Result<(), String> {
    let rf_action = if enabled { "unblock" } else { "block" };
    let _ = run_cmd_ok("rfkill", &[rf_action, "bluetooth"]);

    let bt_power = if enabled { "on" } else { "off" };
    if run_cmd_ok("bluetoothctl", &["power", bt_power]) {
        return Ok(());
    }

    Ok(())
}

#[tauri::command]
pub fn system_power_action(action: String) -> Result<(), String> {
    let sys_arg = match action.as_str() {
        "sleep" | "suspend" => "suspend",
        "reboot" => "reboot",
        "shutdown" | "poweroff" => "poweroff",
        _ => return Err(format!("Unknown power action: {}", action)),
    };

    if run_cmd_ok("systemctl", &[sys_arg]) {
        return Ok(());
    }
    if run_cmd_ok("loginctl", &[sys_arg]) {
        return Ok(());
    }

    Err(format!("Failed to execute system power action: {}", sys_arg))
}
