// lib/tree.mjs — pure functions over cua get_window_state payloads (no I/O).
//
// Why this exists: the host shows the model `structuredContent` as raw JSON
// whenever a result carries one, so a pass-through window_state delivered the
// same AX tree twice (elements[] JSON + tree_markdown) at ~385 chars per
// element, and trees past the host's 50k-char line were spilled to disk
// unseen. The hub now parses the payload once into an internal tree and
// renders its own compact text (~20 chars per row less the chrome).
//
// Source of truth: `elements[]` for every indexed row (role/label/value/frame/
// actions are structured there — no quote-escaping guesswork), and
// `tree_markdown` only for row ORDER and for the un-indexed rows (static
// text, disabled menu items, containers) that elements[] omits.

const NODE_RE = /^(\s*)- (?:\[(\d+)\] )?([A-Za-z][A-Za-z0-9]*)([\s\S]*)$/;

const str = (v) => (v === undefined || v === null ? undefined : String(v));

function relFrame(f, win) {
  if (!f || typeof f.x !== "number") return undefined;
  return win ? { x: f.x - win.x, y: f.y - win.y, w: f.w, h: f.h } : { x: f.x, y: f.y, w: f.w, h: f.h };
}

// Best-effort split of a markdown row tail into label / value / help. Only
// used when the payload has no elements[] (cua >= 0.34 compact default) and
// for the `help=` of unlabeled rows; values containing `" (` can fool it,
// which is why structured fields win whenever they exist.
function splitBracket(rest) {
  const a = rest.lastIndexOf("actions=[");
  if (a < 0) return { head: rest, bracket: "" };
  const open = Math.max(rest.lastIndexOf(" [id=", a), rest.lastIndexOf(" [help=", a), rest.lastIndexOf(" [actions=", a));
  if (open < 0) return { head: rest, bracket: "" };
  return { head: rest.slice(0, open), bracket: rest.slice(open + 2) };
}

// A row tail still has an unterminated quote when it contains one and does
// not end with `"`, optionally followed by ` (desc)` and/or the ` [id=… ]`
// bracket.
// Judged on the part before the bracket: help="…" inside the bracket is not
// a row value.
const CLOSED_RE = /"(?: \([^\n]*\))?\s*$/;
function isOpen(rest) {
  const { head } = splitBracket(rest);
  return head.includes('"') && !CLOSED_RE.test(head);
}

function parseHead(head) {
  const m = /^(?: "([\s\S]*?)")?(?: = "([\s\S]*?)")?(?: \(([\s\S]*?)\))?$/.exec(head);
  if (!m) return {};
  return { label: m[1] ?? m[3], value: m[2] };
}

function helpOf(bracket) {
  const m = /help="([\s\S]*?)" actions=\[/.exec(bracket);
  return m ? m[1] : undefined;
}

function nodeFromElement(e, win, rest) {
  const actions = Array.isArray(e.actions) ? e.actions : [];
  const n = {
    idx: e.element_index,
    role: String(e.role ?? "AXUnknown"),
    depth: Number.isInteger(e.depth) && e.depth > 0 ? e.depth : 0,
    label: str(e.label),
    value: str(e.value),
    press: actions.includes("AXPress"),
    actions,
    enabled: e.enabled,
    selected: e.selected,
    frame: relFrame(e.frame, win),
  };
  if (!n.label && rest) n.help = helpOf(splitBracket(rest).bracket);
  return n;
}

function nodeFromMarkdown(idx, role, indent, rest) {
  const { head, bracket } = splitBracket(rest);
  const { label, value } = parseHead(head);
  const acts = /actions=\[([^\]]*)\]/.exec(bracket)?.[1] ?? "";
  return {
    idx,
    role,
    depth: indent >> 1,
    label,
    value,
    press: /(^|,)press(,|$)/.test(acts),
    actions: [],
    enabled: undefined,
    selected: undefined,
    frame: undefined,
    help: label ? undefined : helpOf(bracket),
  };
}

// Parse one get_window_state payload. Returns null when it is not a window
// tree at all; a degraded payload returns a tree with `degraded:true`.
export function parseTree(sc, meta = {}) {
  if (!sc || typeof sc !== "object") return null;
  const hasEls = Array.isArray(sc.elements);
  const md = typeof sc.tree_markdown === "string" ? sc.tree_markdown : "";
  if (!hasEls && !md && !sc.degraded) return null;

  const els = new Map();
  if (hasEls) for (const e of sc.elements) if (Number.isInteger(e?.element_index)) els.set(e.element_index, e);
  const winEl = hasEls ? sc.elements.find((e) => e?.depth === 0 && e?.role === "AXWindow") : undefined;
  const win = winEl?.frame && typeof winEl.frame.x === "number" ? { x: winEl.frame.x, y: winEl.frame.y, w: winEl.frame.w, h: winEl.frame.h } : undefined;

  const nodes = [];
  const seen = new Set();
  let truncated;
  if (md) {
    // A row is built lazily: its tail may run over several lines (a quoted
    // value with newlines, action names with newlines), and those lines can
    // LOOK like rows — a terminal showing this very tree does. While a quote
    // is open every line belongs to the row; outside one, an indexed line is
    // a row only if it agrees with elements[] on role, depth and label and
    // its index moves forward.
    let cur = null;
    let open = false;
    let lastIdx = -1;
    const finalize = () => {
      if (!cur) return;
      if (cur.kind === "el") nodes.push(nodeFromElement(cur.e, win, cur.rest));
      else if (cur.kind === "md") nodes.push(nodeFromMarkdown(cur.idx, cur.role, cur.indent, cur.rest));
      else {
        const text = cur.rest.replace(/\s+$/, "");
        const { label, value } = parseHead(splitBracket(text).head);
        nodes.push({ idx: null, role: cur.role, depth: cur.indent >> 1, text, label, value });
      }
      cur = null;
    };
    // Does this line agree with elements[] as the next indexed row?
    const realRow = (m) => {
      if (!m || m[2] === undefined) return null;
      const idx = Number(m[2]);
      const e = els.get(idx);
      if (!e || seen.has(idx) || idx <= lastIdx) return null;
      if (e.role !== m[3] || m[1].length !== (e.depth ?? 0) * 2) return null;
      if (e.label && !m[4].includes(String(e.label).split("\n")[0])) return null;
      return { kind: "el", idx, e, rest: m[4] };
    };
    // Without elements[] there is nothing to check a row against; the best
    // available sign that a quote failed to close is an indexed row whose
    // number is exactly the next one, at a plausible indent.
    const nextRowMdOnly = (line) => {
      const m = NODE_RE.exec(line);
      if (!m || m[2] === undefined || !m[3].startsWith("AX") || m[1].length % 2) return false;
      let last = -1;
      for (let k = nodes.length - 1; k >= 0 && last < 0; k--) if (nodes[k].idx !== null && nodes[k].idx !== undefined) last = nodes[k].idx;
      const curIdx = cur?.idx ?? last;
      return Number(m[2]) === Math.max(last, curIdx ?? -1) + 1;
    };
    for (const line of md.split("\n")) {
      if (open) {
        // Inside a quoted multi-line value everything is content — unless the
        // line is provably the next real row, which means the quote never
        // closed the way this parser expects (e.g. a description with a
        // newline); swallowing the rest of the tree would be far worse.
        if (!(hasEls ? realRow(NODE_RE.exec(line)) : nextRowMdOnly(line))) {
          cur.rest += `\n${line}`;
          open = !CLOSED_RE.test(splitBracket(line).head);
          continue;
        }
        open = false;
      }
      // cua appends "⚠️  AX tree truncated at N nodes …" after the rows when
      // the walk hit its cap — a notice, not content of the last row.
      if (line.startsWith("⚠️")) {
        truncated = line.replace(/^⚠️\s*/, "");
        finalize();
        continue;
      }
      const m = NODE_RE.exec(line);
      let made = null;
      if (m && m[3].startsWith("AX")) {
        const indent = m[1].length;
        if (m[2] === undefined) made = { kind: "text", role: m[3], indent, rest: m[4] };
        else {
          const idx = Number(m[2]);
          if (hasEls) made = realRow(m);
          else if (!seen.has(idx) && idx > lastIdx) made = { kind: "md", idx, role: m[3], indent, rest: m[4] };
          if (made) {
            seen.add(idx);
            lastIdx = idx;
          }
        }
      }
      if (made) {
        finalize();
        cur = made;
        open = isOpen(cur.rest);
      } else if (cur && line.trim() !== "") {
        cur.rest += `\n${line}`; // e.g. action names that contain newlines
      }
    }
    finalize();
  }
  // elements[] rows the markdown did not carry (or no markdown at all): splice
  // them in by index so order stays depth-first.
  if (hasEls && seen.size < els.size) {
    const missing = [...els.keys()].filter((i) => !seen.has(i)).sort((a, b) => a - b);
    const merged = [];
    let k = 0;
    for (const n of nodes) {
      if (n.idx !== null) while (k < missing.length && missing[k] < n.idx) merged.push(nodeFromElement(els.get(missing[k++]), win));
      merged.push(n);
    }
    while (k < missing.length) merged.push(nodeFromElement(els.get(missing[k++]), win));
    nodes.length = 0;
    nodes.push(...merged);
  }

  // Parent links + menu-bar membership in one pass over the DFS order.
  // The menu bar is the application's own: an AXMenuBar hanging off the
  // window/application root. A role=menubar inside a web page (el-menu, a
  // rich-text editor's toolbar) is page content like any other.
  const stack = []; // positions of open ancestors
  let menuDepth = -1;
  let webDepth = -1;
  const byIdx = new Map();
  for (let p = 0; p < nodes.length; p++) {
    const n = nodes[p];
    while (stack.length && nodes[stack[stack.length - 1]].depth >= n.depth) stack.pop();
    n.pos = p;
    n.parent = stack.length ? stack[stack.length - 1] : -1;
    stack.push(p);
    if (menuDepth >= 0 && n.depth <= menuDepth) menuDepth = -1;
    if (webDepth >= 0 && n.depth <= webDepth) webDepth = -1;
    n.inMenuBar = menuDepth >= 0;
    if (n.role === "AXWebArea" && webDepth < 0) webDepth = n.depth;
    else if (n.role === "AXMenuBar" && menuDepth < 0 && webDepth < 0 && n.depth <= 1) {
      menuDepth = n.depth;
      n.inMenuBar = true;
    }
    if (n.idx !== null) byIdx.set(n.idx, n);
  }

  return {
    snapshotId: str(sc.snapshot_id),
    pid: sc.pid ?? meta.pid,
    windowId: sc.window_id ?? meta.windowId,
    title: str(sc.window_title) ?? nodes.find((n) => n.role === "AXWindow")?.label ?? "",
    complete: sc.elements_complete !== false,
    degraded: !!sc.degraded,
    degradedReason: str(sc.degraded_reason),
    structured: hasEls,
    truncated,
    win,
    nodes,
    byIdx,
    at: meta.at,
    walkMs: meta.walkMs,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function clip(v, max) {
  v = String(v);
  return v.length > max ? `${v.slice(0, max)}…[+${v.length - max} chars]` : v;
}

const quote = (v, max) => JSON.stringify(clip(v, max));

// One row, without indentation. `[n]` = AX-pressable, `(n)` = indexed but not
// pressable: 34% of real web rows are indexed-but-inert, and an AX click on
// one is a silent no-op — the cheapest possible signal is the bracket shape.
//
// o.shown (a Set) collects every row number printed: a token is only honoured
// for rows the model was actually shown under that snapshot id.
// @x,y = element centre — in screenshot px when o.scale is known (directly
// usable as act x,y), else in window points. Printed with frames:true, and
// always for rows that have neither label nor value (an icon row is
// otherwise indistinguishable from its siblings).
const POINTABLE = /^AX(Image|Button|Link|CheckBox|RadioButton|PopUpButton|MenuButton|ComboBox|TextField|TextArea|Slider|DisclosureTriangle)$/;

// Pure: the row's text and whether it carries a coordinate.
function rowParts(n, o = {}) {
  const max = o.fullText ? 20_000 : 500;
  if (n.idx === null) {
    const t = n.text.replace(/^ "([^"]+)" \(\1\)$/, ' "$1"');
    return { text: `- ${n.role}${clip(t, max)}`, coord: false };
  }
  let s = `- ${n.press ? `[${n.idx}]` : `(${n.idx})`} ${n.role}`;
  if (n.label) s += ` ${quote(n.label, max)}`;
  if (n.value !== undefined && n.value !== "" && n.value !== n.label) s += ` = ${quote(n.value, max)}`;
  if (!n.label && n.help) s += ` help=${quote(n.help, 80)}`;
  if (n.enabled === false) s += " [disabled]";
  if (n.selected === true) s += " [selected]";
  const bare = !n.label && (n.value === undefined || n.value === "") && POINTABLE.test(n.role);
  const coord = !!n.frame && (o.frames === true || bare);
  if (coord) {
    const k = o.scale || 1;
    s += ` @${Math.round((n.frame.x + n.frame.w / 2) * k)},${Math.round((n.frame.y + n.frame.h / 2) * k)}`;
  }
  return { text: s, coord };
}

// Record that a row was really printed: o.shown collects its number, and
// o.used.frames says a units line is owed.
function markPrinted(n, parts, o) {
  if (n.idx !== null) o.shown?.add(n.idx);
  if (o.shown) (o.shown.pos ??= new Set()).add(n.pos); // …and its place, numbered or not: which texts a view really showed
  if (parts.coord && o.used) o.used.frames = true;
}

export function rowText(n, o = {}) {
  const parts = rowParts(n, o);
  markPrinted(n, parts, o);
  return parts.text;
}

export function headerLine(tree, extra = "") {
  return `win ${tree.windowId} ${quote(tree.title ?? "", 60)} pid ${tree.pid} · snapshot ${tree.snapshotId ?? "?"}${extra}`;
}

export function unitsLine(o = {}) {
  return o.scale
    ? "(@x,y = element centre in screenshot px — usable as act x,y)"
    : "(@x,y = element centre in window points; no screenshot taken yet, so the px scale is unknown)";
}

// Render the tree (or the subset `only` of node positions) as compact text.
// o: { menus, frames, fullText, maxRows, maxDepth, maxChars, only:Set<pos> }
export function renderRows(tree, o = {}) {
  const maxChars = o.maxChars ?? 20_000;
  const lines = [];
  let chars = 0;
  let shown = 0;
  let hiddenMenu = 0;
  let cut = 0;
  let deeper = 0;
  for (const n of tree.nodes) {
    if (o.only && !o.only.has(n.pos)) continue;
    if (n.inMenuBar && !o.menus) {
      hiddenMenu++;
      continue;
    }
    if (o.maxDepth !== undefined && n.depth > o.maxDepth) {
      deeper++;
      continue;
    }
    if (cut || (o.maxRows !== undefined && shown >= o.maxRows)) {
      cut++;
      continue;
    }
    const parts = rowParts(n, o);
    const line = `${" ".repeat(n.depth)}${parts.text}`;
    if (chars + line.length + 1 > maxChars && shown > 0) {
      cut++;
      continue;
    }
    markPrinted(n, parts, o);
    lines.push(line);
    chars += line.length + 1;
    shown++;
  }
  return { lines, shown, hiddenMenu, cut, deeper };
}

export function renderTree(tree, o = {}) {
  o = { ...o, used: o.used ?? {} };
  const { lines, shown, hiddenMenu, cut, deeper } = renderRows(tree, o);
  o.used.cut = cut > 0 || deeper > 0;
  const out = [headerLine(tree, ` · ${shown}${cut || deeper ? ` of ${shown + cut + deeper}` : ""} rows${tree.structured ? "" : " · no structured elements from this cua build: pressability unknown"}`), ...lines];
  if (o.used.frames) out.push(unitsLine(o));
  if (cut) out.push(`…[${cut} more rows not shown — narrow with query:"a|b" (substring, any term)]`);
  if (deeper) out.push(`…[${deeper} rows deeper than max_depth ${o.maxDepth} not shown]`);
  if (tree.truncated) out.push(`⚠ ${clip(tree.truncated, 160)}`);
  if (hiddenMenu) out.push(`(menu bar hidden: ${hiddenMenu} rows — menus:true to list; act menu takes the path directly)`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Query / find — substring, never regex (model-supplied patterns on a
// single-threaded server are a ReDoS vector). Two passes: as written
// (case-insensitive), and only if that finds nothing, ignoring whitespace —
// antd renders 确定 as "确 定", but a query like "创作 " uses the space on
// purpose to exclude "继续创作".
// ---------------------------------------------------------------------------

export const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, "");
const lower = (s) => String(s ?? "").toLowerCase();

export function queryTerms(query) {
  const raw = Array.isArray(query) ? query : String(query ?? "").split("|");
  return raw.map(lower).filter((t) => t.trim() !== "");
}

function haystack(n, loose) {
  if (n.hay === undefined) {
    n.hay = lower([n.role, n.label, n.value, n.help, n.idx === null && n.label === undefined && n.value === undefined ? n.text : undefined].filter((x) => x !== undefined).join("\u0001"));
    n.hayLoose = n.hay.replace(/\s+/g, "");
  }
  return loose ? n.hayLoose : n.hay;
}

// Returns { only:Set<pos> (hits + their ancestor chains), hits, menuHits, loose }.
const QUERY_CTX_HITS = 3;
const QUERY_CTX_ROWS = 20;
const QUERY_CTX_MIN_TREE = 150; // a small window is cheaper to look at whole
const bodyRows = (tree) => (tree.bodyRows ??= tree.nodes.reduce((k, n) => k + (n.inMenuBar ? 0 : 1), 0));
const withContext = (tree, hits) => hits > 0 && hits <= QUERY_CTX_HITS && bodyRows(tree) > QUERY_CTX_MIN_TREE;
export function queryTree(tree, query, o = {}) {
  const terms = queryTerms(query);
  const run = (loose) => {
    const ts = loose ? terms.map((t) => t.replace(/\s+/g, "")).filter(Boolean) : terms;
    const only = new Set();
    let hits = 0;
    let menuHits = 0;
    const hit = [];
    for (const n of tree.nodes) {
      if (!ts.some((t) => haystack(n, loose).includes(t))) continue;
      if (n.inMenuBar && !o.menus) {
        menuHits++;
        continue;
      }
      hits++;
      hit.push(n);
      for (let p = n.pos; p >= 0 && !only.has(p); p = tree.nodes[p].parent) only.add(p);
    }
    // A few hits in a large window: show what each one sits in — the rest of its table row or
    // card, the content of a matched dialog. A lone "删除订单" or "DD0350" says
    // little without the cells beside it, and no other call can fetch them
    // from a window too long to print.
    if (withContext(tree, hits) || (o.context && hits && hits <= QUERY_CTX_HITS)) {
      for (const n of hit) {
        let top = n.pos;
        for (let p = n.parent; p > 0 && subtreeEnd(tree, p) - p <= QUERY_CTX_ROWS; p = tree.nodes[p].parent) top = p;
        for (let x = top, end = Math.min(subtreeEnd(tree, top), top + QUERY_CTX_ROWS); x < end; x++) only.add(x);
        if (top === n.pos && n.parent > 0) {
          // its container is too long to print whole: the rows just before and after it, inside that container
          const lo = Math.max(n.parent + 1, n.pos - 6);
          const hi = Math.min(subtreeEnd(tree, n.parent), subtreeEnd(tree, n.pos) + 6);
          // …and how the container begins (its heading says what all of it is about)
          for (let x = n.parent, end = Math.min(lo, n.parent + 4); x < end; x++) only.add(x);
          for (let x = lo; x < hi; x++) {
            only.add(x);
            for (let p = tree.nodes[x].parent; p >= 0 && !only.has(p); p = tree.nodes[p].parent) only.add(p);
          }
        }
      }
    }
    return { only, hits, menuHits, terms: ts, loose };
  };
  const strict = run(false);
  if (strict.hits || strict.menuHits) return strict;
  const loose = run(true);
  return loose.hits || loose.menuHits ? loose : strict;
}

export function pressableLabels(tree, limit = 10) {
  const web = tree.nodes.find((n) => n.role === "AXWebArea");
  const out = [];
  for (const n of tree.nodes) {
    if (n.idx === null || !n.press || n.inMenuBar || !n.label) continue;
    if (web && n.pos < web.pos) continue; // browser chrome is the same on every page
    out.push(`[${n.idx}] ${quote(n.label, 30)}`);
    if (out.length >= limit) break;
  }
  return out;
}

// Rows sharing a 2+ character fragment with a query term — the near misses.
function nearMisses(tree, terms, limit = 10) {
  const frags = new Set();
  for (const t of terms) {
    const w = t.replace(/\s+/g, "");
    for (let i = 0; i + 2 <= w.length && frags.size < 200; i++) frags.add(w.slice(i, i + 2));
  }
  const out = [];
  for (const n of tree.nodes) {
    if (n.inMenuBar) continue;
    const h = haystack(n, true).slice(n.role.length);
    if (![...frags].some((f) => h.includes(f))) continue;
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

export function renderQuery(tree, query, o = {}) {
  o = { ...o, used: o.used ?? {} };
  const q = queryTree(tree, query, o);
  const total = o.menus ? tree.nodes.length : tree.nodes.filter((n) => !n.inMenuBar).length;
  const qs = JSON.stringify(clip(Array.isArray(query) ? query.join("|") : String(query), 200));
  if (!q.hits) {
    // Probe without side effects (shown/used), render for real only if it fits.
    const fits = !renderRows(tree, { ...o, shown: undefined, used: undefined, maxChars: 1500 }).cut;
    const out = [headerLine(tree, ` · 0 of ${total} rows match ${qs}`)];
    if (q.menuHits) out.push(`${q.menuHits} match(es) exist only in the menu bar — pass menus:true, or use act menu with the path.`);
    if (fits) {
      out.push("the whole window:", ...renderRows(tree, o).lines);
    } else {
      const near = nearMisses(tree, q.terms);
      if (near.length) out.push("closest rows:", ...near.map((n) => rowText(n, o)));
      else {
        const labels = pressableLabels(tree);
        if (labels.length) out.push(`pressable here: ${labels.join(", ")}`);
      }
      out.push("query is a case-insensitive SUBSTRING over role, label, value; separate alternatives with |.");
    }
    if (o.used.frames) out.push(unitsLine(o));
    return out.join("\n");
  }
  const { lines, cut } = renderRows(tree, { ...o, only: q.only, menus: true });
  const out = [headerLine(tree, ` · ${q.hits} match(es) for ${qs}${q.loose ? " (ignoring whitespace)" : ""} of ${total} rows${withContext(tree, q.hits) || (o.context && q.hits <= QUERY_CTX_HITS) ? ", each with the rows around it" : ""}`), ...lines];
  if (cut) out.push(`…[${cut} more rows not shown — tighten the query]`);
  if (q.menuHits && !o.menus) out.push(`(+${q.menuHits} match(es) in the menu bar hidden — menus:true)`);
  if (o.used.frames) out.push(unitsLine(o));
  return out.join("\n");
}

// find: exact role (case-insensitive) + substring on label / value, with the
// same strict-then-whitespace-insensitive passes as query. The menu bar is
// searched only when the caller asks for a menu role: a find for "关机" once
// matched the Apple-menu Shut Down item instead of the web button.
// Roles a value or typed text goes into.
export const FIELD_ROLE = /^AX(TextField|TextArea|ComboBox|SearchField|SecureTextField|PopUpButton|Slider|Incrementor|DateField|TimeField|DateTimeArea|ColorWell)$/;
// A name as people mean it: width forms and spacing are typography (antd renders 确定 as "确 定", a page may write ＯＫ).
export const foldName = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
// How well a row's label IS the wanted label: 2 = the same but for case and outer spaces, 1 = the same but for spacing and width forms, 0 = neither.
export function nameRank(n, want) {
  const w = String(want ?? "");
  if (lower(n.label).trim() === lower(w).trim()) return 2;
  const f = foldName(w);
  return f !== "" && foldName(n.label) === f ? 1 : 0;
}
export function findNodes(tree, find) {
  const role = find.role !== undefined ? String(find.role).toLowerCase() : undefined;
  const wantMenu = find.menus === true || ["axmenu", "axmenuitem", "axmenubaritem", "axmenubar"].includes(role);
  const base = (n) => {
    if (n.idx === null) return false;
    if (n.role === "AXWindow" && role !== "axwindow") return false; // a window's title is not a control named that
    if (n.inMenuBar && !wantMenu) return false;
    return role === undefined || n.role.toLowerCase() === role;
  };
  const run = (f) => {
    const label = find.label !== undefined ? f(find.label) : undefined;
    const value = find.value !== undefined ? f(find.value) : undefined;
    return tree.nodes.filter((n) => base(n) && (label === undefined || f(n.label).includes(label)) && (value === undefined || f(n.value).includes(value)));
  };
  // "查看详情" is an AXLink with an AXStaticText of the same words inside it:
  // one control, not two (a fifth of real labelled controls look like this).
  const own = (list) => {
    if (list.length < 2) return list;
    const press = new Set(list.filter((n) => n.press).map((n) => n.pos));
    if (!press.size) return list;
    const name = (n) => norm(n.label ?? "");
    return list.filter((n) => {
      // An inert piece of a pressable candidate (the text or icon inside a link) is that control — when that
      // candidate is its NEAREST pressable ancestor, or carries the same name; text inside an unnamed
      // clickable wrapper of its own ("删除" in a span with a handler, inside a row that is one big link)
      // belongs to the wrapper, not to the row. A control inside a candidate that only repeats its name
      // is that candidate too; a [删除] button in such a row is a control of its own, and so is a field.
      if (FIELD_ROLE.test(n.role)) return true;
      let nearest = true;
      for (let p = n.parent; p >= 0; p = tree.nodes[p].parent) {
        const a = tree.nodes[p];
        if (!a.press) continue;
        if (press.has(p) && (name(a) === name(n) || (!n.press && nearest))) return false;
        nearest = false;
      }
      return true;
    });
  };
  const strict = run(lower);
  let list = strict.length ? strict : run(norm);
  // The row whose whole name IS the wanted label, but for spacing or width forms, is a candidate even when
  // other rows contain the label as written: find "确定" must reach the button "确 定" although a link
  // "确定并继续添加" is on the page (round 10 pressed the link). Not when the label was given with outer
  // spaces on purpose ("创作 "), nor when a row named exactly so is a control of its own that something
  // can be done with — a heading "删除" over the buttons "取 消" "删 除", or the word 评论 inside the tab
  // "评论 12", is not that (round 11: the click went to the heading, or the button was not even listed).
  const usable = (n) => (n.press || FIELD_ROLE.test(n.role)) && n.enabled !== false;
  if (find.label !== undefined && String(find.label) === String(find.label).trim() && !own(list).some((n) => nameRank(n, find.label) === 2 && usable(n))) {
    const want = foldName(find.label);
    const value = find.value !== undefined ? lower(find.value) : undefined;
    const have = new Set(list);
    const extra = want === "" ? [] : tree.nodes.filter((n) => !have.has(n) && base(n) && foldName(n.label) === want && (value === undefined || lower(n.value).includes(value)));
    if (extra.length) list = [...list, ...extra].sort((a, b) => a.pos - b.pos);
  }
  return own(list);
}

// "删除" as a bare text inside an unnamed clickable wrapper (a span or div with a handler): the wrapper
// is what a press on that text means — provided it holds nothing but that text and no control of its own.
// → the wrapper row, or null.
export function wrapperOf(tree, n) {
  if (n.press || n.idx === null) return null;
  let a = null;
  for (let p = n.parent; p >= 0; p = tree.nodes[p].parent) {
    if (tree.nodes[p].press) {
      a = tree.nodes[p];
      break;
    }
  }
  if (!a || a.idx === null || a.enabled === false || String(a.label ?? "").trim() !== "") return null;
  const want = norm(n.label);
  if (!want) return null;
  // what the wrapper holds, scanned once per wrapper: the one text all its rows say, or false
  const memo = (tree.wrapSays ??= new Map());
  let says = memo.get(a.pos);
  if (says === undefined) {
    says = null;
    for (let x = a.pos + 1; x < tree.nodes.length && tree.nodes[x].depth > a.depth; x++) {
      const m = tree.nodes[x];
      const t = m.press || FIELD_ROLE.test(m.role) ? false : norm(m.idx === null ? m.text : m.label || m.value);
      if (t === "") continue;
      if (t === false || (says !== null && t !== says)) {
        says = false;
        break;
      }
      says = t;
    }
    memo.set(a.pos, says);
  }
  return says === want ? a : null;
}

export function parseToken(token) {
  const m = /^(s[0-9a-f]+):(\d+)$/i.exec(String(token ?? ""));
  return m ? { sid: m[1], idx: Number(m[2]) } : null;
}

// ---------------------------------------------------------------------------
// Alignment: which row of a newer tree is which row of an older one.
//
// cua mints fresh indices and tokens on every walk, so identity has to come
// from content. Rows are aligned as two SEQUENCES (document order) by a
// longest-common-subsequence over row keys — never by coordinates: delete a
// table row and the next row's button sits at exactly the old spot. An
// order-preserving alignment is also a faithful description: old tree + the
// printed delta reconstructs the new tree row for row, which is what lets an
// older element_token follow the delta the model was shown (carryIndex).
//
// Keys: `weak` = depth + role + name (label; tooltip when unlabeled; the raw
// text of an un-indexed row). `strong` = weak + value, so eight same-named
// fields align by what they hold and an inserted one reads as one new row,
// not eight value changes. A row whose value alone changed falls out of the
// LCS and is re-paired inside its gap ("state" pair — still the same row).
// ---------------------------------------------------------------------------

const SEP = "\u0001";
const weakKey = (n) =>
  n.idx === null ? `${n.depth}${SEP}${n.role}${SEP}#${n.text ?? ""}` : `${n.depth}${SEP}${n.role}${SEP}${n.label ?? ""}${n.label ? "" : `${SEP}${n.help ?? ""}`}`;
const strongKey = (n, w) => (n.idx === null ? w : `${w}${SEP}=${n.value ?? ""}`);

// Rows that differ between two looks at one window; beyond this it is another page.
const MAX_EDIT = 1500;

// Myers O(ND). Returns for every index of `a` its partner in `b` (or -1), or
// null when the two differ in more than maxD rows.
function lcsPartners(a, b, maxD = MAX_EDIT) {
  const n = a.length;
  const m = b.length;
  const pa = new Int32Array(n).fill(-1);
  let lo = 0;
  while (lo < n && lo < m && a[lo] === b[lo]) {
    pa[lo] = lo;
    lo++;
  }
  let ea = n;
  let eb = m;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
    pa[ea] = eb;
  }
  const N = ea - lo;
  const M = eb - lo;
  if (N === 0 || M === 0) return N + M > maxD ? null : pa;
  const max = Math.min(N + M, maxD);
  const off = max + 1;
  const V = new Int32Array(2 * max + 3);
  const trace = [];
  let D = -1;
  for (let d = 0; d <= max && D < 0; d++) {
    trace.push(V.slice(off - d - 1, off + d + 2)); // V after round d-1; diagonal k sits at k + d + 1
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[lo + x] === b[lo + y]) {
        x++;
        y++;
      }
      V[off + k] = x;
      if (x >= N && y >= M) {
        D = d;
        break;
      }
    }
  }
  if (D < 0) return null;
  let x = N;
  let y = M;
  for (let d = D; d > 0; d--) {
    const T = trace[d];
    const k = x - y;
    const at = (kk) => T[kk + d + 1];
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    while (x > px && y > py) {
      x--;
      y--;
      pa[lo + x] = lo + y;
    }
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    pa[lo + x] = lo + y;
  }
  return pa;
}

function frameEq(a, b, tol = 2) {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;
}

// An LCS is free to cut a run of deleted (or inserted) rows anywhere it can
// slide: remove the middle one of three rows that each start with an AXRow
// and "乙, [删除], AXRow" is as good a deletion to it as "AXRow, 乙, [删除]" —
// leaving the third row's children under the second row's container. Slide
// every pure gap (rows missing on one side only) to where it is a run of
// whole subtrees. `rows`/`keys`/`mine` are the side that has the extra rows,
// `theirs` the partner array of the other side.
function settleGaps(rows, keys, mine, theirs) {
  const n = rows.length;
  const whole = (p, q) => {
    const d = rows[p].depth;
    for (let x = p + 1; x < q; x++) if (rows[x].depth < d) return false;
    return q >= n || rows[q].depth <= d;
  };
  for (let p = 0; p < n; ) {
    if (mine[p] >= 0) {
      p++;
      continue;
    }
    let q = p;
    while (q < n && mine[q] < 0) q++;
    // Pure only: the neighbours' partners must be adjacent on the other side.
    const before = p > 0 ? mine[p - 1] : -1;
    const after = q < n ? mine[q] : theirs.length;
    const next = q;
    if (after === before + 1 && !whole(p, q)) {
      const len = q - p;
      let up = 0;
      while (up < 64 && p - up - 1 >= 0 && mine[p - up - 1] >= 0 && keys[p - up - 1] === keys[p - up - 1 + len] && (p - up - 2 < 0 || mine[p - up - 2] === mine[p - up - 1] - 1)) up++;
      let down = 0;
      while (down < 64 && q + down < n && mine[q + down] >= 0 && keys[q + down] === keys[q + down - len] && (q + down + 1 >= n || mine[q + down + 1] === mine[q + down] + 1)) down++;
      let best = 0;
      for (let s = 1; s <= Math.max(up, down) && !best; s++) {
        if (s <= up && whole(p - s, q - s)) best = -s;
        else if (s <= down && whole(p + s, q + s)) best = s;
      }
      for (let s = 0; s > best; s--) {
        // slide up by one: the row above the gap leaves, the gap's last row takes its partner
        const a = p + s - 1;
        const z = q + s - 1;
        mine[z] = mine[a];
        theirs[mine[z]] = z;
        mine[a] = -1;
      }
      for (let s = 0; s < best; s++) {
        const a = q + s;
        const z = p + s;
        mine[z] = mine[a];
        theirs[mine[z]] = z;
        mine[a] = -1;
      }
    }
    p = next;
  }
}

// prev → { "": WeakMap(next → alignment), m: WeakMap(next → alignment) }. Weak on BOTH trees: an entry that
// held its `next` strongly chained every walk to the one after it (report k is diffed against report k-1), so
// no tree was ever freed — 68 actions on a 3,000-row window ran a 256 MB hub out of memory (round 10).
const ALIGNED = new WeakMap();

// Align the rows of `prev` with the rows of `next`. Returns
//   A, B          the rows compared (menu bar left out unless o.menus)
//   pa, pb        strong partner (same key and value) or -1
//   sa, sb        "state" partner: same row, value changed
//   ra, rb        "renamed" partner: same depth and role at the same place,
//                 another label/text (a toggle 开机→关机, a status line)
//   posA, posB    tree position → index in A / B
//   far:true      (and nothing else) when the trees differ too much to align
export function alignTrees(prev, next, o = {}) {
  let memo = ALIGNED.get(prev);
  if (!memo) ALIGNED.set(prev, (memo = { "": new WeakMap(), m: new WeakMap() }));
  const tag = o.menus ? "m" : "";
  const hit = memo[tag].get(next);
  if (hit) return hit;
  const keep = (n) => o.menus || !n.inMenuBar;
  const A = prev.nodes.filter(keep);
  const B = next.nodes.filter(keep);
  const wa = A.map(weakKey);
  const wb = B.map(weakKey);
  const ka = A.map((n, i) => strongKey(n, wa[i]));
  const kb = B.map((n, i) => strongKey(n, wb[i]));
  const pa = lcsPartners(ka, kb);
  let al;
  if (!pa) al = { A, B, far: true };
  else {
    const nA = A.length;
    const nB = B.length;
    const pb = new Int32Array(nB).fill(-1);
    for (let i = 0; i < nA; i++) if (pa[i] >= 0) pb[pa[i]] = i;
    const posA = new Int32Array(prev.nodes.length).fill(-1);
    const posB = new Int32Array(next.nodes.length).fill(-1);
    A.forEach((n, i) => (posA[n.pos] = i));
    B.forEach((n, i) => (posB[n.pos] = i));
    const parA = Int32Array.from(A, (n) => (n.parent >= 0 ? posA[n.parent] : -1));
    const parB = Int32Array.from(B, (n) => (n.parent >= 0 ? posB[n.parent] : -1));
    settleGaps(A, ka, pa, pb);
    settleGaps(B, kb, pb, pa);
    const sa = new Int32Array(nA).fill(-1);
    const sb = new Int32Array(nB).fill(-1);
    const ra = new Int32Array(nA).fill(-1);
    const rb = new Int32Array(nB).fill(-1);
    const mate = (i) => (pa[i] >= 0 ? pa[i] : sa[i] >= 0 ? sa[i] : ra[i]);
    const sameParent = (i, j) => (parA[i] < 0 && parB[j] < 0) || (parA[i] >= 0 && mate(parA[i]) === parB[j]);
    const gaps = [];
    let i = 0;
    let j = 0;
    while (i < nA || j < nB) {
      if (i < nA && pa[i] >= 0 && pa[i] === j) {
        i++;
        j++;
        continue;
      }
      const i0 = i;
      const j0 = j;
      while (i < nA && pa[i] < 0) i++;
      while (j < nB && pb[j] < 0) j++;
      gaps.push([i0, i, j0, j]);
      // Same row, value changed: same weak key under the same (paired) parent, in order.
      let q = j0;
      for (let p = i0; p < i; p++) {
        for (let t = q; t < j; t++) {
          if (wa[p] === wb[t] && sameParent(p, t)) {
            sa[p] = t;
            sb[t] = p;
            q = t + 1;
            break;
          }
        }
      }
      // Renamed in place: same depth and role between the same two state pairs.
      let floor = j0;
      for (let p = i0; p < i; p++) {
        if (sa[p] >= 0) {
          floor = sa[p] + 1;
          continue;
        }
        let ceil = j;
        for (let u = p + 1; u < i; u++) {
          if (sa[u] >= 0) {
            ceil = sa[u];
            break;
          }
        }
        for (let t = floor; t < ceil; t++) {
          if (sb[t] < 0 && rb[t] < 0 && A[p].depth === B[t].depth && A[p].role === B[t].role && (A[p].idx === null) === (B[t].idx === null) && sameParent(p, t)) {
            ra[p] = t;
            rb[t] = p;
            floor = t + 1;
            break;
          }
        }
      }
    }
    al = { A, B, wa, wb, pa, pb, sa, sb, ra, rb, posA, posB, parA, parB, gaps };
  }
  memo[tag].set(next, al);
  return al;
}

// Back-compatible view of an alignment (display code and tests).
export function pairTrees(prev, next, o = {}) {
  const al = alignTrees(prev, next, o);
  const { A, B } = al;
  if (al.far) return { pairs: [], added: B, removed: A, relabeled: [], retexted: [], sizeA: A.length, sizeB: B.length, far: true };
  const pairs = [];
  const removed = [];
  const relabeled = [];
  const retexted = [];
  A.forEach((a, i) => {
    const j = al.pa[i] >= 0 ? al.pa[i] : al.sa[i];
    if (j >= 0) pairs.push([a, B[j]]);
    else if (al.ra[i] >= 0) (a.idx === null ? retexted : relabeled).push([a, B[al.ra[i]]]);
    else removed.push(a);
  });
  const added = B.filter((_, j) => al.pb[j] < 0 && al.sb[j] < 0 && al.rb[j] < 0);
  return { pairs, added, removed, relabeled, retexted, sizeA: A.length, sizeB: B.length };
}

// How an old text is quoted next to its new form. Short texts are quoted
// from the start; two long texts that only differ far in (two mail subjects
// with the same first 60 characters) are quoted around the first difference
// instead — "was <the same 60 characters>" would say nothing.
function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
function commonSuffix(a, b, p) {
  const n = Math.min(a.length, b.length) - p;
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}
// Does a line that prints `now` the way diffTrees does show everything in it
// that differs from `old`? Outside [p, end) the two are identical, and what
// was there before the model already knew. The new side prints its first
// `head` characters (the row itself) and, for values, [p-24, p+span).
function wholeChange(old, now, { head = 0, span = 0 } = {}) {
  old = String(old ?? "");
  now = String(now ?? "");
  const p = commonPrefix(old, now);
  const endNow = now.length - commonSuffix(old, now, p);
  return endNow <= head || (span > 0 && endNow <= p + span);
}
const NEW_SPAN = 320;
function wasQuote(old, now, lim) {
  old = String(old ?? "");
  const p = commonPrefix(old, String(now ?? ""));
  if (p < lim - 12) return quote(old, lim);
  const from = Math.max(0, p - 24);
  return `…${JSON.stringify(old.slice(from, p + lim - 24))}${old.length > p + lim - 24 ? "…" : ""} (differs from character ${Array.from(old.slice(0, p)).length + 1})`;
}

// The delta as entries { text, node?, parts? } in document order of `next`
// (node = the row of `next` the line prints, for shown-marking) plus
// counters. churn:true means the delta is noise (navigation): show the new
// tree instead. capped:true means some changes are only counted, not listed.
export function diffTrees(prev, next, o = {}) {
  const al = alignTrees(prev, next, o);
  const { A, B } = al;
  if (al.far) {
    return { entries: [], movedLine: null, lines: [], changes: A.length + B.length, moved: 0, churn: true, added: B.length, removed: A.length, changed: 0, rows: B.length, capped: true };
  }
  const entries = [];
  const row = (prefix, n, suffix = "") => {
    const parts = rowParts(n, o);
    entries.push({ text: `${prefix} ${parts.text.slice(2)}${suffix}`, node: n, parts });
  };
  let changed = 0;
  let moved = 0;
  let added = 0;
  let removed = 0;
  let hidden = false; // a change whose substance lies beyond what a row prints
  const rowMax = o.fullText ? 20_000 : 500;
  const capAdd = o.maxRows ?? 40;
  const capGone = 12;
  const shift = new Map();
  const same = (a, b) => {
    if (b.idx === null) return;
    const d = [];
    if ((a.value ?? "") !== (b.value ?? "")) {
      const bv = String(b.value ?? "");
      const p = commonPrefix(a.value ?? "", bv);
      if (p < 108) d.push(`value ${quote(a.value ?? "", 120)} → ${quote(bv, 120)}`);
      else d.push(`value ${wasQuote(a.value, bv, 120)} → …${JSON.stringify(bv.slice(p - 24, p + NEW_SPAN))}${bv.length > p + NEW_SPAN ? "…" : ""}`);
      // the row itself prints the new value's first rowMax characters
      if (!wholeChange(a.value, bv, { head: rowMax - 20, span: p < 108 ? 0 : NEW_SPAN })) hidden = true;
    }
    if (a.enabled !== b.enabled && (a.enabled === false || b.enabled === false)) d.push(b.enabled === false ? "now disabled" : "now enabled");
    if (a.selected !== b.selected && (a.selected === true || b.selected === true)) d.push(b.selected === true ? "now selected" : "no longer selected");
    if (a.press !== b.press) d.push(b.press ? "now pressable" : "no longer pressable");
    if (d.length) {
      row("~", b, `: ${d.join("; ")}`);
      changed++;
    } else if (a.frame && b.frame && !frameEq(a.frame, b.frame)) {
      moved++;
      const k = `${Math.round(b.frame.x - a.frame.x)},${Math.round(b.frame.y - a.frame.y)}`;
      shift.set(k, (shift.get(k) ?? 0) + 1);
    }
  };
  let g = 0;
  for (let j = 0, i = 0; j < B.length || i < A.length; ) {
    if (i < A.length && al.pa[i] >= 0 && al.pa[i] === j) {
      same(A[i], B[j]);
      i++;
      j++;
      continue;
    }
    const [i0, i1, j0, j1] = al.gaps[g++];
    for (let t = j0; t < j1; t++) {
      const b = B[t];
      if (al.sb[t] >= 0) same(A[al.sb[t]], b);
      else if (al.rb[t] >= 0) {
        const a = A[al.rb[t]];
        if (a.idx === null) {
          const p = commonPrefix(a.text ?? "", b.text ?? "");
          if (!wholeChange(a.text, b.text, { head: rowMax - 20 })) hidden = true;
          row("~", b, p < 108 ? ` (was${clip(a.text, 120)})` : ` (was ${wasQuote(a.text, b.text, 120)})`);
        } else {
          if (!a.label && !b.label) {
            // unlabeled icons are named by their tooltip, of which a row prints 80 characters
            if (!wholeChange(a.help, b.help, { head: 80 })) hidden = true;
            if ((a.value ?? "") !== (b.value ?? "")) {
              if (!wholeChange(a.value, b.value, { head: rowMax - 20 })) hidden = true;
              row("~", b, ` (was help=${wasQuote(a.help ?? "", b.help ?? "", 60)}; value was ${quote(a.value ?? "", 120)})`);
            } else row("~", b, ` (was help=${wasQuote(a.help ?? "", b.help ?? "", 60)})`);
          } else {
            if (!wholeChange(a.label, b.label, { head: rowMax - 20 })) hidden = true;
            // a renamed row may also carry another value: say so, or the list is not the whole story
            if ((a.value ?? "") !== (b.value ?? "") && !(a.value === a.label && b.value === b.label)) {
              if (!wholeChange(a.value, b.value, { head: rowMax - 20 })) hidden = true;
              row("~", b, ` (was ${wasQuote(a.label ?? "", b.label ?? "", 60)}; value was ${quote(a.value ?? "", 120)})`);
            } else row("~", b, ` (was ${wasQuote(a.label ?? "", b.label ?? "", 60)})`);
          }
        }
        changed++;
      } else {
        if (added < capAdd) {
          row("+", b);
          // a new row prints its first rowMax characters: beyond that the list is not the whole story
          if (Math.max(String(b.label ?? "").length, String(b.value ?? "").length, String(b.text ?? "").length) > rowMax || (!b.label && String(b.help ?? "").length > 80)) hidden = true;
        }
        added++;
      }
    }
    for (let p = i0; p < i1; p++) {
      if (al.sa[p] >= 0 || al.ra[p] >= 0) continue;
      const a = A[p];
      if (removed < capGone) entries.push({ text: `- ${a.idx === null ? `${a.role}${clip(a.text, 80)}` : `${a.role}${a.label ? ` ${quote(a.label, 60)}` : ""}`} (gone)` });
      removed++;
    }
    i = i1;
    j = j1;
  }
  if (added > capAdd) entries.push({ text: `+ …${added - capAdd} more new rows` });
  if (removed > capGone) entries.push({ text: `- …${removed - capGone} more rows gone` });
  let movedLine = null;
  if (moved) {
    const [top, cnt] = [...shift.entries()].sort((x, y) => y[1] - x[1])[0];
    movedLine = cnt > moved / 2 ? `(${moved} rows only moved — content scrolled by ${top} px)` : `(${moved} rows only moved/resized)`;
  }
  // Rows that are not the same row any more, on the heavier side.
  let looseA = 0;
  let looseB = 0;
  for (let i = 0; i < A.length; i++) if (al.pa[i] < 0 && al.sa[i] < 0) looseA++;
  for (let j = 0; j < B.length; j++) if (al.pb[j] < 0 && al.sb[j] < 0) looseB++;
  return {
    entries,
    movedLine,
    lines: [...entries.map((e) => e.text), ...(movedLine ? [movedLine] : [])],
    changes: changed + added + removed,
    moved,
    churn: Math.max(looseA, looseB) > Math.max(A.length, B.length, 1) * 0.5,
    added,
    removed,
    changed,
    rows: B.length,
    capped: added > capAdd || removed > capGone || hidden,
  };
}

// True when two walks show the same rows in the same order (scrolling moves
// frames, not rows). Row by row — cheap enough to run on every walk.
export function sameTrees(a, b, o = {}) {
  if (a === b) return true;
  const keep = (n) => o.menus || !n.inMenuBar;
  const A = a.nodes.filter(keep);
  const B = b.nodes.filter(keep);
  if (A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++) {
    const x = A[i];
    const y = B[i];
    if (x.depth !== y.depth || x.role !== y.role || (x.idx === null) !== (y.idx === null)) return false;
    if (x.idx === null ? x.text !== y.text : (x.label ?? "") !== (y.label ?? "") || (x.value ?? "") !== (y.value ?? "") || (x.label ? false : (x.help ?? "") !== (y.help ?? ""))) return false;
    if (x.press !== y.press || (x.enabled === false) !== (y.enabled === false) || (x.selected === true) !== (y.selected === true)) return false;
  }
  return true;
}

// o.since names the baseline; o.used.cut is set when the delta is not the
// whole story — clipped at o.maxChars or past the per-kind line caps — and
// the caller must then not treat the model as knowing every change. Only
// lines actually printed mark o.shown.
export function renderDiff(prev, next, o = {}) {
  o = { ...o, used: o.used ?? {} };
  const d = diffTrees(prev, next, o);
  if (d.churn) return { ...d, text: null };
  const since = o.since ?? "your last view";
  const lineage = prev.snapshotId && prev.snapshotId !== next.snapshotId ? ` (was ${prev.snapshotId})` : "";
  if (!d.changes && !d.moved) {
    return { ...d, text: `${headerLine(next, lineage)} · no change vs ${since} (${d.rows} rows)` };
  }
  const max = o.maxChars ?? 20_000;
  const body = [];
  let chars = 0;
  let kept = 0;
  for (const e of d.entries) {
    if (chars + e.text.length + 1 > max) break;
    body.push(e.text);
    chars += e.text.length + 1;
    kept++;
    if (e.node) markPrinted(e.node, e.parts, o);
  }
  if (kept < d.entries.length) {
    body.push(`…[+${d.entries.length - kept} more change lines — window_state diff:true lists them all]`);
    o.used.cut = true;
  }
  if (d.capped) o.used.cut = true;
  if (d.movedLine) body.push(d.movedLine);
  if (o.used.frames) body.push(unitsLine(o));
  return { ...d, text: `${headerLine(next, lineage)} · +${d.added} −${d.removed} ~${d.changed} of ${d.rows} rows vs ${since}\n${body.join("\n")}` };
}

// ---------------------------------------------------------------------------
// Describing a row: the text around it (for candidate lists, for "where did
// this land" notes, for find.near, and for the re-press gate's "same control
// as a moment ago" check).
// ---------------------------------------------------------------------------

const keyOf = (n) => `${n.role}\u0000${n.idx === null ? n.text : n.label ?? ""}`;
// What makes two controls "the same kind" to a reader: role + label, or the
// tooltip when there is no label. Depth is NOT part of it — a selected row's
// button can sit one wrapper deeper than its look-alikes.
const nameKey = (n) => `${n.role}\u0000${n.label ? n.label : `\u0000${n.help ?? ""}`}`;
const CTX_SMALL = 12;
const CTX_SIDE = 6;

function ownText(n) {
  return norm(n.label ?? n.value ?? (n.idx === null ? n.text : ""));
}

// The row's own words as printed (original case and spacing).
function rawText(n) {
  if (n.idx === null) return String(n.text ?? "").replace(/^ (?:= )?"([\s\S]*?)"(?: \([\s\S]*\))?$/, "$1").trim();
  return String(n.label || n.value || "").trim();
}

function subtreeEnd(tree, p) {
  const d = tree.nodes[p].depth;
  let e = p + 1;
  while (e < tree.nodes.length && tree.nodes[e].depth > d) e++;
  return e;
}

// Text around n as seen from its ancestor `h` steps up: that ancestor's
// subtree minus n's own subtree and minus rows with n's role+label. A large
// group contributes only the CTX_SIDE nearest texts on each side. Returns
// null when there is no such ancestor, { sig:null } when it holds no other text.
function ctxAt(tree, n, h) {
  if (!n.ctxH) n.ctxH = new Map();
  if (n.ctxH.has(h)) return n.ctxH.get(h);
  let p = n.parent;
  for (let i = 1; i < h && p >= 0; i++) p = tree.nodes[p].parent;
  let out = null;
  if (p >= 0) {
    const end = subtreeEnd(tree, p);
    const selfEnd = subtreeEnd(tree, n.pos);
    const k = keyOf(n);
    const lim = CTX_SMALL + 1;
    const take = (m, into) => {
      if (m.idx !== null && keyOf(m) === k) return;
      const t = ownText(m);
      if (t) into.push(t.slice(0, 60));
    };
    const before = [];
    for (let i = n.pos - 1; i >= p && before.length < lim; i--) take(tree.nodes[i], before);
    before.reverse();
    const after = [];
    for (let i = selfEnd; i < end && after.length < lim; i++) take(tree.nodes[i], after);
    if (before.length || after.length) {
      const large = before.length + after.length > CTX_SMALL;
      const b = large ? before.slice(-CTX_SIDE) : before;
      const f = large ? after.slice(0, CTX_SIDE) : after;
      out = { sig: `${h}:${tree.nodes[p].role}${large ? "~" : "#"}${b.join("|")}^${f.join("|")}`, large, parts: [...b, ...f] };
    } else out = { sig: null };
  }
  n.ctxH.set(h, out);
  return out;
}

function nearestCtx(tree, n) {
  for (let h = 1; ; h++) {
    const c = ctxAt(tree, n, h);
    if (c === null) return null;
    if (c.sig !== null) return c;
  }
}

export function contextOf(tree, n) {
  return nearestCtx(tree, n)?.sig;
}

// Is frame b on the visual line of control frame a? They overlap vertically
// by half the shorter one; b may be up to twice as tall as the control (a
// text wrapped onto two lines), the control up to four times as tall as b (a
// big button beside small print). Anything taller is a block, not a line.
const sameLine = (a, b) => {
  const lo = Math.min(a.h, b.h);
  if (!(lo > 0) || b.h > 2 * a.h || a.h > 4 * b.h) return false;
  // A text clearly taller than the control (two lines) is on its line only when the control lies within
  // the text's top and bottom: a button level with the lower half of the NEXT card's two-line title,
  // sticking out below it, is not beside that title (round 10 pressed the left card's 删除).
  if (b.h > 1.25 * a.h && (a.y < b.y - 2 || a.y + a.h > b.y + b.h + 2)) return false;
  return Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) >= 0.5 * lo;
};

// b is a block more than two control-heights tall that covers control a's
// midline: text wrapped onto three lines in the cell next to a button. It is
// not on the button's line (the next card's body can stand there just as
// well), but it does not end the line either.
const besideBlock = (a, b) => b.h > 2 * a.h && b.y <= a.y + a.h / 2 && b.y + b.h >= a.y + a.h / 2;

// ---------------------------------------------------------------------------
// find.near — "the 删除 whose row says DD1005".
//
// Which texts belong to a control is a fact about the page's meaning; the
// tree only hints at it. Every rule that inferred it from containment was
// made to press the wrong row in review: "the largest container with no other
// such control" (a lone [取消订单] owned its table), "no words on the control's
// side" (a schedule cell took its neighbour's text), "a container that
// repeats" (two sections, two panes), "the only one in its sheet" (a sheet
// holding a table). What survived two rounds of attack are the two kinds of
// evidence that do not infer anything about containers:
//
//   LINE  the text is a leaf row (or a control's own label) on the control's
//         visual line, with nothing from another line between them in
//         reading order (needs frames; real web pages arrive mostly flat, so
//         this is the common case). Several look-alikes on one line: a text
//         between two of them counts for both, and the caller reports the
//         ambiguity — whether "昵称 [编辑] 待审核 签名 [编辑]" reads forwards or
//         backwards is not in the tree (round 9 pressed the wrong one with
//         every rule that tried to tell). A line with one look-alike and
//         words on both sides keeps the side the page's other look-alikes
//         use, if they agree.
//   ROW   the text is in the control's AXRow — provided the control's own
//         cell says nothing of its own (a cell that does is a record of its
//         own: a calendar, a schedule), or the table repeats the control in
//         that column.
//
// Everything else — cards, panes, dialogs, pages without frames — is "cannot
// tell": the caller lists the candidates with their place in reading order
// and the model picks one by token.
//
// Matching is by whole words (nearMatch); a text ending in "…" — the way a
// reply prints a long one — means "starts with"; "a · b" (the way a reply
// joins texts) means both. Known limits, all on the accepting side: several
// records laid out on one visual line or in one flattened AXRow with a single
// such control among them; a cell spanning rows is seen in its first row only.
// The reply names where the press landed.
// ---------------------------------------------------------------------------

const says = (m) => !!rawText(m);
const plainText = (m) => !m.press && says(m);
// Text that describes a record rather than names an action: static text, and links (ids are often links).
const wordy = (m) => says(m) && (!m.press || m.role === "AXLink");
const isLeaf = (tree, x) => x + 1 >= tree.nodes.length || tree.nodes[x + 1].depth <= tree.nodes[x].depth;

const HAN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORDCH = /[\p{L}\p{N}]/u;
const DIGIT = /\p{Nd}/u;
const NUMSEP = /[,.:\/\-_#]/;
const IDJOIN = /[.\/\-_#]/;
// 0 = not part of a word, 1 = letters and digits, 2 = CJK (no spaces between words: a script change is a boundary)
const charClass = (ch) => (!ch || !WORDCH.test(ch) ? 0 : HAN.test(ch) ? 2 : 1);
const cpBefore = (s, i) => (i <= 0 ? "" : i >= 2 && /[\uDC00-\uDFFF]/.test(s[i - 1]) && /[\uD800-\uDBFF]/.test(s[i - 2]) ? s.slice(i - 2, i) : s[i - 1]);
const cpAt = (s, i) => (i >= s.length ? "" : String.fromCodePoint(s.codePointAt(i)));
const foldNear = (v) => String(v ?? "").normalize("NFKC").replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

// 2 = the text is exactly `want`; 1 = it contains `want` as whole words; 0 = no.
// An id is not found inside a longer id ("DD100" in "DD1001", in "DD100-2"),
// a number not inside a longer number ("200" in "¥1,200"), a name not inside
// a longer name ("张伟" in "张伟明").
function nearMatch(hay, want) {
  const test = (h, w) => {
    if (!w || !h) return 0;
    if (h === w) return 2;
    const first = cpAt(w, 0);
    const last = cpBefore(w, w.length);
    for (let at = h.indexOf(w); at >= 0; at = h.indexOf(w, at + 1)) {
      const end = at + w.length;
      const prev = cpBefore(h, at);
      const next = cpAt(h, end);
      let ok = (charClass(prev) === 0 || charClass(prev) !== charClass(first)) && (charClass(next) === 0 || charClass(next) !== charClass(last));
      // 1,200 · 12:30 · 2026-11-19 read as one token; so do DD100-2, DD100-A, a.example, v1.2
      if (ok && DIGIT.test(first) && NUMSEP.test(prev) && DIGIT.test(cpBefore(h, at - prev.length))) ok = false;
      if (ok && DIGIT.test(last) && NUMSEP.test(next) && DIGIT.test(cpAt(h, end + next.length))) ok = false;
      if (ok && charClass(first) === 1 && IDJOIN.test(prev) && charClass(cpBefore(h, at - prev.length)) === 1) ok = false;
      if (ok && charClass(last) === 1 && IDJOIN.test(next) && charClass(cpAt(h, end + next.length)) === 1) ok = false;
      if (ok) return 1;
    }
    return 0;
  };
  const h = foldNear(hay);
  let w = foldNear(want);
  if (h && h === w) return 2; // the whole text as the page has it — "加载中…" included
  // "…": the way replies print a long text cut short — an explicit "starts with"
  const cut = /(…|\.\.\.)$/.exec(w);
  if (cut) {
    w = w.slice(0, -cut[0].length).trim();
    return w.length >= 8 && h.startsWith(w) ? 1 : 0;
  }
  const m = test(h, w);
  if (m || /[0-9a-z]/.test(w)) return m;
  // CJK-only words: spacing is typography (antd renders 确定 as "确 定")
  return test(h.replace(/ /g, ""), w.replace(/ /g, ""));
}

function kidsOf(tree, p) {
  if (!tree.kids) {
    tree.kids = new Map();
    for (const n of tree.nodes) if (n.parent >= 0) (tree.kids.get(n.parent) ?? tree.kids.set(n.parent, []).get(n.parent)).push(n.pos);
  }
  return tree.kids.get(p);
}

// Does the subtree at p (minus [skipFrom, skipTo)) say something of its own —
// descriptive text outside controls? The label inside a button is the button's.
function holdsWords(tree, p, skipFrom = -1, skipTo = -1) {
  for (let x = p, end = subtreeEnd(tree, p); x < end; x++) {
    if (x >= skipFrom && x < skipTo) {
      x = skipTo - 1;
      continue;
    }
    const m = tree.nodes[x];
    if (wordy(m)) return true;
    if (m.press) x = subtreeEnd(tree, x) - 1;
  }
  return false;
}

const childToward = (tree, anc, pos) => {
  let c = pos;
  while (c >= 0 && tree.nodes[c].parent !== anc) c = tree.nodes[c].parent;
  return c;
};

// Everything the near functions need to know about a control's look-alikes,
// computed once per (tree, look-alike set).
function peerCtx(tree, n, isPeer) {
  const byFn = (tree.peerCtxFn ??= new WeakMap());
  const byKey = (tree.peerCtxKey ??= new Map());
  const key = isPeer ? null : nameKey(n);
  let c = isPeer ? byFn.get(isPeer) : byKey.get(key);
  if (!c) {
    const peer = isPeer ?? ((m) => m.idx !== null && nameKey(m) === key);
    c = { peer, list: tree.nodes.filter((m) => peer(m)), convention: undefined };
    c.pos = c.list.map((m) => m.pos);
    if (isPeer) byFn.set(isPeer, c);
    else byKey.set(key, c);
  }
  return c;
}

// ctx.pos is sorted: first index with pos >= x.
function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
// Look-alikes strictly inside (p, end): how many, and the first one.
function peersIn(ctx, p, end) {
  const i = lowerBound(ctx.pos, p + 1);
  const j = lowerBound(ctx.pos, end);
  return { count: j - i, first: ctx.pos[i] };
}

// The largest ancestor of n that holds no other look-alike (-1: one is a sibling).
function territoryOf(tree, n, ctx) {
  const i = lowerBound(ctx.pos, n.pos);
  const prev = i > 0 ? ctx.pos[i - 1] : -1;
  const next = ctx.pos[i] === n.pos ? ctx.pos[i + 1] ?? Infinity : ctx.pos[i] ?? Infinity;
  let top = -1;
  for (let p = n.parent; p >= 0; p = tree.nodes[p].parent) {
    if (tree.nodes[p].inMenuBar !== n.inMenuBar) break;
    if (prev >= p || next < subtreeEnd(tree, p)) break;
    top = p;
  }
  return top;
}

// Is `unit` (an ancestor of n) one record among like records: it has siblings
// of its role that hold look-alikes, and each of those holds exactly one, at
// the same place (child indexes) as n in `unit`?
function repeats(tree, n, ctx, unit) {
  const up = tree.nodes[unit].parent;
  if (up < 0) return false;
  kidsOf(tree, 0);
  if (!tree.childIdx) {
    tree.childIdx = new Map(); // position → index among its parent's children
    for (const kids of tree.kids.values()) kids.forEach((k, i) => tree.childIdx.set(k, i));
  }
  const path = (root, pos) => {
    const out = [];
    for (let c = pos; c !== root; c = tree.nodes[c].parent) out.push(tree.childIdx.get(c));
    return out.join(",");
  };
  // One pass per (container, role): which child paths the single look-alikes of its children sit at.
  const memo = (ctx.repeatMemo ??= new Map());
  const key = `${up}|${tree.nodes[unit].role}`;
  let shape = memo.get(key);
  if (!shape) {
    shape = { paths: new Map(), multi: false, units: 0 };
    for (const sib of tree.kids.get(up) ?? []) {
      if (tree.nodes[sib].role !== tree.nodes[unit].role) continue;
      const { count, first } = peersIn(ctx, sib, subtreeEnd(tree, sib));
      if (!count) continue;
      shape.units++;
      if (count !== 1) shape.multi = true;
      else {
        const p = path(sib, first);
        shape.paths.set(p, (shape.paths.get(p) ?? 0) + 1);
      }
    }
    memo.set(key, shape);
  }
  return !shape.multi && shape.units >= 2 && shape.paths.size === 1 && shape.paths.has(path(unit, n.pos));
}

// LINE: the items on n's visual line, in reading order — texts and look-alikes
// (n among them), as far as the line runs unbroken in both directions.
const LINE_MAX = 200;
// One line for every look-alike on it, or for none (round 13): each control scans the line from where it
// stands, and one that sits a few pixels lower or inside a pressable wrapper can see a shorter line than its
// neighbours do. On a line past LINE_MAX it was then the only one with line evidence, and a text between it
// and a neighbour matched it alone. "No line" therefore spreads to whoever has such a look-alike on its own
// line, to a fixpoint (one hop is not enough: the short view's own neighbours see it, not the long line).
function lineItems(tree, n, ctx) {
  const memo = (ctx.lineMemo ??= new Map());
  const own = (m) => memo.get(m) ?? memo.set(m, lineItemsOf(tree, m, ctx)).get(m);
  const items = own(n);
  if (items.length < 2) return items;
  // Looked up from n outwards, not for every look-alike in the window at once: n has no line when a look-alike
  // it can reach along "is on my line" has none. (The first version scanned the line of every look-alike on
  // first use: a grid of 8,000 same-named buttons took two seconds per find, a batch of eight ran out of time.)
  const ok = (ctx.lineOk ??= new Set());
  const bad = (ctx.noLine ??= new Set());
  if (ok.has(n)) return items;
  if (bad.has(n)) return [];
  const seen = new Set([n]);
  for (const todo = [n]; todo.length; ) {
    const q = todo.pop();
    if (ok.has(q)) continue;
    if (bad.has(q) || !own(q).length) {
      bad.add(n);
      return [];
    }
    for (const m of own(q)) {
      if (seen.has(m) || !ctx.peer(m)) continue;
      seen.add(m);
      todo.push(m);
    }
  }
  for (const q of seen) ok.add(q);
  return items;
}
// clip (besideRows only): each side stops at LINE_MAX instead of voiding the line.
function lineItemsOf(tree, n, ctx, clip = false) {
  if (!n.frame) return [];
  const N = tree.nodes;
  const anc = new Set();
  for (let p = n.parent; p >= 0; p = N[p].parent) anc.add(p);
  const insidePeer = (m) => {
    for (let p = m.parent; p >= 0 && !anc.has(p); p = N[p].parent) if (ctx.peer(N[p])) return true;
    return false;
  };
  const side = (dir) => {
    const out = [];
    for (let x = dir < 0 ? n.pos - 1 : subtreeEnd(tree, n.pos); x > 0 && x < N.length; x += dir) {
      const m = N[x];
      if (m.inMenuBar !== n.inMenuBar) break;
      if (anc.has(x)) continue;
      const isP = ctx.peer(m);
      if (!isP && insidePeer(m)) continue; // the label inside a look-alike
      const leaf = isLeaf(tree, x);
      if (!m.frame) {
        if (leaf && (isP || says(m))) break; // something is here and nobody knows on which line
        continue;
      }
      if (!isP && leaf && (m.frame.w <= 2 || m.frame.h <= 2)) continue; // screen-reader-only text: not on the line, and no end of it
      if (!sameLine(n.frame, m.frame)) {
        if (leaf && (isP || !besideBlock(n.frame, m.frame))) break; // the line ends
        continue; // a container around other lines, or a block of text several lines tall beside this one, says nothing about this line
      }
      // a container's label ("DD1005 李四" on the group around a whole card) is not a text on this line
      if (isP || (says(m) && (leaf || m.press))) out.push(m);
      if (out.length > LINE_MAX) {
        if (clip) break;
        return null; // hundreds of things at one height are not a line anybody reads (and scanning them for each is quadratic)
      }
    }
    return out;
  };
  const before = side(-1);
  const after = before && side(1);
  // the limit is on the whole line, not on one side of it: with a per-side limit the controls near the middle of
  // a 202-item line still had line evidence and their neighbours past the limit had none — a text between two
  // of them then matched one alone and was pressed without the ambiguity being reported (round 12)
  if (clip) return [...before.reverse(), n, ...after];
  return before && after && before.length + after.length < LINE_MAX ? [...before.reverse(), n, ...after] : [];
}

// Split a line at its look-alikes. Look-alikes with no descriptive text
// between them form one cluster ("[编辑][删除]" share what the line says).
// → { segs, clusters, k }: segs[i] precedes clusters[i], segs[clusters.length]
// trails; k = the cluster n is in.
function lineShape(items, n, ctx) {
  const segs = [[]];
  const clusters = [];
  let k = -1;
  for (const m of items) {
    if (m === n || ctx.peer(m)) {
      if (clusters.length && !segs[segs.length - 1].some(wordy)) clusters[clusters.length - 1].push(m);
      else {
        clusters.push([m]);
        segs.push([]);
      }
      if (m === n) k = clusters.length - 1;
    } else segs[segs.length - 1].push(m);
  }
  return { segs, clusters, k };
}

// Do the look-alikes that stand alone on their line have their words in front, or behind? (-1 / 1 / 0 = no rule)
function lineConvention(tree, ctx) {
  if (ctx.convention !== undefined) return ctx.convention;
  let before = 0;
  let after = 0;
  const step = Math.max(1, Math.ceil(ctx.list.length / 120));
  for (let i = 0; i < ctx.list.length; i += step) {
    const q = ctx.list[i];
    const sh = lineShape(lineItems(tree, q, ctx), q, ctx);
    if (sh.clusters.length !== 1) continue;
    const b = sh.segs[0].some(wordy);
    const a = sh.segs[1].some(wordy);
    if (b && !a) before++;
    else if (a && !b) after++;
  }
  return (ctx.convention = before >= 2 && after === 0 ? -1 : after >= 2 && before === 0 ? 1 : 0);
}

function lineRows(tree, n, ctx, whole = false, clip = false) {
  const items = clip ? lineItemsOf(tree, n, ctx, true) : lineItems(tree, n, ctx);
  if (items.length < 2) return [];
  const { segs, clusters, k } = lineShape(items, n, ctx);
  const K = clusters.length;
  const plainOnly = (seg) => seg.filter((m) => !wordy(m));
  const head = segs[0].some(wordy);
  const tail = segs[K].some(wordy);
  if (K === 1) {
    if (head && tail) {
      // words on both sides of a lone control: the side the page's other such controls use, when they agree
      const conv = lineConvention(tree, ctx);
      if (conv < 0) return [...segs[0], ...plainOnly(segs[1])];
      if (conv > 0) return [...plainOnly(segs[0]), ...segs[1]];
    }
    return [...segs[0], ...segs[1]];
  }
  // Several on one line: a text between two of them counts for both. With words at both ends
  // ("张伟 [移除] 李四 [移除] 王五") one record has no control and the line does not say whether it is
  // the first or the last: the end texts then count for nobody.
  const ends = head && tail && !whole;
  return [...(k === 0 && ends ? plainOnly(segs[0]) : segs[k]), ...(k + 1 === K && ends ? plainOnly(segs[K]) : segs[k + 1])];
}

// Rows of the subtree at `root` outside n, outside look-alikes, outside the subtrees `skip` says to leave out.
function rowsIn(tree, n, ctx, root, skip) {
  const out = [];
  const selfEnd = subtreeEnd(tree, n.pos);
  for (let x = root, end = subtreeEnd(tree, root); x < end; x++) {
    if (x === n.pos) {
      x = selfEnd - 1;
      continue;
    }
    const m = tree.nodes[x];
    if (ctx.peer(m) || (skip && x !== root && skip(m, x))) {
      x = subtreeEnd(tree, x) - 1;
      continue;
    }
    out.push(m);
  }
  return out;
}

// ROW: the other rows of n's AXRow.
function axRowRows(tree, n, ctx) {
  let R = -1;
  for (let p = n.parent; p >= 0 && tree.nodes[p].inMenuBar === n.inMenuBar; p = tree.nodes[p].parent) {
    if (tree.nodes[p].role === "AXRow") {
      R = p;
      break;
    }
  }
  if (R < 0) return { rows: [], top: -1 };
  const cell = childToward(tree, R, n.pos);
  if (cell !== n.pos && holdsWords(tree, cell, n.pos, subtreeEnd(tree, n.pos)) && !repeats(tree, n, ctx, R)) return { rows: [], top: R };
  const anc = new Set();
  for (let p = n.parent; p >= 0; p = tree.nodes[p].parent) anc.add(p);
  // a row nested in this one (a table in a cell) is somebody else's record
  return { rows: rowsIn(tree, n, ctx, R, (m, x) => m.role === "AXRow" && !anc.has(x)), top: R };
}

// The rows that say which record n is — on ROW or LINE evidence — and how they were found.
export function recordOf(tree, n, isPeer) {
  const ctx = peerCtx(tree, n, isPeer);
  const cache = (ctx.records ??= new Map());
  let r = cache.get(n.pos);
  if (r) return r;
  const row = axRowRows(tree, n, ctx);
  const line = lineRows(tree, n, ctx);
  const seen = new Set();
  const rows = [...row.rows, ...line].filter((m) => says(m) && !seen.has(m) && seen.add(m)).sort((a, b) => a.pos - b.pos);
  // full = the same before the "ends count for nobody" rule: for asking whether two rows are ONE record
  // (with the ends taken away, two neighbours on a line are left with the very same middle text).
  const seenF = new Set();
  const full = [...row.rows, ...lineRows(tree, n, ctx, true)].filter((m) => says(m) && !seenF.has(m) && seenF.add(m)).sort((a, b) => a.pos - b.pos);
  r = { how: row.rows.length ? "row" : line.length ? "line" : "none", rows, full, top: row.top };
  cache.set(n.pos, r);
  return r;
}

// What a row says for near: its text or label, and its value — but not what
// the user typed into a field (a search box holding "DD1005" says nothing
// about the buttons beside it).
const EDITABLE = /^AX(TextField|TextArea|ComboBox|SearchField|SecureTextField)$/;
const scoreRow = (m, text) => Math.max(nearMatch(rawText(m.label || m.idx === null || !EDITABLE.test(m.role) ? m : { ...m, value: "" }), text), m.value !== undefined && m.value !== m.label && !EDITABLE.test(m.role) ? nearMatch(m.value, text) : 0);

// Is `text` near control n? → 0 no / 1 yes. "a · b" (how replies join the
// texts of a row) asks for each part.
export function nearScore(tree, n, isPeer, text) {
  const rows = recordOf(tree, n, isPeer).rows;
  const parts = String(text).split(" · ").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return 0;
  return parts.every((part) => rows.some((m) => scoreRow(m, part) > 0)) ? 1 : 0;
}

export function recordHas(tree, n, isPeer, text) {
  return nearScore(tree, n, isPeer, text) > 0;
}

// Of `list` (controls a find matched), those in the smallest section that
// says `text` and holds two or more of them: for telling the model which ones
// a text that names a whole card could mean — never for choosing one.
export function sharedBy(tree, list, text) {
  if (list.length < 2) return [];
  const ctx = { pos: list.map((m) => m.pos).sort((a, b) => a - b) };
  const set = new Set(list);
  let best = null;
  for (const t of tree.nodes) {
    if (set.has(t) || t.inMenuBar !== list[0].inMenuBar || t.role === "AXWindow" || t.role === "AXWebArea" || !scoreRow(t, text)) continue;
    for (let p = t.parent; p > 0; p = tree.nodes[p].parent) {
      const end = subtreeEnd(tree, p);
      const inside = peersIn(ctx, p, end).count;
      if (!inside) continue;
      if (inside >= 2 && inside < list.length && tree.nodes[p].role !== "AXWebArea" && (!best || end - p < best.size)) best = { p, end, size: end - p };
      break;
    }
  }
  return best ? list.filter((m) => m.pos > best.p && m.pos < best.end) : [];
}

function textCounts(tree) {
  if (tree.textCount) return tree.textCount;
  const m = new Map();
  let colDepth = -1; // Chromium lists a table's cells twice: under AXRow and again under AXColumn
  for (const n of tree.nodes) {
    if (colDepth >= 0 && n.depth <= colDepth) colDepth = -1;
    if (colDepth < 0 && n.role === "AXColumn") colDepth = n.depth;
    if (colDepth >= 0) continue;
    const t = norm(rawText(n));
    if (t) m.set(t, (m.get(t) ?? 0) + 1);
  }
  return (tree.textCount = m);
}

const shortText = (t) => (t.length > 28 ? `${t.slice(0, 28)}…` : t);

// Up to three texts that say which record n is in, in the page's own
// spelling — exactly the kind find.near accepts for n, so what a reply prints
// as near "…" can be sent back as near. Descriptive text before button
// labels; texts unique in the window first, bare small numbers last.
export function nearOf(tree, n, isPeer) {
  const rows = recordOf(tree, n, isPeer).rows;
  const pool = rows.some(wordy) ? rows.filter(wordy) : rows;
  const cnt = textCounts(tree);
  const seen = new Set();
  const uniq = pool.map(rawText).filter((t) => t && !seen.has(t) && seen.add(t));
  const rank = (t) => (/^\d{1,4}$/.test(t) ? 2 : cnt.get(norm(t)) === 1 ? 0 : 1);
  const best = uniq.map((t, i) => [rank(t), i, t]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).slice(0, 3).sort((x, y) => x[1] - y[1]);
  return best.map(([, , t]) => shortText(t)).join(" · ");
}

// When nothing can be shown to sit in a control's row or card: the text that
// comes just before it in reading order, up to the previous look-alike — a
// fact about order, not a claim about what belongs to what, and not usable
// as near.
function orderRowsOf(tree, n, ctx) {
  const before = [];
  for (let x = n.pos - 1; x > 0 && before.length < 2; x--) {
    const m = tree.nodes[x];
    if (ctx.peer(m) || m.inMenuBar !== n.inMenuBar) break;
    if (m.role === "AXWebArea" || m.role === "AXWindow") continue; // the page's title does not come "before" a control on it
    if (plainText(m)) before.unshift(m);
  }
  if (before.length) return { rows: before, side: "after" };
  for (let x = subtreeEnd(tree, n.pos); x < tree.nodes.length; x++) {
    const m = tree.nodes[x];
    if (ctx.peer(m) || m.inMenuBar !== n.inMenuBar) break;
    if (plainText(m)) return { rows: [m], side: "before" };
  }
  return { rows: [], side: "" };
}
// o.both: also the text that follows (when the hub knows the model is behind, a control with no row of its own is placed from both sides)
export function orderHintOf(tree, n, isPeer, o = {}) {
  const ctx = peerCtx(tree, n, isPeer);
  const { rows, side } = orderRowsOf(tree, n, ctx);
  // a field is said with what it holds: 收款人 = 李四 (a hint about place, never usable as near)
  const one = (m) => (m.idx !== null && m.label && m.value !== undefined && String(m.value).trim() !== "" && m.value !== m.label ? shortText(`${String(m.label).trim()} = ${String(m.value).trim()}`) : shortText(rawText(m)));
  const say = (list) => `"${list.map(one).join(" · ")}"`;
  if (!rows.length) return "";
  const next = o.both && side === "after" ? followingRows(tree, n, ctx, tree.nodes.length, 1) : [];
  return `${side} ${say(rows)}${next.length ? `, before ${say(next)}` : ""}`;
}
// Up to `max` plain texts that follow n in reading order, before the next look-alike and before row `end`.
function followingRows(tree, n, ctx, end, max) {
  const out = [];
  for (let x = subtreeEnd(tree, n.pos); x < end && out.length < max; x++) {
    const m = tree.nodes[x];
    if (ctx.peer(m) || m.inMenuBar !== n.inMenuBar) break;
    if (plainText(m)) out.push(m);
  }
  return out;
}

// The rows that stand beside control n: its record rows, else the texts just before it in reading order.
// (For comparing a control's surroundings across two walks — never for near.) Where the record has no
// descriptive text (none at all, or only other controls' names — "[通过] [驳回]"), the texts just before
// it in reading order count too, and those that follow it inside its own container ("[通过] DD1003" in
// one group, button first). What follows on a flat page is not compared — under a tab bar or a toolbar
// that is the page's first line, and every tab would cost a held call — except for a control with no
// record and nothing before it at all.
export function besideRows(tree, n) {
  const rec = recordOf(tree, n).rows;
  if (rec.some(wordy)) return rec;
  const ctx = peerCtx(tree, n);
  // A line that is no evidence for near (past LINE_MAX, or shared with a look-alike that has none) is still
  // what stands beside the control: for comparing two walks the nearest part of it counts (round 13: on a
  // 244-item line the record text three cells back, or right after the button, was no longer compared, and a
  // record the page swapped in by itself was deleted by name).
  if (!rec.length && n.frame && !lineItems(tree, n, ctx).length) {
    const long = lineRows(tree, n, ctx, false, true).filter(says);
    if (long.some(wordy)) return long.sort((a, b) => a.pos - b.pos);
  }
  const par = n.parent >= 0 ? tree.nodes[n.parent] : null;
  const box = par && par.depth > 0 && !/^AX(Window|WebArea|Sheet|Dialog)$/.test(par.role) ? par.pos : -1;
  const ord = orderRowsOf(tree, n, ctx);
  const more = [...(ord.side === "after" || !rec.length ? ord.rows : []), ...(box >= 0 ? followingRows(tree, n, ctx, subtreeEnd(tree, box), 2) : [])];
  const seen = new Set(rec);
  return [...rec, ...more.filter((m) => !seen.has(m) && seen.add(m))].sort((a, b) => a.pos - b.pos);
}

// The row of `prev` that row n of `next` is, by aligning the two trees (null when it has none there or the trees are too far apart).
export function mateOf(prev, next, n) {
  if (prev === next) return n;
  const al = alignTrees(prev, next, { menus: n.inMenuBar === true });
  if (al.far) return null;
  const j = al.posB[n.pos];
  return j === undefined || j < 0 || al.pb[j] < 0 ? null : al.A[al.pb[j]];
}

// Control n of `next` against `prev`: the row it was there, and whether it
// stands under the same ancestors with the SAME texts beside it (besideRows),
// one for one. → { was, same, changed } — `changed` lists the beside rows
// that are the same row with another text now ({ then, now }), for telling
// the model what differs; it is never grounds for calling them the same.
export function contextDiff(prev, next, n) {
  if (prev === next) return { was: n, same: true, changed: [] };
  const no = (was = null, changed = []) => ({ was, same: false, changed });
  const al = alignTrees(prev, next, { menus: n.inMenuBar === true });
  if (al.far) return no();
  const j = al.posB[n.pos];
  if (j === undefined || j < 0 || al.pb[j] < 0) return no();
  const was = al.A[al.pb[j]];
  const mate = (x) => (al.pb[x] >= 0 ? al.pb[x] : al.sb[x] >= 0 ? al.sb[x] : al.rb[x]);
  for (let p = al.parB[j], q = al.parA[al.pb[j]]; p >= 0 || q >= 0; p = al.parB[p], q = al.parA[q]) {
    if (p < 0 || q < 0 || mate(p) !== q) return no(was);
  }
  const now = besideRows(next, n);
  const then = new Set(besideRows(prev, was));
  const changed = [];
  let same = now.length === then.size;
  for (const m of now) {
    const x = al.posB[m.pos];
    if (x === undefined || x < 0) {
      same = false;
      continue;
    }
    if (al.pb[x] >= 0 && then.has(al.A[al.pb[x]])) continue;
    same = false;
    const soft = al.sb[x] >= 0 ? al.A[al.sb[x]] : al.rb[x] >= 0 ? al.A[al.rb[x]] : null;
    if (soft && then.has(soft)) changed.push({ then: soft, now: m });
  }
  return { was, same, changed };
}
// → the row of `prev` control n of `next` was, when it stands as it did there; else null.
export function sameContext(prev, next, n) {
  const d = contextDiff(prev, next, n);
  return d.same ? d.was : null;
}
export const sayRow = (m) => shortText(rawText(m));

// A text that says which card/section n sits in, from outside its own record:
// the nearest texts unique in the window that precede the record, going
// outward. Used to tell apart candidates whose own rows read the same.
export function outerOf(tree, n, isPeer) {
  const own = territoryOf(tree, n, peerCtx(tree, n, isPeer));
  const cnt = textCounts(tree);
  const out = [];
  let depth = Infinity;
  for (let x = (own >= 0 ? own : n.pos) - 1; x > 0 && out.length < 2; x--) {
    const m = tree.nodes[x];
    if (m.inMenuBar !== n.inMenuBar || m.depth > depth || !plainText(m)) continue;
    const t = rawText(m);
    if (cnt.get(norm(t)) !== 1 || /^\d{1,4}$/.test(t)) continue;
    out.push(shortText(t));
    depth = m.depth;
  }
  return out.reverse().join(" · ");
}

// A candidate the model can act on directly: full token + what it sits next to.
export function describeNode(tree, n, isPeer, o = {}) {
  const near = nearOf(tree, n, isPeer);
  const outer = o.outer ? outerOf(tree, n, isPeer) : "";
  const order = near && !o.order ? "" : orderHintOf(tree, n, isPeer, { both: o.both });
  tree.shown?.add(n.idx);
  return `${tree.snapshotId}:${n.idx} ${n.role}${n.label ? ` ${quote(n.label, 40)}` : n.help ? ` help=${quote(n.help, 40)}` : ""}${n.press ? "" : " (not pressable)"}${n.enabled === false ? " [disabled]" : ""}${near ? ` near "${near}"` : ""}${order ? ` (${order} in reading order)` : ""}${outer ? ` (in "${outer}")` : ""}`;
}

// Candidates as a list: where two read the same, each also says what it sits in.
export function describeAll(tree, list, isPeer) {
  const nears = list.map((n) => nearOf(tree, n, isPeer));
  const keys = nears.map((t, i) => t || orderHintOf(tree, list[i], isPeer));
  const parts = nears.map((t) => new Set(t ? t.split(" · ") : []));
  // two candidates that share a text (one line, several of them): each also says what precedes it
  const overlap = (i) => parts.some((p, k) => k !== i && [...parts[i]].some((x) => p.has(x)));
  return list.map((n, i) => {
    const twin = keys.indexOf(keys[i]) !== keys.lastIndexOf(keys[i]); // reads the same as another: say which card it is in
    return describeNode(tree, n, isPeer, { outer: twin, order: !twin && overlap(i) });
  });
}

// The page a browser window shows, when its address bar is readable: record
// identity usually lives in the URL even when title and layout do not change.
export function addressOf(tree) {
  if (tree.address !== undefined) return tree.address ?? undefined;
  let found = null;
  const web = tree.nodes.findIndex((n) => n.role === "AXWebArea");
  // a window without web content has no page address (a file name "report.xlsx" in a save panel is not one)
  for (let i = 0; i < web; i++) {
    const n = tree.nodes[i];
    if (n.role !== "AXTextField" || typeof n.value !== "string") continue;
    const v = n.value.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(v) || /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#]\S*)?$/i.test(v)) {
      found = v;
      tree.addressPos = n.pos;
      break;
    }
  }
  tree.address = found;
  return found ?? undefined;
}

// ---------------------------------------------------------------------------
// Carrying an element_token over to a newer walk.
//
// cua kills every token of a window the moment a newer walk of it exists —
// the hub's own walks (find, the look after an action) included. The hub
// carries an older token forward in exactly two cases:
//   * the newer walk shows the same rows in the same order → same position;
//   * the control's name (role + label, or tooltip) is the only one of its
//     kind in the window, before and after, it is still there under that
//     name, and its ancestors are still its ancestors.
// Everything else is refused. In particular a control that repeats — the
// [删除] of every table row — is never followed across a change. Five
// designs that tried (by coordinates; by nearest group text; by a widening
// text signature; by "the row still holds its unique text"; by "the row is
// unchanged row for row") were each broken in review with a record swapped
// under a button that looked the same: a slot whose amount and date happened
// to match, a card whose inner list stayed while its heading changed, a
// carousel cell named by its slot number. What a repeated control acts on is
// decided by content the hub cannot rank. The model can: find + near
// ("the 删除 whose row says DD1005") addresses it by content on a fresh walk.
// What this cannot see either — the same unique button now acting on another
// record — is the caller's job: server.mjs honours an older token only after
// every change since has been put in front of the model.
// ---------------------------------------------------------------------------

function nameCounts(tree) {
  if (tree.nameCount) return tree.nameCount;
  const m = new Map();
  for (const n of tree.nodes) if (n.idx !== null) m.set(nameKey(n), (m.get(nameKey(n)) ?? 0) + 1);
  return (tree.nameCount = m);
}

// Look-alikes of t in `tree`, nearest to position `at` first.
function lookAlikes(tree, t, at) {
  const k = nameKey(t);
  return tree.nodes.filter((n) => n.idx !== null && nameKey(n) === k).sort((a, b) => Math.abs(a.pos - at) - Math.abs(b.pos - at));
}

function candidateList(tree, list, max = 6) {
  const out = describeAll(tree, list.slice(0, max));
  if (list.length > max) out.push(`(+${list.length - max} more — narrow with find + near)`);
  return out;
}

// Map element `idx` of `prev` onto `next`. Returns {idx, node} or {error, candidates}.
export function carryIndex(prev, next, idx) {
  const t = prev.byIdx.get(idx);
  if (!t) return { error: `index ${idx} does not exist in snapshot ${prev.snapshotId}` };
  const what = `${t.role}${t.label ? ` ${quote(t.label, 40)}` : ""}`;
  // Same rows in the same order → same position. The menu bar does not count
  // for a control outside it: Undo/Redo items change after almost any action.
  if (sameTrees(prev, next, { menus: t.inMenuBar })) {
    const keep = (n) => t.inMenuBar || !n.inMenuBar;
    const b = next.nodes.filter(keep)[prev.nodes.filter(keep).indexOf(t)];
    if (b && b.idx !== null && nameKey(b) === nameKey(t)) return { idx: b.idx, node: b };
  }
  const al = alignTrees(prev, next, { menus: true });
  const cands = (at) => candidateList(next, lookAlikes(next, t, at));
  if (al.far) return { error: `the window changed too much since snapshot ${prev.snapshotId} to follow ${what}`, candidates: cands(t.pos) };
  const i = al.posA[t.pos];
  const j = al.pa[i] >= 0 ? al.pa[i] : al.sa[i];
  if (j < 0) {
    if (al.ra[i] >= 0) {
      const b = al.B[al.ra[i]];
      return { error: `${what} from snapshot ${prev.snapshotId} is now ${b.role}${b.label ? ` ${quote(b.label, 40)}` : ""} — its label changed (a toggle that already flipped?)`, candidates: b.idx !== null ? [describeNode(next, b)] : [] };
    }
    return { error: `${what} from snapshot ${prev.snapshotId} is no longer in the window where you saw it`, candidates: cands(t.pos) };
  }
  const b = al.B[j];
  const mate = (x) => (al.pa[x] >= 0 ? al.pa[x] : al.sa[x] >= 0 ? al.sa[x] : al.ra[x]);
  for (let p = al.parA[i], q = al.parB[j]; p >= 0 || q >= 0; p = al.parA[p], q = al.parB[q]) {
    if (p < 0 || q < 0 || mate(p) !== q) return { error: `${what} now sits in a different container than when you saw it`, candidates: cands(b.pos) };
  }
  const nA = nameCounts(prev).get(nameKey(t)) ?? 0;
  const nB = nameCounts(next).get(nameKey(t)) ?? 0;
  if (nA === 1 && nB === 1) return { idx: b.idx, node: b };
  return {
    error: `${what} is one of ${nB} controls of that name (${nA} when you saw it) and the window has changed since — the token of a repeated control is kept only while nothing changes. Say which one by content: find {${t.label ? `label:${quote(t.label, 30)}` : `role:"${t.role}"`}, near:"<a text from its row or card>"}, or use a current token`,
    candidates: cands(b.pos),
  };
}

// Deepest indexed node whose window-relative frame contains the point
// (window points). Used to tell the model what a pixel click actually hit.
export function hitTest(tree, x, y) {
  let best = null;
  for (const n of tree.nodes) {
    const f = n.frame;
    if (n.idx === null || !f || n.inMenuBar || n.role === "AXWindow") continue;
    if (x < f.x || y < f.y || x > f.x + f.w || y > f.y + f.h) continue;
    if (!best || n.depth > best.depth || (n.depth === best.depth && f.w * f.h < best.frame.w * best.frame.h)) best = n;
  }
  if (!best) return null;
  let anc = null;
  for (let p = best.parent; p >= 0; p = tree.nodes[p].parent) {
    const a = tree.nodes[p];
    if (a.idx !== null && a.press && a.role !== "AXWindow") {
      anc = a;
      break;
    }
  }
  return { node: best, pressableAncestor: best.press ? null : anc };
}
