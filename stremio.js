#!/usr/bin/env node

/**
 * Stremio Addon wrapper for All-in-One-Nuvio providers.
 *
 * Bridges the gap between Stremio's addon protocol (IMDb IDs, specific
 * stream format) and the Nuvio provider interface (TMDB IDs, custom format).
 *
 * Usage:
 *   node stremio.js                         # Start on default port 7000
 *   PORT=8080 node stremio.js               # Start on custom port
 *   PROVIDERS=vidlink,showbox node stremio.js  # Only load specific providers
 */

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
const TMDB_BASE = "https://api.themoviedb.org/3";
const PORT = parseInt(process.env.PORT, 10) || 7000;

// ---------------------------------------------------------------------------
// Load Nuvio manifest to discover providers
// ---------------------------------------------------------------------------

const nuvioManifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "manifest.json"), "utf-8")
);

// ---------------------------------------------------------------------------
// Smart routing — provider categories
// ---------------------------------------------------------------------------

// Tag each provider so we only query relevant ones per content.
// "general" = English / multi-lang providers, queried for most content.
const PROVIDER_CATEGORIES = {
    // General English — fire for any EN / mainstream content
    vidlink:       ["general"],
    videasy:       ["general"],
    vixsrc:        ["general"],
    showbox:       ["general"],
    castle:        ["general"],
    dooflix:        ["general"],
    embed69:       ["general"],
    streamflix:    ["general"],
    streamflixen:  ["general"],
    cinestream:    ["general"],
    cinemacity:    ["general"],
    dahmermovies:  ["general"],
    netmirror:     ["general"],
    moviebox:      ["general"],
    movieblast:    ["general"],
    "4khdhub":     ["general"],
    "4khdhubtv":   ["general"],
    hdhub4u:       ["general"],
    hindmoviez:    ["general"],
    moviesdrive:   ["general"],
    moviesmod:     ["general"],
    movies4u:      ["general"],
    allmovieland:  ["general"],
    flixindia:     ["general"],
    uhdmovies:     ["general"],

    // French
    movix:         ["french"],
    nakios:        ["french"],
    purstream:     ["french"],

    // Spanish / Portuguese
    brazucaplay:   ["spanish", "portuguese"],
    lamovie:       ["spanish"],

    // Turkish
    diziyou:       ["turkish"],

    // Anime (Japanese animation)
    hianime:       ["anime"],
    animekai:      ["anime"],
    animesalt:     ["anime"],
    animeworld:    ["anime"],
    allwish:       ["anime"],

    // K-drama / Asian drama
    onlykdrama:    ["kdrama"],
    kisskh:        ["kdrama"],
    dramafull:     ["kdrama"],
};

// TMDB genre ID for Animation
const ANIMATION_GENRE_ID = 16;

// TMDB metadata cache (genre + language info)
const tmdbMetaCache = new Map();

async function getTmdbMeta(tmdbId, mediaType) {
    const cacheKey = `${tmdbId}:${mediaType}`;
    if (tmdbMetaCache.has(cacheKey)) return tmdbMetaCache.get(cacheKey);

    try {
        const endpoint = mediaType === "tv" ? "tv" : "movie";
        const res = await fetch(
            `${TMDB_BASE}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`
        );
        const data = await res.json();
        const meta = {
            title: data.title || data.name || "",
            original_title: data.original_title || data.original_name || "",
            original_language: data.original_language,
            genres: (data.genres || []).map((g) => g.id),
        };
        tmdbMetaCache.set(cacheKey, meta);
        return meta;
    } catch {
        return null;
    }
}

/**
 * Determine which provider categories are relevant for this content.
 */
function getRelevantCategories(tmdbMeta) {
    const cats = new Set(["general"]); // always include general

    if (!tmdbMeta) return cats;

    const lang = tmdbMeta.original_language;
    const isAnimation = tmdbMeta.genres.includes(ANIMATION_GENRE_ID);

    // Japanese + Animation = anime. Japanese live-action = kdrama bucket.
    if (lang === "ja") {
        cats.add(isAnimation ? "anime" : "kdrama");
    } else if (lang === "ko" || lang === "zh" || lang === "th") {
        cats.add("kdrama");
    } else if (lang === "es") {
        cats.add("spanish");
    } else if (lang === "pt") {
        cats.add("portuguese");
    } else if (lang === "fr") {
        cats.add("french");
    } else if (lang === "tr") {
        cats.add("turkish");
    }

    return cats;
}

/**
 * Filter providers to only those relevant for the content.
 */
function filterProvidersByContent(allProviders, relevantCategories) {
    return allProviders.filter((p) => {
        const providerCats = PROVIDER_CATEGORIES[p.id] || ["general"];
        return providerCats.some((cat) => relevantCategories.has(cat));
    });
}

// ---------------------------------------------------------------------------
// Stream title validation — reject false matches, accept branded/generic names
// ---------------------------------------------------------------------------

/**
 * Determine if a stream should be rejected based on title mismatch.
 *
 * Strategy:
 * 1. Strip technical metadata (resolution, codecs, container, etc.) from the
 *    stream title.
 * 2. If fewer than 2 meaningful words remain, the title is just
 *    provider branding / quality info — ACCEPT (it used the right TMDB ID).
 * 3. Otherwise, compare what remains against the TMDB title using Dice
 *    coefficient on character bigrams. This handles concatenated words,
 *    partial matches, and word-order variations gracefully.
 *
 * Returns true if the stream should be REJECTED.
 */
function shouldRejectStream(streamTitle, tmdbTitle, tmdbOrigTitle) {
    const noise = /\b(\d{3,4}p|[hx]\.?26[45]|aac|hevc|web[- ]?dl|blu[- ]?ray|hdr\d*|sdr|remux|atmos|dts|mkv|mp4|avi|multi|vf|vff|vo|vostfr|dual|server\s*\d*|auto|hls|hd|fhd|uhd|sd|full|stream|premium|standard|quality|original|low|mid|s\d{1,2}e?\d{0,3}|season\s*\d+|episode\s*\d+|hindi|english|tamil|telugu|french|spanish|japanese|korean|chinese|arabic|german|italian|portuguese|turkish)\b/gi;

    // Strip everything that's clearly technical / language metadata
    const stripped = streamTitle
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(noise, "")
        .replace(/\s+/g, " ")
        .trim();

    // If nothing meaningful remains, it's a branded/generic name — ACCEPT
    const words = stripped.split(/\s+/).filter((w) => w.length > 1);
    if (words.length < 2) return false;

    const clean = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
    const wanted = clean(tmdbTitle);
    const wantedOrig = tmdbOrigTitle ? clean(tmdbOrigTitle) : "";

    // Dice coefficient on character bigrams
    const bigrams = (s) => {
        const b = new Set();
        for (let i = 0; i < s.length - 1; i++) b.add(s[i] + s[i + 1]);
        return b;
    };
    const dice = (a, b) => {
        if (!a.size || !b.size) return 0;
        let overlap = 0;
        for (const x of a) if (b.has(x)) overlap++;
        return (2 * overlap) / (a.size + b.size);
    };

    const streamBigrams = bigrams(stripped.replace(/\s/g, ""));
    const score = Math.max(
        dice(streamBigrams, bigrams(wanted.replace(/\s/g, ""))),
        wantedOrig ? dice(streamBigrams, bigrams(wantedOrig.replace(/\s/g, ""))) : 0
    );

    // Fast-path: stream title contains the full TMDB title as substring
    const containsTitle =
        stripped.includes(wanted) ||
        (wantedOrig && stripped.includes(wantedOrig));

    return !containsTitle && score < 0.45;
}

// ---------------------------------------------------------------------------
// Load providers
// ---------------------------------------------------------------------------

/**
 * Dynamically require each provider listed in the Nuvio manifest.
 * We skip providers that fail to load (missing file, syntax error, etc.)
 * so one broken provider doesn't take down the whole addon.
 */
function loadProviders() {
    const filter = process.env.PROVIDERS
        ? process.env.PROVIDERS.split(",").map((s) => s.trim().toLowerCase())
        : null;

    const loaded = [];

    for (const scraper of nuvioManifest.scrapers) {
        if (!scraper.enabled) continue;
        // Disabled providers
        // if (scraper.id === "test") continue;
        // if (scraper.id === "test2") continue;
        // if (scraper.id === "anime-sama") continue;
        // if (scraper.id === "hdmovie2") continue;
        // if (scraper.id === "isaidub") continue;
        // if (scraper.id === "moviebox") continue;
        // if (scraper.id === "allmovieland") continue;
        // if (scraper.id === "flixindia") continue; // Cloudflare blocked
        // if (scraper.id === "dooflix") continue; // 403 blocked
        // if (scraper.id === "embed69") continue; // 403 blocked
        // if (scraper.id === "diziyou") continue; // 403 blocked
        // if (scraper.id === "dramafull") continue; // dead/unreachable
        const skip = ["test", "test2", "anime-sama", "hdmovie2", "isaidub", "moviebox", "allmovieland", "flixindia", "dooflix", "embed69", "diziyou", "dramafull"];
        if (skip.includes(scraper.id)) continue;
        if (filter && !filter.includes(scraper.id)) continue;

        try {
            const modPath = path.join(__dirname, scraper.filename);
            if (!fs.existsSync(modPath)) {
                console.warn(`[stremio] skip ${scraper.id}: file not found (${scraper.filename})`);
                continue;
            }
            const mod = require(modPath);
            const getStreams = mod.getStreams || mod.default?.getStreams || mod;
            if (typeof getStreams !== "function") {
                console.warn(`[stremio] skip ${scraper.id}: no getStreams export`);
                continue;
            }
            loaded.push({
                id: scraper.id,
                name: scraper.name,
                types: scraper.supportedTypes, // ["movie", "tv"]
                langs: scraper.contentLanguage || [], // ["en", "hi", etc.]
                getStreams,
            });
            console.log(`[stremio] loaded provider: ${scraper.id}`);
        } catch (err) {
            console.warn(`[stremio] skip ${scraper.id}: ${err.message}`);
        }
    }

    console.log(`[stremio] ${loaded.length} providers loaded\n`);
    return loaded;
}

const providers = loadProviders();

// ---------------------------------------------------------------------------
// IMDb → TMDB ID conversion (cached)
// ---------------------------------------------------------------------------

const imdbToTmdbCache = new Map();

async function imdbToTmdb(imdbId, type) {
    const cacheKey = `${imdbId}:${type}`;
    if (imdbToTmdbCache.has(cacheKey)) return imdbToTmdbCache.get(cacheKey);

    const mediaType = type === "series" ? "tv" : "movie";

    try {
        const res = await fetch(
            `${TMDB_BASE}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
        );
        const data = await res.json();

        const results =
            mediaType === "tv" ? data.tv_results : data.movie_results;
        if (!results || results.length === 0) return null;

        const tmdbId = results[0].id;
        imdbToTmdbCache.set(cacheKey, tmdbId);
        return tmdbId;
    } catch (err) {
        console.error(`[stremio] TMDB lookup failed for ${imdbId}: ${err.message}`);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Transform Nuvio stream → Stremio stream
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stream probing — detect actual audio tracks & embedded subs
// ---------------------------------------------------------------------------

// Check if ffprobe is available at startup
let HAS_FFPROBE = false;
try {
    require("child_process").execSync("ffprobe -version", { stdio: "ignore" });
    HAS_FFPROBE = true;
    console.log("[stremio] ffprobe detected — audio probing enabled");
} catch {
    console.log("[stremio] ffprobe not found — using m3u8 parsing only");
}

/**
 * Probe a stream URL with ffprobe to get real audio/subtitle tracks.
 * Returns { audio: ["eng","hin"], subs: ["eng"], video: "1920x1080" } or null on failure.
 */
// Concurrency limiter — max N probes at once to avoid overwhelming the system
function makeLimiter(concurrency) {
    let running = 0;
    const queue = [];
    function next() {
        if (queue.length === 0 || running >= concurrency) return;
        running++;
        const { fn, resolve } = queue.shift();
        fn().then(resolve).finally(() => { running--; next(); });
    }
    return (fn) => new Promise((resolve) => { queue.push({ fn, resolve }); next(); });
}
const probeLimit = makeLimiter(20);

function probeStream(url, headers) {
    if (!HAS_FFPROBE) return Promise.resolve(null);
    return probeLimit(() => new Promise((resolve) => {
        const args = [
            "-v", "quiet",
            "-print_format", "json",
            "-show_streams",
            "-analyzeduration", "0",        // don't analyze duration — just read headers
            "-probesize", "32768",           // 32KB — enough for container metadata
            "-fflags", "+nobuffer",          // no buffering
        ];

        // Add headers for authenticated streams
        if (headers && typeof headers === "object") {
            const headerStr = Object.entries(headers)
                .map(([k, v]) => `${k}: ${v}`)
                .join("\r\n");
            args.push("-headers", headerStr + "\r\n");
        }

        args.push(url);

        execFile("ffprobe", args, { timeout: 3000 }, (err, stdout) => {
            if (err) return resolve(null);
            try {
                const data = JSON.parse(stdout);
                const streams = data.streams || [];

                const audio = streams
                    .filter((s) => s.codec_type === "audio")
                    .map((s) => {
                        const lang = s.tags?.language || s.tags?.LANGUAGE || "";
                        const title = s.tags?.title || s.tags?.TITLE || "";
                        const codec = s.codec_name || "";
                        const ch = s.channels || 0;
                        return { lang, title, codec, ch };
                    });

                const subs = streams
                    .filter((s) => s.codec_type === "subtitle")
                    .map((s) => {
                        const lang = s.tags?.language || s.tags?.LANGUAGE || "";
                        const title = s.tags?.title || s.tags?.TITLE || "";
                        return { lang, title };
                    });

                const vid = streams.find((s) => s.codec_type === "video");
                const video = vid ? `${vid.width}x${vid.height}` : "";

                resolve({ audio, subs, video });
            } catch {
                resolve(null);
            }
        });
    }));
}

/**
 * For m3u8/HLS: fetch the master playlist and parse audio track info.
 * Much faster than ffprobe — just a small text fetch.
 */
async function probeM3U8(url, headers) {
    try {
        const fetchHeaders = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            ...(headers || {}),
        };
        const res = await fetch(url, { headers: fetchHeaders, signal: AbortSignal.timeout(5000) });
        const text = await res.text();

        // Parse #EXT-X-MEDIA:TYPE=AUDIO lines
        const audioTracks = [];
        const mediaRegex = /#EXT-X-MEDIA:([^\n]+)/g;
        let match;
        while ((match = mediaRegex.exec(text)) !== null) {
            const line = match[1];
            if (!line.includes('TYPE=AUDIO')) continue;
            const langMatch = line.match(/LANGUAGE="([^"]+)"/);
            const nameMatch = line.match(/NAME="([^"]+)"/);
            if (langMatch || nameMatch) {
                audioTracks.push({
                    lang: langMatch ? langMatch[1] : "",
                    title: nameMatch ? nameMatch[1] : "",
                    codec: "aac", ch: 2,
                });
            }
        }

        // Parse #EXT-X-MEDIA:TYPE=SUBTITLES lines
        const subTracks = [];
        const text2 = text;
        const mediaRegex2 = /#EXT-X-MEDIA:([^\n]+)/g;
        let match2;
        while ((match2 = mediaRegex2.exec(text2)) !== null) {
            const line = match2[1];
            if (!line.includes('TYPE=SUBTITLES')) continue;
            const langMatch = line.match(/LANGUAGE="([^"]+)"/);
            const nameMatch = line.match(/NAME="([^"]+)"/);
            if (langMatch || nameMatch) {
                subTracks.push({
                    lang: langMatch ? langMatch[1] : "",
                    title: nameMatch ? nameMatch[1] : "",
                });
            }
        }

        if (audioTracks.length === 0 && subTracks.length === 0) return null;
        return { audio: audioTracks, subs: subTracks, video: "" };
    } catch {
        return null;
    }
}

/**
 * Probe a stream — picks the right method based on URL type.
 */
async function probeStreamAuto(url, headers) {
    if (url.toLowerCase().includes(".m3u8")) {
        // Try m3u8 parsing first (fast), fallback to ffprobe
        const result = await probeM3U8(url, headers);
        if (result && result.audio.length > 0) return result;
    }
    // ffprobe for direct files or m3u8 fallback
    return probeStream(url, headers);
}

/**
 * Format probe results into a readable string for the description.
 */
function formatProbeInfo(probe) {
    if (!probe) return null;

    const parts = [];

    if (probe.audio.length > 0) {
        const audioStr = probe.audio.map((a) => {
            const lang = (a.lang || "?").toUpperCase().substring(0, 3);
            const chStr = a.ch > 2 ? ` ${a.ch}.1ch` : "";
            return `${lang}${chStr}`;
        }).join(" + ");
        parts.push(`Audio: ${audioStr}`);
    }

    if (probe.subs.length > 0) {
        const subStr = probe.subs.map((s) =>
            (s.lang || s.title || "?").toUpperCase().substring(0, 3)
        ).join(", ");
        parts.push(`Subs: ${subStr}`);
    }

    if (probe.video) parts.push(probe.video);

    return parts.length > 0 ? parts.join(" | ") : null;
}

// ---------------------------------------------------------------------------
// Transform Nuvio stream → Stremio stream
// ---------------------------------------------------------------------------

function toStremioStream(nuvioStream, providerName, probeInfo) {
    if (!nuvioStream || !nuvioStream.url) return null;

    // Filter out low quality streams (480p and below)
    const q = (nuvioStream.quality || "").toLowerCase();
    if (/^(480|360|240)p?$/i.test(q) || q === "sd") return null;

    // Also check probe resolution
    if (probeInfo) {
        const resMatch = probeInfo.match(/(\d{3,4})x(\d{3,4})/);
        if (resMatch && parseInt(resMatch[2]) < 600) return null;
    }

    // Filter out French-only and Hindi-only audio streams
    // Check 1: probe results (actual audio tracks)
    if (probeInfo) {
        const audioMatch = probeInfo.match(/Audio:\s*([^|]+)/);
        if (audioMatch) {
            const tracks = audioMatch[1].trim().toUpperCase();
            const codes = tracks.split(/\s*\+\s*/);
            if (codes.length > 0 && codes.every((c) => /^FRE|^FRA/.test(c.trim()))) return null;
            if (codes.length > 0 && codes.every((c) => /^HIN/.test(c.trim()))) return null;
        }
    }
    // Check 2: stream name/title text (when probe didn't detect audio)
    if (!probeInfo || !probeInfo.includes("Audio:")) {
        const text = `${nuvioStream.name || ""} ${nuvioStream.title || ""}`.toLowerCase();
        const hasHindi = /hindi|🔊\s*hindi/.test(text);
        const hasEnglish = /english|eng\b/.test(text);
        const hasDual = /dual|multi/.test(text);
        // If it mentions Hindi but not English and not dual/multi, skip it
        if (hasHindi && !hasEnglish && !hasDual) return null;
    }

    // Format the name line
    const quality = nuvioStream.quality || "";
    const name = `${providerName}\n${quality}`;

    // Description: probe info + size + title + format
    const descParts = [];

    // Real audio/sub info from probing (top priority)
    if (probeInfo) descParts.push(probeInfo);

    if (nuvioStream.size) descParts.push(nuvioStream.size);
    if (nuvioStream.title) descParts.push(nuvioStream.title);

    // Detect format from URL
    const urlLower = nuvioStream.url.toLowerCase();
    if (urlLower.includes(".m3u8")) descParts.push("HLS");
    else if (urlLower.includes(".mkv")) descParts.push("MKV");
    else if (urlLower.includes(".mp4")) descParts.push("MP4");

    const stream = {
        url: nuvioStream.url,
        name,
        description: descParts.join(" | "),
    };

    // Stremio needs behaviorHints for non-MP4 / non-HTTPS streams or custom headers
    const hints = {};

    const url = nuvioStream.url.toLowerCase();
    const needsProxy =
        url.includes(".m3u8") ||
        url.includes(".mkv") ||
        !url.startsWith("https://");

    if (needsProxy || nuvioStream.headers) {
        hints.notWebReady = true;
    }

    if (nuvioStream.headers && typeof nuvioStream.headers === "object") {
        hints.proxyHeaders = { request: nuvioStream.headers };
    }

    if (Object.keys(hints).length > 0) {
        stream.behaviorHints = hints;
    }

    // Subtitles
    if (Array.isArray(nuvioStream.subtitles) && nuvioStream.subtitles.length > 0) {
        stream.subtitles = nuvioStream.subtitles.map((sub) => ({
            id: sub.label || sub.lang || "unknown",
            url: sub.url,
            lang: sub.label || sub.lang || "eng",
        }));
    }

    return stream;
}

// ---------------------------------------------------------------------------
// Stremio Manifest
// ---------------------------------------------------------------------------

const manifest = {
    id: "community.allinone.nuvio",
    version: "1.0.0",
    name: "All-in-One Nuvio",
    description:
        "Multi-provider streaming addon with 50+ sources. Movies & Series in multiple languages.",
    resources: ["stream", "subtitles"],
    types: ["movie", "series"],
    catalogs: [],
    idPrefixes: ["tt"],
    logo: "https://i.postimg.cc/8c5XGzsx/showbox.png",
    behaviorHints: { configurable: false },
};

// ---------------------------------------------------------------------------
// Addon builder & stream handler
// ---------------------------------------------------------------------------

const builder = new addonBuilder(manifest);

// Stream result cache — 30 minute TTL
const CACHE_TTL = 30 * 60 * 1000;
const streamCache = new Map();

builder.defineStreamHandler(async ({ type, id }) => {
    // Check cache first
    const cached = streamCache.get(id);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
        console.log(`[stremio] cache hit for ${id} (${cached.data.streams.length} streams)`);
        return cached.data;
    }

    // Parse the Stremio ID: "tt1234567" for movies, "tt1234567:S:E" for series
    const parts = id.split(":");
    const imdbId = parts[0];
    const season = parts.length > 1 ? parseInt(parts[1], 10) : null;
    const episode = parts.length > 2 ? parseInt(parts[2], 10) : null;

    console.log(`[stremio] stream request: type=${type} id=${id}`);

    // Convert IMDb → TMDB
    const tmdbId = await imdbToTmdb(imdbId, type);
    if (!tmdbId) {
        console.warn(`[stremio] no TMDB match for ${imdbId}`);
        return { streams: [] };
    }

    // Map Stremio type to Nuvio type
    const mediaType = type === "series" ? "tv" : "movie";

    console.log(`[stremio] resolved ${imdbId} → TMDB ${tmdbId}`);

    // Smart routing (disabled — uncomment to re-enable)
    // const tmdbMeta = await getTmdbMeta(tmdbId, mediaType);
    // const categories = getRelevantCategories(tmdbMeta);
    // const typeFiltered = providers.filter((p) => p.types.includes(mediaType));
    // const relevantProviders = filterProvidersByContent(typeFiltered, categories);
    // console.log(
    //     `[stremio] routing: lang=${tmdbMeta?.original_language || "?"} ` +
    //     `categories=[${[...categories]}] → ${relevantProviders.length}/${typeFiltered.length} providers`
    // );

    // Get TMDB title for validating provider results
    const tmdbMeta = await getTmdbMeta(tmdbId, mediaType);
    const tmdbTitle = (tmdbMeta?.title || "").toLowerCase();
    const tmdbOrigTitle = (tmdbMeta?.original_title || "").toLowerCase();

    // Query all providers that support this media type
    const relevantProviders = providers.filter((p) => p.types.includes(mediaType));
    console.log(`[stremio] querying ${relevantProviders.length} providers (title: "${tmdbMeta?.title}")`);

    // Deadline-based approach: return whatever streams we have after
    // DEADLINE_MS, without waiting for slow providers. Each provider that
    // finishes pushes its results into the shared array immediately.
    const DEADLINE_MS = 60000;

    const stremioStreams = [];

    const providerPromises = relevantProviders.map((provider) =>
        Promise.resolve()
            .then(() => provider.getStreams(tmdbId, mediaType, season, episode))
            .then(async (streams) => {
                if (!Array.isArray(streams) || streams.length === 0) return;

                // Probe all streams from this provider in parallel
                const probeResults = await Promise.allSettled(
                    streams.map((s) =>
                        s.url
                            ? probeStreamAuto(s.url, s.headers).catch(() => null)
                            : Promise.resolve(null)
                    )
                );

                let accepted = 0;
                for (let i = 0; i < streams.length; i++) {
                    const s = streams[i];

                    // Validate 1: title check — reject wrong content (e.g. "Hana Kimi" for "The Boys")
                    if (tmdbTitle && s.title && shouldRejectStream(s.title, tmdbTitle, tmdbOrigTitle)) {
                        console.log(`[stremio] ${provider.id} REJECTED (title): "${s.title}" doesn't match "${tmdbMeta.title}"`);
                        continue;
                    }

                    // Validate 2: language cross-check
                    // If a provider doesn't list the content's language (from TMDB),
                    // only keep the stream if its title clearly contains the content name.
                    // e.g. Kisskh [ko] returning "Kisskh HLS" for an English show → reject.
                    // But Kisskh returning "The Boys" for The Boys → keep (title matches).
                    if (tmdbMeta && provider.langs.length > 0) {
                        const contentLang = tmdbMeta.original_language;
                        const providerSupportsLang = provider.langs.includes(contentLang) || provider.langs.includes("en");
                        if (!providerSupportsLang) {
                            // Provider doesn't serve this language.
                            // Check if stream title actually contains the content name
                            const streamText = (s.title || s.name || "").toLowerCase();
                            const wantedClean = tmdbTitle.replace(/[^a-z0-9\s]/g, "");
                            const origClean = tmdbOrigTitle ? tmdbOrigTitle.replace(/[^a-z0-9\s]/g, "") : "";
                            const titleMatches = streamText.includes(wantedClean) ||
                                (origClean && streamText.includes(origClean));
                            if (!titleMatches) {
                                console.log(`[stremio] ${provider.id} REJECTED (lang): [${provider.langs}] doesn't cover "${contentLang}", title "${s.title || s.name}" doesn't confirm match`);
                                continue;
                            }
                        }
                    }

                    const probe =
                        probeResults[i]?.status === "fulfilled"
                            ? probeResults[i].value
                            : null;
                    const probeInfo = formatProbeInfo(probe);
                    const converted = toStremioStream(s, provider.name, probeInfo);
                    if (converted) {
                        stremioStreams.push(converted);
                        accepted++;
                    }
                }
                console.log(`[stremio] ${provider.id} returned ${streams.length} stream(s), accepted ${accepted}`);
            })
            .catch((err) => {
                console.warn(`[stremio] ${provider.id} failed: ${err.message}`);
            })
    );

    // Wait for either ALL providers to finish or the deadline — whichever
    // comes first. Streams from fast providers are already in the array.
    await Promise.race([
        Promise.allSettled(providerPromises),
        new Promise((resolve) => setTimeout(resolve, DEADLINE_MS)),
    ]);

    // Sort streams by quality: 4K > 2160p > 1080p > 720p > Auto > unknown
    const qualityOrder = (stream) => {
        const q = (stream.name || "").toLowerCase();
        const desc = (stream.description || "").toLowerCase();
        const all = q + " " + desc;

        // Check for resolution in probe info (e.g. "1920x1080")
        const resMatch = all.match(/(\d{3,4})x(\d{3,4})/);
        if (resMatch) return parseInt(resMatch[2]);

        // Check quality label
        if (/4k|2160/i.test(all)) return 2160;
        if (/1080/i.test(all)) return 1080;
        if (/720/i.test(all)) return 720;
        if (/auto/i.test(all)) return 700;
        return 500;
    };

    stremioStreams.sort((a, b) => qualityOrder(b) - qualityOrder(a));

    // Deduplicate — same URL from different providers is the same file
    const seenUrls = new Set();
    const deduped = stremioStreams.filter((s) => {
        if (seenUrls.has(s.url)) return false;
        seenUrls.add(s.url);
        return true;
    });

    console.log(
        `[stremio] returning ${deduped.length} streams for ${imdbId} (${stremioStreams.length - deduped.length} dupes removed)`
    );

    const result = { streams: deduped };

    // Cache the result for 30 minutes
    streamCache.set(id, { data: result, ts: Date.now() });

    return result;
});

// ---------------------------------------------------------------------------
// Subtitles handler (OpenSubtitles)
// ---------------------------------------------------------------------------

const OPENSUBTITLES_BASE = "https://rest.opensubtitles.org/search";

builder.defineSubtitlesHandler(async ({ type, id }) => {
    const parts = id.split(":");
    const imdbId = parts[0].replace("tt", "");
    const season = parts[1] || null;
    const episode = parts[2] || null;

    let url = `${OPENSUBTITLES_BASE}/imdbid-${imdbId}/sublanguageid-eng`;
    if (season && episode) {
        url += `/season-${season}/episode-${episode}`;
    }

    console.log(`[stremio] subtitle request: ${id}`);

    try {
        const res = await fetch(url, {
            headers: { "User-Agent": "TemporaryUserAgent" },
        });
        const data = await res.json();

        if (!Array.isArray(data)) return { subtitles: [] };

        // Deduplicate by filename, prefer most downloaded
        const sorted = data.sort(
            (a, b) => parseInt(b.SubDownloadsCnt) - parseInt(a.SubDownloadsCnt)
        );

        const seen = new Set();
        const subtitles = [];

        for (const sub of sorted) {
            if (!sub.SubDownloadLink) continue;
            const key = sub.SubFileName || sub.IDSubtitleFile;
            if (seen.has(key)) continue;
            seen.add(key);

            subtitles.push({
                id: `opensub-${sub.IDSubtitleFile}`,
                url: sub.SubDownloadLink,
                lang: "eng",
            });

            if (subtitles.length >= 15) break; // cap to avoid clutter
        }

        console.log(`[stremio] returning ${subtitles.length} subtitles for ${id}`);
        return { subtitles };
    } catch (err) {
        console.error(`[stremio] subtitle fetch failed: ${err.message}`);
        return { subtitles: [] };
    }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`\nStremio addon running at: http://127.0.0.1:${PORT}`);
console.log(`Install in Stremio:       http://127.0.0.1:${PORT}/manifest.json\n`);
