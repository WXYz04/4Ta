const ORIGIN = "https://qlixoxvwishgsybjwetg.supabase.co";
const KEY = "sb_publishable_x5p1DZPP0iGqi0220f7qSw_Jmu2gl3Y";
const ALLOWED = new Set(["https://4ta.space", "https://www.4ta.space"]);

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  if (!req?.[Symbol.asyncIterator]) {
    if (Buffer.isBuffer(req?.body)) return req.body;
    if (typeof req?.body === "string") return Buffer.from(req.body);
    return Buffer.from(JSON.stringify(req?.body ?? {}));
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "authorization,apikey,content-type,x-client-info,x-supabase-api-version,accept-profile,content-profile,prefer,range,x-upsert");
  res.setHeader("Access-Control-Expose-Headers", "content-range,range");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(req.method)) return res.status(405).json({ message: "Method not allowed" });
  if (origin && !ALLOWED.has(origin)) return res.status(403).json({ message: "Origin not allowed" });

  const path = String(req.query.path || "");
  // The production client uses this same Supabase base URL for Auth, data,
  // media and Edge Functions. Blocking `functions/v1` here makes login work
  // while every push-function invocation silently ends at the proxy.
  if (!/^(auth|rest|storage|functions)\/v1(?:\/|$)/.test(path)) return res.status(404).json({ message: "Unsupported Supabase path" });
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "path") continue;
    for (const item of (Array.isArray(value) ? value : [value])) query.append(key, String(item));
  }
  const headers = {
    apikey: KEY,
    "content-type": req.headers["content-type"] || "application/json",
    "x-client-info": "4ta-vercel-proxy"
  };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  for (const name of ["accept-profile", "content-profile", "prefer", "range", "x-upsert"]) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  const rawBody = req.method === "GET" || req.method === "HEAD" ? undefined : await readRawBody(req);
  const upstream = await fetch(`${ORIGIN}/${path}${query.size ? `?${query}` : ""}`, {
    method: req.method,
    headers,
    body: rawBody?.length ? rawBody : undefined,
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  const type = upstream.headers.get("content-type");
  if (type) res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-store");
  return res.status(upstream.status).send(body);
}
