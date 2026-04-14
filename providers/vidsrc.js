// VidSrc Scraper for Nuvio
// Source: vsrc.su — Embed chain via cloudnestra.com
// Movies + TV, 720p-1080p

var TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';

function getJson(url, options) {
    return fetch(url, options || {}).then(function(r) {
        if (!r || !r.ok) throw new Error('HTTP ' + (r ? r.status : '?'));
        return r.json();
    });
}

function getText(url, options) {
    return fetch(url, options || {}).then(function(r) {
        if (!r || !r.ok) throw new Error('HTTP ' + (r ? r.status : '?'));
        return r.text();
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
    var typePath = mediaType === 'tv' ? 'tv' : 'movie';
    var tmdbUrl = 'https://api.themoviedb.org/3/' + typePath + '/' + tmdbId + '?append_to_response=external_ids&api_key=' + TMDB_API_KEY;

    console.log('[VidSrc] Starting for TMDB ' + tmdbId);

    return getJson(tmdbUrl)
        .then(function(meta) {
            var imdbId = mediaType === 'tv'
                ? (meta.external_ids && meta.external_ids.imdb_id)
                : meta.imdb_id;

            if (!imdbId) {
                console.log('[VidSrc] No IMDB ID found');
                return [];
            }

            var embedUrl = mediaType === 'tv'
                ? 'https://vsrc.su/embed/tv?imdb=' + imdbId + '&season=' + (season || 1) + '&episode=' + (episode || 1)
                : 'https://vsrc.su/embed/' + imdbId;

            console.log('[VidSrc] Embed: ' + embedUrl);

            return getText(embedUrl)
                .then(function(embedHtml) {
                    var iframeMatch = embedHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i);
                    var iframeSrc = iframeMatch ? iframeMatch[1] : '';
                    if (!iframeSrc) {
                        console.log('[VidSrc] No iframe found');
                        return [];
                    }

                    var fullIframeSrc = iframeSrc.startsWith('http') ? iframeSrc : 'https:' + iframeSrc;
                    console.log('[VidSrc] Iframe URL: ' + fullIframeSrc);

                    return getText(fullIframeSrc, { headers: { referer: 'https://vsrc.su/' } })
                        .then(function(iframeHtml) {
                            console.log('[VidSrc] Iframe response length: ' + iframeHtml.length);
                            var srcMatch = iframeHtml.match(/src:\s*['"]([^'"]+)['"]/i);
                            var prorcpSrc = srcMatch ? srcMatch[1] : '';
                            if (!prorcpSrc) {
                                console.log('[VidSrc] No prorcp src found (page might be blocked)');
                                return [];
                            }

                            return getText('https://cloudnestra.com' + prorcpSrc, {
                                headers: { referer: 'https://cloudnestra.com/' }
                            })
                            .then(function(cloudHtml) {
                                var divMatch = cloudHtml.match(/<div id="([^"]+)"[^>]*style=["']display\s*:\s*none;?["'][^>]*>([a-zA-Z0-9:\/.,{}\-_=+ ]+)<\/div>/i);
                                var divId = divMatch ? divMatch[1] : '';
                                var divText = divMatch ? divMatch[2] : '';
                                if (!divId || !divText) {
                                    console.log('[VidSrc] No encrypted div found');
                                    return [];
                                }

                                return getJson('https://enc-dec.app/api/dec-cloudnestra', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ text: divText, div_id: divId })
                                })
                                .then(function(decrypted) {
                                    var urls = (decrypted && decrypted.result) || [];
                                    if (!Array.isArray(urls)) return [];

                                    // Parse each m3u8 to detect quality
                                    var hdrs = {
                                        referer: 'https://cloudnestra.com/',
                                        origin: 'https://cloudnestra.com',
                                        'User-Agent': 'Mozilla/5.0'
                                    };

                                    var qualityPromises = urls.map(function(url) {
                                        if (!url) return Promise.resolve('Auto');
                                        return fetch(url, { headers: hdrs })
                                            .then(function(r) { return r.text(); })
                                            .then(function(m3u8) {
                                                // Look for RESOLUTION in master playlist
                                                var resolutions = [];
                                                var re = /RESOLUTION=(\d+)x(\d+)/g;
                                                var m;
                                                while ((m = re.exec(m3u8)) !== null) {
                                                    resolutions.push(parseInt(m[2]));
                                                }
                                                if (resolutions.length === 0) return 'Auto';
                                                var maxRes = Math.max.apply(null, resolutions);
                                                if (maxRes >= 2160) return '4K';
                                                if (maxRes >= 1080) return '1080p';
                                                if (maxRes >= 720) return '720p';
                                                return maxRes + 'p';
                                            })
                                            .catch(function() { return 'Auto'; });
                                    });

                                    return Promise.all(qualityPromises).then(function(qualities) {
                                        var streams = urls.map(function(url, index) {
                                            if (!url) return null;
                                            var q = qualities[index] || 'Auto';
                                            return {
                                                name: 'VidSrc - Server ' + (index + 1) + ' ' + q,
                                                title: 'VidSrc Server ' + (index + 1),
                                                url: url,
                                                quality: q,
                                                headers: {
                                                    referer: 'https://cloudnestra.com/',
                                                    origin: 'https://cloudnestra.com'
                                                },
                                                provider: 'vidsrc'
                                            };
                                        }).filter(Boolean);

                                        console.log('[VidSrc] Found ' + streams.length + ' stream(s)');
                                        return streams;
                                    });
                                });
                            });
                        });
                });
        })
        .catch(function(err) {
            console.log('[VidSrc] Error: ' + err.message);
            return [];
        });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams };
} else {
    global.getStreams = getStreams;
}
