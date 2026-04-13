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
        const skip = ["test", "test2", "anime-sama", "hdmovie2", "isaidub"];
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

function toStremioStream(nuvioStream, providerName) {
    if (!nuvioStream || !nuvioStream.url) return null;

    // Format the name line: "ProviderName  Quality"
    // Stremio shows `name` as the bold heading, `description` below it
    const quality = nuvioStream.quality || "";
    const name = `${providerName}\n${quality}`;

    // Description: size + title + format info
    const descParts = [];
    if (nuvioStream.size) descParts.push(`${nuvioStream.size}`);
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

builder.defineStreamHandler(async ({ type, id }) => {
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

    // Query all providers that support this media type
    const relevantProviders = providers.filter((p) => p.types.includes(mediaType));
    console.log(`[stremio] querying ${relevantProviders.length} providers`);

    // Deadline-based approach: return whatever streams we have after
    // DEADLINE_MS, without waiting for slow providers. Each provider that
    // finishes pushes its results into the shared array immediately.
    const DEADLINE_MS = 15000;

    const stremioStreams = [];

    const providerPromises = relevantProviders.map((provider) =>
        Promise.resolve()
            .then(() => provider.getStreams(tmdbId, mediaType, season, episode))
            .then((streams) => {
                if (!Array.isArray(streams)) return;
                for (const s of streams) {
                    const converted = toStremioStream(s, provider.name);
                    if (converted) stremioStreams.push(converted);
                }
                console.log(`[stremio] ${provider.id} returned ${streams.length} stream(s)`);
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

    console.log(
        `[stremio] returning ${stremioStreams.length} streams for ${imdbId}`
    );

    return { streams: stremioStreams };
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
