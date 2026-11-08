# OpenBone brand

The logo was generated with ElevenLabs (Recraft vector model) and cleaned up by hand. Every icon in the repo is built from these SVGs:

| File | Use |
| --- | --- |
| `logo.svg` | Main logo: two bones on a rounded square (README, 192/512 px web icons) |
| `logo-small.svg` | Larger bones for small sizes (favicon.svg, favicon.ico) |
| `logo-mark.svg` | Bones only, transparent (editor toolbar) |
| `logo-maskable.svg` | Full-bleed square, bones inside the safe zone (Android maskable icon, Apple touch icon) |
| `app-icon.svg` | Rounded square with the macOS icon margin (desktop app icons) |

Colours: background `#190826`, blue `#70c4fc`, amber `#fab70c`.

After changing an SVG, rebuild everything (editor favicons, PWA icons and the Tauri icon set):

```bash
pnpm icons
```
