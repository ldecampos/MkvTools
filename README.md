# MKV Tools

A monorepo with two desktop apps (Electron) for preparing clean MKV files for a
media library such as Jellyfin:

- **MKV Remuxer** — remux a single MKV: keep the audio/subtitle tracks you want,
  rename them with templates, fix track flags, fetch metadata from TMDB, write
  IMDb/TMDB tags, embed cover art, and optionally rip discs via MakeMKV.
- **MKV Merger** — combine the best tracks from two or more sources of the same
  title into one file, auto-picking the best video source and correcting audio
  sync (offset/drift) between sources.

Both apps share the same settings file, so you configure your preferences once
and they apply to both.

## Repository layout

```
packages/mkv-core   Shared logic (settings, naming, track planning, services…)
apps/remuxer        MKV Remuxer (Electron app)
apps/merger         MKV Merger (Electron app)
scripts             Helper scripts (vendoring external binaries)
```

## Requirements

- Node.js 20+
- pnpm 10+
- External tools (bundled in release builds, see below):
  - **mkvmerge** (MKVToolNix) — required by both apps
  - **ffmpeg** — required by the Merger for audio sync detection
  - **MakeMKV** — optional, for disc ripping in the Remuxer
  - **Tesseract** — optional, for subtitle OCR (PGS → SRT)

## Development

```bash
pnpm install            # install dependencies
pnpm vendor             # copy local mkvmerge + ffmpeg into each app's vendor/
pnpm start:remuxer      # launch MKV Remuxer
pnpm start:merger       # launch MKV Merger
pnpm test               # run the mkv-core test suite
```

`pnpm vendor` populates the (gitignored) `vendor/` folders from your locally
installed MKVToolNix and ffmpeg. Run it once after cloning and again after
updating those tools.

## Building installers

```bash
pnpm --filter mkv-remuxer build:mac     # or build:win / build:linux
pnpm --filter mkv-merger  build:mac
```

CI (`.github/workflows/build.yml`) builds signed-off installers for macOS
(arm64 + x64), Windows and Linux on every push to `main`, and publishes a
GitHub Release on `v*` tags. The external binaries are vendored automatically
during the CI build.

## License

[MIT](LICENSE) © Luis de Campos.

The bundled `mkvmerge` (MKVToolNix) and `ffmpeg` binaries are licensed under the
GPL and are invoked as separate processes; they are redistributed under their
own licenses.
