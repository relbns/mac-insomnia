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

- **With hooks (recommended).** Choose **Install Claude Code Hooks…** in the menu. This adds hooks to `~/.claude/settings.json` and saves a backup next to it (`settings.json.bak-mac-insomnia`).
  - `UserPromptSubmit` marks a session busy.
  - `Stop`, `StopFailure`, `SessionEnd` and the `idle_prompt` notification mark it idle.
  - Each hook runs `open -g "mac-insomnia://claude?state=busy|idle&pid=$PPID"` in the background, and only while Mac Insomnia is running. A prompt never waits for it, and quitting the app keeps it quit.
  - Sessions that are already open pick up the hooks after a restart.
- **Without hooks.** Mac Insomnia checks every 30 seconds for running Claude Code processes (the native `claude` binary or the npm CLI), and keeps the Mac awake while any exists. An idle session that stays open, for example in VS Code, counts as running.
- **How a session is held.** Each session is held by `caffeinate -i -s -t 10793 -w <claude pid>`. The hold ends at the first of these:
  - the session goes idle;
  - its Claude process exits;
  - 3 hours pass since the last prompt.

  The cap covers a turn that ends without an idle event. The display may still sleep. Holds left behind by a crash of Mac Insomnia are cleared on its next launch.
- **Background work.** The hold ends when Claude finishes its turn, even if it left a background command running. For long background runs, use the normal timer as well.
- **Remove Claude Code Hooks…** removes only these hooks and keeps every other hook, including one that shares a group with them.

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
