# AliaSpaces app icon

Concept **A ("A-home")**: the AliaSpaces **A** (also a rooftop = *one home*) with a glowing
cyan **"soul" node** at its heart (a nod to *soulular*) on the hologram-blue brand tile.
Two alternates are included as SVGs: **B (orbit)** and **C (mask)**.

## Files

| File | Use |
|---|---|
| `icon.svg` | Vector master (edit here; re-export from here) |
| `icon-1024.png` | App Store / general hi-res |
| `icon-512.png` / `icon-192.png` | PWA / Android |
| `icon-maskable-512.png` + `icon-maskable.svg` | Android **maskable** (mark inset to the safe zone) |
| `icon-180.png` | Apple touch icon (iPhone) |
| `icon-167.png` / `icon-152.png` / `icon-120.png` | iPad / older iOS |
| `icon-32.png` / `icon-16.png` | Favicon PNGs |
| `favicon.ico` | Classic multi-size favicon (16/32/48) |
| `concept-b-orbit.svg` / `concept-c-mask.svg` | Alternate directions |
| `_preview/` | Contact sheet + hero (reference only — safe to delete) |

## Web wiring (paste into `index.html` `<head>`)

```html
<link rel="icon" href="/brand/app-icon/favicon.ico" sizes="any">
<link rel="icon" type="image/svg+xml" href="/brand/app-icon/icon.svg">
<link rel="apple-touch-icon" sizes="180x180" href="/brand/app-icon/icon-180.png">
```

## PWA manifest (`manifest.webmanifest`)

```json
"icons": [
  { "src": "/brand/app-icon/icon-192.png", "sizes": "192x192", "type": "image/png" },
  { "src": "/brand/app-icon/icon-512.png", "sizes": "512x512", "type": "image/png" },
  { "src": "/brand/app-icon/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
]
```

## Native apps
- **iOS:** drop `icon-1024.png` into the Xcode/Expo App Icon slot (it generates the rest).
- **Android:** use `icon-512.png` (foreground) + `icon-maskable-512.png` for the adaptive icon.

## Best-practice vs. free
- **Best practice:** the full set above (maskable + favicon + per-platform sizes), wired via the
  manifest + link tags — correct rendering everywhere, no clipping on Android.
- **Free / drop-in:** just `icon.svg` (scales anywhere) + `icon-1024.png`. Zero build; good enough
  to start. Re-export the full set from `icon.svg` any time.

## Re-export
`/outputs/export_icon.py` (this session) regenerates everything from the master SVG via cairosvg.
