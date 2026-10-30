// Yūgen Nexus deploy backend for Supabase Edge Functions.
// Requires a valid Supabase Auth access token in Authorization: Bearer <token>.
// Deploy tokens are used only in memory for the request and are never logged/stored.

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const VERCEL_API = "https://api.vercel.com";
const NETLIFY_API = "https://api.netlify.com/api/v1";
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function cleanName(value: unknown, max: number) {
  const cleaned = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, max);
  return cleaned || `yn-${crypto.randomUUID().slice(0, 6)}`;
}

async function providerRequest(url: string, token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  const hasBody = init.body !== undefined && init.body !== null;
  if (hasBody && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(25000),
  });
  const text = await response.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* provider may return plain text */ }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || data?.error || `Provider HTTP ${response.status}`;
    throw new Error(typeof message === "string" ? message : `Provider HTTP ${response.status}`);
  }
  return data;
}

async function authenticate(request: Request) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error("Environment Supabase belum tersedia pada Edge Function.");
  const match = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("Login Supabase diperlukan.");
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${match[1]}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Sesi Supabase tidak valid atau kedaluwarsa. Silakan login ulang.");
  const user = await response.json();
  if (!user?.id) throw new Error("Sesi Supabase tidak valid.");
  return user;
}

async function validateToken(platform: string, token: string) {
  if (platform === "vercel") {
    await providerRequest(`${VERCEL_API}/v2/user`, token);
    return { success: true, message: "Token Vercel valid." };
  }
  if (platform === "netlify") {
    await providerRequest(`${NETLIFY_API}/sites?per_page=1`, token);
    return { success: true, message: "Token Netlify valid." };
  }
  throw new Error("Platform tidak didukung.");
}

function base64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

async function deployVercel(token: string, name: string, html: string) {
  const projectName = cleanName(name, 52);
  const deployment = await providerRequest(`${VERCEL_API}/v13/deployments`, token, {
    method: "POST",
    body: JSON.stringify({
      name: projectName,
      files: [{ file: "index.html", data: base64Utf8(html), encoding: "base64" }],
      target: "production",
    }),
  });
  if (!deployment.id) throw new Error("Vercel tidak mengembalikan ID deployment.");
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const status = await providerRequest(`${VERCEL_API}/v13/deployments/${encodeURIComponent(deployment.id)}`, token);
    if (status.readyState === "READY") {
      let url = status.url || status.alias?.[0] || `${deployment.id}.vercel.app`;
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      return { success: true, url, platform: "vercel", deploymentId: deployment.id };
    }
    if (status.readyState === "ERROR" || status.readyState === "CANCELED") throw new Error("Deployment Vercel gagal atau dibatalkan.");
  }
  throw new Error("Timeout menunggu deployment Vercel. Periksa dashboard Vercel.");
}

async function deployNetlify(token: string, name: string, html: string) {
  const siteName = cleanName(name, 40);
  const site = await providerRequest(`${NETLIFY_API}/sites`, token, {
    method: "POST",
    body: JSON.stringify({ name: siteName }),
  });
  if (!site.id) throw new Error("Netlify tidak mengembalikan ID site.");
  const digestBytes = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(html));
  const digest = Array.from(new Uint8Array(digestBytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const deploy = await providerRequest(`${NETLIFY_API}/sites/${encodeURIComponent(site.id)}/deploys`, token, {
    method: "POST",
    body: JSON.stringify({ files: { "/index.html": digest } }),
  });
  if (!deploy.id) throw new Error("Netlify tidak mengembalikan ID deploy.");
  const upload = await fetch(`${NETLIFY_API}/deploys/${encodeURIComponent(deploy.id)}/files/index.html`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body: html,
    signal: AbortSignal.timeout(45000),
  });
  if (!upload.ok) throw new Error(`Upload file Netlify gagal: HTTP ${upload.status}`);
  let finalUrl = site.ssl_url || site.url || `https://${siteName}.netlify.app`;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const status = await providerRequest(`${NETLIFY_API}/deploys/${encodeURIComponent(deploy.id)}`, token);
    if (status.state === "ready" || status.state === "current") {
      finalUrl = status.ssl_url || status.url || finalUrl;
      return { success: true, url: finalUrl, platform: "netlify", siteId: site.id, deploymentId: deploy.id };
    }
    if (status.state === "error") throw new Error("Deployment Netlify gagal.");
  }
  return { success: true, url: finalUrl, platform: "netlify", siteId: site.id, deploymentId: deploy.id, pending: true };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { success: false, error: "Method tidak diizinkan." });
  try {
    await authenticate(request);
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "");
    const platform = String(body.platform || "").toLowerCase();
    const token = String(body.token || "").trim();
    const html = typeof body.html === "string" ? body.html : "";
    const name = String(body.name || "").trim();
    if (!["vercel", "netlify"].includes(platform)) return json(400, { success: false, error: "Platform tidak valid." });
    if (!token || token.length > 4096) return json(400, { success: false, error: "Token wajib dan harus valid." });
    if (action === "validate") return json(200, await validateToken(platform, token));
    if (action !== "deploy") return json(400, { success: false, error: "Action tidak dikenal." });
    if (!name) return json(400, { success: false, error: "Nama project/site wajib." });
    if (!html.trim()) return json(400, { success: false, error: "Konten HTML wajib." });
    if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) return json(413, { success: false, error: "Ukuran HTML maksimal 4 MiB." });
    const result = platform === "vercel" ? await deployVercel(token, name, html) : await deployNetlify(token, name, html);
    return json(200, result);
  } catch (error) {
    const message = String((error as Error)?.message || "Deploy gagal.").slice(0, 300);
    const status = /Login Supabase|Sesi Supabase/.test(message) ? 401 : (/Environment Supabase/.test(message) ? 503 : 502);
    return json(status, { success: false, error: message });
  }
});
