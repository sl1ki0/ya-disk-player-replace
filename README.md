# ya-disk-player-overlay

A YouTube-like video player for public Yandex Disk links.  
Paste any public share URL (`disk.360.yandex.ru/i/…`) and watch it in a
full-featured, keyboard-controlled player.

## Features

| Feature | Details |
|---|---|
| **HLS streaming** | Uses hls.js for adaptive-bitrate playback |
| **Direct MP4 fallback** | Official Yandex API download URL when HLS is unavailable |
| **YouTube-like controls** | Progress bar, volume, quality selector, playback speed |
| **Full keyboard support** | Space/K · J/L · ← → · ↑ ↓ · M · F · 0-9 · Home · End |
| **CORS proxy** | Backend rewrites HLS manifests and proxies segments with Yandex headers |
| **Responsive** | Works on desktop and mobile |

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | Play / Pause |
| `J` / `←` | Seek −10 s |
| `L` / `→` | Seek +10 s |
| `Shift+←` / `Shift+→` | Seek −5 s / +5 s |
| `↑` / `↓` | Volume +5% / −5% |
| `M` | Mute / Unmute |
| `F` | Toggle fullscreen |
| `0`–`9` | Jump to 0%–90% |
| `Home` / `End` | Go to start / end |

## Getting started

```bash
npm install
npm start
# → http://localhost:3000
```

Set `PORT` environment variable to change the port.

## How it works

1. The Express backend fetches the Yandex Disk public page and tries to extract an embedded HLS manifest URL.
2. If not found in the page, it calls the internal `fetch-info` API.
3. As a final fallback it uses the official Yandex Disk public download API.
4. All upstream requests are proxied through `/api/hls-proxy` (for HLS) or `/api/proxy` (for direct files), adding the required `Origin: https://disk.360.yandex.ru` header and rewriting HLS manifest URLs.
5. The frontend uses hls.js for HLS playback and native `<video>` for direct files.

> **Note:** Only public Yandex Disk share links are supported.  
> Videos that require a Yandex account to view will not work.
