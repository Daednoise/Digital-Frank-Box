# Digital Frank Box (Electron)

Electron desktop app for the Digital Frank Box UI and scanner engine, running entirely via IPC (no local HTTP server).

## Requirements
- Node.js 18+ (20 recommended)
- npm 9+

## Quick Start (Dev)
```bash
npm install
npm run dev
```
This starts the Vite UI on `http://127.0.0.1:3000` and launches Electron pointed at it.

## Build (Packaged App)
```bash
npm run build
```
Outputs installers to `dist/` for the current OS.

## Cross‑Platform Builds
Electron packages must be built **on the target OS** (mac builds on macOS, Windows builds on Windows, Linux builds on Linux).
Use GitHub Actions CI to build for all three OSes automatically.

## Icons
Icon files live in `build/`:
- `build/icon.ico` (Windows)
- `build/icon.icns` (macOS)
- `build/icon.png` (Linux / default)

The BrowserWindow icon is also set from this folder during development.

## Recordings
Recordings are written to `app.getPath("userData")/recordings`.

## Scripts
- `npm run dev` – Vite + Electron (development)
- `npm run build` – Build renderer + package with electron-builder

## Notes
- Playwright Chromium is installed via `postinstall` and bundled for packaged builds.
- The scanner engine runs inside the Electron main process (`main/scanEngine.js`).

