const SUPABASE_ORIGIN = "https://qlixoxvwishgsybjwetg.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_x5p1DZPP0iGqi0220f7qSw_Jmu2gl3Y";
const ALLOWED_ORIGINS = new Set(["https://4ta.space", "https://www.4ta.space"]);

function applyCors(request, response) {
  const origin = request.headers.origin || "";
  if (ALLOWED_ORIGINS.has(origin)) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "authorization,apikey,content-type,x-client-info,x-supabase-api-version");
}

export default async function handler(request, response) {
  applyCors(request, response);
  if (request.method === "OPTIONS") return response.status(204).end();
  if (!["GET", "POST", "PATCH", "PUT"].includes(request.method)) return response.status(405).json({ message: "Method not allowed" });
  const origin = request.headers.origin || "";
  if (origin && !ALLOWED_ORIGINS.has(origin)) return response.status(403).json({ message: "Origin not allowed" });
  const rawPath = Array.isArray(request.query.path) ? request.query.path.join("/") : String(request.query.path || "");
  if (!/^(auth|rest|storage)\/v1(?:\/|$)/.test(rawPath)) return response.status(404).json({ message: "Unsupported Supabase path" });
  const query = new URLSearchParams();
  Object.entries(request.query).forEach(([key, value]) => {
    if (key === "path") return;
    (Array.isArray(value) ? value : [value]).forEach((entry) => query.append(key, String(entry)));
  });
  const target = `${SUPABASE_ORIGIN}/${rawPath}${query.size ? `?${query}` : ""}`;
  const headers = { apikey: PUBLISHABLE_KEY, "content-type": request.headers["content-type"] || "application/json", "x-client-info": request.headers["x-client-info"] || "4ta-vercel-proxy" };
  if (request.headers.authorization) headers.authorization = request.headers.authorization;
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : typeof request.body === "string" || Buffer.isBuffer(request.body) ? request.body : JSON.stringify(request.body ?? {}),
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  const contentType = upstream.headers.get("content-type");
  if (contentType) response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "no-store");
  return response.status(upstream.status).send(body);
}
