'use strict';

const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

/* Copy bundled hls.js into public/ so express.static serves it without a
   custom route handler (avoids rate-limit concerns on a sendFile endpoint). */
(function syncHlsBundle() {
  const src = path.join(__dirname, 'node_modules', 'hls.js', 'dist', 'hls.min.js');
  const dst = path.join(__dirname, 'public', 'hls.min.js');
  try {
    if (
      !fs.existsSync(dst) ||
      fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs
    ) {
      fs.copyFileSync(src, dst);
      console.log('[startup] hls.min.js copied to public/');
    }
  } catch (err) {
    console.warn('[startup] could not copy hls.min.js:', err.message);
  }
})();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Allowed upstream hostnames for proxy endpoints.
 * Only Yandex Disk / streaming domains are permitted to prevent SSRF.
 */
const ALLOWED_UPSTREAM_HOSTS = new Set([
  'disk.360.yandex.ru',
  'disk.yandex.ru',
  'yadi.sk',
  'downloader.disk.yandex.ru',
  'streaming.disk.yandex.net',
  'cloud-api.yandex.net',
  'strm.yandex.ru',
  'storage.yandexcloud.net',
]);

/**
 * Validate that a URL is an http/https request to an allowed Yandex domain.
 * Returns a parsed URL object on success, or null if invalid / not allowed.
 */
function validateUpstreamUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.toLowerCase();
  // Allow exact match or subdomain of an allowed host
  const allowed = [...ALLOWED_UPSTREAM_HOSTS].some(
    (h) => host === h || host.endsWith('.' + h),
  );
  return allowed ? parsed : null;
}

/** Headers that mimic a real browser visiting disk.360.yandex.ru */
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/** Headers required by the Yandex streaming CDN */
const STREAMING_HEADERS = {
  ...BROWSER_HEADERS,
  Origin: 'https://disk.360.yandex.ru',
  Referer: 'https://disk.360.yandex.ru/',
};

/**
 * Extract the public key / hash from a Yandex Disk public URL.
 * Works for:
 *   https://disk.360.yandex.ru/i/phdnku2qD3p3vw
 *   https://disk.yandex.ru/i/phdnku2qD3p3vw
 *   https://yadi.sk/i/phdnku2qD3p3vw
 */
function extractPublicKey(diskUrl) {
  try {
    return new URL(diskUrl).href; // the full URL is accepted as public_key
  } catch {
    return null;
  }
}

/**
 * Detect a Yandex Disk folder-with-file URL of the form:
 *   https://disk.yandex.ru/d/<hash>/<filepath>
 *   https://disk.360.yandex.ru/d/<hash>/<filepath>
 *
 * Returns { folderUrl, filePath } when detected, or null otherwise.
 * `filePath` starts with '/' and is already decoded (human-readable).
 */
function parseFolderFileUrl(diskUrl) {
  let parsed;
  try {
    parsed = new URL(diskUrl);
  } catch {
    return null;
  }
  // Match /d/<hash>/<rest> where <rest> is non-empty
  const m = parsed.pathname.match(/^(\/d\/[^/]+)(\/.+)$/);
  if (!m) return null;
  const folderPath = m[1];
  const filePath = decodeURIComponent(m[2]); // e.g. "/Лекция 21.mkv"
  // Guard against directory traversal
  if (filePath.includes('..')) return null;
  const folderUrl = `${parsed.protocol}//${parsed.host}${folderPath}`;
  return { folderUrl, filePath };
}

/**
 * Try to pull the `sk` CSRF token out of a Yandex Disk HTML page.
 * Yandex embeds it in several places depending on the page version.
 */
function extractSk(html) {
  const patterns = [
    /"sk"\s*:\s*"([a-f0-9]+)"/,
    /name="sk"\s+value="([a-f0-9]+)"/,
    /'sk'\s*:\s*'([a-f0-9]+)'/,
    /sk\s*=\s*"([a-f0-9]+)"/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return '';
}

/**
 * Try to extract an internal resource hash (base64) from Yandex Disk HTML.
 * The hash is used by the get-video-streams API and looks like a base64 string
 * (e.g. "j2/8t9XZVJrl6a...Dag==").  In JSON it may have escaped slashes (\/).
 */
function extractResourceHash(html) {
  const re = /"hash"\s*:\s*"([^"]{20,})"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    let hash = match[1]
      .replace(/\\\//g, '/')
      .replace(/\\u002F/gi, '/');
    // Must be valid base64 AND contain at least one of +, / or =
    // (to distinguish from hex-like tokens such as sk)
    if (/^[A-Za-z0-9+/]+=*$/.test(hash) && /[+/=]/.test(hash)) {
      return hash;
    }
  }
  return null;
}

/**
 * Decode HTML-encoded ampersands that may appear inside URLs embedded in HTML.
 * Yandex pages sometimes embed streaming URLs with `&amp;` instead of `&`.
 */
function decodeHtmlEntities(url) {
  return url.replace(/&amp;/gi, '&');
}

/**
 * Given a streaming.disk.yandex.net URL that points to a .ts segment or other
 * non-manifest resource, try to derive the master-playlist.m3u8 URL by
 * stripping the quality-specific path components and preserving query params.
 * Returns null when derivation is not possible.
 */
function deriveManifestUrl(streamingUrl) {
  try {
    const parsed = new URL(streamingUrl);
    if (parsed.pathname.includes('.m3u8')) return streamingUrl;

    // .ts / .m4s segment: .../720p/3.ts → .../master-playlist.m3u8
    const segMatch = parsed.pathname.match(
      /^(.+)\/\d{2,4}p\/[^/]+\.(?:ts|m4s)$/i,
    );
    if (segMatch) {
      parsed.pathname = segMatch[1] + '/master-playlist.m3u8';
      return parsed.toString();
    }

    // Quality-specific directory without segment: .../720p/ → .../master-playlist.m3u8
    const dirMatch = parsed.pathname.match(/^(.+)\/\d{2,4}p\/?$/i);
    if (dirMatch) {
      parsed.pathname = dirMatch[1] + '/master-playlist.m3u8';
      return parsed.toString();
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Try to find an HLS master manifest URL (.m3u8) inside raw HTML.
 * Yandex embeds streaming URLs in the serialised page state.
 * Prefers adaptive/master playlist URLs over quality-specific ones.
 */
function extractHlsFromHtml(html) {
  // Normalise common JSON escape sequences for '/' so that all URL patterns
  // work regardless of how Yandex serialised the URLs into the page.
  const normalised = html.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');

  // First pass: look specifically for the adaptive master playlist
  const masterPatterns = [
    /(https?:\/\/streaming\.disk\.yandex\.net\/[^"'\s]*master-playlist\.m3u8[^"'\s]*)/,
    /"(https?:\/\/strm\.yandex\.ru\/[^"]*master-playlist\.m3u8[^"]*)"/,
  ];
  for (const re of masterPatterns) {
    const m = normalised.match(re);
    if (m) return decodeHtmlEntities(m[1] || m[0]);
  }

  // Second pass: any .m3u8 URL (quality-specific fallback)
  const patterns = [
    /(https?:\/\/streaming\.disk\.yandex\.net\/[^"'\s]+\.m3u8[^"'\s]*)/,
    /"(https?:\/\/strm\.yandex\.ru\/[^"]+\.m3u8[^"]*)"/,
    /"contentUrl"\s*:\s*"([^"]+\.m3u8[^"]*)"/,
    /"video_url"\s*:\s*"([^"]+\.m3u8[^"]*)"/,
    /"stream_url"\s*:\s*"([^"]+\.m3u8[^"]*)"/,
  ];
  for (const re of patterns) {
    const m = normalised.match(re);
    if (m) return decodeHtmlEntities(m[1] || m[0]);
  }

  // Third pass: any streaming.disk.yandex.net/hls/ URL, including .ts segments
  // or <video>/<source> src attributes.  Derive master playlist from the path.
  const anyStreamRe =
    /(https?:\/\/streaming\.disk\.yandex\.net\/hls\/[^"'\s<>]+)/;
  const sm = normalised.match(anyStreamRe);
  if (sm) {
    const url = decodeHtmlEntities(sm[1]);
    if (url.includes('.m3u8')) return url;
    const derived = deriveManifestUrl(url);
    if (derived) return derived;
  }

  return null;
}

/**
 * From an array of video stream objects (as returned by get-video-streams),
 * return the best HLS URL: the adaptive/master-playlist entry first, falling
 * back to the first entry that has an .m3u8 URL.
 */
function findAdaptiveStream(videos) {
  if (!Array.isArray(videos)) return null;
  const adaptive = videos.find(
    (v) => v.dimension === 'adaptive' || (v.url || '').includes('master-playlist'),
  );
  const firstM3u8 = videos.find((v) => (v.url || '').includes('.m3u8'));
  return adaptive?.url || firstM3u8?.url || null;
}

/** Resolve a possibly-relative HLS line to an absolute URL */
function resolveHlsLine(line, baseUrl) {
  line = line.trim();
  if (!line) return '';
  if (/^https?:\/\//.test(line)) return line;
  if (line.startsWith('/')) {
    const base = new URL(baseUrl);
    return `${base.protocol}//${base.host}${line}`;
  }
  return baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1) + line;
}

/** Rewrite every non-comment, non-empty line in an HLS manifest to use our proxy */
function rewriteManifest(text, baseUrl) {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const absUrl = resolveHlsLine(trimmed, baseUrl);
      return `/api/hls-proxy?url=${encodeURIComponent(absUrl)}`;
    })
    .join('\n');
}

/**
 * If `url` points to a quality-specific HLS media playlist
 * (e.g. …/240p/playlist.m3u8 or …/480p/playlist.m3u8), try to fetch the
 * Yandex master playlist (…/master-playlist.m3u8) which lists all quality
 * levels. Falls back to the original URL if the master cannot be fetched
 * or does not contain #EXT-X-STREAM-INF.
 */
async function resolveMasterPlaylist(url) {
  // Pattern: anything followed by /NNN[p]/<name>.m3u8 with optional query string
  const qualityRe = /^(https?:\/\/.+\/)(\d+p?\/[^/?]+\.m3u8)(\?[^\s"']*)?$/i;
  const m = url.match(qualityRe);
  if (!m) return url;

  const queryPart = m[3] || ''; // preserve any query/auth parameters
  const masterUrl = m[1] + 'master-playlist.m3u8' + queryPart;
  console.log('[video-info] quality-specific URL detected, trying master:', masterUrl.substring(0, 120));

  try {
    const masterResp = await axios.get(masterUrl, {
      headers: STREAMING_HEADERS,
      responseType: 'text',
      timeout: 10_000,
    });
    if (typeof masterResp.data === 'string' && masterResp.data.includes('#EXT-X-STREAM-INF')) {
      const levelCount = (masterResp.data.match(/#EXT-X-STREAM-INF/g) || []).length;
      console.log(`[video-info] master playlist confirmed (${levelCount} levels), switching to master`);
      return masterUrl;
    }
    console.log('[video-info] parent URL is not a master playlist, keeping original quality URL');
  } catch (err) {
    console.warn('[video-info] master playlist probe failed:', err.response?.status, err.message, '– keeping original');
  }

  return url;
}

/**
 * Call the Yandex get-video-streams API and return the adaptive master
 * playlist URL (or null).  `currentHlsUrl` is the URL we already have
 * (if any) and is kept if get-video-streams fails.
 */
async function tryGetVideoStreams(sk, currentHlsUrl, fileHash, htmlResourceHash, folderFile, diskUrl, htmlCookies) {
  // Construct the hash expected by get-video-streams:
  // - If we got an internal hash from fetch-info, use it (+ file path for folder links)
  // - Fall back to the hash extracted from the HTML page
  // - Last resort: use the raw disk URL as the hash
  const resolvedHash = fileHash || htmlResourceHash || null;
  let gvsHash = null;
  if (resolvedHash) {
    gvsHash = folderFile ? `${resolvedHash}:${folderFile.filePath}` : resolvedHash;
  } else {
    // Some Yandex endpoints accept the full URL as the hash parameter
    gvsHash = diskUrl;
  }
  console.log('[video-info] calling get-video-streams, hash:', gvsHash.length > 60 ? gvsHash.substring(0, 60) + '…' : gvsHash);
  try {
    const gvsResp = await axios.post(
      'https://disk.yandex.ru/public/api/get-video-streams',
      { hash: gvsHash, sk },
      {
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Origin: 'https://disk.yandex.ru',
          Referer: 'https://disk.yandex.ru/',
          ...(htmlCookies ? { Cookie: htmlCookies } : {}),
        },
        timeout: 10_000,
      },
    );
    console.log('[video-info] get-video-streams status:', gvsResp.status);
    const videos = gvsResp.data?.data?.videos;
    const adaptiveUrl = findAdaptiveStream(videos);
    if (adaptiveUrl) {
      console.log('[video-info] HLS from get-video-streams:', adaptiveUrl.substring(0, 80));
      return adaptiveUrl;
    }
  } catch (err) {
    console.warn('[video-info] get-video-streams failed:', err.response?.status, err.message);
  }
  return currentHlsUrl || null;
}

/* ------------------------------------------------------------------ */
/*  Route: GET /api/video-info?url=<yandex_disk_public_url>           */
/* ------------------------------------------------------------------ */
app.get('/api/video-info', async (req, res) => {
  const diskUrl = req.query.url;
  if (!diskUrl) {
    return res.status(400).json({ error: 'url parameter is required' });
  }

  console.log('[video-info] start →', diskUrl);

  // Detect folder-with-file URLs: /d/<hash>/<filepath>
  const folderFile = parseFolderFileUrl(diskUrl);
  if (folderFile) {
    console.log('[video-info] folder-file URL detected → folder:', folderFile.folderUrl, '| path:', folderFile.filePath);
  }

  // For API calls: use the folder URL as public_key + path parameter when applicable
  const apiPublicKey = folderFile ? folderFile.folderUrl : diskUrl;
  const apiPathParam = folderFile ? `&path=${encodeURIComponent(folderFile.filePath)}` : '';

  let videoTitle = 'Видео';
  let hlsUrl = null;
  let directUrl = null;
  let htmlCookies = '';

  /* ---- Step 1: fetch the public page to look for embedded HLS URL ---- */
  try {
    console.log('[video-info] step 1: fetching page HTML');
    const pageResp = await axios.get(diskUrl, {
      headers: BROWSER_HEADERS,
      maxRedirects: 5,
      timeout: 15_000,
    });
    console.log('[video-info] page status:', pageResp.status, '| html bytes:', pageResp.data?.length);
    const html = pageResp.data;

    // Collect cookies for subsequent API calls
    const setCookie = pageResp.headers['set-cookie'];
    if (Array.isArray(setCookie)) {
      htmlCookies = setCookie.map((c) => c.split(';')[0]).join('; ');
    }

    // Page title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      videoTitle = titleMatch[1]
        .replace(/\s*[–—-]\s*Яндекс\.?Диск\s*$/i, '')
        .replace(/\s*[–—-]\s*Yandex Disk\s*$/i, '')
        .trim();
      console.log('[video-info] page title:', videoTitle);
    }

    hlsUrl = extractHlsFromHtml(html);
    console.log('[video-info] HLS from page HTML:', hlsUrl ? hlsUrl.substring(0, 80) : 'not found');

    // Try to extract the internal resource hash from the page HTML
    // (used as a fallback for get-video-streams when fetch-info does not return it)
    const htmlResourceHash = extractResourceHash(html);
    if (htmlResourceHash) console.log('[video-info] resource hash from HTML:', htmlResourceHash.length > 40 ? htmlResourceHash.substring(0, 40) + '…' : htmlResourceHash);

    // Always extract sk – it is needed for get-video-streams even when
    // a quality-specific HLS URL was already found in the HTML.
    const sk = extractSk(html);

    if (!hlsUrl) {
      /* ---- Step 2: try the internal fetch-info API with sk token ---- */
      console.log('[video-info] step 2: calling fetch-info API, sk:', sk ? sk.substring(0, 8) + '…' : '(none)');
      // For folder-file URLs use just the folder URL as hash + a path parameter;
      // also call the API on the same domain as the original URL.
      const fetchInfoHash = folderFile ? folderFile.folderUrl : diskUrl;
      const fetchInfoPath = folderFile ? `&path=${encodeURIComponent(folderFile.filePath)}` : '';
      let fetchInfoDomain = 'disk.360.yandex.ru';
      try {
        const h = new URL(diskUrl).hostname.toLowerCase();
        if (h === 'disk.yandex.ru' || h === 'disk.360.yandex.ru') fetchInfoDomain = h;
      } catch { /* keep default */ }
      const publicKey = encodeURIComponent(fetchInfoHash);
      const fetchInfoUrl =
        `https://${fetchInfoDomain}/public/api/fetch-info` +
        `?hash=${publicKey}${fetchInfoPath}&sk=${sk}`;

      let fileHash = null; // internal Yandex hash, used for get-video-streams

      try {
        const infoResp = await axios.get(fetchInfoUrl, {
          headers: {
            ...BROWSER_HEADERS,
            Accept: 'application/json',
            ...(htmlCookies ? { Cookie: htmlCookies } : {}),
          },
          timeout: 10_000,
        });
        console.log('[video-info] fetch-info status:', infoResp.status);
        const body = infoResp.data;
        const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        hlsUrl = extractHlsFromHtml(bodyStr);
        console.log('[video-info] HLS from fetch-info:', hlsUrl ? hlsUrl.substring(0, 80) : 'not found');

        // Extract the internal file hash for use with get-video-streams
        fileHash =
          body?.data?.hash ||
          body?.data?.meta?.hash ||
          body?.resource?.hash ||
          body?.hash ||
          null;
        if (fileHash) console.log('[video-info] file hash from fetch-info:', fileHash.length > 40 ? fileHash.substring(0, 40) + '…' : fileHash);

        // Check for videos array (same format as get-video-streams response)
        if (!hlsUrl) {
          const videos =
            body?.data?.videos ||
            body?.resource?.videos ||
            body?.videos;
          hlsUrl = findAdaptiveStream(videos);
          if (hlsUrl) console.log('[video-info] HLS from fetch-info videos:', hlsUrl.substring(0, 80));
        }

        // Also try nested data.meta.video_info.streams — prefer adaptive stream
        if (!hlsUrl) {
          const streams =
            body?.data?.meta?.video_info?.streams ||
            body?.resource?.video_info?.streams ||
            body?.video_info?.streams;
          console.log('[video-info] streams from fetch-info:', streams ? `${streams.length} entries` : 'none');
          if (Array.isArray(streams)) {
            let adaptiveUrl = null;
            let firstUrl = null;
            for (const s of streams) {
              const u = s.url || s.contentUrl || s.src;
              if (!u || !u.includes('.m3u8')) continue;
              if (!firstUrl) firstUrl = u;
              const dim = (s.dimension || s.format || '').toLowerCase();
              if (dim === 'adaptive' || u.includes('master-playlist')) {
                adaptiveUrl = u;
                break;
              }
            }
            hlsUrl = adaptiveUrl || firstUrl || null;
            if (hlsUrl) console.log('[video-info] HLS from streams:', hlsUrl.substring(0, 80));
          }
        }
      } catch (err) {
        console.warn('[video-info] fetch-info failed:', err.response?.status, err.message);
      }

      /* ---- Step 2b: call get-video-streams for adaptive HLS ---- */
      if (!hlsUrl && sk) {
        hlsUrl = await tryGetVideoStreams(sk, null, fileHash, htmlResourceHash, folderFile, diskUrl, htmlCookies);
      }
    }

    /* ---- Step 2c: if we only got a quality-specific URL (not master),
       still try get-video-streams to obtain the adaptive master playlist ---- */
    if (hlsUrl && !(hlsUrl.includes('master-playlist')) && sk) {
      console.log('[video-info] step 2c: have quality-specific URL, trying get-video-streams for adaptive master');
      // fileHash is null here because step 2 (fetch-info) was skipped when the HTML already contained an HLS URL
      const adaptiveUrl = await tryGetVideoStreams(sk, hlsUrl, null, htmlResourceHash, folderFile, diskUrl, htmlCookies);
      if (adaptiveUrl) {
        hlsUrl = adaptiveUrl;
      }
    }
  } catch (err) {
    // Page fetch failed (e.g. region block) – fall through to official API
    console.warn('[video-info] page fetch failed:', err.response?.status || err.code, err.message);
  }

  /* ---- Step 3: official public download API (always try for fallback) ---- */
  if (!hlsUrl) {
    console.log('[video-info] step 3: calling cloud-api download endpoint');
    try {
      const dlResp = await axios.get(
        `https://cloud-api.yandex.net/v1/disk/public/resources/download` +
          `?public_key=${encodeURIComponent(apiPublicKey)}${apiPathParam}`,
        {
          headers: { ...BROWSER_HEADERS, Accept: 'application/json' },
          timeout: 10_000,
        },
      );
      console.log('[video-info] download API status:', dlResp.status, '| href:', dlResp.data?.href?.substring(0, 80));
      if (dlResp.data?.href) {
        directUrl = dlResp.data.href;
      }
    } catch (err) {
      console.warn('[video-info] download API failed:', err.response?.status, err.message);
    }
  }

  /* ---- Step 4: also pull resource metadata for title/thumb ---- */
  let thumbnail = null;
  console.log('[video-info] step 4: fetching resource metadata');
  try {
    const metaResp = await axios.get(
      `https://cloud-api.yandex.net/v1/disk/public/resources` +
        `?public_key=${encodeURIComponent(apiPublicKey)}${apiPathParam}&preview_size=L`,
      {
        headers: { ...BROWSER_HEADERS, Accept: 'application/json' },
        timeout: 8_000,
      },
    );
    const meta = metaResp.data;
    console.log('[video-info] meta status:', metaResp.status, '| name:', meta?.name, '| media_type:', meta?.media_type);
    if (meta?.name) {
      videoTitle =
        meta.name.replace(/\.[^.]+$/, '') || videoTitle; // strip extension
    }
    if (meta?.preview) thumbnail = meta.preview;
  } catch (err) {
    console.warn('[video-info] meta fetch failed:', err.response?.status, err.message);
  }

  /* ---- Build response ---- */
  if (hlsUrl) {
    hlsUrl = await resolveMasterPlaylist(hlsUrl);
    console.log('[video-info] → returning HLS type, url prefix:', hlsUrl.substring(0, 80));
    return res.json({
      type: 'hls',
      url: `/api/hls-proxy?url=${encodeURIComponent(hlsUrl)}`,
      title: videoTitle,
      thumbnail,
    });
  }

  if (directUrl) {
    console.log('[video-info] → returning direct type, url prefix:', directUrl.substring(0, 80));
    return res.json({
      type: 'direct',
      url: `/api/proxy?url=${encodeURIComponent(directUrl)}`,
      title: videoTitle,
      thumbnail,
    });
  }

  console.warn('[video-info] → 404 – could not resolve any playable URL');
  return res.status(404).json({
    error:
      'Не удалось получить ссылку на видео. ' +
      'Убедитесь, что ссылка на публичный файл с Яндекс Диска корректна.',
  });
});

/* ------------------------------------------------------------------ */
/*  Route: GET /api/hls-proxy?url=<encoded_hls_url>                   */
/*  Proxies HLS master/media manifests and .ts segments               */
/* ------------------------------------------------------------------ */
app.get('/api/hls-proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('url parameter required');

  if (!validateUpstreamUrl(targetUrl)) {
    console.warn('[hls-proxy] blocked URL:', targetUrl.substring(0, 100));
    return res.status(403).send('URL not permitted');
  }

  const isManifest =
    targetUrl.includes('.m3u8') || targetUrl.includes('m3u8');

  console.log('[hls-proxy]', isManifest ? 'manifest' : 'segment', targetUrl.substring(0, 100));

  try {
    const upstream = await axios.get(targetUrl, {
      headers: STREAMING_HEADERS,
      responseType: isManifest ? 'text' : 'arraybuffer',
      timeout: 30_000,
    });

    console.log('[hls-proxy] upstream status:', upstream.status, '| ct:', upstream.headers['content-type']);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');

    if (isManifest) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      const rewritten = rewriteManifest(upstream.data, targetUrl);
      console.log('[hls-proxy] manifest lines:', upstream.data.split('\n').length, '→ rewritten');
      res.send(rewritten);
    } else {
      const ct = upstream.headers['content-type'] || 'video/mp2t';
      res.setHeader('Content-Type', ct);
      res.send(Buffer.from(upstream.data));
    }
  } catch (err) {
    console.error('[hls-proxy] error:', err.response?.status, err.message, '| url:', targetUrl.substring(0, 100));
    if (!res.headersSent) res.status(502).send('HLS proxy error');
  }
});

/* ------------------------------------------------------------------ */
/*  Route: GET /api/proxy?url=<encoded_url>                           */
/*  Streaming proxy for direct MP4/WebM with Range support            */
/* ------------------------------------------------------------------ */
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('url parameter required');

  if (!validateUpstreamUrl(targetUrl)) {
    console.warn('[proxy] blocked URL:', targetUrl.substring(0, 100));
    return res.status(403).send('URL not permitted');
  }

  console.log('[proxy] range:', req.headers.range || 'none', '| url:', targetUrl.substring(0, 100));

  const upstreamHeaders = { ...STREAMING_HEADERS };
  if (req.headers.range) {
    upstreamHeaders.Range = req.headers.range;
  }

  try {
    const upstream = await axios({
      method: 'GET',
      url: targetUrl,
      headers: upstreamHeaders,
      responseType: 'stream',
      maxRedirects: 10,
      timeout: 30_000,
    });

    console.log('[proxy] upstream status:', upstream.status, '| ct:', upstream.headers['content-type']);

    res.setHeader('Access-Control-Allow-Origin', '*');

    const forward = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'cache-control',
      'last-modified',
      'etag',
    ];
    forward.forEach((h) => {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    });

    res.status(upstream.status);
    upstream.data.pipe(res);
  } catch (err) {
    console.error('[proxy] error:', err.response?.status, err.message, '| url:', targetUrl.substring(0, 100));
    if (!res.headersSent) res.status(502).send('Proxy error');
  }
});

/* ------------------------------------------------------------------ */
app.listen(PORT, () => {
  console.log(`Ya-Disk-Player running on http://localhost:${PORT}`);
});
