// lib/windows.mjs — pure helpers over cua list_windows payloads (no I/O).
//
// A raw list_windows is ~20k chars on a normal desktop: 87 windows of which
// 74 are untitled helper surfaces (autofill popovers, cursor overlays, panel
// services), each as a JSON object with six fields the model never uses. The
// model only ever acted on titled windows, so the default view is one line
// per plausible target and a count of what was left out.

const MIN_SIDE = 100;

export function windowsOf(sc) {
  return Array.isArray(sc?.windows) ? sc.windows : null;
}

const titled = (w) => typeof w.title === "string" && w.title.trim() !== "";
const big = (w) => (w.bounds?.width ?? 0) > MIN_SIDE && (w.bounds?.height ?? 0) > MIN_SIDE;

// Default visibility: a titled window larger than an icon. Every window the
// model went on to use in a month of transcripts had a title; untitled
// on-screen surfaces are overlays (the driver's own cursor layer, autofill
// popovers). An untitled sheet/dialog is reachable through the pid filter.
export function isCandidate(w) {
  return big(w) && titled(w);
}

function clipTitle(t, max = 60) {
  t = String(t ?? "");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function windowLine(w, o = {}) {
  const b = w.bounds ?? {};
  // other-Space: with cua 0.28.x such a window cannot be read or driven in the
  // background at all (AX lists no windows of a process on a Space the user
  // is not on) — worth knowing before the first window_state.
  const where = w.on_current_space === false ? " other-Space" : w.is_on_screen === false ? " off-screen" : "";
  return `${w.window_id} pid ${w.pid} ${w.app_name ?? "?"} ${JSON.stringify(clipTitle(w.title))} ${Math.round(b.width ?? 0)}x${Math.round(b.height ?? 0)}${o.origin && Number.isFinite(b.x) && Number.isFinite(b.y) ? ` @${Math.round(b.x)},${Math.round(b.y)}` : ""}${where}`;
}

// o: { pid, all } — a pid filter lists every window of that process (the way
// to find an untitled sheet or dialog); all:true lists everything.
export function renderWindows(windows, o = {}) {
  // On-screen windows first, then by cua's z_index, which grows toward the
  // front (measured: the frontmost app's key window carries the highest
  // value among on-screen windows; off-screen ones can rank above them).
  const sorted = [...windows].sort((a, b) => Number(b.is_on_screen === true) - Number(a.is_on_screen === true) || (b.z_index ?? -1) - (a.z_index ?? -1));
  const scoped = o.pid !== undefined ? sorted.filter((w) => Number(w.pid) === Number(o.pid)) : sorted;
  const shown = o.all || o.pid !== undefined ? scoped : scoped.filter(isCandidate);
  const hidden = scoped.length - shown.length;
  const lines = [`${shown.length} window(s)${o.pid !== undefined ? ` of pid ${o.pid}` : ""}, front-most first — window_id pid app "title" WxH @x,y (top-left, screen points)`, ...shown.map((w) => windowLine(w, { origin: true }))];
  if (hidden) lines.push(`(${hidden} untitled/tiny helper windows hidden — pid:<pid> lists every window of one app, all:true lists everything)`);
  if (shown.some((w) => w.on_current_space === false)) lines.push("(other-Space = on a desktop/full-screen Space the user is not on: screenshot only — its accessibility tree cannot be read and background input is refused until the user is there)");
  if (!shown.length && !hidden) lines.push("(none)");
  return lines.join("\n");
}

// Window-set delta around an action: a click that opens a file panel or a
// dialog changes the window list, not the clicked window's AX tree.
// Only windows that can be a consequence of the action count: the acted
// process's own, and anything that appeared ON SCREEN (a system Open/Save
// panel belongs to a helper process). Other apps' background windows come
// and go on their own.
export function windowDelta(before, after, pid) {
  if (!before || !after) return [];
  const b = new Map(before.map((w) => [w.window_id, w]));
  const a = new Map(after.map((w) => [w.window_id, w]));
  const mine = (w) => pid === undefined || Number(w.pid) === Number(pid);
  const out = [];
  for (const [id, w] of a) if (!b.has(id) && big(w) && (mine(w) || w.is_on_screen === true)) out.push(`new window: ${windowLine(w)}`);
  for (const [id, w] of b) if (!a.has(id) && big(w) && titled(w) && mine(w)) out.push(`closed window: ${windowLine(w)}`);
  return out.slice(0, 6);
}
