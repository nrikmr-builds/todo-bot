// Meta WhatsApp Cloud API: webhook signature check and sending replies.

const enc = new TextEncoder();

/** Checks Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the app secret). */
export async function validSignature(rawBody: string, header: string | null, appSecret: string): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7).toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export type WaConfig = { token: string; phoneNumberId: string; graphVersion: string };

async function graph(cfg: WaConfig, body: unknown) {
  const res = await fetch(`https://graph.facebook.com/${cfg.graphVersion}/${cfg.phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
}

/** Blue ticks + "typing…" while the agent works. Best-effort. */
export async function markReadTyping(cfg: WaConfig, messageId: string) {
  try {
    await graph(cfg, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    });
  } catch {
    // older API versions reject typing_indicator; the reply still goes out
  }
}

/** WhatsApp caps text at 4096 chars; split on line breaks. */
function chunks(text: string, max = 3900): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur && cur.length + line.length + 1 > max) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${line}` : line.slice(0, max);
  }
  if (cur) out.push(cur);
  return out;
}

export async function sendText(cfg: WaConfig, to: string, text: string) {
  for (const body of chunks(text)) {
    await graph(cfg, { messaging_product: "whatsapp", to, type: "text", text: { body, preview_url: false } });
  }
}
