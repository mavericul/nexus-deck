# 🎮 NexusDeck

**NexusDeck** is a modern, lightweight, and high-performance game launcher tailored for **Linux** (CachyOS, Arch Linux, Steam Deck) and Windows. Built with **Tauri v2**, **Rust**, and **Tailwind CSS**, it consolidates your entire gaming library—including Steam and Epic Games, and custom Wine setups—into one fast, sleek interface.

**IMPORTANT:** As the project is still in the alpha phase, bugs, glitches and unpolished areas are to be expected.

---

## ✨ Key Features

- 🚀 **Multi-Launcher Integration**: Automatically scans and imports games from Steam and Lutris libraries.
- 🍷 **Wine & Proton Prefix Manager**: Manage Wine/Proton runners, run standalone game installers (`setup.exe`), and execute secondary binaries inside isolated Wine prefixes.
- 🎮 **Big Picture Mode**: Complete controller and gamepad support with a TV-friendly UI designed for Steam Deck and handheld gaming.
- 🎨 **Automated Artwork Fetcher**: Automatically searches and applies official Steam cover art for custom games.
- 📊 **Real-time System Monitor**: Integrated HUD tracking live CPU usage, RAM consumption, and system stats.
- ⚡ **Performance Toggles**: Native support for **GameMode** (`gamemoderun`) and **MangoHud**.
- 🖌️ **Customizable UI**: Glassmorphism visual features, UI scaling options, dynamic tags, and dark/light theme support.

---

## 🛠️ Tech Stack

- **Backend**: Rust (Tauri v2, Sysinfo, Rusqlite, Reqwest)
- **Frontend**: Vanilla JavaScript, Tailwind CSS, Lucide Icons
- **Platform Targets**: Linux / Steam Deck / Windows

---

## 🚀 Quick Start

### Prerequisites

Ensure you have Node.js and Rust installed on your system:
- [Node.js](https://nodejs.org/) (v18+)
- [Rust Toolchain](https://www.rust-lang.org/)

### Development

```bash
# Clone the repository
git clone [https://github.com/mavericul/nexus-deck.git](https://github.com/mavericul/nexus-deck.git)
cd nexus-deck

# Install dependencies
npm install

# Launch in Tauri Dev Mode
npm run tauri dev
