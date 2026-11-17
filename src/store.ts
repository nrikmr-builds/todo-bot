// All list logic. Both the WhatsApp agent and the Claude Code API call these methods.

export type Cat = {
  id: number;
  name: string;
  parent_id: number | null;
  prefix: string | null;
  next_num: number;
  position: number;
};
export type Item = {
  id: number;
  category_id: number;
  label: string;
  text: string;
  position: number;
  created_at: string;
  done_at: string | null;
};

/** A user-facing problem (bad label, unknown category). Returned to the model, not thrown to the user. */
export class ToolError extends Error {}

const MAX_DEPTH = 3;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const normLabel = (s: string) => s.trim().toUpperCase().replace(/\s+/g, "");
const splitPath = (path: string) =>
  path
    .split(/\s*(?:>|\/|›|»)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);

export class Store {
  constructor(private db: D1Database) {}

  // ---------- reads ----------

  async cats(): Promise<Cat[]> {
    return (await this.db.prepare("SELECT * FROM categories ORDER BY position, id").all<Cat>()).results;
  }

  async openItems(): Promise<Item[]> {
    return (
      await this.db.prepare("SELECT * FROM items WHERE done_at IS NULL ORDER BY position, id").all<Item>()
    ).results;
  }

  private async openByLabel(label: string): Promise<Item | null> {
    return this.db
      .prepare("SELECT * FROM items WHERE label = ? AND done_at IS NULL")
      .bind(normLabel(label))
      .first<Item>();
  }

  // ---------- category helpers ----------

  private top(cat: Cat, cats: Cat[]): Cat {
    let c = cat;
    while (c.parent_id !== null) c = cats.find((x) => x.id === c.parent_id)!;
    return c;
  }

  pathOf(cat: Cat, cats: Cat[]): string {
    const parts: string[] = [];
    let c: Cat | undefined = cat;
    while (c) {
      parts.unshift(c.name);
      c = c.parent_id === null ? undefined : cats.find((x) => x.id === c!.parent_id);
    }
    return parts.join(" > ");
  }

  private subtreeIds(root: Cat, cats: Cat[]): number[] {
    const ids = [root.id];
    for (let i = 0; i < ids.length; i++) {
      for (const c of cats) if (c.parent_id === ids[i]) ids.push(c.id);
    }
    return ids;
  }

  /** Full path from the root ("Recruiting > Networking"), or a single unique name anywhere ("networking"). */
  resolve(path: string, cats: Cat[]): Cat | null {
    const parts = splitPath(path);
    if (!parts.length) throw new ToolError("Empty category name.");
    let parent: number | null = null;
    let cur: Cat | undefined;
    for (const p of parts) {
      cur = cats.find((c) => c.parent_id === parent && norm(c.name) === norm(p));
      if (!cur) break;
      parent = cur.id;
    }
    if (cur) return cur;
    if (parts.length === 1) {
      const hits = cats.filter((c) => norm(c.name) === norm(parts[0]));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1)
        throw new ToolError(
          `"${parts[0]}" is ambiguous: ${hits.map((h) => this.pathOf(h, cats)).join(", ")}. Use the full path.`,
        );
    }
    return null;
  }

  private async pickPrefix(name: string, cats: Cat[]): Promise<string> {
    const taken = new Set(cats.map((c) => c.prefix).filter(Boolean));
    const letters = name.toUpperCase().replace(/[^A-Z]/g, "") || "X";
    for (let n = 1; n <= Math.min(3, letters.length); n++) {
      if (!taken.has(letters.slice(0, n))) return letters.slice(0, n);
    }
    for (let i = 2; ; i++) if (!taken.has(letters[0] + "X".repeat(i - 1))) return letters[0] + "X".repeat(i - 1);
  }

  /** Resolve a path, creating any missing categories. Returns the leaf and the paths it created. */
  private async ensure(path: string): Promise<{ cat: Cat; created: string[] }> {
    let cats = await this.cats();
    const existing = this.resolve(path, cats);
    if (existing) return { cat: existing, created: [] };

    const parts = splitPath(path);
    if (parts.length > MAX_DEPTH) throw new ToolError(`Lists can nest at most ${MAX_DEPTH} levels deep.`);
    const created: string[] = [];
    let parent: Cat | null = null;
    for (const p of parts) {
      const parentId: number | null = parent ? parent.id : null;
      let cur: Cat | undefined = cats.find((c) => c.parent_id === parentId && norm(c.name) === norm(p));
      if (!cur) {
        const prefix: string | null = parentId === null ? await this.pickPrefix(p, cats) : null;
        const pos: number = Math.max(0, ...cats.filter((c) => c.parent_id === parentId).map((c) => c.position)) + 1;
        const row: Cat | null = await this.db
          .prepare("INSERT INTO categories (name, parent_id, prefix, position) VALUES (?, ?, ?, ?) RETURNING *")
          .bind(p, parentId, prefix, pos)
          .first<Cat>();
        cats = [...cats, row!];
        cur = row!;
        created.push(this.pathOf(cur, cats));
      }
      parent = cur;
    }
    return { cat: parent!, created };
  }

  /** Reserve the next label for a top-level category (A4, R6, ...). */
  private async nextLabel(top: Cat): Promise<string> {
    const row = await this.db
      .prepare("UPDATE categories SET next_num = next_num + 1 WHERE id = ? RETURNING next_num - 1 AS n, prefix")
      .bind(top.id)
      .first<{ n: number; prefix: string }>();
    let n = row!.n;
    // Skip any label still held by an open item (possible after renumber/restore).
    while (await this.openByLabel(row!.prefix + n)) {
      n = (await this.db
        .prepare("UPDATE categories SET next_num = next_num + 1 WHERE id = ? RETURNING next_num - 1 AS n")
        .bind(top.id)
        .first<{ n: number }>())!.n;
    }
    return row!.prefix + n;
  }

  private async nextPosition(catId: number): Promise<number> {
    const r = await this.db
      .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM items WHERE category_id = ?")
      .bind(catId)
      .first<{ p: number }>();
    return r!.p;
  }

  // ---------- rendering ----------

  /** WhatsApp-formatted list. `path` limits it to one category (and its sub-lists). */
  async render(path?: string | null): Promise<string> {
    const cats = await this.cats();
    const items = await this.openItems();
    let roots = cats.filter((c) => c.parent_id === null);
    if (path) {
      const c = this.resolve(path, cats);
      if (!c) throw new ToolError(`No category called "${path}".`);
      roots = [c];
    }
    const lines: string[] = [];
    const walk = (c: Cat, depth: number) => {
      const pad = "    ".repeat(depth);
      const own = items.filter((i) => i.category_id === c.id);
      const kids = cats.filter((k) => k.parent_id === c.id);
      lines.push(depth === 0 ? `*${c.name}*` : `${"    ".repeat(depth - 1)}  ▸ _${c.name}_`);
      for (const i of own) lines.push(`${pad}${i.label} · ${i.text}`);
      if (!own.length && !kids.length) lines.push(`${pad}(empty)`);
      for (const k of kids) walk(k, depth + 1);
    };
    roots.forEach((r, idx) => {
      if (idx) lines.push("");
      walk(r, 0);
    });
    const shown = path
      ? items.filter((i) => this.subtreeIds(roots[0], cats).includes(i.category_id)).length
      : items.length;
    const header = path ? `📋 ${shown} open` : `📋 *To-do list* — ${shown} open`;
    if (!roots.length) return `${header}\n\nNothing here yet. Try "add to Academics: ..."`;
    return `${header}\n\n${lines.join("\n")}`;
  }

  // ---------- tools ----------

  async addItems(category: string, texts: string[]) {
    const clean = texts.map((t) => t.trim()).filter(Boolean);
    if (!clean.length) throw new ToolError("No item text given.");
    const { cat, created } = await this.ensure(category);
    const cats = await this.cats();
    const top = this.top(cat, cats);
    const added: { label: string; text: string }[] = [];
    let pos = await this.nextPosition(cat.id);
    for (const text of clean) {
      const label = await this.nextLabel(top);
      await this.db
        .prepare("INSERT INTO items (category_id, label, text, position) VALUES (?, ?, ?, ?)")
        .bind(cat.id, label, text, pos++)
        .run();
      added.push({ label, text });
    }
    return { category: this.pathOf(cat, cats), created_categories: created, added };
  }

  async completeItems(labels: string[]) {
    const done: { label: string; text: string }[] = [];
    const notFound: string[] = [];
    for (const l of labels) {
      const item = await this.openByLabel(l);
      if (!item) {
        notFound.push(normLabel(l));
        continue;
      }
      await this.db.prepare("UPDATE items SET done_at = datetime('now') WHERE id = ?").bind(item.id).run();
      done.push({ label: item.label, text: item.text });
    }
    const open = (await this.openItems()).length;
    return { completed: done, not_found: notFound, open_remaining: open };
  }

  async restoreItems(labels: string[]) {
    const restored: { label: string; text: string; was: string }[] = [];
    const notFound: string[] = [];
    const cats = await this.cats();
    for (const l of labels) {
      const item = await this.db
        .prepare("SELECT * FROM items WHERE label = ? AND done_at IS NOT NULL ORDER BY done_at DESC LIMIT 1")
        .bind(normLabel(l))
        .first<Item>();
      if (!item) {
        notFound.push(normLabel(l));
        continue;
      }
      let label = item.label;
      if (await this.openByLabel(label)) {
        label = await this.nextLabel(this.top(cats.find((c) => c.id === item.category_id)!, cats));
      }
      await this.db.prepare("UPDATE items SET done_at = NULL, label = ? WHERE id = ?").bind(label, item.id).run();
      restored.push({ label, text: item.text, was: item.label });
    }
    return { restored, not_found: notFound };
  }

  async editItem(label: string, text: string) {
    const item = await this.openByLabel(label);
    if (!item) throw new ToolError(`No open item ${normLabel(label)}.`);
    if (!text.trim()) throw new ToolError("New text is empty.");
    await this.db.prepare("UPDATE items SET text = ? WHERE id = ?").bind(text.trim(), item.id).run();
    return { label: item.label, before: item.text, after: text.trim() };
  }

  async moveItems(labels: string[], category: string) {
    const { cat: dest, created } = await this.ensure(category);
    const cats = await this.cats();
    const destTop = this.top(dest, cats);
    const moved: { from: string; to: string; text: string }[] = [];
    const notFound: string[] = [];
    let pos = await this.nextPosition(dest.id);
    for (const l of labels) {
      const item = await this.openByLabel(l);
      if (!item) {
        notFound.push(normLabel(l));
        continue;
      }
      const srcTop = this.top(cats.find((c) => c.id === item.category_id)!, cats);
      const label = srcTop.id === destTop.id ? item.label : await this.nextLabel(destTop);
      await this.db
        .prepare("UPDATE items SET category_id = ?, label = ?, position = ? WHERE id = ?")
        .bind(dest.id, label, pos++, item.id)
        .run();
      moved.push({ from: item.label, to: label, text: item.text });
    }
    return { category: this.pathOf(dest, cats), created_categories: created, moved, not_found: notFound };
  }

  async createCategory(path: string) {
    const { cat, created } = await this.ensure(path);
    const cats = await this.cats();
    return { category: this.pathOf(cat, cats), already_existed: created.length === 0, prefix: this.top(cat, cats).prefix };
  }

  async renameCategory(path: string, newName: string) {
    const cats = await this.cats();
    const cat = this.resolve(path, cats);
    if (!cat) throw new ToolError(`No category called "${path}".`);
    const name = newName.trim();
    if (!name || /[>\/]/.test(name)) throw new ToolError("New name must be a plain name without > or /.");
    if (cats.some((c) => c.id !== cat.id && c.parent_id === cat.parent_id && norm(c.name) === norm(name)))
      throw new ToolError(`A category called "${name}" already exists there.`);
    const before = this.pathOf(cat, cats);
    await this.db.prepare("UPDATE categories SET name = ? WHERE id = ?").bind(name, cat.id).run();
    return { before, after: this.pathOf({ ...cat, name }, cats), note: "Item labels are unchanged." };
  }

  async deleteCategory(path: string) {
    const cats = await this.cats();
    const cat = this.resolve(path, cats);
    if (!cat) throw new ToolError(`No category called "${path}".`);
    const ids = this.subtreeIds(cat, cats);
    const marks = ids.map(() => "?").join(",");
    const open = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM items WHERE done_at IS NULL AND category_id IN (${marks})`)
      .bind(...ids)
      .first<{ n: number }>();
    if (open!.n > 0)
      throw new ToolError(
        `"${this.pathOf(cat, cats)}" still has ${open!.n} open item(s). Move or complete them first.`,
      );
    await this.db.batch([
      this.db.prepare(`DELETE FROM items WHERE category_id IN (${marks})`).bind(...ids),
      // children first so parent references never dangle
      ...ids
        .slice()
        .reverse()
        .map((id) => this.db.prepare("DELETE FROM categories WHERE id = ?").bind(id)),
    ]);
    return { deleted: this.pathOf(cat, cats), categories_removed: ids.length };
  }

  async listDone(days = 7) {
    const cats = await this.cats();
    const rows = (
      await this.db
        .prepare(
          "SELECT * FROM items WHERE done_at IS NOT NULL AND done_at >= datetime('now', ?) ORDER BY done_at DESC LIMIT 100",
        )
        .bind(`-${Math.max(1, Math.min(365, Math.round(days)))} days`)
        .all<Item>()
    ).results;
    return {
      days,
      count: rows.length,
      items: rows.map((r) => ({
        label: r.label,
        text: r.text,
        category: this.pathOf(cats.find((c) => c.id === r.category_id)!, cats),
        done_at: r.done_at,
      })),
    };
  }

  /** Close the gaps in labels (R1, R2, R4 -> R1, R2, R3) for one top-level category or all. */
  async renumber(category?: string | null) {
    const cats = await this.cats();
    const items = await this.openItems();
    let tops = cats.filter((c) => c.parent_id === null);
    if (category) {
      const c = this.resolve(category, cats);
      if (!c) throw new ToolError(`No category called "${category}".`);
      tops = [this.top(c, cats)];
    }
    const changes: { from: string; to: string }[] = [];
    for (const t of tops) {
      const ordered: Item[] = [];
      const walk = (c: Cat) => {
        ordered.push(...items.filter((i) => i.category_id === c.id));
        cats.filter((k) => k.parent_id === c.id).forEach(walk);
      };
      walk(t);
      // two passes so the unique index never sees a temporary duplicate
      const stmts = ordered.map((i) => this.db.prepare("UPDATE items SET label = ? WHERE id = ?").bind(`~${i.id}`, i.id));
      ordered.forEach((i, n) => {
        const label = `${t.prefix}${n + 1}`;
        stmts.push(this.db.prepare("UPDATE items SET label = ? WHERE id = ?").bind(label, i.id));
        if (label !== i.label) changes.push({ from: i.label, to: label });
      });
      stmts.push(this.db.prepare("UPDATE categories SET next_num = ? WHERE id = ?").bind(ordered.length + 1, t.id));
      await this.db.batch(stmts);
    }
    return { changed: changes };
  }

  // ---------- chat memory & dedup ----------

  async recentTurns(pairs: number): Promise<{ role: "user" | "assistant"; content: string }[]> {
    const rows = (
      await this.db
        .prepare("SELECT role, content FROM messages ORDER BY id DESC LIMIT ?")
        .bind(pairs * 2)
        .all<{ role: "user" | "assistant"; content: string }>()
    ).results.reverse();
    while (rows.length && rows[0].role !== "user") rows.shift();
    return rows;
  }

  async saveTurn(user: string, assistant: string) {
    await this.db.batch([
      this.db.prepare("INSERT INTO messages (role, content) VALUES ('user', ?)").bind(user),
      this.db.prepare("INSERT INTO messages (role, content) VALUES ('assistant', ?)").bind(assistant),
      this.db.prepare("DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 40)"),
      this.db.prepare("DELETE FROM processed WHERE created_at < datetime('now', '-7 days')"),
    ]);
  }

  /** True the first time a WhatsApp message id is seen. */
  async claim(msgId: string): Promise<boolean> {
    const r = await this.db.prepare("INSERT OR IGNORE INTO processed (msg_id) VALUES (?)").bind(msgId).run();
    return r.meta.changes > 0;
  }
}
