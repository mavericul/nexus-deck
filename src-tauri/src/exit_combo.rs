//! Combinația de ieșire din emulatoare: Select + Start ținute apăsat ~1,5 s închid emulatorul.
//!
//! Cât rulează jocul, fereastra emulatorului are focusul, deci interfața NexusDeck nu mai vede
//! controller-ul. Citim direct evenimentele din `/dev/input/event*` (gamepad-urile sunt accesibile
//! utilizatorului prin regula `uaccess` din systemd-logind; tastaturile, de regulă, nu).
//! Codurile BTN_SELECT / BTN_START sunt aceleași pentru Xbox, DualSense, Switch Pro etc.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const O_NONBLOCK: i32 = 0o4000;
const EV_KEY: u16 = 0x01;
const BTN_SELECT: u16 = 0x13a;
const BTN_START: u16 = 0x13b;
/// `struct input_event`: timeval (2 × long) + type (u16) + code (u16) + value (i32)
const EVENT_SIZE: usize = 2 * std::mem::size_of::<usize>() + 8;
/// Cât trebuie ținută combinația (o apăsare scurtă pe ambele butoane apare și în jocuri)
const HOLD: Duration = Duration::from_millis(1500);
const POLL: Duration = Duration::from_millis(25);
const RESCAN: Duration = Duration::from_secs(2);

struct Pad {
    file: File,
    select: bool,
    start: bool,
}

/// Urmărește controller-ele cât timp procesul `pid` există; la combinație apelează `on_combo` o dată.
pub fn watch(pid: u32, on_combo: impl FnOnce() + Send + 'static) {
    std::thread::spawn(move || {
        let proc_dir = PathBuf::from(format!("/proc/{}", pid));
        let mut pads: HashMap<PathBuf, Pad> = HashMap::new();
        let mut last_scan: Option<Instant> = None;
        let mut held_since: Option<Instant> = None;
        let mut buf = vec![0u8; EVENT_SIZE * 64];

        while proc_dir.exists() {
            if last_scan.map_or(true, |t| t.elapsed() >= RESCAN) {
                open_new_pads(&mut pads);
                last_scan = Some(Instant::now());
            }

            let mut gone = Vec::new();
            for (path, pad) in pads.iter_mut() {
                if !drain_events(pad, &mut buf) {
                    gone.push(path.clone());
                }
            }
            for path in gone {
                pads.remove(&path);
            }

            if pads.values().any(|p| p.select && p.start) {
                let since = *held_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= HOLD {
                    eprintln!("[NexusDeck] Select + Start: închid emulatorul (pid {})", pid);
                    on_combo();
                    return;
                }
            } else {
                held_since = None;
            }
            std::thread::sleep(POLL);
        }
    });
}

fn open_new_pads(pads: &mut HashMap<PathBuf, Pad>) {
    let Ok(entries) = fs::read_dir("/dev/input") else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_event = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("event"))
            .unwrap_or(false);
        if !is_event || pads.contains_key(&path) {
            continue;
        }
        // Dispozitivele fără drept de citire (tastaturi, mouse) sunt pur și simplu sărite
        if let Ok(file) = OpenOptions::new().read(true).custom_flags(O_NONBLOCK).open(&path) {
            pads.insert(path, Pad { file, select: false, start: false });
        }
    }
}

/// Citește tot ce s-a adunat de la dispozitiv. Întoarce false dacă dispozitivul a dispărut.
fn drain_events(pad: &mut Pad, buf: &mut [u8]) -> bool {
    loop {
        match pad.file.read(buf) {
            Ok(0) => return false,
            Ok(n) => {
                for ev in buf[..n].chunks_exact(EVENT_SIZE) {
                    apply_event(pad, ev);
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => return true,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return false,
        }
    }
}

fn apply_event(pad: &mut Pad, ev: &[u8]) {
    let off = EVENT_SIZE - 8;
    let ty = u16::from_ne_bytes([ev[off], ev[off + 1]]);
    let code = u16::from_ne_bytes([ev[off + 2], ev[off + 3]]);
    let value = i32::from_ne_bytes([ev[off + 4], ev[off + 5], ev[off + 6], ev[off + 7]]);
    if ty != EV_KEY {
        return;
    }
    // value: 0 = eliberat, 1 = apăsat, 2 = repetare automată
    match code {
        BTN_SELECT => pad.select = value != 0,
        BTN_START => pad.start = value != 0,
        _ => {}
    }
}

/// Procesele care nu trebuie oprite direct: învelișurile Flatpak / gamescope. Dacă primesc semnalul
/// înaintea emulatorului, acesta e omorât brusc (fără să-și salveze memory card-ul / setările).
fn is_wrapper_process(pid: u32) -> bool {
    let comm = fs::read_to_string(format!("/proc/{}/comm", pid)).unwrap_or_default();
    let comm = comm.trim();
    comm == "bwrap" || comm.starts_with("flatpak") || comm.starts_with("gamescope") || comm == "xdg-dbus-proxy"
}

/// Oprește emulatorul politicos (SIGTERM, ca la închiderea ferestrei: își salvează starea),
/// iar dacă nu iese în câteva secunde, forțat. `tree` întoarce PID-urile arborelui la momentul apelului.
pub fn stop_tree(root: u32, tree: impl Fn() -> Vec<u32>) {
    let targets: Vec<String> = tree()
        .into_iter()
        .filter(|&p| p > 1 && !is_wrapper_process(p))
        .map(|p| p.to_string())
        .collect();
    if !targets.is_empty() {
        let _ = std::process::Command::new("kill").arg("-TERM").args(&targets).output();
    }

    let root_dir = format!("/proc/{}", root);
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if !Path::new(&root_dir).exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    let rest: Vec<String> = tree().into_iter().filter(|&p| p > 1).map(|p| p.to_string()).collect();
    if !rest.is_empty() {
        eprintln!("[NexusDeck] emulatorul nu s-a închis în 8 s; îl opresc forțat");
        let _ = std::process::Command::new("kill").arg("-9").args(&rest).output();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(ty: u16, code: u16, value: i32) -> Vec<u8> {
        let mut ev = vec![0u8; EVENT_SIZE - 8];
        ev.extend_from_slice(&ty.to_ne_bytes());
        ev.extend_from_slice(&code.to_ne_bytes());
        ev.extend_from_slice(&value.to_ne_bytes());
        ev
    }

    #[test]
    fn tracks_select_and_start_state() {
        let mut pad = Pad { file: File::open("/dev/null").unwrap(), select: false, start: false };
        apply_event(&mut pad, &event(EV_KEY, BTN_SELECT, 1));
        apply_event(&mut pad, &event(EV_KEY, BTN_START, 1));
        assert!(pad.select && pad.start);
        apply_event(&mut pad, &event(EV_KEY, BTN_START, 2)); // repetare: încă apăsat
        assert!(pad.start);
        apply_event(&mut pad, &event(EV_KEY, BTN_SELECT, 0));
        assert!(!pad.select);
        // Alte tipuri de evenimente (ex. EV_ABS cu același cod) sunt ignorate
        apply_event(&mut pad, &event(0x03, BTN_START, 0));
        assert!(pad.start);
    }

    #[test]
    fn stop_tree_terminates_child_processes() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 30 & sleep 30 & wait"])
            .spawn()
            .unwrap();
        let root = child.id();
        std::thread::sleep(Duration::from_millis(200));
        let kids = || -> Vec<u32> {
            let mut out = vec![root];
            if let Ok(entries) = fs::read_dir("/proc") {
                for e in entries.flatten() {
                    let Ok(pid) = e.file_name().to_string_lossy().parse::<u32>() else { continue };
                    let stat = fs::read_to_string(format!("/proc/{}/stat", pid)).unwrap_or_default();
                    let ppid = stat.rsplit(')').next().and_then(|r| r.split_whitespace().nth(1)).and_then(|p| p.parse::<u32>().ok());
                    if ppid == Some(root) {
                        out.push(pid);
                    }
                }
            }
            out
        };
        assert!(kids().len() >= 3);
        let started = Instant::now();
        let waiter = std::thread::spawn(move || child.wait());
        stop_tree(root, kids);
        assert!(started.elapsed() < Duration::from_secs(5), "SIGTERM ar fi trebuit să ajungă");
        assert!(!waiter.join().unwrap().unwrap().success());
    }
}
