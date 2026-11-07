'use strict';

/**
 * Turns TikTok usernames into something an American English TTS voice can say
 * naturally. The function is deliberately deterministic so the control panel can
 * show exactly what will be spoken before an announcement is queued.
 */

const ONES = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen'
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const ACRONYMS = new Set(['dj', 'mc', 'vip', 'tv', 'usa', 'uk', 'la', 'nyc', 'gif', 'tt']);
const COMPOUNDS = new Map([
    ['darkwolf', 'dark wolf'],
    ['coolguy', 'cool guy'],
    ['coolgirl', 'cool girl'],
    ['partyking', 'party king'],
    ['partyqueen', 'party queen'],
    ['bigboss', 'big boss'],
    ['topdj', 'top dj'],
    ['nightowl', 'night owl'],
    ['goodvibes', 'good vibes'],
    ['bestie', 'bestie'],
    ['tiktok', 'tik tok'],
    ['clouddisco', 'cloud disco']
]);

function underHundred(number) {
    if (number < 20) return ONES[number];
    const unit = number % 10;
    return TENS[Math.floor(number / 10)] + (unit ? `-${ONES[unit]}` : '');
}

function underThousand(number) {
    if (number < 100) return underHundred(number);
    const remainder = number % 100;
    return `${ONES[Math.floor(number / 100)]} hundred${remainder ? ` ${underHundred(remainder)}` : ''}`;
}

function cardinal(number) {
    const value = Math.max(0, Math.floor(Number(number) || 0));
    if (value < 1000) return underThousand(value);
    if (value < 1000000) {
        const remainder = value % 1000;
        return `${underThousand(Math.floor(value / 1000))} thousand${remainder ? ` ${underThousand(remainder)}` : ''}`;
    }
    if (value < 1000000000) {
        const remainder = value % 1000000;
        return `${underThousand(Math.floor(value / 1000000))} million${remainder ? ` ${cardinal(remainder)}` : ''}`;
    }
    return digits(number);
}

function digits(value) {
    return String(value).split('').map(character => ONES[Number(character)] || character).join(' ');
}

function year(number) {
    if (number === 2000) return 'two thousand';
    if (number % 1000 === 0) return `${underHundred(number / 1000)} thousand`;
    if (number % 100 === 0) return `${underHundred(number / 100)} hundred`;
    const first = Math.floor(number / 100);
    const last = number % 100;
    if (last === 0) return `${underHundred(first)} hundred`;
    if (last < 10) return `${underHundred(first)} oh ${ONES[last]}`;
    return `${underHundred(first)} ${underHundred(last)}`;
}

function pairs(value) {
    const text = String(value);
    if (text.length <= 2) return underHundred(Number(text));
    if (text.length % 2 !== 0) {
        const firstLength = text.length % 4 || (text.length > 4 ? 3 : 1);
        const first = Number(text.slice(0, firstLength));
        const remainder = text.slice(firstLength);
        const grouped = remainder.match(/.{1,2}/g) || [];
        return [underThousand(first), ...grouped.map(part => underHundred(Number(part)))].join(' ');
    }
    return (text.match(/.{1,2}/g) || []).map(part => underHundred(Number(part))).join(' ');
}

function readNumber(value, mode = 'smart') {
    const text = String(value).replace(/^0+(?=\d)/, '');
    if (!text) return 'zero';
    if (mode === 'digits') return digits(text);
    if (mode === 'cardinal') {
        return text.length <= 9 ? cardinal(Number(text)) : digits(text);
    }
    const number = Number(text);
    if (text.length === 4 && number >= 1900 && number <= 2099) return year(number);
    if (text.length <= 3) return cardinal(number);
    if (text.length <= 8) return pairs(text);
    // A long random numeric suffix is less annoying read as individual digits,
    // but this is a bounded fallback rather than the default for normal names.
    return digits(text);
}

function cleanWhitespace(value) {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function pronunciationKey(value) {
    return cleanWhitespace(value).replace(/^@+/, '').trim().toLocaleLowerCase('en-US');
}

function sanitizeSpoken(value, maximum = 160) {
    return cleanWhitespace(value)
        .replace(/[<>{}[\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maximum);
}

function splitCamel(value) {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

function titleWord(word) {
    if (!word) return '';
    if (ACRONYMS.has(word.toLocaleLowerCase('en-US'))) return word.toLocaleUpperCase('en-US');
    return word.charAt(0).toLocaleUpperCase('en-US') + word.slice(1).toLocaleLowerCase('en-US');
}

function tidyToken(token) {
    let value = token;
    // xX_darkwolf_Xx and xxdarkwolfxx are common decorative patterns.
    value = value.replace(/^x{1,4}(?=[a-z])/i, '');
    value = value.replace(/(?<=[a-z])x{1,4}$/i, '');
    const compound = COMPOUNDS.get(value.toLocaleLowerCase('en-US'));
    return compound || value;
}

function findOverride(raw, overrides) {
    const key = pronunciationKey(raw);
    if (!key) return '';
    if (Array.isArray(overrides)) {
        const match = overrides.find(item => pronunciationKey(item?.username) === key);
        return match ? sanitizeSpoken(match.spoken) : '';
    }
    if (overrides && typeof overrides === 'object') {
        const matchKey = Object.keys(overrides).find(candidate => pronunciationKey(candidate) === key);
        return matchKey ? sanitizeSpoken(overrides[matchKey]) : '';
    }
    return '';
}

/**
 * @param {string} raw
 * @param {{mode?: string, maxChars?: number, maxWords?: number}} options
 * @param {Array<{username: string, spoken: string}>|Object} overrides
 */
function normalizeUsername(raw, options = {}, overrides = []) {
    const original = cleanWhitespace(raw).replace(/^@+/, '');
    const manual = findOverride(original, overrides);
    if (manual) {
        return { original, spoken: manual, overridden: true, truncated: false };
    }

    let value = original
        .replace(/\uFE0F|\u200D/g, '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        // Emoji and pictographs must never reach the speech synthesizer.
        .replace(/\p{Extended_Pictographic}/gu, ' ')
        .replace(/[’']/g, '')
        .replace(/[._-]+/g, ' ')
        .replace(/[^A-Za-z0-9\s]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2');

    value = splitCamel(value);
    let words = cleanWhitespace(value).split(' ').filter(Boolean);
    while (words.length > 1 && /^x{1,4}$/i.test(words[0])) words.shift();
    while (words.length > 1 && /^x{1,4}$/i.test(words[words.length - 1])) words.pop();
    words = words.map(tidyToken).filter(Boolean);

    const mode = ['smart', 'digits', 'cardinal'].includes(options.mode) ? options.mode : 'smart';
    const spokenWords = [];
    for (const word of words) {
        const pieces = word.split(/(\d+)/).filter(Boolean);
        for (const piece of pieces) {
            if (/^\d+$/.test(piece)) spokenWords.push(...readNumber(piece, mode).split(' '));
            else spokenWords.push(...splitCamel(piece).split(' ').filter(Boolean));
        }
    }

    const maximumWords = Math.max(1, Math.min(24, Number(options.maxWords) || 8));
    const maximumChars = Math.max(8, Math.min(160, Number(options.maxChars) || 40));
    let truncated = spokenWords.length > maximumWords;
    let result = spokenWords.slice(0, maximumWords).map(titleWord).join(' ');
    if (result.length > maximumChars) {
        truncated = true;
        result = result.slice(0, maximumChars);
        const lastSpace = result.lastIndexOf(' ');
        if (lastSpace >= maximumChars * 0.55) result = result.slice(0, lastSpace);
    }
    result = sanitizeSpoken(result, maximumChars);
    if (!result) result = 'TikTok friend';
    return { original, spoken: result, overridden: false, truncated };
}

function normalizePronunciations(input) {
    if (!Array.isArray(input)) return [];
    const seen = new Set();
    const output = [];
    for (const item of input) {
        const username = cleanWhitespace(item?.username).replace(/^@+/, '').slice(0, 64);
        const spoken = sanitizeSpoken(item?.spoken, 120);
        const key = pronunciationKey(username);
        if (!key || !spoken || seen.has(key)) continue;
        seen.add(key);
        output.push({ username, spoken });
        if (output.length >= 100) break;
    }
    return output;
}

module.exports = {
    normalizeUsername,
    normalizePronunciations,
    sanitizeSpoken,
    pronunciationKey,
    readNumber
};
