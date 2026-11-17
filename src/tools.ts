import type Anthropic from "@anthropic-ai/sdk";
import { Store, ToolError } from "./store";

const labels = {
  type: "array",
  items: { type: "string" },
  description: 'Item labels exactly as shown in the list, e.g. ["R3", "A1"].',
} as const;
const category = {
  type: "string",
  description: 'Category name or path. Sub-lists use ">", e.g. "Recruiting > Networking".',
} as const;

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "show_list",
    description:
      "Show the open to-do list to the user. The formatted list is appended to your reply automatically; do not retype it. Omit category for the whole list.",
    input_schema: { type: "object", properties: { category }, additionalProperties: false },
  },
  {
    name: "add_items",
    description: "Add one or more items to a category. Missing categories/sub-lists in the path are created.",
    input_schema: {
      type: "object",
      properties: { category, items: { type: "array", items: { type: "string" }, description: "Item texts." } },
      required: ["category", "items"],
      additionalProperties: false,
    },
  },
  {
    name: "complete_items",
    description: "Mark items done. They are archived and will not appear in the list again.",
    input_schema: { type: "object", properties: { labels }, required: ["labels"], additionalProperties: false },
  },
  {
    name: "restore_items",
    description: "Undo completion: bring archived items back onto the list.",
    input_schema: { type: "object", properties: { labels }, required: ["labels"], additionalProperties: false },
  },
  {
    name: "edit_item",
    description: "Replace the text of one open item.",
    input_schema: {
      type: "object",
      properties: { label: { type: "string" }, text: { type: "string" } },
      required: ["label", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "move_items",
    description:
      "Move items to another category or sub-list (created if missing). Items moved to a different top-level category get a new label.",
    input_schema: {
      type: "object",
      properties: { labels, category },
      required: ["labels", "category"],
      additionalProperties: false,
    },
  },
  {
    name: "create_category",
    description: "Create an empty category or sub-list.",
    input_schema: { type: "object", properties: { category }, required: ["category"], additionalProperties: false },
  },
  {
    name: "rename_category",
    description: "Rename a category or sub-list.",
    input_schema: {
      type: "object",
      properties: { category, new_name: { type: "string" } },
      required: ["category", "new_name"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_category",
    description:
      "Delete a category and its sub-lists. Fails if it still has open items. Ask the user before deleting.",
    input_schema: { type: "object", properties: { category }, required: ["category"], additionalProperties: false },
  },
  {
    name: "list_done",
    description: "List items completed in the last N days (default 7).",
    input_schema: {
      type: "object",
      properties: { days: { type: "number" } },
      additionalProperties: false,
    },
  },
  {
    name: "renumber",
    description:
      "Close gaps in labels (R1, R2, R5 -> R1, R2, R3). Only when the user asks to renumber or tidy labels.",
    input_schema: { type: "object", properties: { category }, additionalProperties: false },
  },
];

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`"${name}" must be a non-empty string.`);
  return v;
};
const strs = (v: unknown, name: string): string[] => {
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string"))
    throw new ToolError(`"${name}" must be a non-empty list of strings.`);
  return v as string[];
};
const optStr = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

/**
 * Run one tool. `shown` collects rendered lists that get appended to the reply.
 * Returns a JSON-serialisable result; ToolErrors come back as { error } so the model can recover.
 */
export async function runTool(store: Store, name: string, input: any, shown?: string[]): Promise<unknown> {
  input = input ?? {};
  try {
    switch (name) {
      case "show_list": {
        const text = await store.render(optStr(input.category));
        shown?.push(text);
        return shown ? { ok: true, note: "List will be shown to the user below your reply." } : { text };
      }
      case "add_items":
        return await store.addItems(str(input.category, "category"), strs(input.items, "items"));
      case "complete_items":
        return await store.completeItems(strs(input.labels, "labels"));
      case "restore_items":
        return await store.restoreItems(strs(input.labels, "labels"));
      case "edit_item":
        return await store.editItem(str(input.label, "label"), str(input.text, "text"));
      case "move_items":
        return await store.moveItems(strs(input.labels, "labels"), str(input.category, "category"));
      case "create_category":
        return await store.createCategory(str(input.category, "category"));
      case "rename_category":
        return await store.renameCategory(str(input.category, "category"), str(input.new_name, "new_name"));
      case "delete_category":
        return await store.deleteCategory(str(input.category, "category"));
      case "list_done":
        return await store.listDone(typeof input.days === "number" ? input.days : 7);
      case "renumber":
        return await store.renumber(optStr(input.category));
      default:
        return { error: `Unknown tool ${name}` };
    }
  } catch (e) {
    if (e instanceof ToolError) return { error: e.message };
    throw e;
  }
}
