const ORIGIN = "https://qlixoxvwishgsybjwetg.supabase.co";
const KEY = "sb_publishable_x5p1DZPP0iGqi0220f7qSw_Jmu2gl3Y";
const ALLOWED = new Set(["https://4ta.space", "https://www.4ta.space"]);
function cors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin"); res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,OPTIONS"); res.setHeader("Access-Control-Allow-Headers", "authorization,apikey,content-type,x-client-info,x-supabase-api-version");
}
export default async function handler(req, res) {
  cors(req, res); if (req.method === "OPTIONS") return res.status(204).end();
  if (!["GET","POST","PATCH","PUT"].includes(req.method)) return res.status(405).json({message:"Method not allowed"});
  const origin=req.headers.origin||""; if(origin&&!ALLOWED.has(origin)) return res.status(403).json({message:"Origin not allowed"});
  const path=Array.isArray(req.query.path)?req.query.path.join("/"):String(req.query.path||"");
  if(!/^(auth|rest|storage)\/v1(?:\/|$)/.test(path)) return res.status(404).json({message:"Unsupported Supabase path"});
  const query=new URLSearchParams(); for(const [k,v] of Object.entries(req.query)) if(k!=="path") for(const x of(Array.isArray(v)?v:[v])) query.append(k,String(x));
  const headers={apikey:KEY,"content-type":req.headers["content-type"]||"application/json","x-client-info":"4ta-vercel-proxy"}; if(req.headers.authorization) headers.authorization=req.headers.authorization;
  const upstream=await fetch(ORIGIN+"/"+path+(query.size?"?"+query:""),{method:req.method,headers,body:req.method==="GET"?undefined:typeof req.body==="string"||Buffer.isBuffer(req.body)?req.body:JSON.stringify(req.body??{})});
  const body=Buffer.from(await upstream.arrayBuffer()); const type=upstream.headers.get("content-type"); if(type)res.setHeader("Content-Type",type); res.setHeader("Cache-Control","no-store"); return res.status(upstream.status).send(body);
}
