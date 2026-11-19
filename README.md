<p align="center">
  <img src="./assets/insomnia-logo.png" alt="Mac Insomnia Logo" width="160" height="160">
</p>

<h1 align="center">💤 Mac Insomnia</h1>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT) [![Build Status](https://github.com/relbns/mac-insomnia/actions/workflows/release.yml/badge.svg?style=flat-square)](https://github.com/relbns/mac-insomnia/actions/workflows/release.yml) [![GitHub Downloads](https://img.shields.io/github/downloads/relbns/mac-insomnia/total.svg?style=flat-square)](https://github.com/relbns/mac-insomnia/releases) [![Latest Release](https://img.shields.io/github/v/release/relbns/mac-insomnia?label=latest&style=flat-square)](https://github.com/relbns/mac-insomnia/releases/latest)

<p align="center">
  A minimalist macOS utility that keeps your Mac awake when you need it most.<br>
  Perfect for long rendering sessions, file uploads, or coding marathons.
</p>

---

## 🚀 Features

- 🕹️ **Menu Bar Control** – Toggle sleep prevention instantly
- ⏱️ **Set Duration** – Choose 30 min, 1 hour, 2 hours, or infinite
- 🔊 **Sound Effects** – Optional feedback for start/stop
- 🧠 **Start at Login** – Launch automatically with macOS
- 🧩 **Icon Sets** – Switch between two icon styles
- 🤖 **Smart Mode for Claude Code** – Stay awake only while Claude is working
- 💤 **Powered by `caffeinate`** – Lightweight native macOS approach
- 🔒 **Secure and Signed Build** – Uses hardened runtime and entitlements

---

## 🧩 Installation

1. Download the latest `.dmg` from the [Releases page](https://github.com/relbns/mac-insomnia/releases).
2. Drag **Mac Insomnia.app** into your **Applications** folder.
3. Launch from Spotlight or the menu bar icon.

---

## ⚙️ Development

```bash
git clone https://github.com/relbns/mac-insomnia.git
cd mac-insomnia
npm install
npm start
```

---

## 🏗️ Build for macOS

```bash
npm run build
```

The generated `.dmg` will appear in:

```
dist/
```

> 💡 To automatically publish a new release to GitHub when tagging a version, use the GitHub Action defined in `.github/workflows/release.yml`.

---

## 🤖 Smart Mode for Claude Code

**Smart Mode: Keep Awake While Claude Works** in the menu keeps the Mac awake while Claude Code is working, and lets it sleep when Claude is idle.

- **With hooks (recommended).** Choose **Install Claude Code Hooks…** in the menu. This adds `UserPromptSubmit`, `Stop` and `SessionEnd` hooks to `~/.claude/settings.json`, and saves a backup next to the file. Each hook runs `open -g "mac-insomnia://claude?state=busy|idle&pid=$PPID"` in the background, so a prompt never waits for it. The Mac stays awake from the moment you send a prompt until Claude finishes the turn.
- **Without hooks.** Mac Insomnia checks every 30 seconds for running `claude` processes, and keeps the Mac awake while any exists. An idle session that stays open (for example in VS Code) counts as running.
- Each session is held by `caffeinate -i -s -w <claude pid>`. The hold ends when the turn ends or when that Claude process exits, even if no `Stop` hook ran. The display may still sleep.
- **Remove Claude Code Hooks…** removes only these hooks and keeps every other hook.

---

## 📦 Tech Stack

- [Electron](https://www.electronjs.org/)
- [Node.js](https://nodejs.org/)
- Native macOS `caffeinate` command

---

## 🪪 License

This project is licensed under the **MIT License**.  
Feel free to use, modify, and share.

---

<p align="center">
  <sub>Built by @relbns for macOS users</sub>
</p>
