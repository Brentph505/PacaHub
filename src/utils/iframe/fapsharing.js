const axios = require('axios');
const cheerio = require('cheerio');

// ==================== CONFIGURATION ====================

const CONFIG = {
    timeout: 10000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    debug: false // Set to true for detailed logging
};

// ==================== UTILITY FUNCTIONS ====================

/**
 * Check if URL is a FapSharing URL
 */
function isFapSharingURL(url) {
    if (!url) return false;
    return url.includes('fapsharing.com');
}

/**
 * Validate and clean video URL
 */
function validateVideoURL(url) {
    if (!url) return null;
    
    // Ensure URL is complete
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return null;
    }
    
    return url.trim();
}

/**
 * Create success result object
 */
function createSuccessResult(url, isM3U8 = false) {
    return {
        success: true,
        sources: [{
            quality: 'default',
            url: url,
            isM3U8: isM3U8
        }],
        media: url
    };
}

// ==================== UNPACKER UTILITY ====================

/**
 * Unbaser class for decoding packed JavaScript
 */
class Unbaser {
    constructor(base) {
        this.ALPHABET = {
            62: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
            95: "' !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'"
        };
        
        this.base = base;
        this.dictionary = {};
        
        if (36 < base && base < 62) {
            this.ALPHABET[base] = this.ALPHABET[base] || this.ALPHABET[62].substr(0, base);
        }
        
        if (2 <= base && base <= 36) {
            this.unbase = (value) => parseInt(value, base);
        } else {
            [...this.ALPHABET[base]].forEach((cipher, index) => {
                this.dictionary[cipher] = index;
            });
            this.unbase = this._dictunbaser.bind(this);
        }
    }

    _dictunbaser(value) {
        let result = 0;
        [...value].reverse().forEach((cipher, index) => {
            result += Math.pow(this.base, index) * this.dictionary[cipher];
        });
        return result;
    }
}

/**
 * Parse packed JavaScript arguments
 */
function parsePackedArgs(source) {
    const pattern = /}\('(.*)', *(\d+), *(\d+), *'(.*)'\.split\('\|'\)/;
    const match = pattern.exec(source);
    
    if (!match) {
        throw new Error("Could not parse packed JavaScript data");
    }
    
    return {
        payload: match[1],
        radix: parseInt(match[2]),
        count: parseInt(match[3]),
        symtab: match[4].split("|")
    };
}

/**
 * Unpack JavaScript code packed with Dean Edwards' p.a.c.k.e.r
 */
function unpack(source) {
    try {
        const { payload, symtab, radix, count } = parsePackedArgs(source);
        
        if (count !== symtab.length) {
            throw new Error("Malformed symbol table");
        }
        
        const unbaser = new Unbaser(radix);
        
        const lookup = (match) => symtab[unbaser.unbase(match)] || match;
        
        return payload.replace(/\b\w+\b/g, lookup);
    } catch (error) {
        if (CONFIG.debug) {
            console.error('[FapSharing Unpack] Error:', error.message);
        }
        throw error;
    }
}

// ==================== OBFUSCATION HANDLING ====================

/**
 * Extract video URLs from FapSharing's packed/obfuscated JavaScript
 * FapSharing uses a packer that encodes the video configuration
 */
function extractFromPackedJS(html) {
    try {
        if (CONFIG.debug) {
            console.log('[FapSharing] Attempting to extract from packed JavaScript');
        }

        // First, find and unpack packed JavaScript
        const packedPattern = /<script[^>]*>\s*(eval\(function\(p,a,c,k,e,d.*?\)[\s\S]*?)<\/script>/g;
        let packedMatch;
        const unpackedScripts = [];

        while ((packedMatch = packedPattern.exec(html)) !== null) {
            try {
                const unpacked = unpack(packedMatch[1]);
                unpackedScripts.push(unpacked);
                if (CONFIG.debug) {
                    console.log('[FapSharing] Successfully unpacked script');
                }
            } catch (error) {
                if (CONFIG.debug) {
                    console.log('[FapSharing] Failed to unpack script:', error.message);
                }
            }
        }

        // Also check for direct eval calls in scripts
        const $ = cheerio.load(html);
        const scripts = $('script');
        for (let i = 0; i < scripts.length; i++) {
            const scriptContent = $(scripts[i]).html();
            if (scriptContent && scriptContent.includes('eval(function(p,a,c,k,e,d')) {
                try {
                    const unpacked = unpack(scriptContent);
                    unpackedScripts.push(unpacked);
                    if (CONFIG.debug) {
                        console.log('[FapSharing] Successfully unpacked inline script');
                    }
                } catch (error) {
                    if (CONFIG.debug) {
                        console.log('[FapSharing] Failed to unpack inline script:', error.message);
                    }
                }
            }
        }

        // Search in unpacked scripts first
        for (const unpacked of unpackedScripts) {
            // Look for M3U8 URLs
            const m3u8Matches = unpacked.match(/https?:\/\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi);
            if (m3u8Matches && m3u8Matches.length > 0) {
                if (CONFIG.debug) {
                    console.log('[FapSharing] Found M3U8 in unpacked JS:', m3u8Matches.slice(0, 3));
                }
                for (const url of m3u8Matches) {
                    if (validateVideoURL(url)) {
                        return {
                            success: true,
                            url: url,
                            mediaType: 'm3u8',
                            source: 'unpacked_js'
                        };
                    }
                }
            }

            // Look for config objects in unpacked code
            const configMatch = unpacked.match(/var\s+o\s*=\s*\{[\s\S]*?\};/);
            if (configMatch) {
                const urlMatches = configMatch[0].match(/(https?:\/\/[^"'<>]+)/g);
                if (urlMatches && urlMatches.length > 0) {
                    const videoUrls = urlMatches.filter(u => 
                        u.match(/\.(m3u8|mp4|mkv|flv|webm)(?:[?#]|$)/i)
                    );
                    if (videoUrls.length > 0) {
                        if (CONFIG.debug) {
                            console.log('[FapSharing] Found video URLs in unpacked config:', videoUrls.slice(0, 2));
                        }
                        return {
                            success: true,
                            url: videoUrls[0],
                            mediaType: videoUrls[0].includes('.m3u8') ? 'm3u8' : 'video',
                            alternateUrls: videoUrls,
                            source: 'unpacked_config'
                        };
                    }
                }
            }
        }

        // Fallback: Search in raw HTML (original logic)
        const hlsPatterns = [
            /https?:\/\/[^\s"'<>]*cdn[^\s"'<>]*\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*stream[^\s"'<>]*\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*hls[^\s"'<>]*\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+\/.*\.m3u8[^\s"'<>]*/gi
        ];

        for (const pattern of hlsPatterns) {
            const matches = html.match(pattern);
            if (matches && matches.length > 0) {
                if (CONFIG.debug) {
                    console.log('[FapSharing] Found HLS URLs in raw HTML:', matches.slice(0, 3));
                }
                // Return the first valid match
                for (const url of matches) {
                    if (validateVideoURL(url)) {
                        return {
                            success: true,
                            url: url,
                            mediaType: 'm3u8',
                            source: 'raw_html'
                        };
                    }
                }
            }
        }

        // Pattern 2: Extract configuration object with URLs
        // var o={"16":"https://...","1f":"https://..."}
        const configMatch = html.match(/var\s+o\s*=\s*\{[\s\S]*?\};/);
        if (configMatch) {
            if (CONFIG.debug) {
                console.log('[FapSharing] Found config object in raw HTML');
            }
            // Extract all URLs from the config
            const urlMatches = configMatch[0].match(/(https?:\/\/[^"'<>]+)/g);
            if (urlMatches && urlMatches.length > 0) {
                // Filter for video URLs (m3u8, mp4, etc.)
                const videoUrls = urlMatches.filter(u => 
                    u.match(/\.(m3u8|mp4|mkv|flv|webm)(?:[?#]|$)/i)
                );
                if (videoUrls.length > 0) {
                    if (CONFIG.debug) {
                        console.log('[FapSharing] Found video URLs in raw config:', videoUrls.slice(0, 2));
                    }
                    return {
                        success: true,
                        url: videoUrls[0],
                        mediaType: videoUrls[0].includes('.m3u8') ? 'm3u8' : 'video',
                        alternateUrls: videoUrls,
                        source: 'raw_config'
                    };
                }
            }
        }

        return null;
    } catch (err) {
        if (CONFIG.debug) {
            console.log('[FapSharing] Error extracting from packed JS:', err.message);
        }
        return null;
    }
}

/**
 * Extract video configuration from HTML scripts
 */
function extractVideoConfigFromScripts(html) {
    try {
        const $ = cheerio.load(html);
        const scripts = $('script');

        for (let i = 0; i < scripts.length; i++) {
            const scriptContent = $(scripts[i]).html();
            if (!scriptContent) continue;

            // Look for M3U8/HLS URLs
            const m3u8Matches = scriptContent.match(/https?:\/\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi);
            if (m3u8Matches && m3u8Matches.length > 0) {
                if (CONFIG.debug) {
                    console.log('[FapSharing] Found M3U8 in script tags');
                }
                for (const url of m3u8Matches) {
                    if (validateVideoURL(url)) {
                        return {
                            success: true,
                            url: url,
                            mediaType: 'm3u8',
                            source: 'script_tags'
                        };
                    }
                }
            }

            // Look for other video formats
            const videoMatches = scriptContent.match(/https?:\/\/[^\s"'<>]*\.(?:mp4|mkv|flv|webm)[^\s"'<>]*/gi);
            if (videoMatches && videoMatches.length > 0) {
                // Skip ad/tracking URLs
                const cleanUrls = videoMatches.filter(u => 
                    !u.includes('doubleclick') && 
                    !u.includes('google') && 
                    !u.includes('fbcdn')
                );
                
                if (cleanUrls.length > 0) {
                    if (CONFIG.debug) {
                        console.log('[FapSharing] Found video URLs in script');
                    }
                    return {
                        success: true,
                        url: cleanUrls[0],
                        mediaType: 'video',
                        source: 'script_tags'
                    };
                }
            }

            // Look for JSON configurations with URLs
            const jsonPatterns = [
                /"(?:url|src|file|sources|hls[2-4]?)"\s*:\s*"([^"]+\.(?:m3u8|mp4|mkv|flv)[^"]*)"/gi,
                /(?:url|src|file|sources)\s*:\s*["']([^\s"']+\.(?:m3u8|mp4|mkv|flv)[^\s"']*)/gi
            ];

            for (const pattern of jsonPatterns) {
                let match;
                while ((match = pattern.exec(scriptContent)) !== null) {
                    if (match[1]) {
                        const cleanUrl = validateVideoURL(match[1]);
                        if (cleanUrl && !cleanUrl.includes('doubleclick')) {
                            if (CONFIG.debug) {
                                console.log('[FapSharing] Found URL in JSON pattern');
                            }
                            return {
                                success: true,
                                url: match[1],
                                mediaType: match[1].includes('.m3u8') ? 'm3u8' : 'video',
                                source: 'json_config'
                            };
                        }
                    }
                }
            }
        }

        return null;
    } catch (err) {
        if (CONFIG.debug) {
            console.log('[FapSharing] Error extracting from scripts:', err.message);
        }
        return null;
    }
}



/**
 * Extract video URL from FapSharing embed page
 * Note: FapSharing uses blob URLs created by JavaScript runtime.
 */
async function extractFapSharingVideo(url) {
    try {
        if (CONFIG.debug) {
            console.log(`[FapSharing] Extracting from: ${url}`);
        }

        const options = {
            headers: {
                'User-Agent': CONFIG.userAgent,
                'Referer': url,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'DNT': '1',
                'Connection': 'keep-alive'
            },
            timeout: CONFIG.timeout,
            validateStatus: () => true,
            maxRedirects: 5
        };

        const { data } = await axios.get(url, options);
        
        if (!data) {
            if (CONFIG.debug) console.log('[FapSharing] No response data');
            return { success: false, error: 'No response data' };
        }

        const $ = cheerio.load(data);

        // Fetch external scripts that might contain video code
        const externalScripts = await fetchExternalScripts(url, $);
        
        // Combine HTML and external scripts for searching
        const allContent = [data, ...externalScripts];

        // Method 1: Try extracting from packed/obfuscated JavaScript
        for (const content of allContent) {
            const packedExtraction = extractFromPackedJS(content);
            if (packedExtraction && packedExtraction.success) {
                if (CONFIG.debug) {
                    console.log(`[FapSharing] Method 1 (Packed JS): Found ${packedExtraction.mediaType}`);
                }
                return createSuccessResult(packedExtraction.url, packedExtraction.mediaType === 'm3u8');
            }
        }

        // Method 2: Extract from script tags
        for (const content of allContent) {
            const scriptExtraction = extractVideoConfigFromScripts(content);
            if (scriptExtraction && scriptExtraction.success) {
                if (CONFIG.debug) {
                    console.log(`[FapSharing] Method 2 (Scripts): Found ${scriptExtraction.mediaType}`);
                }
                return createSuccessResult(scriptExtraction.url, scriptExtraction.mediaType === 'm3u8');
            }
        }

        // Method 3: Try extracting from video/source elements
        let videoElement = $('video');
        if (videoElement.length) {
            let videoUrl = videoElement.attr('src');
            
            // If no direct src, check for source tags
            if (!videoUrl) {
                const sourceTag = videoElement.find('source').first();
                videoUrl = sourceTag.attr('src');
            }
            
            if (videoUrl) {
                if (CONFIG.debug) console.log(`[FapSharing] Method 3: Found video element src: ${videoUrl}`);
                
                // If it's a blob URL, note it but continue searching
                if (videoUrl.includes('blob:')) {
                    if (CONFIG.debug) console.log('[FapSharing] Method 3: Blob URL detected - searching for fallback');
                } else {
                    // Otherwise validate and return the direct URL
                    const cleanUrl = validateVideoURL(videoUrl);
                    if (cleanUrl) {
                        if (CONFIG.debug) console.log('[FapSharing] Method 3: Direct video URL - Success');
                        return createSuccessResult(cleanUrl, videoUrl.includes('.m3u8'));
                    }
                }
            }
        }

        // Method 4: Search for any HTTPS URLs in script content (last resort)
        for (const content of allContent) {
            const content$ = content === data ? $ : cheerio.load(content);
            const scripts = content$.is('script') ? content$ : content$('script');
            
            for (let script of scripts) {
                const scriptContent = content$(script).html() || (typeof content === 'string' ? content : '');
                if (!scriptContent) continue;

                // Look for full M3U8 URLs (most likely to be video streaming)
                const m3u8Urls = scriptContent.match(/https?:\/\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi);
                if (m3u8Urls && m3u8Urls.length > 0) {
                    for (const url of m3u8Urls) {
                        const cleanUrl = validateVideoURL(url);
                        if (cleanUrl && !cleanUrl.includes('doubleclick')) {
                            if (CONFIG.debug) console.log('[FapSharing] Method 4: M3U8 URL found');
                            return createSuccessResult(cleanUrl, true);
                        }
                    }
                }
            }
        }

        // Fallback: Return the embed URL itself
        // FapSharing embed URLs can often be played directly
        if (CONFIG.debug) {
            console.log(`[FapSharing] All methods failed - using embed URL as fallback`);
        }

        return { 
            success: false, 
            error: 'Could not extract M3U8 URL',
            fallback: true,
            embedUrl: url,
            suggestion: 'Use embed URL directly or consider using headless browser (Puppeteer)'
        };

    } catch (error) {
        if (CONFIG.debug) {
            console.error('[FapSharing] Error:', error.message);
        }
        return { success: false, error: error.message };
    }
}

/**
 * Resolve relative URLs to absolute URLs
 */
function resolveUrl(baseUrl, relativeUrl) {
    try {
        return new URL(relativeUrl, baseUrl).href;
    } catch (error) {
        return null;
    }
}

/**
 * Fetch and search external scripts for video URLs
 */
async function fetchExternalScripts(baseUrl, $) {
    const scripts = $('script[src]');
    const externalContents = [];
    
    for (let i = 0; i < scripts.length; i++) {
        const src = $(scripts[i]).attr('src');
        if (!src) continue;
        
        // Skip analytics, ads, and known non-video scripts
        if (src.includes('google') || 
            src.includes('analytics') || 
            src.includes('tag.min.js') ||
            src.includes('yandex') ||
            src.includes('facebook') ||
            src.includes('doubleclick')) {
            continue;
        }
        
        // Focus on scripts that might contain video code
        // Specifically look for f.txt or similar player scripts
        const shouldFetch = src.includes('f.txt') || 
                           src.includes('player') || 
                           src.includes('video') || 
                           src.includes('embed') ||
                           (!src.includes('/') && src.length < 20) || // Short filenames
                           src.match(/\.(js|txt)$/); // JS or TXT files
        
        if (shouldFetch) {
            const absoluteUrl = resolveUrl(baseUrl, src);
            if (absoluteUrl) {
                try {
                    if (CONFIG.debug) {
                        console.log(`[FapSharing] Fetching external script: ${absoluteUrl}`);
                    }
                    
                    const scriptResponse = await axios.get(absoluteUrl, {
                        headers: {
                            'User-Agent': CONFIG.userAgent,
                            'Referer': baseUrl
                        },
                        timeout: CONFIG.timeout
                    });
                    
                    externalContents.push(scriptResponse.data);
                    
                    if (CONFIG.debug) {
                        console.log(`[FapSharing] Successfully fetched script, length: ${scriptResponse.data.length}`);
                    }
                    
                } catch (error) {
                    if (CONFIG.debug) {
                        console.log(`[FapSharing] Failed to fetch script ${absoluteUrl}:`, error.message);
                    }
                }
            }
        }
    }
    
    return externalContents;
}

// ==================== MAIN EXTRACTION FUNCTION ====================

/**
 * Extract media from FapSharing URL
 */
async function extractFapSharing(url) {
    try {
        if (!isFapSharingURL(url)) {
            return { success: false, error: 'Not a FapSharing URL' };
        }

        return await extractFapSharingVideo(url);
    } catch (error) {
        if (CONFIG.debug) {
            console.error('[FapSharing] Extraction failed:', error.message);
        }
        return { success: false, error: error.message };
    }
}

// ==================== SERVER ENHANCEMENT ====================

/**
 * Enhance server objects with FapSharing media extraction
 */
async function enhanceServerWithMedia(servers) {
    if (!Array.isArray(servers) || servers.length === 0) {
        return servers;
    }

    // Filter only FapSharing servers
    const fapSharingServers = servers.filter(server => 
        server && server.type === 'FapSharing' && server.url
    );

    if (fapSharingServers.length === 0) {
        return servers;
    }

    // Process each FapSharing server
    const enhancedServers = await Promise.all(
        servers.map(async (server) => {
            if (!server || server.type !== 'FapSharing' || !server.url) {
                return server;
            }

            try {
                const extraction = await extractFapSharing(server.url);

                if (extraction.success && extraction.media) {
                    return {
                        ...server,
                        media: extraction.media,
                        sources: extraction.sources,
                        type: 'FapSharing',
                        quality: 'HD',
                        isExtracted: true
                    };
                }

                // Fallback: Return the embed URL itself as playable media
                if (CONFIG.debug) {
                    console.log(`[FapSharing] Using fallback: embed URL as media source`);
                }

                return {
                    ...server,
                    media: server.url,
                    sources: [{
                        quality: 'default',
                        url: server.url,
                        isM3U8: false,
                        isFapSharingEmbed: true,
                        note: 'FapSharing embed URL - player will handle JavaScript streams'
                    }],
                    type: 'FapSharing',
                    isExtracted: false,
                    hasWarning: true,
                    warning: 'Direct M3U8 extraction not available. Using embed URL.'
                };
            } catch (error) {
                if (CONFIG.debug) {
                    console.error(`[FapSharing] Exception:`, error.message);
                }
                
                // Still return a working server with the embed URL as fallback
                return {
                    ...server,
                    media: server.url,
                    sources: [{
                        quality: 'default',
                        url: server.url,
                        isFapSharingEmbed: true
                    }],
                    hasWarning: true
                };
            }
        })
    );

    return enhancedServers;
}

// ==================== DEBUG FUNCTIONS ====================

/**
 * Enable debug logging
 */
function enableDebug() {
    CONFIG.debug = true;
}

/**
 * Disable debug logging
 */
function disableDebug() {
    CONFIG.debug = false;
}

// ==================== EXPORTS ====================

module.exports = {
    extractFapSharing,
    isFapSharingURL,
    enhanceServerWithMedia,
    enableDebug,
    disableDebug
};
