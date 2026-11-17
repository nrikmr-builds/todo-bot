import Anthropic from "@anthropic-ai/sdk";
import { Store } from "./store";
import { TOOLS, runTool } from "./tools";

const MODEL = "claude-haiku-5-5";
const MAX_STEPS = 8;

const SYSTEM = `You manage the user's personal to-do list. They talk to you in a WhatsApp chat called "To-do list".

Every open item has a label: its top-level category's letter(s) plus a number, e.g. A1 or R3. Labels stay the same when other items are completed, so gaps (R1, R2, R4) are normal.

How to work:
- Make every change with a tool. Never say something changed unless a tool result confirms it.
- When the user wants to see the list or one category, call show_list. The list is appended under your reply automatically, so don't retype it; a short lead-in or nothing at all is fine.
- Match loose references ("the podcast one", "econ") to labels using the current list below. If a reference fits more than one item, or none, ask instead of guessing.
- "done", "finished", "check off", "remove", "x R3" mean complete_items. Completed items are archived and never shown in the list again; restore_items brings one back.
- Categories can hold sub-lists, written as a path like "Recruiting > Networking". add_items and move_items create missing categories, so tell the user when one was created.
- Keep item wording close to what the user typed. Fix only obvious typos.
- Ask before deleting a category. delete_category only works once its items are done or moved.

Replies are WhatsApp messages: short and plain, usually one or two lines. Use WhatsApp formatting (*bold*, _italic_) sparingly; no markdown headings, tables or code blocks. After a change, confirm it with labels, e.g. "✅ Done: R5, A1 (6 open)" or "➕ Added A4 to Academics". If a message isn't about the list, answer in a line and offer to help with the list.`;

export async function runAgent(apiKey: string, store: Store, userText: string): Promise<string> {
  const client = new Anthropic({ apiKey });
  const history = await store.recentTurns(6);
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/Los_Angeles",
  });

  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: SYSTEM },
    { type: "text", text: `Today is ${today}.\n\nCurrent open list:\n${await store.render()}` },
  ];
  const messages: Anthropic.MessageParam[] = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userText },
  ];

  const shown: string[] = [];
  let reply = "";
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      output_config: { effort: "low" },
      system,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === "refusal") {
      reply = "Sorry, I can't help with that one.";
      break;
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (response.stop_reason !== "tool_use" || !calls.length) {
      reply = text;
      break;
    }

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      const result = await runTool(store, call.name, call.input, shown);
      const isError = typeof result === "object" && result !== null && "error" in result;
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify(result),
        ...(isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });
    if (step === MAX_STEPS - 1) reply = text || "I made some changes but ran out of steps. Ask me to show the list to check.";
  }

  const full = [reply, ...shown].filter(Boolean).join("\n\n") || "👍";
  // Keep memory compact: the list itself isn't stored, just the fact that it was shown.
  await store.saveTurn(userText, [reply, shown.length ? "[showed the list]" : ""].filter(Boolean).join(" ") || "👍");
  return full;
}
