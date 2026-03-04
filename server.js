'use strict';

const express = require('express');
const axios = require('axios');
const path = require('path');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

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
 * Try to find an HLS master manifest URL (.m3u8) inside raw HTML.
 * Yandex embeds streaming URLs in the serialised page state.
 */
function extractHlsFromHtml(html) {
  const patterns = [
    // escaped JSON in Next.js __NEXT_DATA__
    /https?:\\u002F\\u002Fstreaming\.disk\.yandex\.net\\u002F[^"'\s\\]+\.m3u8[^"'\s]*/,
    // plain streaming URL
    /(https?:\/\/streaming\.disk\.yandex\.net\/[^"'\s]+\.m3u8[^"'\s]*)/,
    /"(https?:\/\/strm\.yandex\.ru\/[^"]+\.m3u8[^"]*)"/,
    /"contentUrl"\s*:\s*"([^"]+\.m3u8[^"]*)"/,
    /"video_url"\s*:\s*"([^"]+\.m3u8[^"]*)"/,
    /"stream_url"\s*:\s*"([^"]+\.m3u8[^"]*)"/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      return m[0].startsWith('https')
        ? m[0]
        : // un-escape \\u002F → /
          m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
    }
  }
  return null;
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

/* ------------------------------------------------------------------ */
/*  Route: GET /api/video-info?url=<yandex_disk_public_url>           */
/* ------------------------------------------------------------------ */
app.get('/api/video-info', async (req, res) => {
  const diskUrl = req.query.url;
  if (!diskUrl) {
    return res.status(400).json({ error: 'url parameter is required' });
  }

  let videoTitle = 'Видео';
  let hlsUrl = null;
  let directUrl = null;
  let htmlCookies = '';

  /* ---- Step 1: fetch the public page to look for embedded HLS URL ---- */
  try {
    const pageResp = await axios.get(diskUrl, {
      headers: BROWSER_HEADERS,
      maxRedirects: 5,
      timeout: 15_000,
    });
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
    }

    hlsUrl = extractHlsFromHtml(html);

    if (!hlsUrl) {
      /* ---- Step 2: try the internal fetch-info API with sk token ---- */
      const sk = extractSk(html);
      const publicKey = encodeURIComponent(diskUrl);
      const fetchInfoUrl =
        `https://disk.360.yandex.ru/public/api/fetch-info` +
        `?hash=${publicKey}&sk=${sk}`;

      try {
        const infoResp = await axios.get(fetchInfoUrl, {
          headers: {
            ...BROWSER_HEADERS,
            Accept: 'application/json',
            ...(htmlCookies ? { Cookie: htmlCookies } : {}),
          },
          timeout: 10_000,
        });
        const body = infoResp.data;
        const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        hlsUrl = extractHlsFromHtml(bodyStr);

        // Also try nested data.meta.video_info.streams
        if (!hlsUrl) {
          const streams =
            body?.data?.meta?.video_info?.streams ||
            body?.resource?.video_info?.streams ||
            body?.video_info?.streams;
          if (Array.isArray(streams)) {
            for (const s of streams) {
              const u = s.url || s.contentUrl || s.src;
              if (u && u.includes('.m3u8')) {
                hlsUrl = u;
                break;
              }
            }
          }
        }
      } catch (_) {
        // fetch-info not available – continue to official API
      }
    }
  } catch (err) {
    // Page fetch failed (e.g. region block) – fall through to official API
    console.warn('Page fetch failed:', err.message);
  }

  /* ---- Step 3: official public download API (always try for fallback) ---- */
  if (!hlsUrl) {
    try {
      const dlResp = await axios.get(
        `https://cloud-api.yandex.net/v1/disk/public/resources/download` +
          `?public_key=${encodeURIComponent(diskUrl)}`,
        {
          headers: { ...BROWSER_HEADERS, Accept: 'application/json' },
          timeout: 10_000,
        },
      );
      if (dlResp.data?.href) {
        directUrl = dlResp.data.href;
      }
    } catch (err) {
      console.warn('Download API failed:', err.message);
    }
  }

  /* ---- Step 4: also pull resource metadata for title/thumb ---- */
  let thumbnail = null;
  try {
    const metaResp = await axios.get(
      `https://cloud-api.yandex.net/v1/disk/public/resources` +
        `?public_key=${encodeURIComponent(diskUrl)}&preview_size=L`,
      {
        headers: { ...BROWSER_HEADERS, Accept: 'application/json' },
        timeout: 8_000,
      },
    );
    const meta = metaResp.data;
    if (meta?.name) {
      videoTitle =
        meta.name.replace(/\.[^.]+$/, '') || videoTitle; // strip extension
    }
    if (meta?.preview) thumbnail = meta.preview;
  } catch (_) {
    // metadata not critical
  }

  /* ---- Build response ---- */
  if (hlsUrl) {
    return res.json({
      type: 'hls',
      url: `/api/hls-proxy?url=${encodeURIComponent(hlsUrl)}`,
      title: videoTitle,
      thumbnail,
    });
  }

  if (directUrl) {
    return res.json({
      type: 'direct',
      url: `/api/proxy?url=${encodeURIComponent(directUrl)}`,
      title: videoTitle,
      thumbnail,
    });
  }

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
    return res.status(403).send('URL not permitted');
  }

  const isManifest =
    targetUrl.includes('.m3u8') || targetUrl.includes('m3u8');

  try {
    const upstream = await axios.get(targetUrl, {
      headers: STREAMING_HEADERS,
      responseType: isManifest ? 'text' : 'arraybuffer',
      timeout: 30_000,
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');

    if (isManifest) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(rewriteManifest(upstream.data, targetUrl));
    } else {
      const ct = upstream.headers['content-type'] || 'video/mp2t';
      res.setHeader('Content-Type', ct);
      res.send(Buffer.from(upstream.data));
    }
  } catch (err) {
    console.error('hls-proxy error:', err.message);
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
    return res.status(403).send('URL not permitted');
  }

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
    console.error('proxy error:', err.message);
    if (!res.headersSent) res.status(502).send('Proxy error');
  }
});

/* ------------------------------------------------------------------ */
app.listen(PORT, () => {
  console.log(`Ya-Disk-Player running on http://localhost:${PORT}`);
});
