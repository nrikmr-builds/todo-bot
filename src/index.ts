import { Store } from "./store";
import { runAgent } from "./agent";
import { runTool, TOOLS } from "./tools";
import { markReadTyping, sendText, validSignature, type WaConfig } from "./whatsapp";

export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  WA_TOKEN: string; // permanent System User token
  WA_PHONE_NUMBER_ID: string; // the bot's (test) number id
  WA_VERIFY_TOKEN: string; // any random string, also typed into Meta's webhook form
  WA_APP_SECRET: string; // App settings > Basic > App secret
  ALLOWED_WA_ID: string; // your own WhatsApp number, digits only, e.g. 13105551234
  API_TOKEN: string; // bearer token for the Claude Code /todo skill
  GRAPH_VERSION?: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json" } });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/webhook" && req.method === "GET") return verifyWebhook(url, env);
    if (url.pathname === "/webhook" && req.method === "POST") return handleWebhook(req, env, ctx);
    if (url.pathname.startsWith("/api/")) return handleApi(req, env, url);
    if (url.pathname === "/") return new Response("todo-bot is running");
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ---------- WhatsApp ----------

function verifyWebhook(url: URL, env: Env): Response {
  const p = url.searchParams;
  if (p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") === env.WA_VERIFY_TOKEN) {
    return new Response(p.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

async function handleWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get("x-hub-signature-256"), env.WA_APP_SECRET))) {
    return new Response("Bad signature", { status: 401 });
  }
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const cfg: WaConfig = {
    token: env.WA_TOKEN,
    phoneNumberId: env.WA_PHONE_NUMBER_ID,
    graphVersion: env.GRAPH_VERSION || "v23.0",
  };
  const store = new Store(env.DB);

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      if (value.metadata?.phone_number_id && value.metadata.phone_number_id !== env.WA_PHONE_NUMBER_ID) continue;
      for (const msg of value.messages ?? []) {
        // Only you can talk to it. Everyone else is silently ignored.
        if (msg.from !== env.ALLOWED_WA_ID) continue;
        ctx.waitUntil(handleMessage(env, cfg, store, msg));
      }
    }
  }
  // Acknowledge fast; Meta retries anything slower or non-200.
  return new Response("OK", { status: 200 });
}

async function handleMessage(env: Env, cfg: WaConfig, store: Store, msg: any) {
  if (!(await store.claim(msg.id))) return; // duplicate delivery
  try {
    await markReadTyping(cfg, msg.id);
    if (msg.type !== "text" || !msg.text?.body) {
      await sendText(cfg, msg.from, "I can only read text messages for now. Try \"give me the to-do list\".");
      return;
    }
    const reply = await runAgent(env.ANTHROPIC_API_KEY, store, msg.text.body);
    await sendText(cfg, msg.from, reply);
  } catch (e) {
    console.error("handleMessage failed", e);
    try {
      await sendText(cfg, msg.from, "⚠️ Something went wrong on my side. Your list wasn't changed by this message unless I said so — try again in a moment.");
    } catch (e2) {
      console.error("could not send error reply", e2);
    }
  }
}

// ---------- Private API for Claude Code ----------

function authorized(req: Request, env: Env): boolean {
  const given = req.headers.get("Authorization") ?? "";
  const expected = `Bearer ${env.API_TOKEN}`;
  if (!env.API_TOKEN || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
  const store = new Store(env.DB);
  try {
    if (url.pathname === "/api/list" && req.method === "GET") {
      return new Response(await store.render(url.searchParams.get("category")), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    if (url.pathname === "/api/tools" && req.method === "GET") {
      return json(TOOLS.map((t) => ({ name: t.name, description: t.description, input: t.input_schema })));
    }
    if (url.pathname === "/api/tool" && req.method === "POST") {
      const { name, input } = (await req.json()) as { name: string; input?: unknown };
      return json(await runTool(store, name, input));
    }
    if (url.pathname === "/api/chat" && req.method === "POST") {
      const { text } = (await req.json()) as { text: string };
      if (!text) return json({ error: "text required" }, 400);
      return json({ reply: await runAgent(env.ANTHROPIC_API_KEY, store, text) });
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
}
