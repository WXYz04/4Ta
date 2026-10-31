import { createClient } from "@supabase/supabase-js";
import { safeRandomUUID } from "../utils/webCryptoCompat";
import type { StickerPack } from "../features/stickers/stickerStore";
import {
  getActiveTaId,
  readTaProfiles,
  repairTaProfilesFromSnapshots,
  saveTaMessages,
  saveTaProfiles,
  taMessageKey,
  type TaProfile,
} from "../features/characters/taStore";
import { sha256 } from "./sha256";
import { isStorageQuotaError, reclaimRedundantLocalStorage } from "./safeStorage";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://qlixoxvwishgsybjwetg.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_x5p1DZPP0iGqi0220f7qSw_Jmu2gl3Y";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

const CLOUD_EXCLUDED_KEYS = new Set([
  "4ta:account-password-hash",
  "4ta:backend-token",
  // Offline meeting stories can contain highly private role-play content.
  // Keep the full session transcript on this device only.
  "4ta:meeting-sessions",
]);

const isCloudExcludedKey = (key: string) => CLOUD_EXCLUDED_KEYS.has(key);

async function accountEmail(username: string) {
  const id = await sha256(username.trim().toLocaleLowerCase());
  return `${id.slice(0, 40)}@users.4ta.invalid`;
}

export async function ensureCloudSession() {
  const { data: current } = await supabase.auth.getSession();
  if (current.session) return current.session;
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.session) throw new Error(error?.message || "无法建立云端身份");
  return data.session;
}

export async function loginOrRegisterCloudAccount(username: string, password: string) {
  const email = await accountEmail(username);
  const signedIn = await supabase.auth.signInWithPassword({ email, password });
  if (signedIn.data.session) return { session: signedIn.data.session, isNew: false };
  const signInMessage = signedIn.error?.message.toLowerCase() || "";
  if (signInMessage.includes("rate limit") || signInMessage.includes("exceeded")) {
    throw new Error("登录请求过于频繁，请先停几分钟再试。账号和云端数据没有被删除");
  }

  const signedUp = await supabase.auth.signUp({
    email,
    password,
    options: { data: { username } },
  });
  if (signedUp.error || !signedUp.data.session) {
    const signUpMessage = signedUp.error?.message.toLowerCase() || "";
    if (signUpMessage.includes("rate limit") || signUpMessage.includes("exceeded")) {
      throw new Error("登录请求过于频繁，请先停几分钟再试。不要连续点击，账号数据仍在云端");
    }
    const accountExists = signedUp.error?.message.toLowerCase().includes("registered");
    throw new Error(accountExists ? "账号或密码错误" : signedUp.error?.message || "账号登录失败");
  }
  return { session: signedUp.data.session, isNew: true };
}

/**
 * Recover an already authenticated account without asking the user to remember
 * the username or password again. Supabase persists its session separately
 * from the small 4ta account marker, so a missing marker must not lock users
 * out of data that is still available to the valid cloud session.
 */
export async function recoverSignedInCloudAccount() {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session || session.user.is_anonymous) return "";
  let username = typeof session.user.user_metadata?.username === "string"
    ? session.user.user_metadata.username.trim()
    : "";
  if (!username) {
    const { data } = await supabase
      .from("profiles")
      .select("username")
      .eq("id", session.user.id)
      .maybeSingle();
    username = typeof data?.username === "string" ? data.username.trim() : "";
  }
  if (!username) return "";
  // Only restore the small records needed to decide whether this is an
  // existing account. Full chats/media continue after entering the app.
  await restoreCloudBootstrapData();
  return username;
}

export async function saveCloudProfile(username: string) {
  const session = await ensureCloudSession();
  const { error } = await supabase.from("profiles").upsert({
    id: session.user.id,
    username,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`云端账号保存失败：${error.message}`);
}

export async function syncAllLocalData() {
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) return;
  const records = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => Boolean(key?.startsWith("4ta:")) && !isCloudExcludedKey(key!))
    .map((key) => ({
      user_id: session.user.id,
      record_type: "local_storage",
      record_key: key,
      payload: { value: localStorage.getItem(key) ?? "" },
      updated_at: new Date().toISOString(),
    }));
  if (!records.length) return;
  const profileRecord = records.find((record) => record.record_key === "4ta:ta-profiles");
  if (profileRecord) {
    const { data: cloudProfileRecord } = await supabase
      .from("app_records")
      .select("payload")
      .eq("record_type", "local_storage")
      .eq("record_key", "4ta:ta-profiles")
      .maybeSingle();
    try {
      const localProfiles = JSON.parse(String(profileRecord.payload.value || "[]"));
      const cloudValue = (cloudProfileRecord?.payload as { value?: unknown } | undefined)?.value;
      const cloudProfiles = JSON.parse(typeof cloudValue === "string" ? cloudValue : "[]");
      const merged = mergeProfileLists(
        Array.isArray(cloudProfiles) ? cloudProfiles : [],
        Array.isArray(localProfiles) ? localProfiles : [],
      );
      const value = JSON.stringify(repairTaProfilesFromSnapshots(merged));
      profileRecord.payload.value = value;
      localStorage.setItem("4ta:ta-profiles", value);
    } catch {
      // Never replace a readable local list with malformed cloud data.
    }
  }
  const chatRecords = records.filter((record) =>
    record.record_key === "4ta:chat-messages" || record.record_key.startsWith("4ta:chat-messages:"));
  if (chatRecords.length) {
    const { data: cloudChatRecords } = await supabase
      .from("app_records")
      .select("record_key,payload")
      .eq("record_type", "local_storage")
      .in("record_key", chatRecords.map((record) => record.record_key));
    const cloudByKey = new Map((cloudChatRecords || []).map((record) => [record.record_key, record.payload]));
    chatRecords.forEach((record) => {
      try {
        const localMessages = JSON.parse(String(record.payload.value || "[]"));
        const cloudPayload = cloudByKey.get(record.record_key) as { value?: unknown } | undefined;
        const cloudMessages = JSON.parse(typeof cloudPayload?.value === "string" ? cloudPayload.value : "[]");
        const merged = new Map<string, Record<string, unknown>>();
        [...(Array.isArray(cloudMessages) ? cloudMessages : []), ...(Array.isArray(localMessages) ? localMessages : [])]
          .forEach((message: Record<string, unknown>) => {
            if (typeof message?.id === "string") merged.set(message.id, message);
          });
        const value = JSON.stringify(Array.from(merged.values()).sort((left, right) =>
          String(left.createdAt || "").localeCompare(String(right.createdAt || ""))));
        record.payload.value = value;
        localStorage.setItem(record.record_key, value);
      } catch {
        // Keep the local value if either side contains malformed legacy data.
      }
    });
  }
  const { error } = await supabase.from("app_records").upsert(records);
  if (error) throw new Error(`数据同步失败：${error.message}`);
}

/** Immediately persist one lightweight application record to Supabase. */
export async function syncCloudRecord(recordKey: string, value: string) {
  if (isCloudExcludedKey(recordKey)) return;
  const session = await ensureCloudSession();
  const { error } = await supabase.from("app_records").upsert({
    user_id: session.user.id,
    record_type: "local_storage",
    record_key: recordKey,
    payload: { value },
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`云端保存失败：${error.message}`);
}

/** Read one lightweight application record without restoring every cached file. */
export async function fetchCloudRecord(recordKey: string) {
  const session = await ensureCloudSession();
  const { data, error } = await supabase
    .from("app_records")
    .select("payload")
    .eq("user_id", session.user.id)
    .eq("record_type", "local_storage")
    .eq("record_key", recordKey)
    .maybeSingle();
  if (error) throw new Error(`云端读取失败：${error.message}`);
  const value = (data?.payload as { value?: unknown } | null)?.value;
  return typeof value === "string" ? value : "";
}

function compressCloudImage(dataUrl: string, maxSize: number, quality: number) {
  return new Promise<string>((resolve) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) return resolve(dataUrl);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    image.onerror = () => resolve(dataUrl);
    image.src = dataUrl;
  });
}

export async function restoreAllCloudData() {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) return false;
  const { data, error } = await supabase
    .from("app_records")
    .select("record_key,payload")
    .eq("record_type", "local_storage");
  if (error) throw new Error(`数据恢复失败：${error.message}`);
  if (!data?.length) return false;
  const records = [...data].sort((left, right) => {
    const leftValue = (left.payload as { value?: unknown })?.value;
    const rightValue = (right.payload as { value?: unknown })?.value;
    return (typeof leftValue === "string" ? leftValue.length : 0) -
      (typeof rightValue === "string" ? rightValue.length : 0);
  });
  for (const record of records) {
    if (isCloudExcludedKey(record.record_key)) continue;
    const value = (record.payload as { value?: unknown })?.value;
    if (typeof value !== "string") continue;
    let restoredValue = value;
    if (value.startsWith("data:image/")) {
      const isBackground = record.record_key === "4ta:chat-background";
      restoredValue = await compressCloudImage(value, isBackground ? 1080 : 512, isBackground ? 0.68 : 0.72);
    }
    try {
      localStorage.setItem(record.record_key, restoredValue);
    } catch (storageError) {
      if (isStorageQuotaError(storageError)) {
        reclaimRedundantLocalStorage();
        if (restoredValue.startsWith("data:image/")) {
          const smaller = await compressCloudImage(restoredValue, 320, 0.55);
          try {
            localStorage.setItem(record.record_key, smaller);
          } catch {
            continue;
          }
        } else {
          // Cloud is the source of truth. A standalone iOS PWA can have a
          // smaller local quota than Safari, so keep login usable and omit
          // embedded media from this device cache instead of aborting restore.
          const compacted = compactCloudCacheValue(restoredValue);
          if (!compacted) continue;
          try {
            localStorage.setItem(record.record_key, compacted);
          } catch {
            continue;
          }
        }
      } else {
        throw storageError;
      }
    }
  }
  repairTaProfilesFromSnapshots();
  return true;
}

/** Restore only the small records required to enter the app.
 * Large chats and embedded media must never block the login button. */
export async function restoreCloudBootstrapData() {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) return false;
  const bootstrapKeys = ["4ta:ta-profiles", "4ta:onboarding-complete", "4ta:active-ta-id"];
  const [bootstrapResult, snapshotResult] = await Promise.all([
    supabase
      .from("app_records")
      .select("record_key,payload")
      .eq("record_type", "local_storage")
      .in("record_key", bootstrapKeys),
    supabase
      .from("app_records")
      .select("record_key,payload")
      .eq("record_type", "local_storage")
      .like("record_key", "4ta:ta-profile:%"),
  ]);
  if (bootstrapResult.error) throw new Error(`基础数据恢复失败：${bootstrapResult.error.message}`);
  if (snapshotResult.error) throw new Error(`角色资料恢复失败：${snapshotResult.error.message}`);
  const records = [...(bootstrapResult.data || []), ...(snapshotResult.data || [])];
  for (const record of records) {
    const value = (record.payload as { value?: unknown })?.value;
    if (typeof value === "string") localStorage.setItem(record.record_key, value);
  }
  const profiles = repairTaProfilesFromSnapshots();
  // Older accounts did not always persist the onboarding flag. Existing Ta
  // records are stronger evidence than that optional marker and must never be
  // routed into the first-use creation flow.
  if (profiles.length > 0) localStorage.setItem("4ta:onboarding-complete", "1");
  return records.length > 0;
}

function compactCloudCacheValue(value: string) {
  if (!value.includes("data:image/") && !value.includes("data:audio/") && !value.includes("data:video/")) return "";
  try {
    let changed = false;
    const compact = (entry: unknown): unknown => {
      if (typeof entry === "string" && /^data:(?:image|audio|video)\//i.test(entry) && entry.length > 16_384) {
        changed = true;
        return "";
      }
      if (Array.isArray(entry)) return entry.map(compact);
      if (entry && typeof entry === "object") {
        return Object.fromEntries(Object.entries(entry).map(([key, nested]) => [key, compact(nested)]));
      }
      return entry;
    };
    const parsed = JSON.parse(value) as unknown;
    const result = JSON.stringify(compact(parsed));
    return changed ? result : "";
  } catch {
    return "";
  }
}

function mergeProfileLists(cloudProfiles: TaProfile[], localProfiles: TaProfile[]) {
  const merged = new Map<string, TaProfile>();
  cloudProfiles.forEach((profile) => {
    if (profile && typeof profile.id === "string") merged.set(profile.id, profile);
  });
  localProfiles.forEach((profile) => {
    if (profile && typeof profile.id === "string") {
      merged.set(profile.id, { ...merged.get(profile.id), ...profile });
    }
  });
  return Array.from(merged.values());
}

function mergeStoredMessageLists(cloudValue: string, localValue: string) {
  try {
    const cloudMessages = JSON.parse(cloudValue || "[]");
    const localMessages = JSON.parse(localValue || "[]");
    const merged = new Map<string, Record<string, unknown>>();
    [...(Array.isArray(cloudMessages) ? cloudMessages : []), ...(Array.isArray(localMessages) ? localMessages : [])]
      .forEach((message: Record<string, unknown>) => {
        if (typeof message?.id === "string") merged.set(message.id, message);
      });
    return JSON.stringify(Array.from(merged.values()).sort((left, right) =>
      String(left.createdAt || "").localeCompare(String(right.createdAt || ""))));
  } catch {
    return localValue || cloudValue || "[]";
  }
}

export async function recoverCloudCharacterData() {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) return 0;
  const queries = await Promise.all([
    supabase.from("app_records").select("record_key,payload").eq("record_type", "local_storage").eq("record_key", "4ta:ta-profiles"),
    supabase.from("app_records").select("record_key,payload").eq("record_type", "local_storage").like("record_key", "4ta:ta-profile:%"),
    supabase.from("app_records").select("record_key,payload").eq("record_type", "local_storage").like("record_key", "4ta:chat-messages:%"),
    supabase.from("app_records").select("record_key,payload").eq("record_type", "local_storage").like("record_key", "4ta:ta-seed-messages:%"),
  ]);
  const records = queries.flatMap((result) => result.data || []);
  let cloudProfiles: TaProfile[] = [];
  records.forEach((record) => {
    const value = (record.payload as { value?: unknown } | undefined)?.value;
    if (typeof value !== "string") return;
    if (record.record_key === "4ta:ta-profiles") {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) cloudProfiles = parsed;
      } catch {
        // Individual snapshots can still restore the list.
      }
      return;
    }
    if (record.record_key.startsWith("4ta:chat-messages:")) {
      const merged = mergeStoredMessageLists(value, localStorage.getItem(record.record_key) || "[]");
      localStorage.setItem(record.record_key, merged);
      return;
    }
    if (!localStorage.getItem(record.record_key)) {
      localStorage.setItem(record.record_key, value);
    }
  });
  const mergedProfiles = mergeProfileLists(cloudProfiles, readTaProfiles());
  saveTaProfiles(mergedProfiles);
  return repairTaProfilesFromSnapshots(mergedProfiles).length;
}

export async function restoreCloudChatMessages() {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) return 0;
  const activeTaId = getActiveTaId();
  const activeRecordKey = taMessageKey(activeTaId);
  const { data, error } = await supabase
    .from("app_records")
    .select("payload")
    .eq("record_type", "local_storage")
    .eq("record_key", activeRecordKey)
    .maybeSingle();
  if (error) throw new Error(`聊天恢复失败：${error.message}`);
  let cloudValue = (data?.payload as { value?: unknown } | undefined)?.value;
  if (typeof cloudValue !== "string" && activeTaId === "main") {
    const { data: legacyData } = await supabase
      .from("app_records")
      .select("payload")
      .eq("record_type", "local_storage")
      .eq("record_key", "4ta:chat-messages")
      .maybeSingle();
    cloudValue = (legacyData?.payload as { value?: unknown } | undefined)?.value;
  }
  if (typeof cloudValue !== "string") return 0;
  try {
    const cloudMessages = JSON.parse(cloudValue);
    const localMessages = JSON.parse(localStorage.getItem(activeRecordKey) || "[]");
    if (!Array.isArray(cloudMessages)) return 0;
    const merged = new Map<string, Record<string, unknown>>();
    cloudMessages.forEach((message: Record<string, unknown>) => {
      if (typeof message?.id === "string") merged.set(message.id, message);
    });
    if (Array.isArray(localMessages)) {
      localMessages.forEach((message: Record<string, unknown>) => {
        if (typeof message?.id === "string") merged.set(message.id, message);
      });
    }
    const next = Array.from(merged.values()).sort((left, right) =>
      String(left.createdAt || "").localeCompare(String(right.createdAt || "")));
    saveTaMessages(activeTaId, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("4ta:cloud-chat-restored", {
      detail: { taId: activeTaId, count: next.length },
    }));
    return next.length;
  } catch {
    return 0;
  }
}

export async function changeCloudPassword(username: string, newPassword: string) {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session || session.user.is_anonymous) {
    await loginOrRegisterCloudAccount(username, newPassword);
  } else {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw new Error(`密码修改失败：${error.message}`);
  }
  await saveCloudProfile(username);
  await syncAllLocalData();
}

export async function logoutCloudAccount() {
  await syncAllLocalData();
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(`退出失败：${error.message}`);
}

export async function uploadCloudMedia(file: File) {
  const session = await ensureCloudSession();
  // Supabase bucket now explicitly accepts iOS audio/mp4 and audio/x-m4a.
  // Keep the real MIME type: disguising MP4 bytes as MP3 uploads successfully
  // but produces audio that some browsers cannot decode or play.
  const uploadFile = file;
  const extension = uploadFile.name.split(".").pop()?.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "bin";
  const path = `${session.user.id}/${safeRandomUUID()}.${extension}`;
  const { error } = await supabase.storage
    .from("4ta-media")
    .upload(path, uploadFile, { contentType: uploadFile.type || "application/octet-stream" });
  if (error) throw new Error(`文件上传失败：${error.message}`);
  return supabase.storage.from("4ta-media").getPublicUrl(path).data.publicUrl;
}

export async function syncStickerPackCloud(pack: StickerPack) {
  const session = await ensureCloudSession();
  const { error: packError } = await supabase.from("sticker_packs").upsert({
    id: pack.id,
    user_id: session.user.id,
    name: pack.name,
    cover_url: pack.cover,
    updated_at: pack.updatedAt,
  });
  if (packError) throw new Error(`表情包同步失败：${packError.message}`);

  const { error: deleteError } = await supabase
    .from("stickers")
    .delete()
    .eq("pack_id", pack.id);
  if (deleteError) throw new Error(`表情包同步失败：${deleteError.message}`);

  if (pack.stickers.length) {
    const { error: stickerError } = await supabase.from("stickers").insert(
      pack.stickers.map((sticker, index) => ({
        id: sticker.id,
        pack_id: pack.id,
        user_id: session.user.id,
        image_url: sticker.image,
        name: sticker.name,
        description: sticker.description,
        favorite: sticker.favorite,
        sort_order: index,
      })),
    );
    if (stickerError) throw new Error(`表情包同步失败：${stickerError.message}`);
  }
}
