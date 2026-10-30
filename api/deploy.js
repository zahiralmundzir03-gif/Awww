const crypto = require('node:crypto');

const VERCEL_API = 'https://api.vercel.com';
const NETLIFY_API = 'https://api.netlify.com/api/v1';
const MAX_HTML_BYTES = 4 * 1024 * 1024;

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.end(JSON.stringify(body));
}

function cleanName(value, max) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max) || ('yn-' + crypto.randomBytes(3).toString('hex'));
}

async function providerRequest(url, token, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!response.ok) {
      const message = data?.error?.message || data?.message || data?.error || `Provider HTTP ${response.status}`;
      throw new Error(typeof message === 'string' ? message : `Provider HTTP ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function authenticateSupabase(req) {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const supabaseAnonKey = String(process.env.SUPABASE_ANON_KEY || '');
  if (!supabaseUrl || !supabaseAnonKey) {
    const error = new Error('Backend belum dikonfigurasi: isi SUPABASE_URL dan SUPABASE_ANON_KEY di environment Vercel.');
    error.statusCode = 503;
    throw error;
  }
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const error = new Error('Login Supabase diperlukan.');
    error.statusCode = 401;
    throw error;
  }
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    method: 'GET',
    headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${match[1]}` },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    const error = new Error('Sesi Supabase tidak valid atau sudah kedaluwarsa. Silakan login ulang.');
    error.statusCode = 401;
    throw error;
  }
  const user = await response.json();
  if (!user || !user.id) {
    const error = new Error('Sesi Supabase tidak valid.');
    error.statusCode = 401;
    throw error;
  }
  return user;
}

async function validateToken(platform, token) {
  if (platform === 'vercel') {
    await providerRequest(`${VERCEL_API}/v2/user`, token);
    return { success: true, message: 'Token Vercel valid.' };
  }
  if (platform === 'netlify') {
    await providerRequest(`${NETLIFY_API}/sites?per_page=1`, token);
    return { success: true, message: 'Token Netlify valid.' };
  }
  throw new Error('Platform tidak didukung.');
}

async function deployVercel(token, name, html) {
  const projectName = cleanName(name, 52);
  const base64 = Buffer.from(html, 'utf8').toString('base64');
  const deployment = await providerRequest(`${VERCEL_API}/v13/deployments`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: projectName,
      files: [{ file: 'index.html', data: base64, encoding: 'base64' }],
      target: 'production'
    })
  });
  if (!deployment.id) throw new Error('Vercel tidak mengembalikan ID deployment.');

  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const status = await providerRequest(
      `${VERCEL_API}/v13/deployments/${encodeURIComponent(deployment.id)}`,
      token
    );
    if (status.readyState === 'READY') {
      let url = status.url || status.alias?.[0] || `${deployment.id}.vercel.app`;
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      return { success: true, url, platform: 'vercel', deploymentId: deployment.id };
    }
    if (status.readyState === 'ERROR' || status.readyState === 'CANCELED') {
      throw new Error('Deployment Vercel gagal atau dibatalkan.');
    }
  }
  throw new Error('Timeout menunggu deployment Vercel. Periksa dashboard Vercel.');
}

async function deployNetlify(token, name, html) {
  const siteName = cleanName(name, 40);
  const site = await providerRequest(`${NETLIFY_API}/sites`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: siteName })
  });
  if (!site.id) throw new Error('Netlify tidak mengembalikan ID site.');

  const digest = crypto.createHash('sha1').update(html, 'utf8').digest('hex');
  const deploy = await providerRequest(`${NETLIFY_API}/sites/${encodeURIComponent(site.id)}/deploys`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { '/index.html': digest } })
  });
  if (!deploy.id) throw new Error('Netlify tidak mengembalikan ID deploy.');

  const uploadResponse = await fetch(
    `${NETLIFY_API}/deploys/${encodeURIComponent(deploy.id)}/files/index.html`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream'
      },
      body: html,
      signal: AbortSignal.timeout(45000)
    }
  );
  if (!uploadResponse.ok) throw new Error(`Upload file Netlify gagal: HTTP ${uploadResponse.status}`);

  let finalUrl = site.ssl_url || site.url || `https://${siteName}.netlify.app`;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const status = await providerRequest(`${NETLIFY_API}/deploys/${encodeURIComponent(deploy.id)}`, token);
    if (status.state === 'ready' || status.state === 'current') {
      finalUrl = status.ssl_url || status.url || finalUrl;
      return { success: true, url: finalUrl, platform: 'netlify', siteId: site.id, deploymentId: deploy.id };
    }
    if (status.state === 'error') throw new Error('Deployment Netlify gagal.');
  }
  return { success: true, url: finalUrl, platform: 'netlify', siteId: site.id, deploymentId: deploy.id, pending: true };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { success: false, error: 'Method tidak diizinkan.' });
  }

  // Keep this endpoint same-origin. Do not add permissive CORS headers.
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try { if (new URL(origin).host !== host) return send(res, 403, { success: false, error: 'Cross-origin request ditolak.' }); }
    catch (_) { return send(res, 403, { success: false, error: 'Origin request tidak valid.' }); }
  }
  try {
    await authenticateSupabase(req);
  } catch (error) {
    return send(res, error.statusCode || 401, { success: false, error: String(error.message || 'Autentikasi gagal.').slice(0, 300) });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = String(body.action || '');
  const platform = String(body.platform || '').toLowerCase();
  const token = String(body.token || '').trim();
  const html = typeof body.html === 'string' ? body.html : '';
  const name = String(body.name || '').trim();

  if (!['vercel', 'netlify'].includes(platform)) return send(res, 400, { success: false, error: 'Platform tidak valid.' });
  if (!token || token.length > 4096) return send(res, 400, { success: false, error: 'Token wajib dan harus valid.' });

  try {
    if (action === 'validate') {
      const result = await validateToken(platform, token);
      return send(res, 200, result);
    }
    if (action === 'deploy') {
      if (!name) return send(res, 400, { success: false, error: 'Nama project/site wajib.' });
      if (!html.trim()) return send(res, 400, { success: false, error: 'Konten HTML wajib.' });
      if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
        return send(res, 413, { success: false, error: 'Ukuran HTML maksimal 4 MiB untuk batas request serverless.' });
      }
      const result = platform === 'vercel'
        ? await deployVercel(token, name, html)
        : await deployNetlify(token, name, html);
      return send(res, 200, result);
    }
    return send(res, 400, { success: false, error: 'Action tidak dikenal.' });
  } catch (error) {
    // Avoid logging request bodies or tokens; return only provider error text.
    const message = error?.name === 'AbortError' ? 'Request ke provider timeout.' : (error?.message || 'Deploy gagal.');
    return send(res, 502, { success: false, error: String(message).slice(0, 300) });
  }
};
