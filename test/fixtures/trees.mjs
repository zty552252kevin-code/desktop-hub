// test/fixtures/trees.mjs — synthetic get_window_state payloads shaped like
// cua 0.28.2 output, for test/unit.mjs. All labels are invented.
//
// A row is [depth, role, label, opts]. label may be null. opts (all optional):
//   ix:false      un-indexed row: markdown only, absent from elements[]
//   idx:n         explicit element_index (default: next free number)
//   v             value            desc   (desc) shown after the value
//   id, help      bracket fields   a      actions, AX names (["AXPress"])
//   press:true    shorthand for a:["AXPress","AXShowMenu"]
//   f:[x,y,w,h]   WINDOW-RELATIVE frame; written to elements[] as absolute
//                 screen coordinates (window origin added), the way cua does
//   en:false      enabled:false     sel:true  selected:true    web:true
// AXStaticText rows follow cua: markdown shows ` = "text"`, elements[] carries
// label === value === text.
//
// opts: { pid, windowId, title, win:{x,y,w,h}, mode:"both"|"md"|"els",
//         omitMd:[idx], truncated:"AX tree truncated at …", trailingNewline }

export const WIN = { x: 100, y: 50, w: 1000, h: 700 };

const MD_ACTION = (a) => a.replace(/^AX/, "").toLowerCase();

export function payload(sid, rows, opts = {}) {
  const win = opts.win ?? WIN;
  const mode = opts.mode ?? "both";
  const omit = new Set(opts.omitMd ?? []);
  const elements = [];
  const lines = [];
  const stack = []; // [{depth, idx|null}]
  let next = 0;
  let title = opts.title;
  for (const [depth, role, label, o = {}] of rows) {
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const indexed = o.ix !== false;
    const idx = indexed ? (o.idx ?? next) : null;
    if (indexed) next = Math.max(next, idx + 1);
    const isText = role === "AXStaticText";
    const actions = o.a ?? (o.press ? ["AXPress", "AXShowMenu"] : []);

    // markdown row
    let md = `${"  ".repeat(depth)}- ${indexed ? `[${idx}] ` : ""}${role}`;
    if (isText) {
      if (label !== null) md += ` = "${label}"`;
    } else {
      if (label !== null && label !== undefined) md += ` "${label}"`;
      if (o.v !== undefined) md += ` = "${o.v}"`;
      if (o.desc !== undefined) md += ` (${o.desc})`;
    }
    if (indexed && (actions.length || o.id !== undefined || o.help !== undefined)) {
      const parts = [];
      if (o.id !== undefined) parts.push(`id=${o.id}`);
      if (o.help !== undefined) parts.push(`help="${o.help}"`);
      parts.push(`actions=[${actions.map(MD_ACTION).join(",")}]`);
      md += ` [${parts.join(" ")}]`;
    }
    if (!(indexed && omit.has(idx))) lines.push(md);

    // elements[] entry
    if (indexed) {
      const isRootWin = depth === 0 && role === "AXWindow";
      const parent = [...stack].reverse().find((s) => s.idx !== null);
      const e = { element_index: idx, element_token: `${sid}:${idx}`, role, depth };
      if (parent) e.parent_index = parent.idx;
      e.actions = actions;
      if (!isRootWin) {
        e.enabled = o.en ?? true;
        e.selected = o.sel ?? false;
      }
      if (isText) {
        if (label !== null) e.label = e.value = label;
      } else {
        if (label !== null && label !== undefined) e.label = label;
        if (o.v !== undefined) e.value = o.v;
      }
      if (isRootWin) e.frame = { x: win.x, y: win.y, w: win.w, h: win.h };
      else if (o.f) e.frame = { x: win.x + o.f[0], y: win.y + o.f[1], w: o.f[2], h: o.f[3] };
      if (o.web) e.in_web_content = true;
      elements.push(e);
      if (isRootWin && title === undefined) title = label ?? "";
    }
    stack.push({ depth, idx });
  }

  let tree_markdown = lines.join("\n");
  if (opts.trailingNewline !== false && !opts.truncated) tree_markdown += "\n";
  if (opts.truncated) tree_markdown += `\n\n⚠️  ${opts.truncated}`;

  const out = {
    snapshot_id: sid,
    pid: opts.pid ?? 4242,
    window_id: opts.windowId ?? 777,
    window_title: title ?? "",
    elements_complete: false,
    element_count: elements.length,
  };
  if (mode !== "md") out.elements = elements;
  if (mode !== "els") out.tree_markdown = tree_markdown;
  return out;
}

export function degradedPayload(sid, reason = "ax_window_unresolved:test") {
  return { snapshot_id: sid, pid: 4242, window_id: 777, degraded: true, degraded_reason: reason, elements: [], element_count: 0, tree_markdown: "" };
}

// A window-relative frame for row `i` of a vertical list (30 px rows).
export const rowFrame = (i, x = 20, w = 60, top = 100) => [x, top + i * 30, w, 24];
