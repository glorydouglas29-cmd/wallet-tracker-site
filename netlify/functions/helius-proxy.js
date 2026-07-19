// Netlify Function: proxies wallet lookups to Helius so the API key
// never reaches the browser. Key lives in Netlify env var HELIUS_API_KEY.
//
// Includes a lightweight in-memory cache and per-IP rate limiter. Both live
// in module scope, so they persist for the life of a warm function instance
// but reset on cold start and aren't shared across concurrent instances.
// That's good enough to absorb repeat lookups and casual hammering; if this
// ever needs to be bulletproof under real load, swap this for a shared store
// like Upstash Redis so every instance sees the same counters.

const CACHE_TTL_MS = 30 * 1000; // how long a response is considered fresh
const cache = new Map(); // key -> { data, status, expiresAt }

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30; // requests per IP per window
const rateLimits = new Map(); // ip -> { count, windowStart }

function pruneCache(){
  const now = Date.now();
  for(const [key, entry] of cache){
    if(entry.expiresAt < now) cache.delete(key);
  }
}

function checkRateLimit(ip){
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if(!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS){
    rateLimits.set(ip, { count: 1, windowStart: now });
    return { limited: false };
  }
  entry.count += 1;
  if(entry.count > RATE_LIMIT_MAX){
    const retryAfter = Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
    return { limited: true, retryAfter };
  }
  return { limited: false };
}

exports.handler = async (event) => {
  const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (!HELIUS_API_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'HELIUS_API_KEY is not set in Netlify environment variables.' }),
    };
  }

  // Netlify puts the real client IP first in x-forwarded-for.
  const ip = (event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown').split(',')[0].trim();
  const rl = checkRateLimit(ip);
  if(rl.limited){
    return {
      statusCode: 429,
      headers: { ...headers, 'Retry-After': String(rl.retryAfter) },
      body: JSON.stringify({ error: 'Too many requests. Please slow down.', retryAfterSeconds: rl.retryAfter }),
    };
  }

  const { type, address, ...extra } = event.queryStringParameters || {};

  if (!address) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing address parameter.' }) };
  }

  // Very light validation: Solana addresses are base58, 32-44 chars.
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid Solana address.' }) };
  }

  const cacheKey = `${type}:${address}:${new URLSearchParams(extra).toString()}`;
  pruneCache();
  const cached = cache.get(cacheKey);
  if(cached && cached.expiresAt > Date.now()){
    return {
      statusCode: cached.status,
      headers: { ...headers, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
      body: JSON.stringify(cached.data),
    };
  }

  try {
    let url, options;

    if (type === 'balances') {
      const page = extra.page ? `&page=${encodeURIComponent(extra.page)}` : '';
      url = `https://api.helius.xyz/v1/wallet/${address}/balances?api-key=${HELIUS_API_KEY}${page}`;
      options = { method: 'GET' };
    } else if (type === 'transactions') {
      const before = extra.before ? `&before=${encodeURIComponent(extra.before)}` : '';
      url = `https://api.helius.xyz/v1/wallet/${address}/history?api-key=${HELIUS_API_KEY}&limit=25${before}`;
      options = { method: 'GET' };
    } else if (type === 'balance-at') {
      // Diagnostic passthrough: forwards any extra query params (mint, timestamp,
      // datetime, slot, etc.) straight to Helius so we can confirm the real param
      // names against the live API before committing to a shape in the frontend.
      const forwarded = new URLSearchParams(extra).toString();
      url = `https://api.helius.xyz/v1/wallet/${address}/balance-at?api-key=${HELIUS_API_KEY}${forwarded ? '&' + forwarded : ''}`;
      options = { method: 'GET' };
    } else if (type === 'funded-by') {
      // Requires a paid Helius plan — free tier returns 403, which we pass
      // through as-is so the frontend can show a clear message instead of
      // a generic error.
      url = `https://api.helius.xyz/v1/wallet/${address}/funded-by?api-key=${HELIUS_API_KEY}`;
      options = { method: 'GET' };
    } else if (type === 'nfts') {
      url = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
      options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'ledger',
          method: 'getAssetsByOwner',
          params: { ownerAddress: address, page: 1, limit: 24 },
        }),
      };
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid type parameter.' }) };
    }

    const res = await fetch(url, options);
    const data = await res.json();

    if(res.ok){
      cache.set(cacheKey, { data, status: res.status, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    return {
      statusCode: res.status,
      headers: { ...headers, 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'Upstream request to Helius failed.', detail: err.message }),
    };
  }
};
