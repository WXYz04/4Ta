import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const cronSecret = Deno.env.get("WEB_PUSH_CRON_SECRET") || "";
type AdminClient = ReturnType<typeof createClient>;
let admin: AdminClient | null = null;
let webPushReady = false;

function requiredSecret(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`推送服务缺少 ${name} 配置`);
  return value;
}

function ensureRuntime() {
  if (!admin) {
    admin = createClient(requiredSecret("SUPABASE_URL"), requiredSecret("SUPABASE_SERVICE_ROLE_KEY"));
  }
  if (!webPushReady) {
    webpush.setVapidDetails(
      "mailto:admin@4ta.app",
      requiredSecret("WEB_PUSH_VAPID_PUBLIC_KEY"),
      requiredSecret("WEB_PUSH_VAPID_PRIVATE_KEY"),
    );
    webPushReady = true;
  }
  return admin;
}

function timeGreeting(date: Date) {
  const hour = date.getUTCHours() + 8;
  const localHour = hour % 24;
  if (localHour < 6) return "这么晚还没睡？";
  if (localHour < 10) return "醒了吗？";
  if (localHour < 14) return "吃东西没？";
  if (localHour < 18) return "突然想找你";
  if (localHour < 23) return "你跑哪去了？";
  return "是不是睡着了？";
}

function taipeiClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${value.year}-${value.month}-${value.day}`,
    minutes: Number(value.hour) * 60 + Number(value.minute),
  };
}

function activePushPeriod(date = new Date()) {
  const clock = taipeiClock(date);
  if (clock.minutes >= 0 && clock.minutes <= 180) {
    return { key: `${clock.date}:night`, targetMin: 2, targetMax: 3 };
  }
  if (clock.minutes >= 390 && clock.minutes <= 630) {
    return { key: `${clock.date}:morning`, targetMin: 2, targetMax: 4 };
  }
  return null;
}

async function userContext(userId: string, preferredTaId?: string) {
  const admin = ensureRuntime();
  const { data } = await admin
    .from("app_records")
    .select("record_key,payload")
    .eq("user_id", userId)
    .eq("record_type", "local_storage")
    .in("record_key", [
      "4ta:ta-name",
      "4ta:ta-style",
      "4ta:ta-relationship",
      "4ta:active-ta-id",
      "4ta:ta-profiles",
      "4ta:chat-messages",
    ]);
  const values = new Map((data || []).map((record) => [
    record.record_key,
    typeof record.payload?.value === "string" ? record.payload.value : "",
  ]));
  let profiles: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(values.get("4ta:ta-profiles") || "[]");
    if (Array.isArray(parsed)) profiles = parsed;
  } catch {
    profiles = [];
  }
  const activeTaId = values.get("4ta:active-ta-id") || "main";
  const eligibleProfiles = profiles.filter((profile) => profile.pushEnabled !== false && typeof profile.id === "string");
  const rotationIndex = Math.floor(Date.now() / (30 * 60_000)) % Math.max(1, eligibleProfiles.length);
  const chosenProfile = eligibleProfiles.find((profile) => profile.id === preferredTaId)
    || eligibleProfiles[rotationIndex]
    || profiles.find((profile) => profile.id === activeTaId);
  const selectedTaId = String(chosenProfile?.id || activeTaId);
  const messageKey = `4ta:chat-messages:${selectedTaId}`;
  const { data: scopedMessageRecord } = await admin
    .from("app_records")
    .select("payload")
    .eq("user_id", userId)
    .eq("record_type", "local_storage")
    .eq("record_key", messageKey)
    .maybeSingle();
  const scopedMessages = typeof scopedMessageRecord?.payload?.value === "string"
    ? scopedMessageRecord.payload.value
    : "";
  let messages: Array<Record<string, unknown> & { sender?: string; text?: string; createdAt?: string }> = [];
  try {
    messages = JSON.parse(scopedMessages || values.get("4ta:chat-messages") || "[]");
  } catch {
    messages = [];
  }
  return {
    activeTaId: selectedTaId,
    messageKey,
    taName: String(chosenProfile?.name || values.get("4ta:ta-name") || "Ta"),
    taStyle: String(chosenProfile?.personality || chosenProfile?.style || values.get("4ta:ta-style") || ""),
    speechStyle: String(chosenProfile?.speechStyle || ""),
    relationship: String(chosenProfile?.relationship || values.get("4ta:ta-relationship") || ""),
    pushAllowed: profiles.length === 0 || eligibleProfiles.length > 0,
    messages,
  };
}

async function persistPushMessage(
  userId: string,
  notificationId: string,
  sentAt: string,
  payload: { title: string; body: string },
  taId?: string,
) {
  const admin = ensureRuntime();
  const context = await userContext(userId, taId);
  if (context.messages.some((message) => message.id === notificationId)) return;
  const message = {
    id: notificationId,
    conversationId: context.activeTaId,
    senderId: "ta",
    sender: "ta",
    text: payload.body,
    createdAt: sentAt,
    type: "text",
    source: "push",
  };
  const nextMessages = [...context.messages, message];
  const records = [
    {
      user_id: userId,
      record_type: "local_storage",
      record_key: context.messageKey,
      payload: { value: JSON.stringify(nextMessages) },
      updated_at: sentAt,
    },
    {
      user_id: userId,
      record_type: "local_storage",
      record_key: "4ta:chat-messages",
      payload: { value: JSON.stringify(nextMessages) },
      updated_at: sentAt,
    },
    {
      user_id: userId,
      record_type: "local_storage",
      record_key: "4ta:last-message",
      payload: { value: payload.body },
      updated_at: sentAt,
    },
    {
      user_id: userId,
      record_type: "local_storage",
      record_key: "4ta:last-message-time",
      payload: { value: sentAt },
      updated_at: sentAt,
    },
    {
      user_id: userId,
      record_type: "local_storage",
      record_key: "4ta:ta-unread",
      payload: { value: "1" },
      updated_at: sentAt,
    },
  ];
  const { error } = await admin.from("app_records").upsert(records);
  if (error) throw error;
}

async function generateBody(userId: string) {
  const context = await userContext(userId);
  if (!context.pushAllowed) return null;
  const last = context.messages.at(-1);
  const clock = taipeiClock();
  const deepNight = clock.minutes < 180;
  const fallback = last?.sender === "ta" && /[？?吗呢嘛]$/.test(last.text || "")
    ? (deepNight ? "睡着了？" : "？ 你还没回答我")
    : deepNight
      ? "是不是睡着了？"
      : timeGreeting(new Date());

  const apiKey = Deno.env.get("AI_API_KEY");
  const apiUrl = Deno.env.get("AI_API_URL");
  const model = Deno.env.get("AI_MODEL");
  if (!apiKey || !apiUrl || !model) return { title: context.taName, body: fallback, taId: context.activeTaId };

  try {
    const recent = context.messages.slice(-12).map((message) =>
      `${message.sender === "ta" ? context.taName : "用户"}：${message.text || ""}`
    ).join("\n");
    const hour = new Date().getUTCHours() + 8;
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.95,
        messages: [
          {
            role: "system",
            content: `你是${context.taName}。根据人设、关系、语言风格、真实时间和最近聊天，给迟迟没回复的用户发一条主动消息。必须接着上下文；如果你刚问过问题，优先追问。深夜优先猜测用户是否睡着。可以只发“？”“啊？”“人呢”等极短反应。语气鲜活直接，禁止模板问候、动作旁白和AI腔。只返回一条不超过22字的纯文字。\n人设：${context.taStyle}\n语言风格：${context.speechStyle}\n关系：${context.relationship}\n当前小时：${hour}\n最近聊天：\n${recent}`,
          },
          { role: "user", content: "现在主动找我。" },
        ],
      }),
    });
    const json = await response.json();
    const body = String(json?.choices?.[0]?.message?.content || "")
      .replace(/[（）()[\]【】*]/g, "")
      .trim()
      .slice(0, 22);
    return { title: context.taName, body: body || fallback, taId: context.activeTaId };
  } catch {
    return { title: context.taName, body: fallback, taId: context.activeTaId };
  }
}

async function sendToUser(userId: string, payload: { title: string; body: string; taId?: string }) {
  const admin = ensureRuntime();
  const { data: subscriptions } = await admin
    .from("push_subscriptions")
    .select("id,endpoint,p256dh,auth")
    .eq("user_id", userId);
  const notificationId = crypto.randomUUID();
  const sentAt = new Date().toISOString();
  const notificationPayload = JSON.stringify({
    ...payload,
    url: payload.taId ? `./#/chat/${payload.taId}` : "./#/chat",
    tag: `4ta-message-${notificationId}`,
    notificationId,
    sentAt,
  });
  let sent = 0;
  for (const subscription of subscriptions || []) {
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      }, notificationPayload);
      sent += 1;
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number }).statusCode);
      if (statusCode === 404 || statusCode === 410) {
        await admin.from("push_subscriptions").delete().eq("id", subscription.id);
      }
    }
  }
  if (sent > 0) {
    await persistPushMessage(userId, notificationId, sentAt, payload, payload.taId);
  }
  return { sent, notificationId, sentAt, body: payload.body };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const admin = ensureRuntime();
    const body = await request.json().catch(() => ({}));

  if (body.mode === "test") {
    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
    const { data } = await admin.auth.getUser(token);
    if (!data.user) {
      return Response.json({ sent: 0, error: "未登录" }, { status: 401, headers: corsHeaders });
    }
    const context = await userContext(data.user.id);
    const result = await sendToUser(data.user.id, {
      title: context.taName,
      body: "通知接通了，我能找到你了",
      taId: context.activeTaId,
    });
    return Response.json(result, { headers: corsHeaders });
  }

  if (body.mode === "test-triple") {
    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
    const { data } = await admin.auth.getUser(token);
    if (!data.user) {
      return Response.json({ sent: 0, error: "未登录" }, { status: 401, headers: corsHeaders });
    }
    const context = await userContext(data.user.id);
    const first = await sendToUser(data.user.id, {
      title: context.taName,
      body: "吃晚饭了吗",
      taId: context.activeTaId,
    });
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const second = await sendToUser(data.user.id, {
      title: context.taName,
      body: "鼠标刚刚说它想你了",
      taId: context.activeTaId,
    });
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const third = await sendToUser(data.user.id, {
      title: context.taName,
      body: "我也是",
      taId: context.activeTaId,
    });
    return Response.json({
      sent: first.sent + second.sent + third.sent,
      notifications: [first, second, third],
    }, { headers: corsHeaders });
  }

  if (!cronSecret || request.headers.get("x-cron-secret") !== cronSecret) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders });
  }
  const { data: schedules } = await admin
    .from("push_schedules")
    .select("user_id,next_push_at,period_key,period_sent,period_target")
    .eq("enabled", true)
    .limit(100);
  let sent = 0;
  for (const schedule of schedules || []) {
    const period = activePushPeriod();
    if (!period) continue;
    const isNewPeriod = schedule.period_key !== period.key;
    const target = isNewPeriod
      ? period.targetMin + Math.floor(Math.random() * (period.targetMax - period.targetMin + 1))
      : Number(schedule.period_target || period.targetMin);
    const periodSent = isNewPeriod ? 0 : Number(schedule.period_sent || 0);
    const nextPushAt = isNewPeriod ? null : schedule.next_push_at;
    if (periodSent >= target || (nextPushAt && new Date(nextPushAt).getTime() > Date.now())) continue;

    const payload = await generateBody(schedule.user_id);
    if (!payload) continue;
    const result = await sendToUser(schedule.user_id, payload);
    sent += result.sent;
    const delayMinutes = 22 + Math.floor(Math.random() * 24);
    await admin.from("push_schedules").update({
      last_push_at: new Date().toISOString(),
      next_push_at: new Date(Date.now() + delayMinutes * 60_000).toISOString(),
      period_key: period.key,
      period_sent: periodSent + 1,
      period_target: target,
      updated_at: new Date().toISOString(),
    }).eq("user_id", schedule.user_id);
  }
  return Response.json({ checked: schedules?.length || 0, sent }, { headers: corsHeaders });
  } catch (error) {
    console.error("send-web-push failed", error);
    return Response.json({
      sent: 0,
      error: error instanceof Error ? error.message : "推送服务暂时不可用",
    }, { status: 500, headers: corsHeaders });
  }
});
