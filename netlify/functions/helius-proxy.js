// Netlify Function: proxies wallet lookups to Helius so the API key
// never reaches the browser. Key lives in Netlify env var HELIUS_API_KEY.

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

  const { type, address, ...extra } = event.queryStringParameters || {};

  if (!address) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing address parameter.' }) };
  }

  // Very light validation: Solana addresses are base58, 32-44 chars.
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid Solana address.' }) };
  }

  try {
    let url, options;

    if (type === 'balances') {
      url = `https://api.helius.xyz/v1/wallet/${address}/balances?api-key=${HELIUS_API_KEY}`;
      options = { method: 'GET' };
    } else if (type === 'transactions') {
      url = `https://api.helius.xyz/v1/wallet/${address}/history?api-key=${HELIUS_API_KEY}&limit=25`;
      options = { method: 'GET' };
    } else if (type === 'balance-at') {
      // Diagnostic passthrough: forwards any extra query params (mint, timestamp,
      // datetime, slot, etc.) straight to Helius so we can confirm the real param
      // names against the live API before committing to a shape in the frontend.
      const forwarded = new URLSearchParams(extra).toString();
      url = `https://api.helius.xyz/v1/wallet/${address}/balance-at?api-key=${HELIUS_API_KEY}${forwarded ? '&' + forwarded : ''}`;
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

    return {
      statusCode: res.status,
      headers: { ...headers, 'Content-Type': 'application/json' },
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
