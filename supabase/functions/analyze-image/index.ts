const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const VISION_MODEL = "qwen/qwen3-vl-8b-instruct";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json({ error: "仅支持 POST 请求" }, 405);
  }

  try {
    const openRouterKey = Deno.env.get("OPENROUTER_API_KEY");
    if (!openRouterKey) {
      return json({ error: "服务器尚未配置识图密钥" }, 500);
    }

    const body = await request.json().catch(() => null);
    const imageUrl = typeof body?.imageUrl === "string" ? body.imageUrl.trim() : "";
    if (!/^https?:\/\//i.test(imageUrl)) {
      return json({ error: "图片地址无效" }, 400);
    }

    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openRouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://wxyz04.github.io/4Ta/",
        "X-Title": "4Ta",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        temperature: 0.2,
        max_tokens: 320,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "请客观理解这张聊天图片，并用简洁中文描述：主要人物或物体、场景、可读文字、明显动作或情绪线索。"
                  + "只描述确实能看见的内容，不猜测身份、关系和未显示的信息，不代替聊天角色回复。"
                  + "输出一段纯文字，不要 Markdown、JSON、标题或括号动作。",
              },
              {
                type: "image_url",
                image_url: { url: imageUrl, detail: "low" },
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = data?.error?.message || `识图服务请求失败（${response.status}）`;
      return json({ error: detail }, response.status >= 500 ? 502 : response.status);
    }

    const description = data?.choices?.[0]?.message?.content;
    if (typeof description !== "string" || !description.trim()) {
      return json({ error: "识图模型没有返回有效描述" }, 502);
    }

    return json({
      description: description.trim(),
      model: VISION_MODEL,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "识图服务暂时不可用";
    return json({ error: detail }, 500);
  }
});
