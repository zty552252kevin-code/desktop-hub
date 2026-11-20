#!/usr/bin/env node
// Unit tests for lib/tree.mjs and lib/windows.mjs — pure functions, no I/O,
// no desktop. Run: node test/unit.mjs (npm test runs this before smoke.mjs).
// Payloads come from test/fixtures/trees.mjs (synthetic, cua 0.28.2 shape).

import { spawnSync } from "node:child_process";
import {
  parseTree, rowText, renderTree, renderRows, queryTree, queryTerms, renderQuery, findNodes,
  pairTrees, diffTrees, renderDiff, alignTrees, sameTrees, carryIndex, describeNode, nearOf, recordOf, recordHas, sharedBy, contextOf, hitTest, parseToken, addressOf, nameRank, wrapperOf, besideRows, contextDiff, sayRow, sameContext,
} from "../lib/tree.mjs";
import { isCandidate, renderWindows, windowDelta } from "../lib/windows.mjs";
import { payload, degradedPayload, WIN } from "./fixtures/trees.mjs";

let failures = 0;
let total = 0;
function check(name, cond, detail = "") {
  total++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}
// A section that throws records one FAIL and the run goes on.
function section(name, fn) {
  try {
    fn();
  } catch (e) {
    check(`${name}: runs without throwing`, false, String(e?.stack ?? e).split("\n").slice(0, 2).join(" | "));
  }
}
const J = (v) => JSON.stringify(v);
const eq = (a, b) => J(a) === J(b);
const idxOrder = (t) => t.nodes.filter((n) => n.idx !== null).map((n) => n.idx);
const LRM = "‎";

// ---------------------------------------------------------------------------
// Main fixture: window + toolbar + content group, a menu bar, then a depth-0
// floating group after the menu bar.
// ---------------------------------------------------------------------------
const MENU_ACTS = ["AXCancel", "AXPress", "AXPick"];
const MAIN_ROWS = [
  [0, "AXWindow", "记账本", { a: ["AXRaise"] }],
  [1, "AXToolbar", "应用栏", { ix: false, desc: "应用栏" }],
  [2, "AXButton", "返回", { press: true, desc: "返回", f: [10, 40, 30, 30] }],
  [2, "AXButton", "添加到收藏夹(⌘D)", { a: ["AXPress"], desc: "添加到收藏夹(⌘D)", id: "fav?x=1&y=2 z", f: [50, 40, 30, 30] }],
  [1, "AXGroup", null, { a: ["AXShowMenu", "AXScrollToVisible"], f: [0, 80, 1000, 600], web: true }],
  [2, "AXStaticText", `${LRM}0${LRM}+`, { ix: false }],
  [2, "AXTextField", "备注", { v: "午饭", desc: "备注", a: ["AXPress", "AXShowMenu", "AXScrollToVisible"], f: [20, 100, 300, 24], web: true }],
  [2, "AXStaticText", "合计", { a: ["AXShowMenu", "AXScrollToVisible"], f: [20, 140, 60, 20], web: true }],
  [2, "AXButton", null, { help: "保存当前记录", press: true, f: [20, 180, 60, 24], web: true }],
  [0, "AXMenuBar", null, { a: ["AXCancel"], f: [-100, -50, 1512, 33] }],
  [1, "AXMenuBarItem", "编辑", { a: MENU_ACTS, f: [-90, -50, 34, 33] }],
  [2, "AXMenu", null, { a: ["AXCancel"] }],
  [3, "AXMenuItem", "撤销", { a: MENU_ACTS, id: "undo:" }],
  [3, "AXMenuItem", "粘贴", { ix: false }],
  [0, "AXGroup", "浮层", { a: ["AXShowMenu"], f: [600, 600, 300, 80] }],
  [1, "AXButton", "关闭浮层", { press: true, f: [610, 610, 80, 24] }],
];
const mainSc = payload("s00000101", MAIN_ROWS);
const main = parseTree(mainSc);
const N = (t, idx) => t.byIdx.get(idx);

// 1. structured + markdown --------------------------------------------------
check("parse/main: 16 rows total (13 indexed + 3 markdown-only)", main.nodes.length === 16 && main.byIdx.size === 13, `${main.nodes.length}/${main.byIdx.size}`);
check("parse/main: indexed order 0..12", eq(idxOrder(main), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), J(idxOrder(main)));
section("1b. un-indexed rows", () => {
  const st = main.nodes[5];
  check("parse/main: un-indexed static text row kept with raw tail", st.idx === null && st.role === "AXStaticText" && st.depth === 2 && st.text === ` = "${LRM}0${LRM}+"`, J(st));
  const tb = main.nodes[1];
  check("parse/main: un-indexed toolbar row text", tb.idx === null && tb.role === "AXToolbar" && tb.text === ' "应用栏" (应用栏)', J(tb));
  check("parse/main: un-indexed disabled menu item row", main.nodes[13].idx === null && main.nodes[13].role === "AXMenuItem" && main.nodes[13].text === ' "粘贴"', J(main.nodes[13]));
});
check("parse/main: depth from elements", N(main, 1).depth === 2 && N(main, 3).depth === 1 && N(main, 10).depth === 3 && N(main, 11).depth === 0, J([1, 3, 10, 11].map((i) => N(main, i).depth)));
check("parse/main: parent of [1] is the un-indexed toolbar (pos 1)", N(main, 1).parent === 1 && main.nodes[1].parent === 0, `${N(main, 1).parent}`);
check("parse/main: parent of [4] is group [3]", N(main, 4).parent === N(main, 3).pos, `${N(main, 4).parent}`);
check("parse/main: roots have parent -1", N(main, 0).parent === -1 && N(main, 7).parent === -1 && N(main, 11).parent === -1);
check("parse/main: pos of [4] is 6, of [12] is 15", N(main, 4).pos === 6 && N(main, 12).pos === 15, `${N(main, 4).pos},${N(main, 12).pos}`);
check("parse/main: byIdx points into nodes[]", [...main.byIdx].every(([i, n]) => main.nodes[n.pos] === n && n.idx === i));
section("1c. menu bar membership", () => {
  const mb = main.nodes.filter((n) => n.inMenuBar).map((n) => n.idx);
  check("parse/main: inMenuBar = exactly the menu bar subtree", eq(mb, [7, 8, 9, 10, null]), J(mb));
  check("parse/main: depth-0 group after the menu bar is not inMenuBar", N(main, 11).inMenuBar === false && N(main, 12).inMenuBar === false);
});
check("parse/main: raw elements[] frame is absolute", eq(mainSc.elements[1].frame, { x: 110, y: 90, w: 30, h: 30 }), J(mainSc.elements[1].frame));
check("parse/main: node frame is window-relative", eq(N(main, 1).frame, { x: 10, y: 40, w: 30, h: 30 }), J(N(main, 1).frame));
check("parse/main: window node frame is 0,0,w,h; tree.win absolute", eq(N(main, 0).frame, { x: 0, y: 0, w: 1000, h: 700 }) && eq(main.win, WIN), J([N(main, 0).frame, main.win]));
check("parse/main: menu bar frame relative (negative)", eq(N(main, 7).frame, { x: -100, y: -50, w: 1512, h: 33 }), J(N(main, 7).frame));
check("parse/main: frameless menu item has frame undefined", N(main, 10).frame === undefined);
check("parse/main: title / snapshotId / pid / windowId", main.title === "记账本" && main.snapshotId === "s00000101" && main.pid === 4242 && main.windowId === 777, J([main.title, main.snapshotId, main.pid, main.windowId]));
check("parse/main: structured, not complete, not degraded, not truncated", main.structured === true && main.complete === false && main.degraded === false && main.truncated === undefined);
check("parse/main: label/value from elements", N(main, 4).label === "备注" && N(main, 4).value === "午饭" && N(main, 2).label === "添加到收藏夹(⌘D)", J([N(main, 4).label, N(main, 4).value, N(main, 2).label]));
check("parse/main: static text label === value", N(main, 5).label === "合计" && N(main, 5).value === "合计");
check("parse/main: press from AXPress in elements", N(main, 1).press && N(main, 2).press && N(main, 10).press && !N(main, 0).press && !N(main, 3).press && !N(main, 5).press);
check("parse/main: unlabeled row picks help= from markdown", N(main, 6).help === "保存当前记录" && N(main, 1).help === undefined, J(N(main, 6).help));

// 2. multi-line value containing a row-looking line -------------------------
section("2. multi-line value containing a row-looking line", () => {
  const rows = [
    [0, "AXWindow", "终端", { a: ["AXRaise"] }],
    [1, "AXScrollArea", null, { a: ["AXScrollToVisible"] }],
    [2, "AXStaticText", '第一行\n  - [3] AXButton "假的"\n第三行', { ix: false }],
    [2, "AXButton", "清屏", { press: true }],
    [2, "AXButton", "真的", { press: true }],
  ];
  const t = parseTree(payload("s2", rows));
  const txt = t.nodes.find((n) => n.idx === null && n.role === "AXStaticText");
  check("parse/multiline: fake '- [3] AXButton' line is not a node (5 rows)", t.nodes.length === 5, `${t.nodes.length}`);
  check("parse/multiline: [3] is the real button, after [2]", N(t, 3)?.label === "真的" && N(t, 3).pos === 4 && N(t, 2).pos === 3, `pos[2]=${N(t, 2)?.pos} pos[3]=${N(t, 3)?.pos}`);
  check("parse/multiline: index order still 0,1,2,3", eq(idxOrder(t), [0, 1, 2, 3]), J(idxOrder(t)));
  check("parse/multiline: continuation lines merged into the text row", txt?.text === ' = "第一行\n  - [3] AXButton "假的"\n第三行"', J(txt?.text));
  // Same, but the fake line's role disagrees with element 3 (guard path).
  const rows2 = rows.map((r) => (r[1] === "AXStaticText" ? [2, "AXStaticText", '第一行\n  - [3] AXLink "假的"\n第三行', { ix: false }] : r));
  const t2 = parseTree(payload("s2b", rows2));
  check("parse/multiline: role-mismatched fake row ignored, text merged", t2.nodes.length === 5 && eq(idxOrder(t2), [0, 1, 2, 3]) && t2.nodes[2].text.endsWith('第三行"'), J(t2.nodes[2].text));
  // Multi-line value on an INDEXED row (real shape) containing an AX-looking line.
  const rows3 = [
    [0, "AXWindow", "终端", { a: ["AXRaise"] }],
    [1, "AXGroup", "外框", { a: ["AXShowMenu"] }],
    [2, "AXStaticText", '甲\n  - AXGroup "伪组"\n乙', { a: ["AXShowMenu"] }],
    [2, "AXButton", "确认", { press: true }],
  ];
  const t3 = parseTree(payload("s2c", rows3));
  check("parse/multiline: AX-looking line inside an indexed value is not a node", t3.nodes.length === 4 && !t3.nodes.some((n) => n.text?.includes("伪组")), J(t3.nodes.map((n) => [n.idx, n.role, n.depth])));
  check("parse/multiline: indexed value comes whole from elements[]", N(t3, 2).value === '甲\n  - AXGroup "伪组"\n乙');
  check("parse/multiline: [3] keeps parent [1] despite the fake line", N(t3, 3).parent === N(t3, 1).pos, `${N(t3, 3).parent}`);
});

// 3. truncation notice -------------------------------------------------------
section("3. truncation notice", () => {
  const NOTE = "AX tree truncated at 5 nodes (app has a very large accessibility tree). Element indices above are still valid. Use pixel clicks for elements not visible in this partial tree.";
  const rows = [
    [0, "AXWindow", "大窗", { a: ["AXRaise"] }],
    [1, "AXGroup", null, { a: ["AXShowMenu"] }],
    [2, "AXButton", "甲", { press: true }],
    [2, "AXStaticText", "尾行", { ix: false }],
  ];
  const sc = payload("s3", rows, { truncated: NOTE });
  const t = parseTree(sc);
  check("parse/truncated: fixture markdown ends with the notice", sc.tree_markdown.endsWith(`"尾行"\n\n⚠️  ${NOTE}`));
  check("parse/truncated: tree.truncated holds the notice without the sign", t.truncated === NOTE, J(t.truncated));
  check("parse/truncated: notice is not a node (4 rows)", t.nodes.length === 4, `${t.nodes.length}`);
  check("parse/truncated: last un-indexed row text not polluted", t.nodes[3].text === ' = "尾行"', J(t.nodes[3].text));
  check("parse/truncated: renderTree ends with '⚠ AX tree truncated at 5 nodes'", /\n⚠ AX tree truncated at 5 nodes/.test(renderTree(t)), renderTree(t).slice(-200));
  const t2 = parseTree(payload("s3b", rows.slice(0, 3), { truncated: NOTE }));
  check("parse/truncated: last indexed row unaffected", N(t2, 2).label === "甲" && t2.nodes.length === 3 && t2.truncated === NOTE);
  // cua ends a normal tree_markdown with "\n" (25 of 26 real samples).
  const t3 = parseTree(payload("s3c", rows));
  check("parse/trailing-newline: last un-indexed row text not polluted", t3.nodes[3].text === ' = "尾行"', J(t3.nodes[3].text));
});

// 4. markdown only (cua >= 0.34 compact default) ----------------------------
section("4. markdown only (cua >= 0.34 compact default)", () => {
  const rows = [
    [0, "AXWindow", "只读窗", { a: ["AXRaise"] }],
    [1, "AXButton", "添加到收藏夹(⌘D)", { a: ["AXPress"], desc: "添加到收藏夹(⌘D)" }],
    [1, "AXTextField", "搜索", { v: "关键词", desc: "搜索", id: "q?a=1&b=2 c", a: ["AXPress", "AXShowMenu", "AXScrollToVisible"] }],
    [1, "AXButton", null, { desc: "进入阅读模式(⌘R)", press: true }],
    [1, "AXGroup", null, { a: ["AXShowMenu", "AXScrollToVisible"] }],
    [2, "AXButton", null, { help: "帮助文字", press: true }],
    [2, "AXStaticText", "页脚", { ix: false }],
    [1, "AXMenuItem", "撤销", { a: MENU_ACTS, id: "undo:" }],
    [1, "AXButton", "末尾按", { a: ["AXShowMenu", "AXPress"] }],
  ];
  const sc = payload("s4", rows, { mode: "md" });
  const t = parseTree(sc);
  check("parse/md-only: fixture has no elements[]", !("elements" in sc) && typeof sc.tree_markdown === "string");
  check("parse/md-only: structured:false, 9 rows, indices 0..7", t.structured === false && t.nodes.length === 9 && eq(idxOrder(t), [0, 1, 2, 3, 4, 5, 6, 7]), `${t.nodes.length} ${J(idxOrder(t))}`);
  check("parse/md-only: depth from indentation", eq(t.nodes.map((n) => n.depth), [0, 1, 1, 1, 1, 2, 2, 1, 1]), J(t.nodes.map((n) => n.depth)));
  check("parse/md-only: title falls back to window_title", t.title === "只读窗");
  check("parse/md-only: label with parens + same desc not cut", N(t, 1).label === "添加到收藏夹(⌘D)" && N(t, 1).value === undefined, J([N(t, 1).label, N(t, 1).value]));
  check("parse/md-only: label + value parsed, id with ?=& and space skipped", N(t, 2).label === "搜索" && N(t, 2).value === "关键词", J([N(t, 2).label, N(t, 2).value]));
  check("parse/md-only: desc-only row uses desc (with parens) as label", N(t, 3).label === "进入阅读模式(⌘R)", J(N(t, 3).label));
  check("parse/md-only: help= on unlabeled row", N(t, 5).help === "帮助文字" && N(t, 5).label === undefined, J(N(t, 5).help));
  check("parse/md-only: press when 'press' is first/middle", N(t, 2).press && N(t, 3).press && N(t, 5).press && N(t, 6).press);
  check("parse/md-only: press for [actions=[press]] (press alone)", N(t, 1).press === true, `press=${N(t, 1).press}`);
  check("parse/md-only: press for [actions=[showmenu,press]] (press last)", N(t, 7).press === true, `press=${N(t, 7).press}`);
  check("parse/md-only: not pressable without press", N(t, 0).press === false && N(t, 4).press === false);
  const ml = parseTree({ snapshot_id: "s4b", tree_markdown: '- [0] AXWindow "w" [actions=[raise]]\n  - [1] AXTextArea "记录" = "第一行\n第二行" [actions=[press,showmenu]]\n' });
  check("parse/md-only: multi-line value on an indexed row keeps label/value/press", N(ml, 1).label === "记录" && N(ml, 1).value === "第一行\n第二行" && N(ml, 1).press === true, J(N(ml, 1), ["label", "value", "press"]));
  check("parse/md-only: frames unknown, header says so", N(t, 1).frame === undefined && renderTree(t).split("\n")[0].endsWith("· 9 rows · no structured elements from this cua build: pressability unknown"), renderTree(t).split("\n")[0]);
  check("parse/md-only: structured tree header has no such note", !renderTree(main).split("\n")[0].includes("no structured elements"));
});

// 5. elements only ------------------------------------------------------------
section("5. elements only", () => {
  const t = parseTree(payload("s5", MAIN_ROWS, { mode: "els" }));
  check("parse/els-only: 13 indexed rows in index order, structured", t.nodes.length === 13 && eq(idxOrder(t), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) && t.structured === true, `${t.nodes.length}`);
  const par = (i) => (N(t, i).parent < 0 ? -1 : t.nodes[N(t, i).parent].idx);
  check("parse/els-only: hierarchy rebuilt from depth", eq([1, 2, 3, 4, 6, 8, 9, 10, 12].map(par), [0, 0, 0, 3, 3, 7, 8, 9, 11]), J([1, 2, 3, 4, 6, 8, 9, 10, 12].map(par)));
  check("parse/els-only: menu bar membership same as with markdown", eq(t.nodes.filter((n) => n.inMenuBar).map((n) => n.idx), [7, 8, 9, 10]));
  check("parse/els-only: labels, frames, press still there", N(t, 4).value === "午饭" && eq(N(t, 1).frame, { x: 10, y: 40, w: 30, h: 30 }) && N(t, 1).press);
});

// 6. degraded / not a tree -----------------------------------------------------
section("6. degraded / not a tree", () => {
  const t = parseTree(degradedPayload("s6", "ax_window_unresolved:test"));
  check("parse/degraded: tree with degraded:true and reason", t !== null && t.degraded === true && t.degradedReason === "ax_window_unresolved:test" && t.nodes.length === 0, J(t && { d: t.degraded, r: t.degradedReason }));
  check("parse/degraded: degraded flag alone (no elements, no markdown) still a tree", parseTree({ degraded: true, degraded_reason: "x" })?.degraded === true);
  check("parse/null: null → null", parseTree(null) === null);
  check("parse/null: {} → null", parseTree({}) === null);
  check("parse/null: string / number → null", parseTree("tree") === null && parseTree(42) === null);
  check("parse/null: object without elements/markdown → null", parseTree({ snapshot_id: "s1", pid: 1 }) === null);
});

// 7. elements[] row missing from markdown --------------------------------------
section("7. elements[] row missing from markdown", () => {
  const t = parseTree(payload("s7", MAIN_ROWS, { omitMd: [4, 12] }));
  check("parse/missing: rows spliced back, index order still increasing", eq(idxOrder(t), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), J(idxOrder(t)));
  check("parse/missing: total rows unchanged (16)", t.nodes.length === 16, `${t.nodes.length}`);
  check("parse/missing: [4] sits between [3] and [5], under [3]", N(t, 3).pos < N(t, 4).pos && N(t, 4).pos < N(t, 5).pos && N(t, 4).parent === N(t, 3).pos, J([N(t, 3).pos, N(t, 4).pos, N(t, 5).pos, N(t, 4).parent]));
  check("parse/missing: trailing [12] appended last, under [11]", N(t, 12).pos === 15 && N(t, 12).parent === N(t, 11).pos && N(t, 4).value === "午饭");
});

// 8. rowText ------------------------------------------------------------------
section("8. rowText", () => {
  const long = "长".repeat(600);
  const rows = [
    [0, "AXWindow", "渲染窗", { a: ["AXRaise"] }],
    [1, "AXButton", "停用", { press: true, en: false, f: [10, 20, 30, 40] }],
    [1, "AXRadioButton", "已选", { press: true, sel: true }],
    [1, "AXTextField", "正文", { v: long, a: ["AXShowMenu"] }],
    [1, "AXCheckBox", "同名", { v: "同名", press: true }],
  ];
  const t = parseTree(payload("s8", rows));
  check("render/rowText: pressable uses [n]", rowText(N(main, 1)) === '- [1] AXButton "返回"', rowText(N(main, 1)));
  check("render/rowText: not pressable uses (n)", rowText(N(main, 3)) === "- (3) AXGroup", rowText(N(main, 3)));
  check("render/rowText: label === value printed once", rowText(N(main, 5)) === '- (5) AXStaticText "合计"' && rowText(N(t, 4)) === '- [4] AXCheckBox "同名"', `${rowText(N(main, 5))} | ${rowText(N(t, 4))}`);
  check("render/rowText: label and value both shown", rowText(N(main, 4)) === '- [4] AXTextField "备注" = "午饭"', rowText(N(main, 4)));
  check("render/rowText: un-indexed '\"x\" (x)' deduped", rowText(main.nodes[1]) === '- AXToolbar "应用栏"', rowText(main.nodes[1]));
  check("render/rowText: un-indexed static text kept as is", rowText(main.nodes[5]) === `- AXStaticText = "${LRM}0${LRM}+"`, rowText(main.nodes[5]));
  check("render/rowText: [disabled] only when enabled:false", rowText(N(t, 1)) === '- [1] AXButton "停用" [disabled]' && !rowText(N(main, 1)).includes("[disabled]"), rowText(N(t, 1)));
  check("render/rowText: [selected] only when selected:true", rowText(N(t, 2)) === '- [2] AXRadioButton "已选" [selected]' && !rowText(N(main, 4)).includes("[selected]"), rowText(N(t, 2)));
  check("render/rowText: help shown for unlabeled row (plus its centre: bare button)", rowText(N(main, 6)) === '- [6] AXButton help="保存当前记录" @50,192', rowText(N(main, 6)));
  check("render/coords: frames:true appends the centre in window points", rowText(N(t, 1), { frames: true }) === '- [1] AXButton "停用" [disabled] @25,40', rowText(N(t, 1), { frames: true }));
  check("render/coords: frames:true + scale:2 → centre in screenshot px", rowText(N(t, 1), { frames: true, scale: 2 }) === '- [1] AXButton "停用" [disabled] @50,80', rowText(N(t, 1), { frames: true, scale: 2 }));
  check("render/coords: bare pointable row gets centre without frames:true, scaled", rowText(N(main, 6), { scale: 2 }) === '- [6] AXButton help="保存当前记录" @100,384', rowText(N(main, 6), { scale: 2 }));
  check("render/coords: labeled button has no coords by default", rowText(N(main, 1)) === '- [1] AXButton "返回"' && rowText(N(main, 12)) === '- [12] AXButton "关闭浮层"');
  check("render/coords: bare container row (AXGroup with frame) has no coords", rowText(N(main, 3)) === "- (3) AXGroup", rowText(N(main, 3)));
  check("render/coords: unlabeled field WITH a value is not bare", rowText(parseTree(payload("sv", [[0, "AXWindow", "w", {}], [1, "AXTextField", null, { v: "内容", f: [0, 0, 10, 10] }]])).byIdx.get(1)) === '- (1) AXTextField = "内容"');
  const ut = renderTree(main);
  check("render/coords: units line (window points) once coords were printed", ut.includes("\n(@x,y = element centre in window points; no screenshot taken yet, so the px scale is unknown)\n") && ut.split("\n").filter((l) => l.startsWith("(@x,y")).length === 1, ut);
  check("render/coords: units line says screenshot px when scale is known", renderTree(main, { scale: 2 }).includes("\n(@x,y = element centre in screenshot px — usable as act x,y)"));
  check("render/coords: no coords printed → no units line", !renderTree(t).includes("(@x,y") && !renderQuery(main, "返回").includes("(@x,y"), renderTree(t));
  check("render/rowText: frames:true on a frameless row adds nothing", rowText(N(main, 10), { frames: true }) === '- [10] AXMenuItem "撤销"', rowText(N(main, 10), { frames: true }));
  const r = rowText(N(t, 3));
  check("render/rowText: long value clipped at 500 with …[+100 chars]", r === `- (3) AXTextField "正文" = "${"长".repeat(500)}…[+100 chars]"`, `len=${r.length} tail=${r.slice(-20)}`);
  check("render/rowText: fullText:true does not clip", rowText(N(t, 3), { fullText: true }) === `- (3) AXTextField "正文" = "${long}"`);
});

// 9. menu bar hiding ------------------------------------------------------------
section("9. menu bar hiding", () => {
  const txt = renderTree(main);
  check("render/menus: menu rows hidden by default", !txt.includes("撤销") && !txt.includes("AXMenuBar") && !txt.includes("粘贴"), txt);
  check("render/menus: note counts the 5 hidden rows", txt.includes("(menu bar hidden: 5 rows"), txt.split("\n").pop());
  check("render/menus: rows after the menu bar still shown", txt.includes('[12] AXButton "关闭浮层"') && txt.includes('(11) AXGroup "浮层"'));
  const all = renderTree(main, { menus: true });
  check("render/menus: menus:true shows menu rows, no note", all.includes('\n   - [10] AXMenuItem "撤销"\n') && all.includes('   - AXMenuItem "粘贴"') && !all.includes("menu bar hidden"), all);
  check("render/menus: header counts shown rows (11 vs 16)", txt.split("\n")[0].endsWith("· 11 rows") && all.split("\n")[0].endsWith("· 16 rows"), `${txt.split("\n")[0]} | ${all.split("\n")[0]}`);
});

// 10. limits + header ------------------------------------------------------------
section("10. limits + header", () => {
  const rows = [[0, "AXWindow", "长列表", { a: ["AXRaise"] }]];
  for (let i = 1; i <= 50; i++) rows.push([1, "AXButton", `按钮${String(i).padStart(2, "0")}`, { press: true }]);
  rows.push([1, "AXGroup", null, { a: [] }], [2, "AXButton", "深处", { press: true }]);
  const t = parseTree(payload("s00000119", rows, { windowId: 5150 }));
  const txt = renderTree(t, { maxChars: 300 });
  const L = txt.split("\n");
  check("render/head: line 1 has 'win <id>', 'snapshot <sid>' and the row count", L[0].startsWith('win 5150 "长列表" pid 4242 · snapshot s00000119 · ') && / of 53 rows$/.test(L[0]), L[0]);
  check("render/head: no legend line any more (line 2 is the first row)", L[1] === '- (0) AXWindow "长列表"', L[1]);
  const body = L.slice(1, -1);
  const tail = L[L.length - 1];
  const m = /^…\[(\d+) more rows not shown/.exec(tail);
  check("render/maxChars: trailer says how many rows were not shown", !!m, tail);
  check("render/maxChars: shown + not shown = 53 rows, header agrees", m && body.length + Number(m[1]) === 53 && L[0].endsWith(`· ${body.length} of 53 rows`), `${body.length}+${m?.[1]} | ${L[0]}`);
  check("render/maxChars: no half rows", body.length > 0 && body.every((l) => /^(- \(0\) AXWindow "长列表"| - \[\d+\] AXButton "按钮\d\d")$/.test(l)), J(body));
  check("render/maxChars: body within budget", body.join("\n").length <= 300, `${body.join("\n").length}`);
  const r5 = renderRows(t, { maxRows: 5 });
  check("render/maxRows: exactly 5 rows, 48 cut", r5.lines.length === 5 && r5.shown === 5 && r5.cut === 48, J([r5.lines.length, r5.cut]));
  const d1 = renderRows(t, { maxDepth: 1 });
  check("render/maxDepth: depth-2 row dropped, not counted as cut", d1.lines.length === 52 && !d1.lines.some((l) => l.includes("深处")) && d1.cut === 0, J([d1.lines.length, d1.cut]));
  check("render/indent: one space per depth", d1.lines[1] === ' - [1] AXButton "按钮01"' && renderRows(t).lines[52] === '  - [52] AXButton "深处"', J(d1.lines[1]));
});

// 11. queryTree / renderQuery ------------------------------------------------------
section("11. queryTree / renderQuery", () => {
  const a = queryTree(main, "返回|合计");
  const b = queryTree(main, ["返回", "合计"]);
  check("query: 'a|b' and ['a','b'] give the same hits and rows", a.hits === 2 && b.hits === 2 && eq([...a.only].sort(), [...b.only].sort()), J([a.hits, b.hits, [...a.only], [...b.only]]));
  check("query: renderQuery same text for both spellings", renderQuery(main, "返回|合计") === renderQuery(main, ["返回", "合计"]));
  const rows = [
    [0, "AXWindow", "表单", { a: ["AXRaise"] }],
    [1, "AXButton", "确 定", { press: true }],
    [1, "AXButton", "取消", { press: true }],
    [1, "AXButton", "Save Draft", { press: true }],
    [1, "AXButton", "创作 中心", { press: true }],
    [1, "AXButton", "继续创作", { press: true }],
  ];
  const f = parseTree(payload("s11", rows));
  const qf = queryTree(f, "确定");
  check("query/loose: '确定' hits label '确 定' on the 2nd pass (loose:true)", qf.hits === 1 && qf.loose === true && renderQuery(f, "确定").includes('[1] AXButton "确 定"'), J({ hits: qf.hits, loose: qf.loose }));
  check("query/loose: header says (ignoring whitespace)", renderQuery(f, "确定").split("\n")[0].endsWith('· 1 match(es) for "确定" (ignoring whitespace) of 6 rows'), renderQuery(f, "确定").split("\n")[0]);
  check("query/loose: '取 消' hits label '取消' on the 2nd pass", queryTree(f, "取 消").hits === 1 && queryTree(f, "取 消").loose === true);
  const both = parseTree(payload("s11b", [...rows, [1, "AXButton", "确定", { press: true }]]));
  const qb = queryTree(both, "确定");
  check("query/strict: tree has '确定' and '确 定' → 1st pass hits only '确定'", qb.hits === 1 && qb.loose === false && renderQuery(both, "确定").includes('[6] AXButton "确定"') && !renderQuery(both, "确定").includes('"确 定"'), J({ hits: qb.hits, loose: qb.loose }));
  const qs = queryTree(f, "创作 ");
  check("query/strict: trailing space on purpose — '创作 ' hits '创作 中心' only", qs.hits === 1 && qs.loose === false && renderQuery(f, "创作 ").includes('[4] AXButton "创作 中心"') && !renderQuery(f, "创作 ").includes("继续创作"), J({ hits: qs.hits, loose: qs.loose }));
  check("query/strict: '创作' without the space hits both", queryTree(f, "创作").hits === 2);
  check("query: case-insensitive on both passes ('SAVE D', 'SAVEdraft')", queryTree(f, "SAVE D").hits === 1 && queryTree(f, "SAVE D").loose === false && queryTree(f, "SAVEdraft").hits === 1 && queryTree(f, "SAVEdraft").loose === true);
  check("query: queryTerms lowercases, keeps inner/trailing spaces, drops blank terms", eq(queryTerms("|确定| |Save D|创作 "), ["确定", "save d", "创作 "]), J(queryTerms("|确定| |Save D|创作 ")));
  check("query: blank alternatives dropped ('|确 定|')", queryTree(f, "|确 定|  |").hits === 1 && queryTree(f, "|确 定|  |").loose === false);
  const q = renderQuery(main, "午饭");
  check("query: hit row shown with its ancestor chain", q.includes('- (0) AXWindow "记账本"') && q.includes(" - (3) AXGroup") && q.includes('  - [4] AXTextField "备注" = "午饭"'), q);
  check("query: unrelated siblings not shown", !q.includes("返回") && !q.includes("合计") && !q.includes("应用栏") && !q.includes("关闭浮层"), q);
  // The total counts what was searched: the hidden menu bar (5 rows) is not part of it.
  check("query: header reports 1 match of the 11 searched rows", q.split("\n")[0].endsWith('· 1 match(es) for "午饭" of 11 rows'), q.split("\n")[0]);
  check("query: with menus:true the total includes the menu bar", renderQuery(main, "午饭", { menus: true }).split("\n")[0].endsWith('of 16 rows'), renderQuery(main, "午饭", { menus: true }).split("\n")[0]);
  const qm = queryTree(main, "撤销");
  check("query: menu-bar hit not counted by default, reported apart", qm.hits === 0 && qm.menuHits === 1, J([qm.hits, qm.menuHits]));
  const qmt = renderQuery(main, "撤销");
  check("query: menu-only hit explained in text", qmt.includes("1 match(es) exist only in the menu bar"), qmt);
  const qm2 = renderQuery(main, "撤销", { menus: true });
  check("query: menus:true counts and shows the menu hit with its chain", queryTree(main, "撤销", { menus: true }).hits === 1 && qm2.includes('   - [10] AXMenuItem "撤销"') && qm2.includes("- (7) AXMenuBar"), qm2);
  const mixed = renderQuery(main, "撤销|返回");
  check("query: mixed hit notes the hidden menu match", mixed.includes('[1] AXButton "返回"') && !mixed.includes("[10]") && mixed.includes("(+1 match(es) in the menu bar hidden"), mixed);
  const z = renderQuery(main, "不存在的词");
  check("query/0 hits: row count and window title in header", z.split("\n")[0] === 'win 777 "记账本" pid 4242 · snapshot s00000101 · 0 of 11 rows match "不存在的词"', z.split("\n")[0]);
  check("query/0 hits, small window: 'the whole window:' + full tree (menus hidden)", z.split("\n")[1] === "the whole window:" && z.includes('\n  - [1] AXButton "返回"\n') && z.includes('\n - [12] AXButton "关闭浮层"') && !z.includes("撤销"), z);
  check("query/0 hits, small window: no 'pressable here' / 'closest rows'", !z.includes("pressable here") && !z.includes("closest rows"));
  const many = (n, label) => Array.from({ length: n }, (_, i) => [1, "AXButton", `${label}${String(i + 1).padStart(2, "0")}`, { press: true }]);
  const bigNear = parseTree(payload("s11c", [[0, "AXWindow", "大表", { a: ["AXRaise"] }], ...many(80, "按钮"), [1, "AXButton", "导出数据", { press: true }], [1, "AXStaticText", "月度报表", { a: [] }]]));
  check("query/0 hits, big window: precondition — tree renders over 1500 chars", renderRows(bigNear, { maxChars: 1500 }).cut > 0);
  const zn = renderQuery(bigNear, "导出报表");
  check("query/0 hits, big window: 'closest rows:' = rows sharing 2+ chars", zn.split("\n").slice(1, 4).join("\n") === 'closest rows:\n- [81] AXButton "导出数据"\n- (82) AXStaticText "月度报表"' && !zn.includes("the whole window") && !zn.includes("pressable here"), zn);
  check("query/0 hits, big window: ends with the substring hint", zn.endsWith("query is a case-insensitive SUBSTRING over role, label, value; separate alternatives with |."), zn.split("\n").pop());
  const bigWeb = parseTree(payload("s11d", [[0, "AXWindow", "浏览器", { a: ["AXRaise"] }], [1, "AXButton", "后退", { press: true }], [1, "AXButton", "前进", { press: true }], [1, "AXWebArea", "页面", { a: [] }], ...many(80, "条目").map((r) => [2, ...r.slice(1)])]));
  const zw = renderQuery(bigWeb, "zz");
  check("query/0 hits, big window, no near miss: 'pressable here:' from the web area", zw.includes('\npressable here: [4] "条目01", [5] "条目02"') && !zw.includes("后退") && !zw.includes("closest rows"), zw);
  check("query/0 hits, big window, no near miss: at most 10 labels", (zw.match(/\[\d+\] "条目/g) ?? []).length === 10, zw);
});

// 12. findNodes -------------------------------------------------------------------
section("12. findNodes", () => {
  const ids = (arr) => arr.map((n) => n.idx);
  check("find: role is case-insensitive exact match", eq(ids(findNodes(main, { role: "axbutton" })), [1, 2, 6, 12]), J(ids(findNodes(main, { role: "axbutton" }))));
  check("find: role prefix is not a match", findNodes(main, { role: "AXBut" }).length === 0 && findNodes(main, { role: "Button" }).length === 0);
  check("find: label falls back to whitespace-insensitive ('收 藏')", eq(ids(findNodes(main, { label: "收 藏" })), [2]) && eq(ids(findNodes(main, { label: "浮层" })), [11, 12]));
  {
    const ft = parseTree(payload("s12", [[0, "AXWindow", "表单", {}], [1, "AXButton", "确 定", { press: true }], [1, "AXButton", "确定", { press: true }], [1, "AXButton", "创作 中心", { press: true }], [1, "AXButton", "继续创作", { press: true }]]));
    check("find: strict pass first — '确定' finds only '确定' when both exist", eq(ids(findNodes(ft, { label: "确定" })), [2]), J(ids(findNodes(ft, { label: "确定" }))));
    check("find: trailing space on purpose — '创作 ' finds only '创作 中心'", eq(ids(findNodes(ft, { label: "创作 " })), [3]), J(ids(findNodes(ft, { label: "创作 " }))));
    check("find: '确  定' (2 spaces) → loose pass finds both", eq(ids(findNodes(ft, { label: "确  定" })), [1, 2]), J(ids(findNodes(ft, { label: "确  定" }))));
  }
  check("find: value substring", eq(ids(findNodes(main, { role: "AXTextField", value: "午" })), [4]));
  check("find: menu bar skipped by default", findNodes(main, { label: "撤销" }).length === 0 && findNodes(main, { label: "编辑" }).length === 0);
  check("find: role AXMenuItem searches the menu bar", eq(ids(findNodes(main, { role: "AXMenuItem", label: "撤销" })), [10]));
  check("find: menus:true searches the menu bar", eq(ids(findNodes(main, { label: "编辑", menus: true })), [8]));
  check("find: un-indexed rows never returned", findNodes(main, { role: "AXMenuItem", label: "粘贴" }).length === 0 && eq(ids(findNodes(main, { role: "AXStaticText" })), [5]) && findNodes(main, { role: "AXToolbar" }).length === 0);
});

// 13. pairTrees / diffTrees / renderDiff ------------------------------------------
section("13. pairTrees / diffTrees / renderDiff", () => {
  const BASE = [
    [0, "AXWindow", "设备面板", { a: ["AXRaise"] }],
    [1, "AXGroup", "列表", { a: ["AXShowMenu"], f: [0, 80, 1000, 500] }],
    [2, "AXTextField", "名称", { v: "旧值", a: ["AXPress"], f: [20, 100, 200, 24] }],
    [2, "AXButton", "开机", { press: true, f: [20, 140, 60, 24] }],
    [2, "AXStaticText", "说明文字", { ix: false }],
    [2, "AXButton", "刷新", { press: true, f: [20, 180, 60, 24] }],
    [2, "AXButton", "导出", { press: true, f: [20, 220, 60, 24] }],
    [2, "AXStaticText", "状态良好", { a: [], f: [20, 260, 100, 20] }],
  ];
  // edit(label, fn): copy BASE with the row carrying `label` transformed.
  const edit = (rows, label, fn) => rows.map((r) => (r[2] === label ? fn(r) : r));
  const prev = parseTree(payload("s1", BASE));
  const same = renderDiff(prev, parseTree(payload("s2", BASE)));
  check("diff/same: one line 'no change' with lineage", same.text === 'win 777 "设备面板" pid 4242 · snapshot s2 (was s1) · no change vs your last view (8 rows)', J(same.text));
  check("diff/same: zero counts", same.changes === 0 && same.moved === 0 && same.churn === false);
  check("diff/same: o.since names the baseline", renderDiff(prev, parseTree(payload("s2", BASE)), { since: "the last action" }).text.endsWith("· no change vs the last action (8 rows)"));

  const v = renderDiff(prev, parseTree(payload("s2", edit(BASE, "名称", (r) => [r[0], r[1], r[2], { ...r[3], v: "新值" }]))));
  check("diff/value: exactly one '~' line", eq(v.lines, ['~ [2] AXTextField "名称" = "新值": value "旧值" → "新值"']), J(v.lines));
  check("diff/value: header counts +0 −0 ~1 vs your last view", v.text.split("\n")[0] === 'win 777 "设备面板" pid 4242 · snapshot s2 (was s1) · +0 −0 ~1 of 8 rows vs your last view', v.text.split("\n")[0]);
  check("diff/value: text is header + the change line, nothing else", v.text.split("\n").length === 2 && v.text.split("\n")[1] === v.lines[0], J(v.text));

  const rl = renderDiff(prev, parseTree(payload("s2", edit(BASE, "开机", (r) => [r[0], r[1], "关机", r[3]]))));
  check("diff/relabel: one '~' with was \"开机\", not +/-", eq(rl.lines, ['~ [3] AXButton "关机" (was "开机")']) && rl.added === 0 && rl.removed === 0, J(rl.lines));

  const ad = renderDiff(prev, parseTree(payload("s2", [...BASE, [2, "AXButton", "帮助", { press: true, f: [20, 300, 60, 24] }]])));
  check("diff/added: one '+' line", eq(ad.lines, ['+ [7] AXButton "帮助"']) && ad.added === 1, J(ad.lines));

  const gone = renderDiff(prev, parseTree(payload("s2", BASE.filter((r) => r[2] !== "导出"))));
  check("diff/removed: one '- … (gone)' line", eq(gone.lines, ['- AXButton "导出" (gone)']) && gone.removed === 1, J(gone.lines));
  const goneTxt = renderDiff(prev, parseTree(payload("s2", BASE.filter((r) => r[2] !== "说明文字"))));
  check("diff/removed: un-indexed row gone shows its text", eq(goneTxt.lines, ['- AXStaticText = "说明文字" (gone)']), J(goneTxt.lines));

  const scrolled = BASE.map(([d, role, l, o]) => [d, role, l, o.f && role !== "AXWindow" ? { ...o, f: [o.f[0], o.f[1] - 40, o.f[2], o.f[3]] } : o]);
  const sc = renderDiff(prev, parseTree(payload("s2", scrolled)));
  check("diff/scroll: single 'only moved … scrolled' line", eq(sc.lines, ["(6 rows only moved — content scrolled by 0,-40 px)"]) && sc.changes === 0, J(sc.lines));

  const churnRows = [BASE[0], BASE[1], ...["甲", "乙", "丙", "丁", "戊"].map((l, i) => [2, "AXLink", l, { press: true, f: [20, 100 + 40 * i, 60, 24] }])];
  const ch = renderDiff(prev, parseTree(payload("s2", churnRows)));
  check("diff/churn: >50% rows replaced → churn:true, text null", ch.churn === true && ch.text === null, J({ churn: ch.churn, a: ch.added, r: ch.removed }));

  // 8 same-label rows, values differ; one inserted at the top.
  const list = (vals, framed, shift = 0) => [
    [0, "AXWindow", "清单", { a: ["AXRaise"] }],
    [1, "AXGroup", "条目区", { a: ["AXShowMenu"], ...(framed ? { f: [0, 80, 1000, 600] } : {}) }],
    ...vals.map((val, i) => [2, "AXTextField", "条目", { v: val, a: ["AXPress"], ...(framed ? { f: [20, 100 + 30 * (i + shift), 300, 24] } : {}) }]),
  ];
  const vals = ["值1", "值2", "值3", "值4", "值5", "值6", "值7", "值8"];
  const noF = diffTrees(parseTree(payload("s1", list(vals, false))), parseTree(payload("s2", list(["值新", ...vals], false))));
  check("diff/dup-insert (no frames): 1 added, no value changes", noF.added === 1 && noF.changed === 0 && noF.removed === 0 && noF.lines[0] === '+ [2] AXTextField "条目" = "值新"', J(noF.lines));
  const withF = diffTrees(parseTree(payload("s1", list(vals, true))), parseTree(payload("s2", list(["值新", ...vals], true))));
  check("diff/dup-insert (rows shift down 30px): 1 added, no value changes", withF.added === 1 && withF.changed === 0 && withF.removed === 0 && withF.lines.includes('+ [2] AXTextField "条目" = "值新"'), J(withF.lines.slice(0, 4)));
  const p = pairTrees(parseTree(payload("s1", list(vals, true))), parseTree(payload("s2", list(["值新", ...vals], true))));
  check("diff/dup-insert (rows shift): each old row paired with its own value", p.pairs.filter(([x]) => x.role === "AXTextField").every(([x, y]) => x.value === y.value), J(p.pairs.filter(([x]) => x.role === "AXTextField").map(([x, y]) => `${x.value}->${y.value}`)));
});

// carryIndex (safety-critical: a wrong answer presses another control) -----------
// table(rows): one AXRow per entry; an entry is a text or an array of texts,
// each row ends with a "删除" button (frames only when framed).
const table = (rows, { framed = true, extraTop = false, btn = "删除" } = {}) => [
  [0, "AXWindow", "任务表", { a: ["AXRaise"] }],
  ...(extraTop ? [[1, "AXButton", "新建", { press: true }]] : []),
  [1, "AXTable", "任务", { a: [], ...(framed ? { f: [0, 60, 1000, 600] } : {}) }],
  ...rows.flatMap((texts, i) => [
    [2, "AXRow", null, { a: ["AXShowMenu"], ...(framed ? { f: [0, 100 + 30 * i, 1000, 30] } : {}) }],
    ...[texts].flat().map((tx, j) => [3, "AXStaticText", tx, { a: [], ...(framed ? { f: [20 + 120 * j, 103 + 30 * i, 100, 24] } : {}) }]),
    [3, "AXButton", btn, { press: true, ...(framed ? { f: [800, 103 + 30 * i, 60, 24] } : {}) }],
  ]),
];
const btns = (t, label = "删除") => findNodes(t, { role: "AXButton", label }).map((n) => n.idx);
const okTo = (r, idx) => r && r.error === undefined && r.idx === idx;
const refused = (r) => r && r.error !== undefined && r.idx === undefined;

section("align: Myers LCS against a brute-force LCS length", () => {
  // alignTrees must return an order-preserving alignment of maximal length.
  let seed = 12345;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 8) % n;
  const mk = (sid, labels) => parseTree(payload(sid, [[0, "AXWindow", "w", {}], ...labels.map((l) => [1, "AXButton", l, { press: true }])]));
  const lcsLen = (a, b) => {
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    return dp[a.length][b.length];
  };
  let bad = "";
  for (let c = 0; c < 400 && !bad; c++) {
    const a = Array.from({ length: rnd(14) }, () => "abcd"[rnd(4)]);
    const b = Array.from({ length: rnd(14) }, () => "abcd"[rnd(4)]);
    const al = alignTrees(mk("sa", a), mk("sb", b));
    let last = -1;
    let n = 0;
    for (let i = 0; i < al.A.length; i++) {
      const j = al.pa[i];
      if (j < 0) continue;
      if (j <= last || al.A[i].label !== al.B[j].label || al.pb[j] !== i) bad = `not order-preserving / mismatched at ${i}: ${J([a, b])}`;
      last = j;
      n++;
    }
    if (!bad && n !== lcsLen(a, b) + 1) bad = `length ${n - 1} != LCS ${lcsLen(a, b)} for ${J([a, b])}`;
  }
  check("align: 400 random pairs — order-preserving, same key, maximal length", bad === "", bad);
  const big = (n, skip) => mk("sx", Array.from({ length: n }, (_, i) => `行${i}`).filter((_, i) => i !== skip));
  const t0 = Date.now();
  const al = alignTrees(big(3000, -1), big(3000, 1500));
  check("align: 3000 rows, one removed → 1 unaligned, fast", [...al.pa].filter((x) => x < 0).length === 1 && Date.now() - t0 < 500, `${Date.now() - t0}ms`);
  const far = alignTrees(mk("sf", Array.from({ length: 1000 }, (_, i) => `甲${i}`)), mk("sg", Array.from({ length: 1000 }, (_, i) => `乙${i}`)));
  check("align: two unrelated 1000-row pages → far:true, and diffTrees reports churn", far.far === true && diffTrees(mk("sf2", ["a"]), mk("sg2", ["a"])).churn === false);
});

section("carry/identical walk: same position, whatever the names", () => {
  for (const [name, rows] of [["main", MAIN_ROWS], ["table", table(["甲任务", "乙任务", "丙任务"])]]) {
    const t = parseTree(payload("s14a", rows));
    const u = parseTree(payload("s14b", rows));
    const bad = [...t.byIdx.keys()].filter((i) => !okTo(carryIndex(t, u, i), i));
    check(`carry/self (${name}): every indexed row maps to itself on an identical newer walk`, bad.length === 0, `not mapped: ${J(bad)} ${J(bad.slice(0, 2).map((i) => carryIndex(t, u, i).error))}`);
    check(`sameTrees (${name}): identical walks`, sameTrees(t, u) === true);
  }
  const r = carryIndex(main, main, 99);
  check("carry/missing-index: error", r.error === "index 99 does not exist in snapshot s00000101" && r.idx === undefined, J(r));
  const list = (n) => {
    const out = [[0, "AXWindow", "列表", { a: ["AXRaise"] }], [1, "AXTable", null, {}]];
    for (let i = 0; i < n; i++) out.push([2, "AXRow", null, {}], [3, "AXStaticText", "条目", {}], [3, "AXButton", "移除", { press: true }]);
    return out;
  };
  const L = parseTree(payload("s16i", list(20)));
  const mid = findNodes(L, { label: "移除" })[10];
  check("carry/identical: the 11th of 20 identical rows on an identical walk → the 11th", okTo(carryIndex(L, parseTree(payload("s16j", list(20))), mid.idx), mid.idx));
  check("carry/identical: one row fewer → refused", refused(carryIndex(L, parseTree(payload("s16k", list(19))), mid.idx)));
});

section("carry/repeated controls are never followed across a change", () => {
  for (const framed of [true, false]) {
    const tag = framed ? "frames" : "no frames";
    const old = parseTree(payload("s15a", table(["甲任务", "乙任务", "丙任务"], { framed })));
    const neu = parseTree(payload("s15b", table(["甲任务", "丙任务"], { framed })));
    const [o1, o2, o3] = btns(old);
    if (framed) check("carry/delete-row: precondition — new 丙 button sits at old 乙 button's spot", eq(N(neu, btns(neu)[1]).frame, N(old, o2).frame), J([N(neu, btns(neu)[1]).frame, N(old, o2).frame]));
    const rs = [o1, o2, o3].map((i) => carryIndex(old, neu, i));
    check(`carry/delete-row (${tag}): all three old 删除 tokens refused`, rs.every(refused), J(rs.map((r) => r.error ?? r.idx)));
    check(`carry/delete-row (${tag}): the refusal of a surviving row says why and how to address it`, /is one of 2 controls of that name \(3 when you saw it\) and the window has changed since/.test(rs[2].error) && rs[2].error.includes('find {label:"删除", near:"<a text from its row or card>"}'), rs[2].error);
    check(`carry/delete-row (${tag}): candidates name their rows, nearest first`, eq(rs[2].candidates, ['s15b:7 AXButton "删除" near "丙任务"', 's15b:4 AXButton "删除" near "甲任务"']), J(rs[2].candidates));
    check(`carry/delete-row (${tag}): a unique row text follows`, okTo(carryIndex(old, neu, findNodes(old, { label: "丙任务" })[0].idx), findNodes(neu, { label: "丙任务" })[0].idx));
    const d = renderDiff(old, neu);
    check(`carry/delete-row (${tag}): the delta names the row that went`, d.lines.includes('- AXStaticText "乙任务" (gone)') && d.removed === 3 && d.added === 0 && d.changed === 0, J(d.lines));
  }
  // The five review rounds' counter-examples, all the same shape: a repeated button, a record swapped under it.
  const orders = (recs) => [[0, "AXWindow", "订单", {}], [1, "AXTable", "订单表", {}], ...recs.flatMap(([nm, amt, date], i) => [[2, "AXRow", null, {}], [3, "AXStaticText", String(i + 1), { a: [] }], [3, "AXStaticText", nm, { a: [] }], [3, "AXStaticText", amt, { a: [] }], [3, "AXStaticText", date, { a: [] }], [3, "AXButton", "删除", { press: true }]])];
  const BASE = [["王一", "¥120.00", "11-02"], ["李二", "¥80.00", "11-05"], ["赵三", "¥300.00", "11-07"]];
  const o1 = parseTree(payload("s19j", orders(BASE)));
  const o2 = parseTree(payload("s19k", orders([BASE[0], ["孙五", "¥80.00", "11-05"], BASE[2]])));
  check("carry/slot: name replaced, amount and date unchanged → every 删除 token refused", btns(o1).every((i) => refused(carryIndex(o1, o2, i))));
  const cards = (h2) => [[0, "AXWindow", "卡片", {}], ...[["王一", "键盘"], [h2, "鼠标"], ["赵三", "屏幕"]].flatMap(([who, item]) => [[1, "AXGroup", null, {}], [2, "AXStaticText", `客户 ${who}`, { a: [] }], [2, "AXList", null, {}], [3, "AXStaticText", item, { a: [] }], [3, "AXButton", "退款", { press: true }]])];
  const c1 = parseTree(payload("s19l", cards("李二")));
  const c2 = parseTree(payload("s19m", cards("孙五")));
  check("carry/nested: the card's heading changed, its inner list did not → 退款 refused", btns(c1, "退款").every((i) => refused(carryIndex(c1, c2, i))));
  const slots = (mid) => [[0, "AXWindow", "轮播", {}], ...["键盘 ¥499", mid, "耳机 ¥299"].flatMap((g, i) => [[1, "AXGroup", `${i + 1} / 3`, {}], [2, "AXStaticText", g, { a: [] }], [2, "AXButton", "加入购物车", { press: true }]])];
  const g1 = parseTree(payload("s19n", slots("鼠标 ¥99")));
  const g2 = parseTree(payload("s19o", slots("电竞椅 ¥1299")));
  check("carry/slot-named container: the cell '2 / 3' now shows another product → refused", btns(g1, "加入购物车").every((i) => refused(carryIndex(g1, g2, i))));
  // A selected row's button sits one wrapper deeper: depth must not make it "unique".
  const sel = (k) => [[0, "AXWindow", "选中行", {}], [1, "AXTable", "表", {}], ...["甲", "乙", "丙"].flatMap((nm, i) => [[2, "AXRow", null, {}], [3, "AXStaticText", nm, { a: [] }], ...(i === k ? [[3, "AXGroup", null, {}], [4, "AXButton", "删除", { press: true }]] : [[3, "AXButton", "删除", { press: true }]])])];
  const s1 = parseTree(payload("s19p", sel(0)));
  const s2 = parseTree(payload("s19q", sel(2)));
  check("carry/depth: the one button that sits a level deeper is still a repeated control → refused", btns(s1).every((i) => refused(carryIndex(s1, s2, i))), J(btns(s1).map((i) => carryIndex(s1, s2, i).idx)));
});

section("carry/unique controls follow their name", () => {
  const lone = (extra) => [
    [0, "AXWindow", "空窗", { a: ["AXRaise"] }],
    [1, "AXGroup", null, { a: [] }],
    ...(extra ? [[2, "AXImage", null, { a: [] }]] : []),
    [2, "AXButton", "提交", { press: true }],
    [2, "AXImage", null, { a: [] }],
  ];
  check("carry/unique: a row inserted before it → mapped (index shifted 2→3)", okTo(carryIndex(parseTree(payload("s16a", lone(false))), parseTree(payload("s16b", lone(true))), 2), 3));
  const before = ["标题", "地址甲", "电话", "备注栏", "数量", "单价", "计时 10:01"];
  const page = (b, box = "AXGroup") => [[0, "AXWindow", "下单", { a: ["AXRaise"] }], [1, box, null, { a: [] }], ...b.map((x) => [2, "AXStaticText", x, { a: [] }]), [2, "AXButton", "提交订单", { press: true }]];
  const old = parseTree(payload("s40", page(before)));
  const btn = findNodes(old, { label: "提交订单" })[0];
  check("carry/unique: text next to it changed → mapped", okTo(carryIndex(old, parseTree(payload("s42", page([...before.slice(0, 6), "计时 10:02"]))), btn.idx), btn.idx));
  check("carry/unique: its container is another kind of container now → refused", /different container/.test(carryIndex(old, parseTree(payload("s43", page(before, "AXSheet"))), btn.idx).error ?? ""));
  const a = parseTree(payload("s17a", table([["主机甲"]], { btn: "开机" })));
  const b = parseTree(payload("s17b", table([["主机甲"]], { btn: "关机" })));
  const r = carryIndex(a, b, btns(a, "开机")[0]);
  check("carry/relabel: refused, says what it is now and offers that token", refused(r) && /is now AXButton "关机" — its label changed/.test(r.error) && eq(r.candidates, ['s17b:4 AXButton "关机" near "主机甲"']), J(r));
  const v = (on) => parseTree(payload(on ? "s17d" : "s17c", [[0, "AXWindow", "表单", {}], [1, "AXCheckBox", "同意条款", { v: on ? "1" : "0", press: true }], [1, "AXButton", "提交", { press: true }]]));
  check("carry/value: a control whose VALUE changed is still that control", okTo(carryIndex(v(false), v(true), 1), 1) && okTo(carryIndex(v(false), v(true), 2), 2));
  const icons = (tips) => [[0, "AXWindow", "卡片", {}], [1, "AXGroup", "工具条", {}], ...tips.map((h) => [2, "AXButton", null, { press: true, help: h }])];
  const ia = parseTree(payload("s16m", icons(["置顶", "编辑", "删除"])));
  const ib = parseTree(payload("s16n", icons(["编辑", "删除", "取消置顶"])));
  const byTip = (t, h) => t.nodes.find((n) => n.help === h);
  const re = carryIndex(ia, ib, byTip(ia, "编辑").idx);
  check("carry/tooltip: an unlabeled icon is named by its tooltip and follows it, not its position", re.node && re.node.help === "编辑" && re.idx === byTip(ib, "编辑").idx, J(re));
  check("carry/tooltip: 置顶 (gone, 取消置顶 appeared) is refused", refused(carryIndex(ia, ib, byTip(ia, "置顶").idx)));
  const two = (extra) => [[0, "AXWindow", "双钮", {}], [1, "AXButton", null, { press: true }], [1, "AXButton", null, { press: true }], ...(extra ? [[1, "AXStaticText", "新提示", { a: [] }]] : [])];
  check("carry/anonymous icons: two icons without label or tooltip, something else changed → refused", refused(carryIndex(parseTree(payload("s16g", two(false))), parseTree(payload("s16h", two(true))), 2)));
});

section("diff: a change the printed rows cannot show", () => {
  const S1 = "[some-org/some-repo] Run failed: smoke tests on main — commit 4f2a9c1 by someone";
  const S2 = "[some-org/some-repo] Run failed: smoke tests on main — commit 7be03d2 by someone";
  const one = (t) => parseTree(payload("sd1", [[0, "AXWindow", "信", {}], [1, "AXGroup", "栏", {}], [2, "AXStaticText", t, { a: [] }], [2, "AXButton", "删除", { press: true }]]));
  const d = renderDiff(one(S1), one(S2));
  check("diff/long text: the 'was' part is quoted around the first difference, not from the start", d.lines.length === 1 && d.lines[0].includes("7be03d2") && d.lines[0].includes("4f2a9c1") && /\(differs from character \d+\)/.test(d.lines[0]), J(d.lines));
  const long = (tail) => "甲".repeat(600) + tail;
  const U = {};
  const h = renderDiff(one(long("旧尾")), one(long("新尾")), { used: U });
  check("diff/long text: a difference beyond what a row prints marks the delta as incomplete (used.cut)", h.capped === true && U.cut === true, J([h.capped, U]));
  const U2 = {};
  renderDiff(one(long("旧尾")), one(long("新尾")), { used: U2, fullText: true });
  check("diff/long text: …unless rows are printed in full", U2.cut === undefined, J(U2));
  const val = (v) => parseTree(payload("sd2", [[0, "AXWindow", "表", {}], [1, "AXTextField", "备注", { v }]]));
  const dv = renderDiff(val("字".repeat(200) + "旧"), val("字".repeat(200) + "新"));
  check("diff/long value: both sides quoted around the difference", /value …".*旧".*→ …".*新"/.test(dv.lines[0]), J(dv.lines));
  check("sameTrees: identical rows → true; a value, a label, a tooltip, enabled or row count differing → false",
    sameTrees(val("a"), val("a")) && !sameTrees(val("a"), val("b")) && !sameTrees(one("x"), one("y")) && !sameTrees(one("x"), val("x")));
});

section("review round 5: small parser / renderer fixes", () => {
  // markdown-only tree (cua >= 0.34 shape): an unclosed quote must not swallow the next numbered row
  const md = ['- [0] AXWindow "w" [actions=[raise]]', '  - [1] AXTextField "a" = "unterminated', '  - [2] AXButton "Cancel" [actions=[press]]', '  - [3] AXButton "OK" [actions=[press]]'].join("\n");
  const t = parseTree({ snapshot_id: "s60", pid: 1, window_id: 2, tree_markdown: md });
  check("parse/md-only: the row after an unclosed quote survives", eq(idxOrder(t), [0, 1, 2, 3]) && t.byIdx.get(2).label === "Cancel", J(t.nodes.map((n) => [n.idx, n.label])));
  // a negative depth from upstream must not throw in the renderer
  const sc = payload("s61", [[0, "AXWindow", "w", {}], [1, "AXButton", "甲", { press: true }]]);
  sc.elements[1].depth = -1;
  let threw = "";
  try { renderTree(parseTree(sc)); } catch (e) { threw = String(e); }
  check("parse: a negative element depth is clamped, rendering does not throw", threw === "", threw);
  // rows hidden by max_depth are counted and announced
  const deep = parseTree(payload("s62", [[0, "AXWindow", "w", {}], [1, "AXGroup", "g", {}], [2, "AXButton", "甲", { press: true }], [2, "AXButton", "乙", { press: true }]]));
  const U = {};
  const txt = renderTree(deep, { maxDepth: 1, used: U });
  check("render/max_depth: header says 2 of 4 rows, a line says how many are deeper, used.cut is set", txt.includes("· 2 of 4 rows") && txt.includes("…[2 rows deeper than max_depth 1 not shown]") && U.cut === true, txt);
  // a huge query is echoed clipped
  const q = renderQuery(deep, "q".repeat(5000));
  check("query: a 5000-character query is echoed clipped", q.length < 1200, `len=${q.length}`);
  // "differs from character" counts characters, not UTF-16 units; unlabeled icons quote the old tooltip
  const emoji = "😀".repeat(60);
  const one = (x) => parseTree(payload("s63", [[0, "AXWindow", "信", {}], [1, "AXGroup", "栏", {}], [2, "AXStaticText", x, { a: [] }], [2, "AXButton", "删除", { press: true }]]));
  const de = renderDiff(one(`${emoji}${"字".repeat(60)}旧`), one(`${emoji}${"字".repeat(60)}新`));
  check("diff/was: position counted in characters (60 emoji + 60 字 → 121)", de.lines[0].includes("(differs from character 121)"), de.lines[0].slice(-60));
  const ic = (h) => parseTree(payload("s64", [[0, "AXWindow", "条", {}], [1, "AXButton", null, { press: true, help: h }]]));
  const dh = renderDiff(ic("静音"), ic("取消静音"));
  check("diff/was: an unlabeled icon whose tooltip changed quotes the old tooltip", dh.lines[0].includes('(was help="静音")'), J(dh.lines));
  const long = "提示".repeat(60);
  const UH = {};
  renderDiff(ic(`${long}甲`), ic(`${long}乙`), { used: UH });
  check("diff/was: a tooltip that differs beyond the printed 80 characters marks the delta incomplete", UH.cut === true, J(UH));
});

section("recordOf / nearOf / recordHas (what find.near and candidate lists are built on)", () => {
  // Action column: the nearest group holds only [改][删]; the record is the row.
  const rows = (names) => {
    const out = [[0, "AXWindow", "名册", { a: ["AXRaise"] }], [1, "AXTable", null, {}]];
    names.forEach(([no, nm, id], i) => {
      out.push([2, "AXRow", null, {}], [3, "AXCell", null, {}], [4, "AXStaticText", no, { a: [] }], [3, "AXCell", null, {}], [4, "AXStaticText", nm, { a: [] }], [3, "AXCell", null, {}], [4, "AXStaticText", id, { a: [] }], [3, "AXCell", null, {}], [4, "AXButton", "改", { press: true }], [4, "AXButton", "删", { press: true }]);
    });
    return out;
  };
  const T = parseTree(payload("s50", rows([["1", "张伟", "DD1001"], ["2", "张伟", "DD1002"], ["3", "Li Lei", "dd1003"]])));
  const dels = findNodes(T, { role: "AXButton", label: "删" });
  check("record: a row button's record is its AXRow (not the action cell)", recordOf(T, dels[1]).how === "row" && T.nodes[recordOf(T, dels[1]).top].role === "AXRow");
  check("near: unique text first, the repeated name after it, the row number last; page spelling kept", nearOf(T, dels[1]) === "2 · 张伟 · DD1002" && nearOf(T, dels[2]) === "3 · Li Lei · dd1003", J([nearOf(T, dels[1]), nearOf(T, dels[2])]));
  check("describe: candidate line = full token + record texts", describeNode(T, dels[0]) === `s50:${dels[0].idx} AXButton "删" near "1 · 张伟 · DD1001"`, describeNode(T, dels[0]));
  const has = (txt) => dels.filter((d) => recordHas(T, d, undefined, txt)).map((d) => dels.indexOf(d));
  check("recordHas: an id picks one row; a repeated name picks two; case and extra spaces do not matter; other rows' text does not leak", eq(has("DD1002"), [1]) && eq(has("张伟"), [0, 1]) && eq(has("li  LEI"), [2]) && eq(has("DD1003"), [2]) && eq(has("不存在"), []), J([has("DD1002"), has("张伟"), has("li  LEI")]));
  check("recordHas: a text is matched as a whole word — part of a longer id or number is not a match", eq(has("DD100"), []) && eq(has("D1002"), []) && eq(has("1002"), []) && eq(has("伟"), []) && eq(has("张伟"), [0, 1]), J([has("DD100"), has("D1002"), has("1002"), has("伟"), has("张伟")]));
  // Many texts in the row: at most three shown.
  const wide = parseTree(payload("s51", [[0, "AXWindow", "宽表", {}], [1, "AXTable", null, {}], ...["甲", "乙"].flatMap((k) => [[2, "AXRow", null, {}], ...[`${k}-编号`, "公共", `${k}-姓名`, `${k}-电话`, `${k}-地址`].map((x) => [3, "AXStaticText", x, { a: [] }]), [3, "AXButton", "删", { press: true }]])]));
  check("near: at most three texts, unique ones preferred over shared ones", nearOf(wide, findNodes(wide, { label: "删" })[0]) === "甲-编号 · 甲-姓名 · 甲-电话", nearOf(wide, findNodes(wide, { label: "删" })[0]));
  // Flat page: no container per record; the same visual line decides.
  const flat = (withFrames) => [[0, "AXWindow", "平铺", {}], [1, "AXGroup", "列表", {}], ...["甲", "乙", "丙"].flatMap((nm, i) => [[2, "AXStaticText", `订单${nm}`, { a: [], ...(withFrames ? { f: [20, 100 + 40 * i, 200, 24] } : {}) }], [2, "AXButton", "删除", { press: true, ...(withFrames ? { f: [400, 100 + 40 * i, 60, 24] } : {}) }]])];
  const F = parseTree(payload("s52", flat(true)));
  const fd = findNodes(F, { role: "AXButton", label: "删除" });
  check("record (flat, frames): the text on the same visual line", recordOf(F, fd[1]).how === "line" && nearOf(F, fd[1]) === "订单乙" && recordHas(F, fd[1], undefined, "订单乙") && !recordHas(F, fd[1], undefined, "订单丙"), J([recordOf(F, fd[1]).how, nearOf(F, fd[1])]));
  const G = parseTree(payload("s53", flat(false)));
  const gd = findNodes(G, { role: "AXButton", label: "删除" });
  check("record (flat, no frames): cannot tell — no near text is claimed, recordHas matches nothing, the candidate line gives reading order instead", recordOf(G, gd[1]).how === "none" && !recordHas(G, gd[1], undefined, "订单乙") && nearOf(G, gd[1]) === "" && / \((after|before) "[^"]+" in reading order\)$/.test(describeNode(G, gd[1])), J([recordOf(G, gd[1]).how, nearOf(G, gd[1]), describeNode(G, gd[1])]));
  check("near texts are exactly those find.near accepts: every text a candidate line prints selects that candidate", [T, wide, F].every((t) => findNodes(t, { role: "AXButton" }).every((b) => nearOf(t, b).split(" · ").filter(Boolean).every((x) => recordHas(t, b, undefined, x)))));
  // A unique control inside a dialog: the record is the dialog, near is its words.
  const dlg = parseTree(payload("s54", [[0, "AXWindow", "页", {}], [1, "AXGroup", "确认删除", {}], [2, "AXStaticText", "确定删除项目「乙」？", { a: [] }], [2, "AXGroup", null, {}], [3, "AXButton", "取消", { press: true }], [3, "AXButton", "确认删除", { press: true }]]));
  const dlgBtn = findNodes(dlg, { role: "AXButton", label: "确认删除" })[0];
  check("near (a lone dialog, no frames): nothing can be shown to share a row with its button — no near text is claimed; the candidate line gives reading order", nearOf(dlg, dlgBtn) === "" && describeNode(dlg, dlgBtn).endsWith('(after "确认删除 · 确定删除项目「乙」？" in reading order)'), describeNode(dlg, dlgBtn));
});

// Property: addressing a per-row button by a text of its row (find.near)
// lands on that record or on nothing — over random list contents and layouts.
section("find.near fuzz: a row text picks that row's button or nothing", () => {
  let seed = 20261119;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 8) % n;
  const F = (k, x) => ({ f: [x, 100 + 40 * k, 80, 24] });
  const LAYOUTS = {
    rows: (recs) => recs.flatMap((r, k) => [[1, "AXRow", null, {}], [2, "AXStaticText", String(k + 1), { a: [] }], [2, "AXStaticText", r.name, { a: [] }], [2, "AXStaticText", r.id, { a: [] }], [2, "AXButton", "删除", { press: true }]]),
    cells: (recs) => recs.flatMap((r) => [[1, "AXRow", null, {}], [2, "AXCell", null, {}], [3, "AXStaticText", r.id, { a: [] }], [2, "AXCell", null, {}], [3, "AXStaticText", r.name, { a: [] }], [2, "AXCell", null, {}], [3, "AXButton", "编辑", { press: true }], [3, "AXButton", "删除", { press: true }]]),
    cardsWithList: (recs) => recs.flatMap((r) => [[1, "AXGroup", null, {}], [2, "AXStaticText", r.id, { a: [] }], [2, "AXList", null, {}], [3, "AXStaticText", r.name, { a: [] }], [3, "AXButton", "删除", { press: true }]]),
    flatLineTextFirst: (recs) => recs.flatMap((r, k) => [[1, "AXStaticText", r.id, { a: [], ...F(k, 20) }], [1, "AXStaticText", r.name, { a: [], ...F(k, 120) }], [1, "AXButton", "删除", { press: true, ...F(k, 400) }]]),
    flatLineButtonFirst: (recs) => recs.flatMap((r, k) => [[1, "AXButton", "删除", { press: true, ...F(k, 20) }], [1, "AXStaticText", r.id, { a: [], ...F(k, 120) }]]),
  };
  const NAMES = ["张伟", "李娜", "张伟", "王芳"];
  let n = 0;
  let wrong = "";
  let found = 0;
  let asked = 0;
  for (const layout of Object.keys(LAYOUTS)) {
    for (let c = 0; c < 300 && !wrong; c++) {
      const recs = Array.from({ length: 2 + rnd(7) }, () => ({ id: `DD${1000 + n++}`, name: NAMES[rnd(NAMES.length)] }));
      const t = parseTree(payload("sfz", [[0, "AXWindow", "列表", {}], ...LAYOUTS[layout](recs)]));
      const cands = findNodes(t, { role: "AXButton", label: "删除" });
      const owner = (b) => recs[cands.indexOf(b)]; // one 删除 per record, in document order
      for (const r of recs) {
        asked++;
        const hit = cands.filter((b) => recordHas(t, b, undefined, r.id));
        if (hit.length > 1 || (hit.length === 1 && owner(hit[0]) !== r)) wrong = `${layout}: near ${r.id} → ${J(hit.map((b) => owner(b).id))} in ${J(recs.map((x) => x.id))}`;
        if (layout === "cardsWithList") {
          // generic containers, no frames: no evidence — nothing may be selected at all
          if (hit.length) wrong = `${layout}: near ${r.id} selected something without evidence`;
          asked--;
        } else if (hit.length === 1) found++;
        const byName = cands.filter((b) => recordHas(t, b, undefined, r.name));
        if (byName.some((b) => owner(b).name !== r.name)) wrong = `${layout}: near ${r.name} matched a row of another name`;
      }
    }
  }
  check("find.near fuzz: 1500 random lists over five layouts — a unique row text never selects another record's button", wrong === "", wrong);
  check("find.near fuzz: and it resolves wherever there is a table row or a visual line (every id finds its row)", found === asked, `${found}/${asked}`);
});

section("query: a few hits show the record they sit in (round 6 U6-9)", () => {
  const rowOf = (k) => [[2, "AXRow", null, {}], [3, "AXCell", null, {}], [4, "AXStaticText", `DD${String(k).padStart(4, "0")}`, { a: [] }], [3, "AXCell", null, {}], [4, "AXStaticText", `客户${k}`, { a: [] }], [3, "AXCell", null, {}], [4, "AXStaticText", k % 7 === 0 ? "已过期" : "待付款", { a: [] }], [3, "AXCell", null, {}], [4, "AXButton", "编辑", { press: true }], [4, "AXButton", "删除", { press: true }]];
  const t = parseTree(payload("sq6", [[0, "AXWindow", "订单", {}], [1, "AXTable", null, {}], ...Array.from({ length: 400 }, (_, k) => rowOf(k + 1)).flat(), [1, "AXSheet", "提示", {}], [2, "AXStaticText", "登录已过期，请重新登录", { a: [] }], [2, "AXButton", "重新登录", { press: true }]]));
  const q = renderQuery(t, "DD0350");
  check("query DD0350 on a 400-row table: the row's other cells and its buttons come along, other rows do not", q.includes("客户350") && q.includes('AXButton "删除"') && q.includes('AXButton "编辑"') && !q.includes("客户349") && !q.includes("客户351") && q.split("\n").length < 16, q);
  const d = renderQuery(t, "AXSheet");
  check("query for a dialog role: its words and buttons are shown", d.includes("登录已过期") && d.includes("重新登录"), d);
  const many = renderQuery(t, "已过期");
  check("many hits (57): only the hits and their ancestors, as before", !many.includes("each with the rows around it") && !many.includes("客户7\""), many.split("\n")[0]);
  const small = parseTree(payload("sq7", [[0, "AXWindow", "小窗", {}], [1, "AXGroup", "表单", {}], [2, "AXStaticText", "名称", { a: [] }], [2, "AXButton", "保存", { press: true }], [2, "AXButton", "导出", { press: true }]]));
  check("a small window: hits and ancestors only (it is cheap to look at whole)", !renderQuery(small, "保存").includes("导出"), renderQuery(small, "保存"));
});

section("find.near: review round 6 counter-examples (a lone control does not own the page)", () => {
  const T = (rows) => parseTree(payload("sn6", [[0, "AXWindow", "订单", {}], ...rows]));
  const btn = (t, label) => findNodes(t, { role: "AXButton", label });
  const row = (id, name, st, withBtn, label = "取消订单") => [[2, "AXRow", null, {}], [3, "AXCell", null, {}], [4, "AXStaticText", id, { a: [] }], [3, "AXCell", null, {}], [4, "AXStaticText", name, { a: [] }], [3, "AXCell", null, {}], [4, "AXStaticText", st, { a: [] }], ...(withBtn ? [[3, "AXCell", null, {}], [4, "AXButton", label, { press: true }]] : [])];
  // F1: five rows, only DD1003 has the button.
  const sparse = T([[1, "AXTable", null, {}], ...row("DD1001", "王建国", "已发货", false), ...row("DD1002", "李秀英", "已发货", false), ...row("DD1003", "孙丽", "待处理", true), ...row("DD1004", "赵磊", "已发货", false), ...row("DD1005", "周强", "已发货", false)]);
  const only = btn(sparse, "取消订单")[0];
  check("F1 sparse table: the lone 取消订单 is near its own row's id and not near another row's", recordHas(sparse, only, undefined, "DD1003") && !recordHas(sparse, only, undefined, "DD1005") && !recordHas(sparse, only, undefined, "周强"));
  check("F1 …and the candidate text says which row it is in", nearOf(sparse, only).includes("DD1003"), nearOf(sparse, only));
  // Flat rows (no cells): the button's own row has its own words.
  const flatRow = (id, withBtn, k) => { const f = (x) => (k === undefined ? {} : { f: [x, 100 + 40 * k, 80, 24] }); return [[2, "AXGroup", null, {}], [3, "AXStaticText", id, { a: [], ...f(20) }], ...(withBtn ? [[3, "AXButton", "取消", { press: true, ...f(300) }]] : [])]; };
  const li = T([[1, "AXList", null, {}], ...flatRow("DD1001", false, 0), ...flatRow("DD1002", true, 1), ...flatRow("DD1003", false, 2)]);
  check("U6-1 list items (generic groups, with frames): 取消 is near the text on its own line only", recordOf(li, btn(li, "取消")[0]).how === "line" && recordHas(li, btn(li, "取消")[0], undefined, "DD1002") && !recordHas(li, btn(li, "取消")[0], undefined, "DD1003") && !recordHas(li, btn(li, "取消")[0], undefined, "DD1001"));
  const liN = T([[1, "AXList", null, {}], ...flatRow("DD1001", false), ...flatRow("DD1002", true), ...flatRow("DD1003", false)]);
  check("…the same list without frames: a lone control in a generic group proves nothing — near is refused for every text, its own included", ["DD1001", "DD1002", "DD1003"].every((x) => !recordHas(liN, btn(liN, "取消")[0], undefined, x)) && describeNode(liN, btn(liN, "取消")[0]).includes('(after "DD1001 · DD1002" in reading order)'), describeNode(liN, btn(liN, "取消")[0]));
  // Toolbar button + table: near any row text is refused.
  const tb = T([[1, "AXToolbar", null, {}], [2, "AXButton", "删除", { press: true }], [1, "AXTable", null, {}], ...row("DD1001", "王建国", "已发货", false), ...row("DD1005", "周强", "已发货", false)]);
  check("toolbar 删除 + a table: not near any row's text", !recordHas(tb, btn(tb, "删除")[0], undefined, "DD1005") && !recordHas(tb, btn(tb, "删除")[0], undefined, "王建国"));
  // near2-c: toolbar 删除 + an inline 删除 on one row.
  const tb2 = T([[1, "AXToolbar", null, {}], [2, "AXButton", "删除", { press: true }], [1, "AXTable", null, {}], ...row("DD1001", "王建国", "已发货", true, "删除"), ...row("DD1005", "周强", "已发货", false)]);
  const hits = (t, label, txt) => btn(t, label).filter((b) => recordHas(t, b, undefined, txt)).length;
  check("near2-c toolbar + one inline 删除: DD1005 matches none, DD1001 matches the inline one", hits(tb2, "删除", "DD1005") === 0 && hits(tb2, "删除", "DD1001") === 1);
  // Master-detail.
  const md = T([[1, "AXGroup", "列表", {}], [2, "AXGroup", null, {}], [3, "AXStaticText", "DD1001", { a: [] }], [2, "AXGroup", null, {}], [3, "AXStaticText", "DD1005", { a: [] }], [1, "AXGroup", "详情", {}], [2, "AXStaticText", "订单 DD1001", { a: [] }], [2, "AXStaticText", "客户 王建国", { a: [] }], [2, "AXButton", "删除订单", { press: true }]]);
  check("master-detail (no frames): 删除订单 is not near a list item — nor provably near anything; listed by reading order", !recordHas(md, btn(md, "删除订单")[0], undefined, "DD1005") && !recordHas(md, btn(md, "删除订单")[0], undefined, "DD1001") && describeNode(md, btn(md, "删除订单")[0]).includes('(after "订单 DD1001 · 客户 王建国" in reading order)'));
  // near2-g: single-row table, header text.
  const hdr = T([[1, "AXTable", null, {}], [2, "AXRow", null, {}], [3, "AXCell", null, {}], [4, "AXStaticText", "订单号", { a: [] }], [3, "AXCell", null, {}], [4, "AXStaticText", "客户", { a: [] }], ...row("DD1001", "王建国", "待处理", true)]);
  check("near2-g a header cell's text is not near the only row's button", !recordHas(hdr, btn(hdr, "取消订单")[0], undefined, "订单号") && recordHas(hdr, btn(hdr, "取消订单")[0], undefined, "DD1001"));
  // A toast elsewhere in the window that repeats a deleted record's name.
  const toast = T([[1, "AXList", null, {}], [2, "AXGroup", null, {}], [3, "AXStaticText", "甲任务", { a: [], f: [20, 100, 80, 24] }], [3, "AXButton", "删除", { press: true, f: [300, 100, 60, 24] }], [1, "AXStaticText", "乙任务 已移入回收站", { a: [], f: [20, 400, 200, 24] }]]);
  check("a toast naming another record is not near the remaining row's button", !recordHas(toast, btn(toast, "删除")[0], undefined, "乙任务") && recordHas(toast, btn(toast, "删除")[0], undefined, "甲任务"));
  // The address bar is not near anything in the page.
  const url = T([[1, "AXToolbar", null, {}], [2, "AXTextField", "地址和搜索栏", { v: "shop.example/orders?highlight=DD1005", press: true }], [1, "AXWebArea", "订单", {}], [2, "AXTable", null, {}], ...row("DD1003", "孙丽", "待处理", true).map((r) => [r[0] + 1, ...r.slice(1)])]);
  check("a URL that mentions an id is not near the page's button", !recordHas(url, btn(url, "取消订单")[0], undefined, "DD1005"));
  // Positive cases that must keep working.
  const card = T([[1, "AXGroup", null, {}], [2, "AXGroup", null, {}], [3, "AXStaticText", "项目甲", { a: [] }], [2, "AXGroup", null, {}], [3, "AXStaticText", "一段描述", { a: [] }], [2, "AXGroup", null, {}], [3, "AXButton", "编辑", { press: true }], [3, "AXButton", "删除", { press: true }]]);
  check("a single card (header / body / footer with buttons, no frames): nothing repeats and nothing shares a line — refused, not guessed", !recordHas(card, btn(card, "删除")[0], undefined, "项目甲") && recordOf(card, btn(card, "删除")[0]).how === "none");
  const detail = T([[1, "AXStaticText", "订单 DD1005", { a: [] }], [1, "AXStaticText", "客户 周强", { a: [] }], [1, "AXGroup", null, {}], [2, "AXButton", "删除订单", { press: true }]]);
  check("a detail page of plain lines + one button (no frames): refused, not guessed", !recordHas(detail, btn(detail, "删除订单")[0], undefined, "DD1005"));
  const two = T([[1, "AXTable", null, {}], ...row("DD1001", "王建国", "待处理", true), ...row("DD1002", "李秀英", "待处理", true)]);
  check("a two-row table: each button near its own row only", hits(two, "取消订单", "DD1001") === 1 && hits(two, "取消订单", "DD1002") === 1 && recordHas(two, btn(two, "取消订单")[1], undefined, "DD1002") && !recordHas(two, btn(two, "取消订单")[1], undefined, "DD1001"));
  // status + action in one cell: accepted because the row repeats.
  const sa = (id, st) => [[2, "AXRow", null, {}], [3, "AXCell", null, {}], [4, "AXStaticText", id, { a: [] }], [3, "AXCell", null, {}], [4, "AXStaticText", st, { a: [] }], [4, "AXButton", "去支付", { press: true }]];
  const sat = T([[1, "AXTable", null, {}], ...sa("DD1001", "待付款"), ...sa("DD1002", "待付款")]);
  const sa1 = T([[1, "AXTable", null, {}], ...sa("DD1001", "待付款")]);
  check("status + button in one cell of an AXRow: near the row's id when the table repeats the button in that column; a single such row cannot be told from a grid of records", recordHas(sat, btn(sat, "去支付")[1], undefined, "DD1002") && !recordHas(sat, btn(sat, "去支付")[1], undefined, "DD1001") && !recordHas(sa1, btn(sa1, "去支付")[0], undefined, "DD1001"));
  // W2: two sections; in the first only DD1002 has 取消, the second has one on every row.
  const sec = (name, rows2) => [[1, "AXGroup", name, {}], ...rows2.flatMap(([id, st, b]) => [[2, "AXRow", null, {}], [3, "AXStaticText", id, { a: [] }], [3, "AXStaticText", st, { a: [] }], ...(b ? [[3, "AXButton", "取消", { press: true }]] : [])])];
  const w2 = T([...sec("待发货", [["DD1001", "已打包", false], ["DD1002", "未打包", true]]), ...sec("待付款", [["DD2001", "张伟", true], ["DD2002", "李娜", true]])]);
  check("W2 sections: the lone 取消 of a section is not near another row of that section", !recordHas(w2, btn(w2, "取消")[0], undefined, "DD1001") && recordHas(w2, btn(w2, "取消")[0], undefined, "DD1002") && recordHas(w2, btn(w2, "取消")[2], undefined, "DD2002"));
  // …and neither when both sections happen to have their only button on the second row (stacked blocks of one kind).
  const w3 = T([...sec("待发货", [["DD1001", "已打包", false], ["DD1002", "未打包", true]]), ...sec("待付款", [["DD2001", "张伟", false], ["DD2002", "李娜", true]])]);
  check("W2 variant (same shape in both sections): still not near the other row", !recordHas(w3, btn(w3, "取消")[0], undefined, "DD1001") && recordHas(w3, btn(w3, "取消")[0], undefined, "DD1002"));
  // Cards: title as a direct text of the card, words beside the button — accepted when cards repeat.
  const cardOf = (id, st) => [[1, "AXGroup", null, {}], [2, "AXStaticText", id, { a: [] }], [2, "AXGroup", null, {}], [3, "AXStaticText", st, { a: [] }], [3, "AXButton", "删除", { press: true }]];
  const cs = T([...cardOf("项目甲", "进行中"), ...cardOf("项目乙", "已暂停")]);
  check("cards (title + a footer with status and button), repeating, no frames: a repeating container is not evidence (two sections look the same) — refused, listed by reading order", !recordHas(cs, btn(cs, "删除")[1], undefined, "项目乙") && !recordHas(cs, btn(cs, "删除")[1], undefined, "项目甲") && describeNode(cs, btn(cs, "删除")[1]).includes('(after "项目乙 · 已暂停" in reading order)'), describeNode(cs, btn(cs, "删除")[1]));
  // Side-by-side blocks of one kind (a div-soup table row): accepted with frames, refused without.
  const dv = (k, withF) => { const f = (x) => (withF ? { f: [x, 100 + 40 * k, 120, 24] } : {}); return [[1, "AXGroup", null, {}], [2, "AXGroup", null, {}], [3, "AXStaticText", `DD30${k}`, { a: [], ...f(20) }], [2, "AXGroup", null, {}], [3, "AXStaticText", "待付款", { a: [], ...f(200) }], [3, "AXButton", "去支付", { press: true, ...f(330) }]]; };
  const dvF = T([...dv(1, true), ...dv(2, true)]);
  const dvN = T([...dv(1, false), ...dv(2, false)]);
  check("div rows (id block | status+button block): near the id when the two blocks are side by side; cannot tell without frames", recordHas(dvF, btn(dvF, "去支付")[1], undefined, "DD302") && !recordHas(dvF, btn(dvF, "去支付")[1], undefined, "DD301") && !recordHas(dvN, btn(dvN, "去支付")[1], undefined, "DD302"));
  // F4: a right-hand column on the same visual line as row 2 of a flat list.
  const FR = (k, x) => ({ f: [x, 100 + 40 * k, 80, 24] });
  const flat = T([...[0, 1, 2].flatMap((k) => [[1, "AXStaticText", `DD100${k + 1}`, { a: [], ...FR(k, 20) }], [1, "AXButton", "删除", { press: true, ...FR(k, 400) }]]), [1, "AXStaticText", "DD1005 已发货", { a: [], ...FR(1, 700) }]]);
  const fb = btn(flat, "删除");
  check("F4 flat page: a text of another column on the same line is not in the row", fb.every((b) => !recordHas(flat, b, undefined, "DD1005")) && recordHas(flat, fb[1], undefined, "DD1002") && recordHas(flat, fb[2], undefined, "DD1003"));
});

section("find.near: review round 7 (positive evidence only: line, row, repeating unit)", () => {
  const T = (rows) => parseTree(payload("sn7", [[0, "AXWindow", "订单 DD1005 - 商城后台", {}], ...rows]));
  const btn = (t, label) => findNodes(t, { role: "AXButton", label });
  const F = (k, x, w = 80) => ({ f: [x, 100 + 40 * k, w, 24] });
  const St = (d, t, o = {}) => [d, "AXStaticText", t, { a: [], ...o }];
  const B = (d, t, o = {}) => [d, "AXButton", t, { press: true, ...o }];
  const hit = (t, list, txt) => list.filter((b) => recordHas(t, b, (m) => list.includes(m), txt)).map((b) => list.indexOf(b));
  // R7-1 flat page, five rows, only DD1003 has the button.
  const n1 = T([[1, "AXWebArea", "订单", {}], ...[1, 2, 3, 4, 5].flatMap((k) => [St(2, `DD100${k}`, F(k, 20)), ...(k === 3 ? [B(2, "取消订单", F(k, 400))] : [])])]);
  check("R7-1 flat page: a lone button is near the text on its own line and nothing else", eq(["DD1003", "DD1005", "DD1001", "DD1002"].map((x) => recordHas(n1, btn(n1, "取消订单")[0], undefined, x)), [true, false, false, false]));
  // R7-1b toolbar button + a list of leaf rows; R7-3 the window title says DD1005.
  const n1b = T([[1, "AXToolbar", null, {}], B(2, "删除", F(0, 20)), [1, "AXList", null, {}], ...[1, 2, 3].map((k) => St(2, `DD100${k}`, F(k, 20)))]);
  check("R7-1b a toolbar button is not near any row of the list below it", ["DD1001", "DD1002", "DD1003"].every((x) => !recordHas(n1b, btn(n1b, "删除")[0], undefined, x)));
  const n3 = T([[1, "AXWebArea", "订单 DD1005 - 商城后台", {}], [2, "AXTable", null, {}], [3, "AXRow", null, {}], St(4, "DD1003"), St(4, "待处理"), B(4, "取消订单")]);
  check("R7-3 a window or page title is not a row: near a text that only the title says is refused", !recordHas(n3, btn(n3, "取消订单")[0], undefined, "DD1005") && recordHas(n3, btn(n3, "取消订单")[0], undefined, "DD1003"));
  // R7-2 a grid: each cell of the row is a record of its own.
  const cellOf = (name, st, b) => [[3, "AXCell", null, {}], St(4, name), St(4, st), ...(b ? [B(4, "预约")] : [])];
  const grid = T([[1, "AXTable", null, {}], [2, "AXRow", null, {}], ...cellOf("瑜伽", "余 3", true), ...cellOf("普拉提", "已满", false), [2, "AXRow", null, {}], ...cellOf("搏击", "已满", false), ...cellOf("动感单车", "余 1", true)]);
  check("R7-2 schedule grid: 预约 is near its own cell's words, not near the neighbouring cell's", recordHas(grid, btn(grid, "预约")[0], undefined, "瑜伽") === false && !recordHas(grid, btn(grid, "预约")[0], undefined, "普拉提"), J(recordOf(grid, btn(grid, "预约")[0]).how));
  // R7-4 several controls of the find on one row: all of them match, so the caller reports ambiguity.
  const n5 = T([[1, "AXWebArea", "订单", {}], St(2, "DD1005", F(1, 20)), B(2, "删除", F(1, 300)), B(2, "编辑", F(1, 380)), St(2, "DD1006", F(2, 20)), B(2, "删除", F(2, 300)), B(2, "编辑", F(2, 380))]);
  const all = findNodes(n5, { role: "AXButton" });
  check("R7-4 find by role only: both buttons of the row are near its text (ambiguity, not the first one)", eq(hit(n5, all, "DD1005"), [0, 1]) && eq(hit(n5, all, "DD1006"), [2, 3]));
  // R7-5 whole words across scripts and number punctuation.
  const w = T([[1, "AXTable", null, {}], ...[["A", "¥1,200"], ["DD100-2", "12:30"], ["张伟明", "2026-11-19"], ["订单DD1005", "v1.2"]].flatMap(([a, b]) => [[2, "AXRow", null, {}], St(3, a), St(3, b), B(3, "删除")])]);
  const rowsHit = (txt) => hit(w, btn(w, "删除"), txt);
  check("R7-5 whole words: 200 ∉ ¥1,200 · DD100 ∉ DD100-2 · 张伟 ∉ 张伟明 · 12 ∉ 12:30 · 2026 ∉ 2026-11-19", eq(["200", "DD100", "张伟", "12", "2026", "1.2"].map(rowsHit), [[], [], [], [], [], []]), J(["200", "DD100", "张伟", "12", "2026", "1.2"].map(rowsHit)));
  check("R7-5 …while whole tokens match: ¥1,200 · 1,200 · DD100-2 · 张伟明 · DD1005 after CJK · full-width digits", eq(["¥1,200", "1,200", "DD100-2", "张伟明", "DD1005", "ＤＤ１００５", "订单"].map(rowsHit), [[0], [0], [1], [2], [3], [3], [3]]), J(["¥1,200", "1,200", "DD100-2", "张伟明", "DD1005", "ＤＤ１００５", "订单"].map(rowsHit)));
  // Line: wrappers, the layout convention, look-alikes that share a line.
  const wrapped = T([[1, "AXWebArea", "订单", {}], ...[1, 2].flatMap((k) => [[2, "AXGroup", null, {}], St(3, `DD20${k}`, F(k, 20)), [3, "AXGroup", null, {}], B(4, "删除", F(k, 400))])]);
  check("line: the button sits in a wrapper of its own — the text beside it on the line still counts", eq(hit(wrapped, btn(wrapped, "删除"), "DD202"), [1]) && eq(hit(wrapped, btn(wrapped, "删除"), "DD201"), [0]));
  const n8 = T([[1, "AXWebArea", "订单", {}], ...[1, 2, 3].flatMap((k) => [St(2, `DD30${k}`, F(k, 20)), B(2, "删除", F(k, 400))]), St(2, "DD3009 已发货", F(3, 700, 160))]);
  check("N8 text-first page: a text of another column right after the last button, on its line, is not its row", eq(hit(n8, btn(n8, "删除"), "DD3009"), []) && eq(hit(n8, btn(n8, "删除"), "DD303"), [2]));
  const bf = T([[1, "AXWebArea", "订单", {}], ...[1, 2, 3].flatMap((k) => [B(2, "删除", F(k, 20)), St(2, `DD40${k}`, F(k, 120))])]);
  check("button-first page: each button is near the text after it", eq(hit(bf, btn(bf, "删除"), "DD402"), [1]));
  const two = T([[1, "AXWebArea", "订单", {}], St(2, "DD501", F(1, 20)), B(2, "删除", F(1, 120)), St(2, "DD502", F(1, 320)), B(2, "删除", F(1, 420)), St(2, "DD503", F(2, 20)), B(2, "删除", F(2, 120)), St(2, "DD504", F(2, 320)), B(2, "删除", F(2, 420))]);
  check("R9-4 two look-alikes on one visual line: the text between them counts for both (the caller reports ambiguity); the outer text is the first one's alone", eq(["DD501", "DD502", "DD503", "DD504"].map((x) => hit(two, btn(two, "删除"), x)), [[0], [0, 1], [2], [2, 3]]));
  const tall = T([[1, "AXWebArea", "订单", {}], [2, "AXGroup", "全部订单", { f: [0, 80, 900, 600] }], St(3, "DD601", F(1, 20)), St(3, "一段说明，折成三行", { f: [120, 132, 200, 60] }), B(3, "删除", F(1, 400)), St(3, "DD602", F(4, 20)), B(3, "删除", F(4, 400))]);
  check("line: a three-line cell beside the button does not end the line, and is not itself on it; a container many lines tall is not a row", eq(hit(tall, btn(tall, "删除"), "DD601"), [0]) && eq(hit(tall, btn(tall, "删除"), "全部订单"), []) && eq(hit(tall, btn(tall, "删除"), "一段说明，折成三行"), []));
  const two2 = T([[1, "AXWebArea", "订单", {}], St(2, "DD611", F(1, 20)), St(2, "折成两行的说明", { f: [120, 130, 200, 44] }), B(2, "删除", F(1, 400)), St(2, "DD612", F(4, 20)), B(2, "删除", F(4, 400))]);
  check("line: a two-line cell is on the line", eq(hit(two2, btn(two2, "删除"), "折成两行的说明"), [0]) && eq(hit(two2, btn(two2, "删除"), "DD611"), [0]));
  // R9-6 side-by-side cards: the label of the group around a whole card, and a tall first paragraph of the next card, are not on a button's line.
  const cardL = (x, id, name, lab) => [[2, "AXGroup", lab ? `${id} ${name}` : null, { f: [x, 100, 300, 90] }], St(3, id, { f: [x + 10, 104, 100, 20] }), St(3, name, { f: [x + 10, 128, 100, 20] }), B(3, "删除", { f: [x + 10, 160, 60, 24] })];
  const sbs = T([[1, "AXWebArea", "订单", {}], ...cardL(20, "DD1003", "张伟", true), ...cardL(340, "DD1005", "李四", true)]);
  check("R9-6 two labelled cards side by side, title above the button: neither 删除 is near DD1005 (the group's label is not a text on the line)", eq(hit(sbs, btn(sbs, "删除"), "DD1005"), []) && eq(hit(sbs, btn(sbs, "删除"), "DD1003"), []));
  const card2 = (x, title, th, by) => [[2, "AXGroup", null, { f: [x, 100, 300, 120] }], St(3, title, { f: [x + 10, 100, 280, th] }), B(3, "删除", { f: [x + 10, by, 60, 24] })];
  const notes = T([[1, "AXWebArea", "笔记", {}], ...card2(20, "买菜", 24, 130), ...card2(340, "周五前把 DD1005 的发票寄给李四，别忘了附回执", 72, 180)]);
  check("R9-6 the left card's 删除 level with the middle of the right card's three-line text: not near it", eq(hit(notes, btn(notes, "删除"), "DD1005"), []));
  // A long text is printed cut short with "…"; sent back like that it means "starts with".
  const longT = "这是一段很长很长的订单备注文字，超过了回执里一段文字能印出的二十八个字的上限";
  const lg = T([[1, "AXTable", null, {}], [2, "AXRow", null, {}], St(3, longT), B(3, "删除"), [2, "AXRow", null, {}], St(3, "另一条备注"), B(3, "删除")]);
  const printed = nearOf(lg, btn(lg, "删除")[0]);
  check('near: a long text is printed with "…" and that printed form selects the same control; the cut text without "…" does not', printed.endsWith("…") && eq(hit(lg, btn(lg, "删除"), printed), [0]) && eq(hit(lg, btn(lg, "删除"), printed.slice(0, -1)), []) && eq(hit(lg, btn(lg, "删除"), "这是…"), []), printed);
  // Round 8: what was removed because it guessed.
  const sh = T([St(1, "正文 DD900"), B(1, "确定"), [1, "AXSheet", "提示", {}], [2, "AXTable", null, {}], ...["张三的 iPhone", "王五的 Mac"].flatMap((d, k) => [[3, "AXRow", null, {}], St(4, d), ...(k === 0 ? [B(4, "移除")] : [])]), [2, "AXGroup", null, {}], B(3, "取消"), B(3, "确定")]);
  check("R8-1 a sheet is not evidence: 移除 in a sheet's table is near its own row only; the sheet's 确定 is near nothing", recordHas(sh, btn(sh, "移除")[0], undefined, "张三的 iPhone") && !recordHas(sh, btn(sh, "移除")[0], undefined, "王五的 Mac") && eq(hit(sh, btn(sh, "确定"), "提示"), []));
  const sect = (title, items, k0) => [[1, "AXGroup", null, {}], St(2, title, F(k0, 20)), B(2, "删除", F(k0, 400)), ...items.map((it, i) => St(2, it, F(k0 + 1 + i, 20)))];
  const groups = T([...sect("工作", ["周报模板", "报销流程"], 0), ...sect("生活", ["菜谱", "账单"], 4)]);
  check("R8-2 a container that repeats is not evidence: a group's 删除 is near the title on its line, not near the items below", eq(hit(groups, btn(groups, "删除"), "报销流程"), []) && eq(hit(groups, btn(groups, "删除"), "工作"), [0]) && eq(hit(groups, btn(groups, "删除"), "生活"), [1]));
  // R8-3 → R9-4: several look-alikes on one line. No shape of the line says which way it reads; a text between two of them is ambiguous.
  const cb = (d, o = {}) => [d, "AXCheckBox", null, { press: true, ...o }];
  const mixed = T([[1, "AXWebArea", "任务", {}], St(2, "显示已完成", F(0, 20)), cb(2, F(0, 120, 30)), St(2, "只看我的", F(0, 200)), cb(2, F(0, 300, 30)), ...[1, 2, 3, 4].flatMap((k) => [cb(2, F(k, 20, 30)), St(2, `任务${k}号`, F(k, 80))])]);
  const boxes = findNodes(mixed, { role: "AXCheckBox" });
  check("R9-4 'T P T P' on a page of 'P T' rows: the text between the two switches matches both; the page's convention is not applied to it; lone rows still work", eq(hit(mixed, boxes, "只看我的"), [0, 1]) && eq(hit(mixed, boxes, "显示已完成"), [0]) && eq(hit(mixed, boxes, "任务3号"), [4]));
  const prof = T([[1, "AXWebArea", "资料", {}], ...[1, 2, 3].flatMap((k) => [St(2, `条目${k}`, F(k, 20)), B(2, "编辑", F(k, 400))]), B(2, "编辑", F(5, 20)), St(2, "昵称", F(5, 100)), B(2, "编辑", F(5, 200)), St(2, "签名", F(5, 280))]);
  check("R9-4 'P T P T' on a page of 'T P' rows: 昵称 between the two 编辑 matches both, 签名 at the end only the last", eq(hit(prof, btn(prof, "编辑"), "昵称"), [3, 4]) && eq(hit(prof, btn(prof, "编辑"), "签名"), [4]));
  const P9 = (spec) => { let x = 20; return T([[1, "AXWebArea", "资料", {}], ...spec.split(" ").map((w9) => { const xx = x; x += 110; return w9 === "P" ? B(2, "编辑", { f: [xx, 100, 80, 24] }) : St(2, w9, { f: [xx, 100, 80, 24] }); })]); };
  const shape = (spec, txt) => { const t9 = P9(spec); return hit(t9, btn(t9, "编辑"), txt); };
  check("R9-4 uneven lines: '昵称 P 待审核 签名 P' · 'P 昵称 已认证 P 签名' · 'T P T T P T P' — every text between two look-alikes is ambiguous", eq([shape("昵称 P 待审核 签名 P", "待审核"), shape("昵称 P 待审核 签名 P", "签名"), shape("昵称 P 待审核 签名 P", "昵称"), shape("P 昵称 已认证 P 签名", "已认证"), shape("昵称 P 签名 备注 P 头像 P", "备注"), shape("昵称 P 签名 P 头像 P", "签名")], [[0, 1], [0, 1], [0], [0, 1], [0, 1], [0, 1]]));
  const ptp = T([[1, "AXWebArea", "x", {}], B(2, "删除", F(1, 20)), St(2, "中间的字", F(1, 100)), B(2, "删除", F(1, 300))]);
  check("a text between two look-alikes on a line that does not say which way it reads: both match (the caller reports ambiguity)", eq(hit(ptp, btn(ptp, "删除"), "中间的字"), [0, 1]));
  // R8-4 what the user typed into a field is not a record's text; no ranking of "exact" over "contains".
  const srch = T([[1, "AXWebArea", "订单", {}], [2, "AXTextField", "搜索订单", { v: "DD1005", press: true, ...F(0, 20, 200) }], B(2, "搜索", F(0, 240)), B(2, "删除", F(0, 340)), ...[1, 2].flatMap((k) => [St(2, k === 1 ? "订单 DD1005" : "订单 DD1006", F(k, 20, 200)), B(2, "删除", F(k, 340))])]);
  check("R8-4 a search box holding DD1005 does not vouch for the toolbar's 删除: only the result row matches", eq(hit(srch, btn(srch, "删除"), "DD1005"), [1]) && eq(hit(srch, btn(srch, "删除"), "搜索订单"), [0]));
  check('near "a · b" (the way a reply joins the texts of a row) asks for each part', recordHas(w, btn(w, "删除")[1], undefined, "DD100-2 · 12:30") && !recordHas(w, btn(w, "删除")[1], undefined, "DD100-2 · 2026-11-19"));
  const inText = (hay, want) => { const t9 = T([[1, "AXTable", null, {}], [2, "AXRow", null, {}], St(3, hay), B(3, "删除")]); return recordHas(t9, btn(t9, "删除")[0], undefined, want); };
  check("R9 ids joined by - . / _ # are one token: DD100 ∉ DD100-A · DD100.pdf · DD100/B; v1 ∉ v1.x; 100 ∉ A-100 · 100-A; 5 ∉ no.5", eq([["DD100-A", "DD100"], ["DD100.pdf", "DD100"], ["DD100/B", "DD100"], ["v1.x", "v1"], ["A-100", "100"], ["100-A", "100"], ["no.5", "5"]].map(([h9, w9]) => inText(h9, w9)), [false, false, false, false, false, false, false]));
  check("R9 …while a space, a bracket or another script still ends a token: DD100 ∈ 'DD100 (2)' · 'DD100甲' · '订单DD100已发货'; 3 ∈ '第 3 页'; whole ids match themselves", eq([["DD100 (2)", "DD100"], ["DD100甲", "DD100"], ["订单DD100已发货", "DD100"], ["第 3 页", "3"], ["DD100-A", "DD100-A"], ["DD100.pdf", "DD100.pdf"]].map(([h9, w9]) => inText(h9, w9)), [true, true, true, true, true, true]));
  check("R7-5 more separators: DD100 ∉ DD100_2, DD100#2", eq(hit(T([[1, "AXTable", null, {}], ...["DD100_2", "DD100#2"].flatMap((a) => [[2, "AXRow", null, {}], St(3, a), B(3, "删除")])]), btn(T([[1, "AXTable", null, {}], ...["DD100_2", "DD100#2"].flatMap((a) => [[2, "AXRow", null, {}], St(3, a), B(3, "删除")])]), "删除"), "DD100"), []));
  // R8-7 a link with its own words inside is one control.
  const lk = T([[1, "AXWebArea", "x", {}], [2, "AXLink", "查看详情", { press: true }], St(3, "查看详情"), St(2, "别的")]);
  const rowLink = T([[1, "AXWebArea", "x", {}], [2, "AXLink", "DD1005 空气炸锅 删除", { press: true }], St(3, "DD1005 空气炸锅"), B(3, "删除"), [2, "AXLink", "DD1006 电饭煲 删除", { press: true }], St(3, "DD1006 电饭煲"), B(3, "删除")]);
  check("R9-3 a 删除 button inside a row that is itself one link is its own control: find by label returns the links and the buttons (exact-label narrowing then keeps the buttons); the row's inert text is the link", eq(findNodes(rowLink, { label: "删除" }).map((n) => n.role), ["AXLink", "AXButton", "AXLink", "AXButton"]) && findNodes(rowLink, { label: "DD1005" }).map((n) => n.role).join() === "AXLink" && findNodes(rowLink, { label: "空气炸锅" }).map((n) => n.role).join() === "AXLink");
  const nest = T([[1, "AXWebArea", "x", {}], [2, "AXCell", "保存", { press: true }], B(3, "保存"), [2, "AXCell", "姓名", { press: true }], [3, "AXTextField", "姓名", { v: "", a: ["AXConfirm"] }]]);
  check("R9-3 a button that only repeats its pressable parent's name is that control (one candidate); a field inside a pressable cell of the same name stays a candidate (a value goes into the field)", findNodes(nest, { label: "保存" }).map((n) => n.role).join() === "AXCell" && findNodes(nest, { label: "姓名" }).map((n) => n.role).join() === "AXCell,AXTextField");
  check("R8-7 find by label: an AXLink and the AXStaticText inside it are one candidate; asking for the text by role still finds it", findNodes(lk, { label: "查看详情" }).length === 1 && findNodes(lk, { label: "查看详情" })[0].role === "AXLink" && findNodes(lk, { role: "AXStaticText", label: "查看详情" }).length === 1);
  // sharedBy: a text naming a card that holds several of them lists exactly those.
  const cardOf = (id, items) => [[1, "AXGroup", null, {}], St(2, `订单 ${id}`), [2, "AXList", null, {}], ...items.flatMap((it) => [[3, "AXGroup", null, {}], St(4, it), B(4, "退款")])];
  const cards = T([...cardOf("DD701", ["甲", "乙"]), ...cardOf("DD702", ["丙", "丁"])]);
  const refunds = btn(cards, "退款");
  check("sharedBy: the look-alikes of the card a text names (for listing only); nothing when the text names everything; without rows or frames an item's own text is not evidence either", eq(sharedBy(cards, refunds, "DD702").map((b) => refunds.indexOf(b)), [2, 3]) && eq(sharedBy(cards, refunds, "商城后台"), []) && eq(hit(cards, refunds, "丙"), []));
});

// describeNode -----------------------------------------------------------------------
section("describeNode", () => {
  const t = parseTree(payload("s30", table(["甲任务", "丙任务"])));
  const txt = findNodes(t, { label: "丙任务" })[0];
  check("describe: pressable → '<sid>:<idx> Role \"label\" near \"…\"'", describeNode(t, N(t, 4)) === 's30:4 AXButton "删除" near "甲任务"', describeNode(t, N(t, 4)));
  check("describe: not pressable → ' (not pressable)' before near", describeNode(t, txt).startsWith('s30:6 AXStaticText "丙任务" (not pressable)'), describeNode(t, txt));
  check("describe: the window itself has no near part", describeNode(main, N(main, 0)) === 's00000101:0 AXWindow "记账本" (not pressable)', describeNode(main, N(main, 0)));
  check("describe: an unlabeled icon shows its tooltip", describeNode(main, main.nodes.find((n) => n.help === "保存当前记录")).includes('AXButton help="保存当前记录"'), describeNode(main, main.nodes.find((n) => n.help === "保存当前记录")));
});

// o.shown: every printed row number, nothing else ---------------------------------------
section("o.shown", () => {
  const printed = (text) => new Set([...String(text).matchAll(/^ *(?:[-+~] )?(?:- )?[[(](\d+)[\])] AX/gm)].map((m) => Number(m[1])));
  const same = (s, text) => eq([...s].sort((a, b) => a - b), [...printed(text)].sort((a, b) => a - b));
  let S = new Set();
  const full = renderTree(main, { shown: S });
  check("shown/renderTree: Set = printed rows; menu rows absent", same(S, full) && eq([...S].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 11, 12]), J([...S]));
  const rows = [[0, "AXWindow", "长列表", {}], ...Array.from({ length: 50 }, (_, i) => [1, "AXButton", `按钮${String(i + 1).padStart(2, "0")}`, { press: true }])];
  const long = parseTree(payload("s31", rows));
  S = new Set();
  const cutTxt = renderTree(long, { maxChars: 300, shown: S });
  check("shown/maxChars: rows cut by maxChars are not in the Set", same(S, cutTxt), `Set has ${J([...S].filter((i) => !printed(cutTxt).has(i)))} not printed`);
  let U = {};
  renderTree(long, { maxChars: 300, used: U });
  check("used/renderTree: cut by maxChars → used.cut === true, no coords → no used.frames", U.cut === true && U.frames === undefined, J(U));
  U = {};
  renderTree(main, { used: U });
  check("used/renderTree: nothing cut → used.cut === false; bare button coords → used.frames", U.cut === false && U.frames === true, J(U));
  {
    // The first row dropped by maxChars is a bare (coordinate-carrying) button.
    const r3 = parseTree(payload("s31b", [[0, "AXWindow", "w", {}], [1, "AXButton", "按钮一", { press: true }], [1, "AXButton", null, { press: true, f: [1, 1, 10, 10] }], [1, "AXButton", "按钮三", { press: true }]]));
    const ls = renderRows(r3).lines;
    const U3 = {};
    const S3 = new Set();
    const t3 = renderTree(r3, { maxChars: ls[0].length + ls[1].length + 5, used: U3, shown: S3 });
    check("used/renderTree: cut row's coords don't set used.frames / units line", !t3.includes("@6,6") && U3.frames === undefined && !t3.includes("(@x,y"), J(t3));
    check("shown/maxChars: first cut row not in the Set (minimal case)", eq([...S3], [0, 1]), J([...S3]));
  }
  S = new Set();
  const qt = renderQuery(main, "午饭", { shown: S });
  check("shown/renderQuery: hit + ancestors only", same(S, qt) && eq([...S].sort((a, b) => a - b), [0, 3, 4]), J([...S]));
  S = new Set();
  const zt = renderQuery(main, "不存在的词", { shown: S });
  check("shown/renderQuery 0 hits, whole window: Set = printed rows", same(S, zt) && S.size === 9, J([...S]));
  const big = parseTree(payload("s32", [[0, "AXWindow", "大表", {}], ...Array.from({ length: 80 }, (_, i) => [1, "AXButton", `按钮${i}`, { press: true }]), [1, "AXButton", "导出数据", { press: true }]]));
  S = new Set();
  const zb = renderQuery(big, "导出报表", { shown: S });
  check("shown/renderQuery 0 hits, big window: the 1500-char probe adds nothing", eq([...S], [81]) && same(S, zb), J([...S].slice(0, 5)));
  const base = [[0, "AXWindow", "差异", {}], ...Array.from({ length: 60 }, (_, i) => [1, "AXButton", `旧${i}`, { press: true }])];
  const prev = parseTree(payload("s33", base));
  S = new Set();
  const dv = renderDiff(prev, parseTree(payload("s34", base.map((r) => (r[2] === "旧5" ? [1, "AXTextField", "旧5x", { v: "新值" }] : r)))), { shown: S });
  check("shown/renderDiff: printed '+' row recorded", dv.text !== null && same(S, dv.text) && eq([...S], [6]), J([...S]));
  S = new Set();
  const added = [...base, ...Array.from({ length: 25 }, (_, i) => [1, "AXButton", `新增${i}`, { press: true }])];
  const DU = {};
  const dc = renderDiff(prev, parseTree(payload("s35", added)), { shown: S, maxChars: 200, used: DU });
  const kept = dc.text.split("\n").slice(1, -1).length;
  check("diff/clip: tail says how many change lines were dropped", dc.text !== null && dc.text.endsWith(`…[+${25 - kept} more change lines — window_state diff:true lists them all]`) && kept > 0 && kept < 25, dc.text?.split("\n").pop());
  check("diff/clip: used.cut === true when clipped", DU.cut === true, J(DU));
  const DU2 = {};
  renderDiff(prev, parseTree(payload("s36", added.slice(0, 63))), { used: DU2 });
  check("diff/clip: used.cut not set when nothing was clipped", DU2.cut === undefined, J(DU2));
  check("shown/renderDiff: rows clipped by maxChars are not in the Set", same(S, dc.text), `Set ${S.size}, printed ${printed(dc.text).size}`);
});

section("addressOf", () => {
  const mk = (url) =>
    parseTree(payload("s42a", [[0, "AXWindow", "页", {}], [1, "AXToolbar", "栏", { ix: false }], [2, "AXTextField", "地址和搜索栏", { v: url, press: true }], [1, "AXWebArea", "页", {}], [2, "AXTextField", "搜索", { v: "https://not.the/address" }]]));
  check("address: URL in the toolbar text field", addressOf(mk("https://example.test/a?id=1")) === "https://example.test/a?id=1", String(addressOf(mk("https://example.test/a?id=1"))));
  check("address: bare host form", addressOf(mk("example.test/path")) === "example.test/path", String(addressOf(mk("example.test/path"))));
  check("address: a search phrase is not an address", addressOf(mk("今天 天气")) === undefined);
  check("address: fields inside the page do not count", addressOf(parseTree(payload("s42b", [[0, "AXWindow", "页", {}], [1, "AXWebArea", "页", {}], [2, "AXTextField", "网址", { v: "https://x.test/" }]]))) === undefined);
});

section("parse/unclosed quote (a description with a newline)", () => {
  const sc = payload("s43a", [[0, "AXWindow", "窗", {}], [1, "AXButton", "甲", { press: true }], [1, "AXButton", "乙", { press: true }], [1, "AXStaticText", "尾", { ix: false }]]);
  const before = sc.tree_markdown;
  sc.tree_markdown = before.replace(/(- \[1\] AXButton "甲")/, "$1 (第一行\n第二行)");
  check("parse/unclosed-quote: fixture really changed", sc.tree_markdown !== before);
  const t = parseTree(sc);
  check("parse/unclosed-quote: following rows survive in order", eq(idxOrder(t), [0, 1, 2]) && t.nodes.length === 4 && t.nodes[3].idx === null, J(t.nodes.map((n) => [n.idx, n.role])));
});

// 22. hitTest (x, y in window points) -------------------------------------------
section("22. hitTest", () => {
  const rows = [
    [0, "AXWindow", "商店", { a: ["AXRaise"] }],
    [1, "AXGroup", "卡片", { press: true, f: [100, 100, 400, 300] }],
    [2, "AXStaticText", "卡片标题", { a: [], f: [120, 120, 200, 30] }],
    [2, "AXButton", "购买", { press: true, f: [120, 200, 100, 40] }],
    [3, "AXImage", null, { a: [], f: [130, 205, 20, 20] }],
    [2, "AXButton", "无框按钮", { press: true }],
    [2, "AXGroup", null, { a: [], f: [300, 300, 150, 80] }],
    [3, "AXStaticText", "角标", { a: [], f: [310, 310, 40, 20] }],
    [0, "AXMenuBar", null, { a: ["AXCancel"], f: [-100, -50, 1512, 33] }],
    [1, "AXMenuBarItem", "文件", { a: MENU_ACTS, f: [-90, -50, 34, 33] }],
  ];
  const t = parseTree(payload("s22", rows));
  const h = (x, y) => {
    const r = hitTest(t, x, y);
    return r && { node: r.node.idx, anc: r.pressableAncestor?.idx ?? null };
  };
  check("hit: nested point → deepest node, pressable ancestor = the button", eq(h(140, 215), { node: 4, anc: 3 }), J(h(140, 215)));
  check("hit: inert text → pressable ancestor = the card", eq(h(150, 130), { node: 2, anc: 1 }), J(h(150, 130)));
  check("hit: pressable node → no ancestor reported", eq(h(200, 230), { node: 3, anc: null }), J(h(200, 230)));
  check("hit: inert text in inert group → nearest pressable ancestor two levels up", eq(h(320, 315), { node: 7, anc: 1 }), J(h(320, 315)));
  check("hit: frameless button never returned (point falls to the card)", eq(h(480, 390), { node: 1, anc: null }), J(h(480, 390)));
  check("hit: menu bar item not hit (window-relative y < 0)", h(-80, -40) === null, J(h(-80, -40)));
  check("hit: blank window area → null", h(800, 600) === null, J(h(800, 600)));
  check("hit: outside the window → null", h(1200, 900) === null, J(h(1200, 900)));
});

// 23. windows.mjs ------------------------------------------------------------------
section("23. windows", () => {
  const W = (window_id, pid, app_name, title, width, height, z_index, is_on_screen = true) => ({ window_id, pid, app_name, title, bounds: { x: 0, y: 0, width, height }, z_index, is_on_screen });
  const doc = W(11, 501, "编辑器", "草稿一", 900, 700, 30);
  const back = W(12, 501, "编辑器", "草稿二", 900, 700, 10, false);
  const overlay = W(13, 502, "助手", "", 1440, 900, 50);
  const tiny = W(14, 502, "助手", "图标", 40, 40, 40);
  const sheet = W(15, 501, "编辑器", "", 400, 300, 35);
  const browser = W(16, 503, "浏览器", "示例页", 1200, 800, 20);
  check("windows/isCandidate: titled + big → true", isCandidate(doc) === true && isCandidate(back) === true);
  check("windows/isCandidate: untitled on-screen big → false", isCandidate(overlay) === false && isCandidate(W(1, 1, "x", "   ", 500, 500, 1)) === false);
  check("windows/isCandidate: titled but ≤100 px side → false", isCandidate(tiny) === false && isCandidate(W(1, 1, "x", "标题", 101, 100, 1)) === false && isCandidate(W(1, 1, "x", "标题", 101, 101, 1)) === true);
  check("windows/isCandidate: missing bounds / null title → false", isCandidate({ window_id: 1, title: "有标题" }) === false && isCandidate({ ...doc, title: null }) === false);
  const all = [back, overlay, doc, tiny, sheet, browser];
  const txt = renderWindows(all);
  const L = txt.split("\n");
  check("windows/render: header counts shown windows, front-most first", L[0] === '3 window(s), front-most first — window_id pid app "title" WxH @x,y (top-left, screen points)', L[0]);
  check("windows/render: sorted by z_index, highest first", eq(L.slice(1, 4).map((l) => Number(l.split(" ")[0])), [11, 16, 12]), J(L.slice(1, 4)));
  check("windows/render: window line format (size, then the top-left corner)", /^11 pid 501 编辑器 "草稿一" 900x700 @-?\d+,-?\d+$/.test(L[1]), L[1]);
  check("windows/render: off-screen marked", /^12 pid 501 编辑器 "草稿二" 900x700 @-?\d+,-?\d+ off-screen$/.test(L[3]), L[3]);
  check("windows/render: hidden helpers counted", L[4] === "(3 untitled/tiny helper windows hidden — pid:<pid> lists every window of one app, all:true lists everything)" && L.length === 5, L[4]);
  const p = renderWindows(all, { pid: 501 }).split("\n");
  check("windows/render pid: every window of the pid, untitled sheet included", p[0].startsWith("3 window(s) of pid 501, front-most first") && eq(p.slice(1).map((l) => Number(l.split(" ")[0])), [15, 11, 12]), J(p));
  const a = renderWindows(all, { all: true }).split("\n");
  check("windows/render all: everything, z-sorted, no hidden note", a[0].startsWith("6 window(s), front-most first") && eq(a.slice(1).map((l) => Number(l.split(" ")[0])), [13, 14, 15, 11, 16, 12]), J(a));
  check("windows/render: none at all → (none)", renderWindows([]) === '0 window(s), front-most first — window_id pid app "title" WxH @x,y (top-left, screen points)\n(none)', renderWindows([]));
  check("windows/render: long title clipped to 60 + …", renderWindows([W(1, 1, "x", "题".repeat(70), 500, 500, 1)]).includes(`"${"题".repeat(60)}…"`));
  const before = [doc, overlay, tiny, W(17, 501, "编辑器", "", 500, 400, 5)];
  const after = [overlay, sheet, W(18, 502, "助手", "", 30, 30, 1), browser];
  const d = windowDelta(before, after);
  check("windows/delta: new big windows reported (untitled sheet too)", d.includes('new window: 15 pid 501 编辑器 "" 400x300') && d.includes('new window: 16 pid 503 浏览器 "示例页" 1200x800'), J(d));
  check("windows/delta: closed titled window reported", d.includes('closed window: 11 pid 501 编辑器 "草稿一" 900x700'), J(d));
  check("windows/delta: tiny new / closed untitled / closed tiny ignored, nothing else", d.length === 3, J(d));
  check("windows/delta: missing list → []", eq(windowDelta(null, after), []) && eq(windowDelta(before, undefined), []));
});

// parseToken ---------------------------------------------------------------------------
section("parseToken", () => {
  check("token: 's00000119:13' parsed", eq(parseToken("s00000119:13"), { sid: "s00000119", idx: 13 }), J(parseToken("s00000119:13")));
  check("token: 'abc', ':3', 's1:', '' , null, undefined → null", ["abc", ":3", "s1:", "", null, undefined].every((x) => parseToken(x) === null));
  check("token: non-hex sid / negative / extra part → null", ["sz1:2", "s1:-2", "s1:2:3", " s1:2"].every((x) => parseToken(x) === null));
});

section("review round 10: names, lines, wrappers, what stands beside a control, memory", () => {
  const T = (rows) => parseTree(payload("sn10", [[0, "AXWindow", "订单 - 商城后台", {}], [1, "AXWebArea", "页", {}], ...rows]));
  const St = (d, t, o = {}) => [d, "AXStaticText", t, { a: [], ...o }];
  const B = (d, t, o = {}) => [d, "AXButton", t, { press: true, ...o }];
  const Lk = (d, t, o = {}) => [d, "AXLink", t, { press: true, ...o }];
  const F = (x, y, w = 80, h = 24) => ({ f: [x, y, w, h] });
  const btn = (t, label) => findNodes(t, { role: "AXButton", label });
  const hit = (t, list, txt) => list.filter((b) => recordHas(t, b, (m) => list.includes(m), txt)).map((b) => list.indexOf(b));
  const names = (list) => list.map((n) => `${n.role.slice(2)} ${n.label}`);
  // R10-F1 a name is the same name whatever its spacing and width forms.
  const antd = T([Lk(2, "确定并继续添加"), St(2, "确定删除吗？"), B(2, "取 消"), B(2, "确 定")]);
  const got = findNodes(antd, { label: "确定" });
  check("R10-F1 find 确定 reaches the button '确 定' although other rows contain 确定 as written; nameRank puts it first (1) and the others at 0", eq(names(got), ["Link 确定并继续添加", "StaticText 确定删除吗？", "Button 确 定"]) && eq(got.map((n) => nameRank(n, "确定")), [0, 0, 1]));
  const wide = T([B(2, "ＯＫ"), Lk(2, "OK 并继续")]);
  check("R10-F1 full-width ＯＫ is OK: a candidate for find OK (rank 1), and the only match when nothing contains OK as written", eq(findNodes(wide, { label: "OK" }).map((n) => nameRank(n, "OK")), [1, 0]) && names(findNodes(T([B(2, "ＯＫ")]), { label: "OK" })).join() === "Button ＯＫ");
  const both = T([B(2, "确定"), B(2, "确 定"), B(2, "继续创作"), B(2, "创作 中心")]);
  check("R10-F1 …but a row named exactly so keeps the others out ('确定' beside '确 定'), and outer spaces given on purpose are respected ('创作 ' is not 继续创作)", names(findNodes(both, { label: "确定" })).join() === "Button 确定" && names(findNodes(both, { label: "创作 " })).join() === "Button 创作 中心");
  // R10-F3 a two-line title of the next card.
  const cards = T([St(2, "买菜清单", F(20, 100, 280)), B(2, "删除", F(20, 132, 60)), St(2, "周五前把 DD1005 的发票寄给李四，别忘了附回执", F(340, 100, 280, 48)), B(2, "删除", F(340, 156, 60))]);
  check("R10-F3 the left card's 删除 hangs below the right card's two-line title (y 132–156 against 100–148): not on its line, near DD1005 matches nothing", eq(hit(cards, btn(cards, "删除"), "DD1005"), []));
  const twoLine = T([St(2, "DD611", F(20, 100)), St(2, "折成两行的说明", F(120, 90, 200, 44)), B(2, "删除", F(400, 100)), St(2, "DD612", F(20, 160)), B(2, "删除", F(400, 160))]);
  check("R10-F3 …a button within the top and bottom of a two-line cell is on its line", eq(hit(twoLine, btn(twoLine, "删除"), "折成两行的说明"), [0]));
  // R10-F5 text inside an unnamed clickable wrapper.
  const rowLink = (y, id) => [Lk(2, `${id} 空气炸锅 删除`, F(20, y, 600, 30)), St(3, id, F(30, y + 4)), St(3, "空气炸锅", F(130, y + 4)), [3, "AXGroup", null, { press: true, ...F(520, y + 4, 60, 22) }], St(4, "删除", F(524, y + 4, 40, 20))];
  const wr = T([...rowLink(100, "DD1003"), ...rowLink(140, "DD1005")]);
  const dels = findNodes(wr, { label: "删除" });
  check("R10-F5 '删除' in an unnamed clickable wrapper inside a row that is one link: the text stays a candidate of its own (the row's plain texts are still the link), and wrapperOf gives the wrapper to press", eq(names(dels), ["Link DD1003 空气炸锅 删除", "StaticText 删除", "Link DD1005 空气炸锅 删除", "StaticText 删除"]) && wrapperOf(wr, dels[1])?.role === "AXGroup" && wrapperOf(wr, dels[0]) === null && names(findNodes(wr, { label: "DD1005" })).join() === "Link DD1005 空气炸锅 删除");
  const mixedWrap = T([[2, "AXGroup", null, { press: true }], St(3, "删除"), St(3, "DD1005")]);
  check("R10-F5 …a wrapper that holds other words too (a whole clickable card) is not that text's button", wrapperOf(mixedWrap, findNodes(mixedWrap, { label: "删除" })[0]) === null);
  // R10-F6 words at both ends of a line with several look-alikes.
  const line = (spec) => { let x = 20; return T(spec.split(" ").map((w) => { const xx = x; x += 110; return w === "P" ? B(2, "移除", F(xx, 100)) : St(2, w, F(xx, 100)); })); };
  const ends = line("张伟 P 李四 P 王五");
  check("R10-F6 '张伟 [移除] 李四 [移除] 王五': one record has no button and the line does not say which — the end texts match nobody, the middle one both", eq(["张伟", "李四", "王五"].map((x) => hit(ends, btn(ends, "移除"), x)), [[], [0, 1], []]));
  // R10-F7 a page text that itself ends in an ellipsis.
  const dots = T([St(2, "空气炸锅5L家…", F(20, 100)), B(2, "删除", F(400, 100)), St(2, "电饭煲3L迷你…", F(20, 140)), B(2, "删除", F(400, 140)), St(2, "加载中...", F(20, 180)), B(2, "删除", F(400, 180))]);
  check("R10-F7 what a reply prints as near can be sent back even when the page's own text is short and ends in '…' or '...'", eq(hit(dots, btn(dots, "删除"), nearOf(dots, btn(dots, "删除")[1])), [1]) && eq(hit(dots, btn(dots, "删除"), "加载中..."), [2]) && eq(hit(dots, btn(dots, "删除"), "电饭煲…"), []));
  // R10-F10 screen-reader-only text.
  const sr = T([St(2, "DD1003", F(20, 100)), St(2, "操作", { f: [200, 100, 1, 1] }), B(2, "删除", F(400, 100)), St(2, "DD1005", F(20, 140)), St(2, "操作", { f: [200, 140, 1, 1] }), B(2, "删除", F(400, 140))]);
  check("R10-F10 a 1px screen-reader-only text between the id and the button does not end the line (and is not on it)", eq(hit(sr, btn(sr, "删除"), "DD1005"), [1]) && eq(hit(sr, btn(sr, "删除"), "操作"), []));
  // besideRows / contextDiff: what the gap hold compares.
  const grp = (id) => T([St(2, "待审核队列"), [2, "AXGroup", null, {}], B(3, "通过"), St(3, id), St(3, "金额 050.00"), St(2, "页脚")]);
  const g1 = grp("DD1003");
  const g2 = grp("DD1005");
  const pass1 = btn(g1, "通过")[0];
  const pass2 = btn(g2, "通过")[0];
  check("R10-O1 a button first in its group, no frames: besideRows takes the text before it and the texts that follow inside the group", eq(besideRows(g1, pass1).map((m) => m.label ?? ""), ["待审核队列", "DD1003", "金额 050.00"]));
  const cd = contextDiff(g1, g2, pass2);
  check("contextDiff: the same button with another order number beside it → not the same, and it says which text became which", cd.was === pass1 && cd.same === false && cd.changed.length === 1 && sayRow(cd.changed[0].then) === "DD1003" && sayRow(cd.changed[0].now) === "DD1005" && sameContext(g1, g2, pass2) === null && sameContext(g1, grp("DD1003"), btn(grp("DD1003"), "通过")[0]) === null === false);
  const flat = (first) => T([St(2, "后台"), B(2, "订单"), B(2, "客户"), B(2, "商品"), St(2, first), St(2, "第二行")]);
  check("…on a flat page what follows a tab bar is not 'beside' its tabs (the page's first line changes with every tab): besideRows of the last tab is the title before the bar only", eq(besideRows(flat("订单 第 0 行"), btn(flat("订单 第 0 行"), "商品")[0]).map((m) => m.label), ["后台"]));
  // R10-G1 the alignment cache must not chain every walk to the next.
  const probe = `
    import { parseTree, diffTrees } from ${JSON.stringify(new URL("../lib/tree.mjs", import.meta.url).href)};
    import { payload } from ${JSON.stringify(new URL("./fixtures/trees.mjs", import.meta.url).href)};
    const mk = (k) => parseTree(payload("s" + (1000 + k).toString(16), [[0, "AXWindow", "w", {}], ...Array.from({ length: 3000 }, (_, i) => [1, "AXStaticText", "行 " + i + (i % 50 === 0 ? " v" + k : ""), { a: [] }])]));
    const first = mk(0);
    let prev = first;
    globalThis.gc();
    const base = process.memoryUsage().heapUsed;
    for (let k = 1; k <= 40; k++) { const next = mk(k); diffTrees(prev, next); prev = next; }
    prev = null;
    globalThis.gc();
    console.log(Math.round((process.memoryUsage().heapUsed - base) / 1e6));`;
  const run = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", probe], { encoding: "utf8" });
  const grew = Number(String(run.stdout).trim());
  check("R10-G1 forty 3,000-row walks diffed in a chain, only the first still referenced: the others are freed (heap grows by a few MB, not by forty trees)", run.status === 0 && Number.isFinite(grew) && grew < 20, `${grew} MB | ${String(run.stderr).slice(0, 200)}`);
});

section("review round 11: names that are not controls, one record or two, lines that are no lines", () => {
  const T = (rows) => parseTree(payload("sn11", [[0, "AXWindow", "w", {}], [1, "AXWebArea", "页", {}], ...rows]));
  const St = (d, t, o = {}) => [d, "AXStaticText", t, { a: [], ...o }];
  const B = (d, t, o = {}) => [d, "AXButton", t, { press: true, ...o }];
  const Lk = (d, t, o = {}) => [d, "AXLink", t, { press: true, ...o }];
  const F = (x, y, w = 80, h = 24) => ({ f: [x, y, w, h] });
  const names = (list) => list.map((n) => `${n.role.slice(2)} ${n.label}`);
  const head = T([St(2, "删除"), St(2, "删除后不可恢复"), B(2, "取 消"), B(2, "删 除")]);
  check("round 11: a heading named exactly 删除 does not keep the button '删 除' out of find 删除 (it is no control); a disabled button of that name does not either", names(findNodes(head, { label: "删除" })).includes("Button 删 除") && names(findNodes(T([B(2, "删除", { en: false }), B(2, "删 除")]), { label: "删除" })).join() === "Button 删除,Button 删 除");
  const badge = T([Lk(2, "删除 (3)"), St(3, "删除"), St(3, "(3)"), B(2, "取 消"), B(2, "删 除")]);
  check("round 11: the word 删除 inside the link '删除 (3)' is a piece of that link, not a control named 删除: the button '删 除' is a candidate", eq(names(findNodes(badge, { label: "删除" })), ["Link 删除 (3)", "Button 删 除"]));
  check("…while a usable control named exactly so still keeps the spaced one out", names(findNodes(T([B(2, "删除"), B(2, "删 除")]), { label: "删除" })).join() === "Button 删除");
  const line = T([St(2, "张伟", F(20, 100)), B(2, "移除", F(120, 100)), St(2, "李四", F(220, 100)), B(2, "移除", { en: false, ...F(320, 100) }), St(2, "王五", F(420, 100))]);
  const bs = findNodes(line, { role: "AXButton", label: "移除" });
  const peer = (m) => bs.includes(m);
  check("round 11: '张伟 [移除] 李四 [移除] 王五' — near takes the ends away (both are left with 李四), but recordOf().full keeps them: the two are different records", eq(bs.map((b) => recordOf(line, b, peer).rows.map((m) => m.label)), [["李四"], ["李四"]]) && eq(bs.map((b) => recordOf(line, b, peer).full.map((m) => m.label)), [["张伟", "李四"], ["李四", "王五"]]));
  const many = T(Array.from({ length: 600 }, (_, i) => (i % 2 ? B(2, "删除", F(20 + 30 * i, 100, 24)) : St(2, `DD${i}`, F(20 + 30 * i, 100, 24)))));
  const mb = findNodes(many, { role: "AXButton", label: "删除" });
  check("round 11: six hundred things at one height are not a line — no line evidence, near matches nothing", !recordHas(many, mb[150], (m) => mb.includes(m), "DD300") && recordOf(many, mb[150], (m) => mb.includes(m)).how === "none");
  const long = (pairs) => T(Array.from({ length: pairs * 2 }, (_, i) => (i % 2 ? B(2, "移除", F(20 + 30 * i, 100, 24)) : St(2, `name${i / 2}`, F(20 + 30 * i, 100, 24)))));
  const l202 = long(101);
  const b202 = findNodes(l202, { role: "AXButton", label: "移除" });
  const p202 = (m) => b202.includes(m);
  check("round 12: the 200 limit is on the whole line — on a 202-item line no control has line evidence (not: those near the middle have it and their neighbours do not), so a text between two of them matches neither", [0, 50, 99, 100].every((k) => recordOf(l202, b202[k], p202).how === "none") && !recordHas(l202, b202[99], p202, "name100") && !recordHas(l202, b202[100], p202, "name100"));
  const l200 = long(100);
  const b200 = findNodes(l200, { role: "AXButton", label: "移除" });
  check("…and a 200-item line is still a line: the text between two buttons counts for both", recordHas(l200, b200[49], (m) => b200.includes(m), "name50") && recordHas(l200, b200[50], (m) => b200.includes(m), "name50"));
  // Round 13: 100 pairs and a trailing text (201 things); button 50 sits 8 px lower and does not see the trailing text.
  const low = T([...Array.from({ length: 200 }, (_, i) => (i % 2 ? B(2, "移除", F(20 + 30 * i, i === 101 ? 108 : 100, 24)) : St(2, `name${i / 2}`, F(20 + 30 * i, 100, 24)))), St(2, "合计 100 人", F(20 + 30 * 200, 90, 24))]);
  const bl = findNodes(low, { role: "AXButton", label: "移除" });
  const pl = (m) => bl.includes(m);
  check("round 13: a line is a line for every look-alike on it, or for none — the one button that sees a shorter line than its neighbours (8 px lower) is not left alone with line evidence, so the text between it and the next matches neither", [49, 50, 51].every((k) => recordOf(low, bl[k], pl).how === "none") && !recordHas(low, bl[50], pl, "name51") && !recordHas(low, bl[51], pl, "name51"), J([49, 50, 51].map((k) => recordOf(low, bl[k], pl).how)));
  const stairs = T([St(2, "张伟", F(20, 100)), B(2, "移除", F(120, 100)), St(2, "李四", F(220, 100)), B(2, "移除", F(320, 100)), ...Array.from({ length: 300 }, (_, i) => (i % 2 ? B(2, "移除", F(20 + 30 * i, 400, 24)) : St(2, `n${i}`, F(20 + 30 * i, 400, 24))))]);
  const bst = findNodes(stairs, { role: "AXButton", label: "移除" });
  check("…and a short line elsewhere on the page keeps its evidence when another line of the same name is past the limit", recordHas(stairs, bst[0], (m) => bst.includes(m), "张伟") && recordOf(stairs, bst[150], (m) => bst.includes(m)).how === "none");
  const wide = (sel) => T([...Array.from({ length: 120 }, (_, i) => St(2, `标签${i}`, F(20 + i * 90, 44))), St(2, sel, F(20 + 120 * 90, 44)), St(2, "金额 ¥120", F(20 + 121 * 90, 44)), St(2, "状态 待审", F(20 + 122 * 90, 44)), B(2, "删除", F(20 + 123 * 90, 44)), ...Array.from({ length: 120 }, (_, i) => St(2, `备注${i}`, F(20 + (125 + i) * 90, 44)))]);
  const del = (t) => findNodes(t, { role: "AXButton", label: "删除" })[0];
  const w3 = wide("选中：订单 DD1003");
  const w5 = wide("选中：订单 DD1005");
  check("round 13: on a 244-item line (no line evidence for near) besideRows still takes the nearest part of the line — the record text three cells before the button is compared across two walks", recordOf(w3, del(w3)).how === "none" && besideRows(w3, del(w3)).some((m) => m.label === "选中：订单 DD1003") && !contextDiff(w3, w5, del(w5)).same && contextDiff(w3, wide("选中：订单 DD1003"), del(w3)).same, J(besideRows(w3, del(w3)).map((m) => m.label)));
  // Round 13, second pass: the all-or-none rule is looked up from the control outwards, not for the whole window.
  const grid = T(Array.from({ length: 8000 }, (_, i) => [B(2, "关注", F(20 + (i % 10) * 110, 4000 + 30 * Math.floor(i / 10), 60)), St(3, "关注", F(20 + (i % 10) * 110, 4000 + 30 * Math.floor(i / 10), 60))]).flat());
  const gb = findNodes(grid, { role: "AXButton", label: "关注" });
  const tg = Date.now();
  const gr = recordOf(grid, gb[7], (m) => gb.includes(m));
  check("round 13: line evidence for one of 8,000 same-named buttons in a grid (each with its own text inside) scans its own line, not the line of every one of them", gb.length === 8000 && gr.how !== undefined && Date.now() - tg < 400, `${Date.now() - tg} ms`);
  const wrap = T([[2, "AXGroup", null, { press: true }], ...Array.from({ length: 4000 }, () => St(3, "删除"))]);
  const texts = findNodes(wrap, { role: "AXStaticText", label: "删除" });
  const t0 = Date.now();
  const all = texts.every((n) => wrapperOf(wrap, n)?.role === "AXGroup");
  check("round 11: wrapperOf scans a wrapper once, not once per text in it (4,000 texts in one clickable group)", all && Date.now() - t0 < 500, `${Date.now() - t0} ms`);
});

console.log(`\n${total - failures}/${total} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
