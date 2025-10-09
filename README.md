<p align="center">
  <img src="./assets/insomnia-logo.png" alt="Mac Insomnia Logo" width="160" height="160">
</p>

<h1 align="center">💤 Mac Insomnia</h1>

<p align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT) [![Build Status](https://github.com/relbns/mac-insomnia/actions/workflows/release.yml/badge.svg?style=flat-square)](https://github.com/relbns/mac-insomnia/actions/workflows/release.yml) [![GitHub Downloads](https://img.shields.io/github/downloads/relbns/mac-insomnia/total.svg?style=flat-square)](https://github.com/relbns/mac-insomnia/releases) [![Latest Release](https://img.shields.io/github/v/release/relbns/mac-insomnia?label=latest&style=flat-square)](https://github.com/relbns/mac-insomnia/releases/latest)

</p>

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

## 👨‍💻 Author

**Ariel Benesh**
[GitHub: relbns](https://github.com/relbns)  
[Website: benesh.io](https://www.benesh.io)

---

<p align="center">
  <sub>Built with ❤️ for macOS users</sub>
</p>
