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
- 💻 **Lid Closed Mode** – Keep the Mac running with the lid closed (asks for an admin password)
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

## 💻 Lid Closed Mode

`caffeinate` cannot stop the sleep that happens when you close a MacBook's lid. **Keep Awake with Lid Closed** in the menu runs `pmset -a disablesleep 1` through the standard macOS administrator prompt.

- **Use it only on power, and never put the Mac in a bag or a closed space while it is on.** The Mac will not sleep and can overheat. The app warns you before every activation and notifies you if the Mac switches to battery.
- Normal sleep (`disablesleep 0`) is restored when you turn the mode off, when the timer ends and when you quit. No second password is needed: a small root watchdog started with the mode waits on a helper process that exits with the app, so a crash or a force quit restores sleep too.
- On launch the app checks `pmset -g`. If sleep is still disabled after an unclean exit (for example a reboot while the mode was on), it asks for the password to restore it. If something else disabled sleep, the menu says so and offers **Restore Normal Sleep…**.
- The mode always starts off when the app launches.

---

## 📊 Resource use

Measure any running instance with:

```bash
npm run measure -- --pid <main process pid> --minutes 30 --out result.json
```

It samples RSS and CPU time of the app and every child process, and reports the RSS growth rate and idle wakeups.

---

## 🔮 Smart Mode (Coming Soon)

Automatically keeps your Mac awake **only when pre defined apps are active**

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
