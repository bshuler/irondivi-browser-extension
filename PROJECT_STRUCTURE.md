# IronDivi Extension - Project Structure

Created: 2026-02-16

## Overview

This document describes the complete project structure created for the IronDivi browser extension.

## Directory Structure

```
~/code/irondivi-browser-extension/
├── .github/
│   └── workflows/              # CI/CD workflows (to be created)
├── assets/
│   └── icons/                  # Extension icons
│       ├── icon-16.png        ✓ Created (blue "P" logo)
│       ├── icon-32.png        ✓ Created
│       ├── icon-48.png        ✓ Created
│       └── icon-128.png       ✓ Created
├── scripts/
│   └── build.js               ✓ Created (multi-browser build script)
├── src/
│   ├── background/            ✓ Created (service worker code)
│   ├── content/               ✓ Created (content script code)
│   ├── injected/              ✓ Created (page provider code)
│   ├── lib/                   ✓ Created (shared libraries)
│   │   ├── address.ts         ✓ Exists (from previous work)
│   │   ├── base58.ts          ✓ Exists
│   │   ├── hash.ts            ✓ Exists
│   │   ├── hdkey.ts           ✓ Exists
│   │   ├── pbkdf2.ts          ✓ Exists
│   │   └── ripemd160.ts       ✓ Exists
│   ├── popup/                 ✓ Created (popup UI code)
│   └── shared/                ✓ Created (shared utilities)
│       ├── browser-polyfill.ts ✓ Exists
│       ├── constants.ts       ✓ Exists
│       ├── crypto-utils.ts    ✓ Exists
│       └── storage.ts         ✓ Exists
├── install-site/              ✓ Created (landing page directory)
├── .gitignore                 ✓ Created
├── esbuild.config.js          ✓ Created (build configuration)
├── manifest.json              ✓ Created (Chrome MV3 manifest)
├── manifest.firefox.json      ✓ Created (Firefox-specific overrides)
├── manifest.safari.json       ✓ Created (Safari-specific overrides)
├── package.json               ✓ Created (dependencies & scripts)
├── README.md                  ✓ Created (project documentation)
├── tsconfig.json              ✓ Created (TypeScript config)
└── PROJECT_STRUCTURE.md       ✓ This file

```

## Configuration Files

### package.json
- Project name: `irondivi-browser-extension`
- Version: `1.0.0`
- Type: `module` (ES modules)
- Scripts:
  - `build` - Build for Chrome
  - `build:all` - Build for all browsers
  - `build:firefox` - Build for Firefox
  - `build:safari` - Build Safari web extension files
  - `build:safari:app` - Wrap them in the macOS app Safari needs (scripts/safari.sh)
  - `build:edge` - Build for Edge
  - `watch` - Development watch mode
  - `package` - Package builds into ZIP files
  - `package:release` - Build all + package
  - `lint` - ESLint
  - `test` - Vitest

### manifest.json (Chrome/Edge MV3)
- Manifest version: 3
- Permissions: `storage`, `alarms`, `activeTab`
- Host permissions: `https://vps1.divi.domains/*`
- Background: Service worker architecture
- Content scripts: Runs at document_start on all URLs
- Web accessible resources: `provider.js`

### manifest.firefox.json
- Browser-specific settings for Firefox
- Add-on ID: `irondivi-wallet@divi.domains`
- Minimum Firefox version: 109.0
- Background scripts configuration

### esbuild.config.js
Bundles:
- `src/background/service-worker.ts` → `dist/{browser}/background.js` (ESM)
- `src/popup/popup.ts` → `dist/{browser}/popup.js` (ESM)
- `src/content/content-script.ts` → `dist/{browser}/content-script.js` (ESM)
- `src/injected/provider.ts` → `dist/{browser}/provider.js` (IIFE)

Copies:
- `src/popup/popup.html` → `dist/{browser}/popup.html`
- `src/popup/styles.css` → `dist/{browser}/styles.css`
- `assets/icons/` → `dist/{browser}/icons/`
- Merged manifest.json for each browser

### tsconfig.json
- Target: ES2022
- Module: ESNext (bundler resolution)
- Strict mode enabled
- Source maps enabled
- Output: `dist/`

### .gitignore
Excludes:
- `node_modules/`
- `dist/`
- `packages/`
- `*.log`
- `.DS_Store`

## Build System

### Build Flow
1. `scripts/build.js` - Entry point
2. Calls `esbuild.config.js` for each target browser
3. Outputs to `dist/{browser}/`

### Browser Support
- **Chrome**: Chromium-based, MV3
- **Firefox**: Gecko, MV3 with specific overrides
- **Safari**: MV3, classic (non-module) background script, shipped inside a macOS app
- **Edge**: Chromium-based, same as Chrome

## Next Steps

To complete the extension, the following source files need to be created:

### Core Files (Required)
- [ ] `src/background/service-worker.ts` - Background service worker entry point
- [ ] `src/popup/popup.ts` - Popup UI TypeScript
- [ ] `src/popup/popup.html` - Popup HTML structure
- [ ] `src/popup/styles.css` - Popup CSS styles
- [ ] `src/content/content-script.ts` - Content script entry point
- [ ] `src/injected/provider.ts` - Injected provider (window.irondivi API)

### Supporting Files
- [ ] `scripts/package.js` - ZIP packaging script
- [ ] `.github/workflows/build.yml` - CI/CD workflow
- [ ] `install-site/index.html` - Installation landing page

### Implementation Order
1. Shared utilities (crypto, storage)
2. Background service worker (wallet state)
3. Injected provider (dApp API)
4. Content script (messaging bridge)
5. Popup UI (user interface)
6. Testing infrastructure
7. CI/CD pipeline

## Installation

```bash
cd ~/code/irondivi-browser-extension
npm install
```

## Development Workflow

```bash
# Start watch mode for Chrome
npm run watch

# In Chrome, load unpacked extension from dist/chrome/

# Make changes to src/ files
# Extension auto-rebuilds
# Reload extension in Chrome
```

## Status

- [x] Project structure created
- [x] Configuration files created
- [x] Build system configured
- [x] Icons created (placeholder)
- [x] Documentation written
- [ ] Source code implementation
- [ ] Testing setup
- [ ] CI/CD pipeline
- [ ] Production packaging

## File Counts

- Total directories: 13
- Configuration files: 6
- Icon files: 4
- Documentation files: 2
- Build scripts: 1
- Existing source files: 8 (lib + shared)
- **Ready for `npm install`**
