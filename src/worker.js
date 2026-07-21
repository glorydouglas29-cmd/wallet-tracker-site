// Cloudflare Worker: serves the static site from public/ (via the ASSETS
// binding configured in wrangler.jsonc) and handles /helius-proxy itself for
// API calls, so the Helius API key never reaches the browser. The key lives
// in a Cloudflare environment variable, HELIUS_API_KEY, set in this Worker's
// Settings -> Variables and Secrets (not in this file).
//
// Includes the same in-memory cache and per-IP rate limiter as the earlier
// Netlify/Pages versions. They live in module scope, so they persist for the
// life of a warm Worker isolate but reset when Cloudflare spins up a new one,
// and aren't shared across every edge location handling your traffic. Good
// enough to absorb repeat lookups and casual hammering; for a hard guarantee
// at real scale, Cloudflare's Cache API or a KV namespace would be the next
// step up.

const CACHE_TTL_MS = 30 * 1000;
const cache = new Map();

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;
const rateLimits = new Map();

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(body, status = 200, extraHeaders = {}){
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

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

async function handleHeliusProxy(request, env){
  if(request.method === 'OPTIONS'){
    return new Response('', { status: 200, headers: CORS_HEADERS });
  }

  const HELIUS_API_KEY = env.HELIUS_API_KEY;
  if(!HELIUS_API_KEY){
    return json({ error: 'HELIUS_API_KEY is not set in this Worker\'s environment variables.' }, 500);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rl = checkRateLimit(ip);
  if(rl.limited){
    return json(
      { error: 'Too many requests. Please slow down.', retryAfterSeconds: rl.retryAfter },
      429,
      { 'Retry-After': String(rl.retryAfter) }
    );
  }

  const reqUrl = new URL(request.url);
  const type = reqUrl.searchParams.get('type');
  const address = reqUrl.searchParams.get('address');
  const extra = {};
  for(const [k, v] of reqUrl.searchParams){
    if(k !== 'type' && k !== 'address') extra[k] = v;
  }

  if(!address){
    return json({ error: 'Missing address parameter.' }, 400);
  }
  if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)){
    return json({ error: 'Invalid Solana address.' }, 400);
  }

  const cacheKey = `${type}:${address}:${new URLSearchParams(extra).toString()}`;
  pruneCache();
  const cached = cache.get(cacheKey);
  if(cached && cached.expiresAt > Date.now()){
    return json(cached.data, cached.status, { 'X-Cache': 'HIT' });
  }

  try{
    let heliusUrl, options;

    if(type === 'balances'){
      const page = extra.page ? `&page=${encodeURIComponent(extra.page)}` : '';
      heliusUrl = `https://api.helius.xyz/v1/wallet/${address}/balances?api-key=${HELIUS_API_KEY}${page}`;
      options = { method: 'GET' };
    } else if(type === 'transactions'){
      const before = extra.before ? `&before=${encodeURIComponent(extra.before)}` : '';
      heliusUrl = `https://api.helius.xyz/v1/wallet/${address}/history?api-key=${HELIUS_API_KEY}&limit=25${before}`;
      options = { method: 'GET' };
    } else if(type === 'balance-at'){
      const forwarded = new URLSearchParams(extra).toString();
      heliusUrl = `https://api.helius.xyz/v1/wallet/${address}/balance-at?api-key=${HELIUS_API_KEY}${forwarded ? '&' + forwarded : ''}`;
      options = { method: 'GET' };
    } else if(type === 'funded-by'){
      // Requires a paid Helius plan — free tier returns 403, passed through
      // as-is so the frontend can show a clear message instead of a generic error.
      heliusUrl = `https://api.helius.xyz/v1/wallet/${address}/funded-by?api-key=${HELIUS_API_KEY}`;
      options = { method: 'GET' };
    } else if(type === 'transfers'){
      // Wallet API's transfers endpoint gives real sender/recipient
      // (counterparty) per transfer — much cheaper than parsing raw
      // transactions one at a time via the Enhanced Transaction API.
      heliusUrl = `https://api.helius.xyz/v1/wallet/${address}/transfers?api-key=${HELIUS_API_KEY}&limit=100`;
      options = { method: 'GET' };
    } else if(type === 'nfts'){
      heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
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
      return json({ error: 'Invalid type parameter.' }, 400);
    }

    const res = await fetch(heliusUrl, options);
    const data = await res.json();

    if(res.ok){
      cache.set(cacheKey, { data, status: res.status, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    return json(data, res.status, { 'X-Cache': 'MISS' });
  }catch(err){
    return json({ error: 'Upstream request to Helius failed.', detail: err.message }, 502);
  }
}

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);

    if(url.pathname === '/helius-proxy'){
      return handleHeliusProxy(request, env);
    }

    // Everything else is a static file — index.html, and anything added to
    // public/ later — served via the ASSETS binding from wrangler.jsonc.
    return env.ASSETS.fetch(request);
  },
};
