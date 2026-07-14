# Welcome to Native PDF Ink!

## What Native PDF Ink Does

Locally handwrite on PDFs with a stylus or mouse inside Obsidian. Annotations live in vault sidecars — original PDFs stay untouched. Export a separate annotated PDF when you need a portable copy.

- Pen, graphite pencil, circular eraser, and lasso tools with a compact Draw toolbar
- Draw mode opt-in so normal PDF mouse/trackpad behavior stays intact until you annotate
- Autosave, recovery, and explicit Save; commands for save, export, and select-all ink (`save-active-pdf-annotations`, `export-active-annotated-pdf`, `select-all-pdf-ink`)
- Desktop and mobile PDF adapters without telemetry or hosted services

## Setup

### Quick Start

1. Download the latest [GitHub release](https://github.com/MarsLuay/obsidian-native-pdf-ink/releases) assets (`main.js`, `manifest.json`, `styles.css`).
2. Copy them into `<Vault>/.obsidian/plugins/obsidian-native-pdf-ink/`.
3. Reload Obsidian and enable **Native PDF Ink** under **Settings → Community plugins**.
4. Open a PDF, turn on **Draw**, and annotate.

### Manual Setup

```bash
git clone https://github.com/MarsLuay/obsidian-native-pdf-ink.git
cd obsidian-native-pdf-ink
npm install
npm test
npm run build
```

Copy `manifest.json`, `main.js`, and `styles.css` into your vault plugin folder, then reload Obsidian. See `docs/manual-test-checklist.md` before trusting private PDF-view integration.

Settings includes **Copy all settings** for a local JSON snapshot. The UI is English; annotation files are language-independent.

## License

MIT — see [LICENSE](LICENSE).

## Privacy

Local-only annotation processing. See [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md). No telemetry or hosted service.
