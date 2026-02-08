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
    let cleaned = source.trim();
    
    // Remove eval wrapper if present
    if (cleaned.startsWith('eval(')) {
        cleaned = cleaned.substring(5, cleaned.length - 1);
    }
    
    // Remove function wrapper
    if (cleaned.includes('}(')) {
        cleaned = cleaned.substring(cleaned.indexOf('}(') + 2);
        if (cleaned.endsWith(')')) {
            cleaned = cleaned.substring(0, cleaned.length - 1);
        }
    }

    // Try multiple pattern variations
    const patterns = [
        /^['"](.+?)['"],(\d+),(\d+),['"](.+?)['"]\.split\(['|"]\|['|"]\)/,
        /^'(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)/,
        /^\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)\)/,
        /,'(.*?)',(\d+),(\d+),'(.*?)'\.split/
    ];

    for (const pattern of patterns) {
        const match = pattern.exec(cleaned);
        if (match) {
            return {
                payload: match[1],
                radix: parseInt(match[2]),
                count: parseInt(match[3]),
                symtab: match[4].split("|")
            };
        }
    }

    throw new Error("Could not parse packed JavaScript data");
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
            console.error('[HiCherri Unpack] Error:', error.message);
        }
        throw error;
    }
}

// ==================== EXTRACTION UTILITIES ====================

/**
 * Find matching closing parenthesis
 */
function findClosingParen(str, startIndex) {
    let count = 0;
    for (let i = startIndex; i < str.length; i++) {
        if (str[i] === '(') count++;
        else if (str[i] === ')') {
            count--;
            if (count === 0) return i;
        }
    }
    return -1;
}

/**
 * Extract packed JavaScript wrapper from page content
 */
function extractPackedWrapper(data) {
    const funcIndex = data.indexOf('function(p,a,c,k,e,d)');
    if (funcIndex === -1) return null;
    
    // Find eval( or fallback to nearest (
    let wrapperStart = data.lastIndexOf('eval(', funcIndex);
    if (wrapperStart === -1) {
        wrapperStart = data.lastIndexOf('(', funcIndex);
    }
    
    if (wrapperStart === -1) return null;
    
    const closingIndex = findClosingParen(data, wrapperStart);
    if (closingIndex === -1) return null;
    
    return data.substring(wrapperStart, closingIndex + 1);
}

/**
 * Validate and clean M3U8 URL
 */
function validateM3U8URL(url) {
    if (!url) return null;
    
    // Clean URL (remove trailing characters)
    const cleaned = url.split(/[\s'"<]/)[0];
    
    // Validate URL format
    if (!cleaned.startsWith('http://') && !cleaned.startsWith('https://')) {
        return null;
    }
    
    return cleaned;
}

// ==================== EXTRACTION METHODS ====================

/**
 * Method 1: JWPlayer direct configuration
 */
function extractJWPlayerDirect(data) {
    const pattern = /jwplayer\(['"][\w-]+['"]\)\.setup\(\{[\s\S]*?sources:\s*\[\s*\{\s*file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/;
    const match = data.match(pattern);
    
    if (match && match[1]) {
        const url = validateM3U8URL(match[1]);
        if (url) {
            if (CONFIG.debug) console.log('[HiCherri] Method 1: JWPlayer direct - Success');
            return url;
        }
    }
    
    return null;
}

/**
 * Method 2: Unpacked JavaScript
 */
function extractFromPacked(data) {
    const packedWrapper = extractPackedWrapper(data);
    if (!packedWrapper) return null;
    
    try {
        const unpacked = unpack(packedWrapper);
        
        if (!unpacked.includes('m3u8')) {
            if (CONFIG.debug) console.log('[HiCherri] Method 2: No m3u8 in unpacked code');
            return null;
        }
        
        // Try multiple M3U8 patterns
        const patterns = [
            /file:\s*['"]([^'"]*\.m3u8[^'"]*)['"]/,
            /sources:\s*\[\s*\{\s*file:\s*['"]([^'"]*\.m3u8[^'"]*)['"]/,
            /(https?:\/\/[^\s'"<>{}]+?\.m3u8[^\s'"<>{}]*)/,
            /['"]([^'"]*\.m3u8[^'"]*)['"]/,
            /([^\s'"<>{}]*\.m3u8[^\s'"<>{}]*)/
        ];
        
        for (const pattern of patterns) {
            const match = unpacked.match(pattern);
            if (match && match[1]) {
                const url = validateM3U8URL(match[1]);
                if (url) {
                    if (CONFIG.debug) console.log('[HiCherri] Method 2: Packed script - Success');
                    return url;
                }
            }
        }
    } catch (error) {
        if (CONFIG.debug) console.log('[HiCherri] Method 2: Unpack failed -', error.message);
    }
    
    return null;
}

/**
 * Method 3: JWPlayer setup in page
 */
function extractJWPlayerSetup(data) {
    const pattern = /file:\s*['"]([^'"]*\.m3u8[^'"]*)['"]/;
    const match = data.match(pattern);
    
    if (match && match[1]) {
        const url = validateM3U8URL(match[1]);
        if (url) {
            if (CONFIG.debug) console.log('[HiCherri] Method 3: JWPlayer setup - Success');
            return url;
        }
    }
    
    return null;
}

/**
 * Method 4: Data attributes
 */
function extractFromDataAttributes($) {
    const playerElement = $('#vplayer, [data-setup], .jwplayer, .video-player').first();
    if (!playerElement.length) return null;
    
    const dataSetup = playerElement.attr('data-setup') || playerElement.attr('data-url');
    if (!dataSetup) return null;
    
    try {
        const setupData = JSON.parse(dataSetup);
        if (setupData.sources && Array.isArray(setupData.sources)) {
            for (const source of setupData.sources) {
                if (source.file && source.file.includes('.m3u8')) {
                    const url = validateM3U8URL(source.file);
                    if (url) {
                        if (CONFIG.debug) console.log('[HiCherri] Method 4: Data attributes - Success');
                        return url;
                    }
                }
            }
        }
    } catch (error) {
        // Not valid JSON, continue
    }
    
    return null;
}

/**
 * Method 5: Generic M3U8 search
 */
function extractGenericM3U8(data) {
    const pattern = /https?:\/\/[a-zA-Z0-9:\/\.\-_?=&%~]+\.m3u8[^\s'"<]*/g;
    const matches = data.match(pattern);
    
    if (matches && matches.length > 0) {
        for (const match of matches) {
            const url = validateM3U8URL(match);
            if (url) {
                if (CONFIG.debug) console.log('[HiCherri] Method 5: Generic search - Success');
                return url;
            }
        }
    }
    
    return null;
}

// ==================== MAIN EXTRACTOR ====================

/**
 * Extract M3U8 stream URL from HiCherri embed page
 * @param {string} url - HiCherri embed URL
 * @returns {Promise<Object>} Extraction result with sources and media URL
 */
async function extractHiCherri(url) {
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
            () => extractJWPlayerDirect(data),
            () => extractFromPacked(data),
            () => extractJWPlayerSetup(data),
            () => extractFromDataAttributes($),
            () => extractGenericM3U8(data)
        ];

        for (const method of methods) {
            const m3u8URL = method();
            if (m3u8URL) {
                return {
                    success: true,
                    sources: [{
                        quality: 'default',
                        url: m3u8URL,
                        isM3U8: true
                    }],
                    media: m3u8URL
                };
            }
        }

        throw new Error("M3U8 URL not found using any extraction method");
    } catch (error) {
        if (CONFIG.debug) {
            console.error('[HiCherri] Extraction error:', error.message);
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
 * Check if URL is a HiCherri URL
 * @param {string} url - URL to check
 * @returns {boolean}
 */
function isHiCherriURL(url) {
    return url && url.includes('hicherri.com');
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
            // Only process HiCherri URLs
            if (!isHiCherriURL(server.url)) {
                return server;
            }

            try {
                if (CONFIG.debug) {
                    console.log(`[HiCherri] Processing: ${server.url}`);
                }
                
                const extraction = await extractHiCherri(server.url);
                
                if (extraction.success && extraction.media) {
                    return {
                        ...server,
                        media: extraction.media,
                        sources: extraction.sources,
                        type: 'HiCherri',
                        quality: 'HD',
                        isExtracted: true
                    };
                }
                
                if (CONFIG.debug) {
                    console.log(`[HiCherri] Failed: ${extraction.error || 'No media found'}`);
                }
                
                return server;
            } catch (error) {
                if (CONFIG.debug) {
                    console.error(`[HiCherri] Exception:`, error.message);
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
    extractHiCherri,
    isHiCherriURL,
    enhanceServerWithMedia,
    enableDebug,
    disableDebug,
    unpack,
    Unbaser
};