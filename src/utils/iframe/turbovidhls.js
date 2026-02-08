const axios = require('axios');
const cheerio = require('cheerio');

// ==================== CONFIGURATION ====================

const CONFIG = {
    timeout: 10000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    debug: false // Set to true for detailed logging
};

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
            console.error('[TurboVid Unpack] Error:', error.message);
        }
        throw error;
    }
}

// ==================== EXTRACTION UTILITIES ====================

/**
 * Validate and clean M3U8 URL
 */
function validateM3U8URL(url) {
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
function createSuccessResult(url, isM3U8 = true) {
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

// ==================== EXTRACTION METHODS ====================

/**
 * Method 1: Extract from data-hash attribute
 */
function extractFromDataHash($) {
    const dataHash = $('#video_player').attr('data-hash');
    
    if (dataHash && dataHash.includes('.m3u8')) {
        const url = validateM3U8URL(dataHash);
        if (url) {
            if (CONFIG.debug) console.log('[TurboVid] Method 1: Data hash - Success');
            return url;
        }
    }
    
    return null;
}

/**
 * Method 2: Extract from JavaScript variable
 */
function extractFromJSVariable(data) {
    const pattern = /var urlPlay\s*=\s*['"]([^'"]+\.m3u8[^'"]*)['"]/;
    const match = data.match(pattern);
    
    if (match && match[1]) {
        const url = validateM3U8URL(match[1]);
        if (url) {
            if (CONFIG.debug) console.log('[TurboVid] Method 2: JS variable - Success');
            return url;
        }
    }
    
    return null;
}

/**
 * Method 3: Extract from packed/obfuscated script
 */
function extractFromPacked(data) {
    const pattern = /<script[^>]*>\s*(eval\(function\(p,a,c,k,e,d.*?\)[\s\S]*?)<\/script>/;
    const match = data.match(pattern);
    
    if (!match) return null;
    
    try {
        const unpacked = unpack(match[1]);
        
        // Look for m3u8 URLs in unpacked code
        const m3u8Pattern = /['"]([^'"]*\.m3u8[^'"]*)['"]/;
        const m3u8Match = unpacked.match(m3u8Pattern);
        
        if (m3u8Match && m3u8Match[1]) {
            const url = validateM3U8URL(m3u8Match[1]);
            if (url) {
                if (CONFIG.debug) console.log('[TurboVid] Method 3: Packed script - Success');
                return url;
            }
        }
    } catch (error) {
        if (CONFIG.debug) console.log('[TurboVid] Method 3: Unpack failed -', error.message);
    }
    
    return null;
}

/**
 * Method 4: Extract from JWPlayer sources array
 */
function extractFromJWPlayerSources(data) {
    const pattern = /sources:\s*\[\s*\{\s*file:\s*['"]([^'"]+)['"]/;
    const match = data.match(pattern);
    
    if (match && match[1]) {
        const url = validateM3U8URL(match[1]);
        if (url) {
            if (CONFIG.debug) console.log('[TurboVid] Method 4: JWPlayer sources - Success');
            return url;
        }
    }
    
    return null;
}

/**
 * Method 5: Generic M3U8 search
 */
function extractGenericM3U8(data) {
    const pattern = /https?:\/\/[^\s'"<>]+\.m3u8[^\s'"<>]*/g;
    const matches = data.match(pattern);
    
    if (matches && matches.length > 0) {
        for (const match of matches) {
            const url = validateM3U8URL(match);
            if (url) {
                if (CONFIG.debug) console.log('[TurboVid] Method 5: Generic search - Success');
                return url;
            }
        }
    }
    
    return null;
}

// ==================== MAIN EXTRACTOR ====================

/**
 * Extract M3U8 stream URL from TurboVid embed page
 * @param {string} url - TurboVid embed URL
 * @returns {Promise<Object>} Extraction result with sources and media URL
 */
async function extractTurboVid(url) {
    const options = {
        headers: {
            'User-Agent': CONFIG.userAgent,
            'Referer': url
        },
        timeout: CONFIG.timeout
    };

    try {
        const { data } = await axios.get(url, options);
        const $ = cheerio.load(data);

        // Try extraction methods in order
        const methods = [
            () => extractFromDataHash($),
            () => extractFromJSVariable(data),
            () => extractFromPacked(data),
            () => extractFromJWPlayerSources(data),
            () => extractGenericM3U8(data)
        ];

        for (const method of methods) {
            const streamURL = method();
            if (streamURL) {
                // Check if it's an M3U8 URL
                const isM3U8 = streamURL.includes('.m3u8');
                return createSuccessResult(streamURL, isM3U8);
            }
        }

        throw new Error("Stream URL not found using any extraction method");
    } catch (error) {
        if (CONFIG.debug) {
            console.error('[TurboVid] Extraction error:', error.message);
        }
        
        return {
            success: false,
            error: error.message,
            sources: [],
            media: null
        };
    }
}

/**
 * Check if URL is a TurboVid URL
 * @param {string} url - URL to check
 * @returns {boolean}
 */
function isTurboVidURL(url) {
    if (!url) return false;
    return url.includes('turbovidhls.com') || 
           url.includes('turboviplay.com') || 
           url.includes('turbovid.com');
}

/**
 * Enhance server objects with extracted media URLs
 * @param {Array} servers - Array of server objects
 * @returns {Promise<Array>} Enhanced servers with media field
 */
async function enhanceServerWithMedia(servers) {
    if (!Array.isArray(servers) || servers.length === 0) {
        return servers;
    }

    const enhancedServers = await Promise.all(
        servers.map(async (server) => {
            // Only process TurboVid URLs
            if (!isTurboVidURL(server.url)) {
                return server;
            }

            try {
                if (CONFIG.debug) {
                    console.log(`[TurboVid] Processing: ${server.url}`);
                }
                
                const extraction = await extractTurboVid(server.url);
                
                if (extraction.success && extraction.media) {
                    return {
                        ...server,
                        media: extraction.media,
                        sources: extraction.sources,
                        type: 'TurboVid',
                        quality: 'HD',
                        isExtracted: true
                    };
                }
                
                if (CONFIG.debug) {
                    console.log(`[TurboVid] Failed: ${extraction.error || 'No media found'}`);
                }
                
                return server;
            } catch (error) {
                if (CONFIG.debug) {
                    console.error(`[TurboVid] Exception:`, error.message);
                }
                return server;
            }
        })
    );

    return enhancedServers;
}

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
    extractTurboVid,
    isTurboVidURL,
    enhanceServerWithMedia,
    enableDebug,
    disableDebug,
    unpack,
    Unbaser
};