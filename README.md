<div align="left">
  <h1>🎮 NexusDeck</h1>
  <p><strong>All your gaming in one place.</strong></p>
  <p>
    A fast, lightweight, cross-platform game launcher built with <strong>Tauri v2 (Rust)</strong> and <strong>Tailwind CSS</strong>, featuring both a sleek Desktop library and a console-style <strong>Big Picture Mode (NexusTV)</strong>.
  </p>
</div>

---

## ✨ Features

### 📚 Unified Game Library
* **Steam Integration**: Automatically detects installed and uninstalled Steam games, enriches missing titles/artwork, and displays live **ProtonDB** compatibility badges on Linux.
* **Epic Games Integration**: Full login and library sync powered by [`legendary`](https://github.com/derrod/legendary), including disk-space verification, pause/resume downloads, progress tracking, and clean uninstallation.
* **Lutris & Custom Games**: Auto-scans existing Lutris libraries, installs Windows `.exe` setups via the built-in **Installer Wizard**, or lets you add custom native/Windows executables manually.
* **Collections, Favorites & Search**: Organize games with custom tags, filter by store or status, hide titles, and track playtime automatically.
* **Support for emulators**: Play all your (legally obtained) console games all the way up to, and including, the PS3 and Xbox 360.

### 📺 Big Picture Mode (`NexusTV`)
* Fullscreen, couch-friendly interface designed for **Gamepad / Controller** and keyboard (`WASD` / Arrow keys / `Q` & `E`) navigation.
* Built-in **On-Screen Keyboard (OSK)** for searching your library directly with a controller.
* Live system status widgets (**Wi-Fi / Ethernet** signal & **Battery** level) and quick per-game launch properties.

### 🐧 Linux Compatibility & Runner Management
* **Runner Manager**: Auto-detects system Wine, Lutris Wine, and Steam Proton installations, and lets you download and manage **GE-Proton** releases directly inside NexusDeck.
* **Per-Game Tweaks**: Toggle **Feral GameMode**, **MangoHud**, **DXVK**, **Esync**, **Fsync**, **FSR Upscaling**, **BattlEye**, and **Easy Anti-Cheat**, or configure custom **DLL overrides** and **environment variables**.
* **Wine Prefix Utilities**: Launch `.exe` mods/patches inside a game's prefix or open `winetricks`, `winecfg`, `regedit`, `taskmgr`, `control`, or a terminal with one click.

### 💾 Save Backups & Shareable Profiles
* **Save Backup Manager**: Create, restore, and manage compressed save-game archives with automatic save-folder detection and pre-restore safety backups.
* **Config Profiles**: Export and import per-game configuration profiles (runner, launch arguments, and environment tweaks).

### 🎨 Customization & Built-in Updater
* **Theme engine** with preset themes, a studio for building custom themes and import/export custom theme profiles.
* **Blur effects** with toggleable Glassmorphism effects, UI scaling, and font-size controls.
* **System Tray Support**: Minimize on game launch, close to tray, or start in the background.
* **Multi-Language UI**: Full support for **English** and **Română**.
* **In-App Updater**: Automatic update checks and installation via GitHub Releases.
* *...plus a hidden 🐧 Easter Egg waiting to be discovered!*

---

## 📦 Installation

Download the latest release for your operating system from the [**Releases**](../../releases) page:

* **Linux**: `.AppImage`
* **Windows**: `.msi` or `.exe` installer

### Optional Runtime Dependencies (Linux)
For full functionality on Linux, having the following packages installed on your system is recommended:
* `legendary` — required for Epic Games library sync & downloads (`pip install legendary-gl` or via your distro's package manager)
* `wine` / `winetricks` — required for running Windows executables and Wine tools
* `gamemode` — required for per-game/global Feral GameMode optimizations
* `mangohud` — required for the in-game FPS & hardware overlay

---

## 🛠️ Building from Source

### Prerequisites
* [Rust & Cargo](https://rustup.rs/) (latest stable)
* [Node.js](https://nodejs.org/) (v18+) or Tauri CLI (`cargo install tauri-cli --version "^2.0.0"`)
* Platform-specific Tauri v2 dependencies (see the [Tauri Prerequisites Guide](https://v2.tauri.app/start/prerequisites/))

### Steps
```bash
# 1. Clone the repository
git clone [https://github.com/](https://github.com/)<your-username>/NexusDeck.git
cd NexusDeck

# 2. Run in development mode
cargo tauri dev

# 3. Build production release bundles
cargo tauri build
```

---

### 🗺️ Coming Next
* **GOG Galaxy** integration & library sync
* Additional store integrations and community refinements

---

## 📄 License
Distributed under the MIT License. See `LICENSE` for more information.
