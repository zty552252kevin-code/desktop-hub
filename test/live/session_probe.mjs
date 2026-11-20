// Live probe: does cua retire snapshots per (pid, window) globally, or per session / per transport?
// Touches Calculator only (background delivery). Usage: node test/live/session_probe.mjs "$PWD/server.mjs"
// The hub's token rules rest on what this prints (measured on cua 0.28.2: any new walk of a window retires the
// older tokens, whoever made it); run it again after a driver upgrade.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const mk = async () => { const t = new StdioClientTransport({ command: 'node', args: [process.argv[2]], env: { ...process.env } }); const c = new Client({ name: 'probe', version: '0' }); await c.connect(t); return c; };
const A = await mk(), B = await mk();
const raw = async (c, tool, args) => { try { return await c.callTool({ name: 'desk_call', arguments: { server: 'cua', tool, args } }, undefined, { timeout: 90000 }); } catch (e) { return { isError: true, content: [{ type: 'text', text: 'THROW ' + e.message }] }; } };
const txt = (r) => (r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
const hubcall = async (c, name, args) => txt(await c.callTool({ name, arguments: args }, undefined, { timeout: 90000 }));
await hubcall(A, 'launch_app', { bundle_id: 'com.apple.calculator' }); await new Promise((r) => setTimeout(r, 1500));
const lw = await hubcall(A, 'list_windows', {});
const m = /^(\d+) pid (\d+) (?:计算器|Calculator) /m.exec(lw); if (!m) { console.log('Calculator window not found', lw); process.exit(1); }
const W = { pid: Number(m[2]), window_id: Number(m[1]) };
// cua >= 0.34 answers with the markdown tree alone unless asked for full_output; an older driver may refuse a
// parameter it does not list. Ask the plain way first, and remember which this driver needs.
let fullOutput = false;
const gws = async (c, extra = {}) => {
  const once = () => raw(c, 'get_window_state', { ...W, include_screenshot: false, ...(fullOutput ? { full_output: true } : {}), ...extra });
  let r = await once();
  if (!fullOutput && !r.isError && !r.structuredContent?.elements && r.structuredContent?.tree_markdown) { fullOutput = true; console.log('  (this driver returns elements only with full_output:true: that one read was made twice, every later one asks that way)'); r = await once(); }
  const sc = r.structuredContent;
  if (!sc?.elements) { console.log('  get_window_state returned no elements:', txt(r).slice(0, 300)); return null; }
  return sc;
};
const tok = (sc, label) => sc.elements.find((e) => e.role === 'AXButton' && e.label === label)?.element_token;
const click = async (c, token, extra = {}) => { const r = await raw(c, 'click', { pid: W.pid, window_id: W.window_id, element_token: token, ...extra }); const t = txt(r) || JSON.stringify(r.structuredContent || {}).slice(0, 300); return (r.isError ? 'ERR ' : 'ok  ') + t.replace(/\s+/g, ' ').slice(0, 200); };

const first = await gws(A);
console.log('element fields:', [...new Set(first.elements.flatMap((e) => Object.keys(e)))].join(', '));
console.log('top-level fields:', Object.keys(first).join(', '));

console.log('\nP0 control: one transport, no session, two walks, then the token of the FIRST walk');
{ const s1 = await gws(A); const t1 = tok(s1, '1'); await gws(A); console.log('  ', await click(A, t1)); }

console.log('\nP1 one transport, two session labels: token from m, another walk under o, click under m');
{ const s1 = await gws(A, { session: 'hubprobe-m' }); const t1 = tok(s1, '2'); const s2 = await gws(A, { session: 'hubprobe-o' });
  console.log('   token of m, sent with session m:', await click(A, t1, { session: 'hubprobe-m' }));
  const s3 = await gws(A, { session: 'hubprobe-m' }); const t3 = tok(s3, '3'); await gws(A, { session: 'hubprobe-o' });
  console.log('   token of m, sent without a session:', await click(A, t3));
  const s4 = await gws(A, { session: 'hubprobe-m' }); const t4 = tok(s4, '4'); await gws(A, { session: 'hubprobe-o' });
  console.log('   token of m, sent with session o:', await click(A, t4, { session: 'hubprobe-o' }));
  console.log('   snapshot ids m/o:', s1.snapshot_id, s2?.snapshot_id); }

console.log('\nP2 two transports: A takes a token, B walks, A clicks');
{ const s1 = await gws(A); const t1 = tok(s1, '5'); const sb = await gws(B); console.log('   A clicks:', await click(A, t1)); console.log('   snapshot ids A/B:', s1.snapshot_id, sb?.snapshot_id);
  const s2 = await gws(A); const t2 = tok(s2, '6'); await gws(B, { session: 'hubprobe-b' }); console.log('   A clicks after B walked under a named session:', await click(A, t2)); }

console.log('\nP3 does verify_state retire a token?');
{ const s1 = await gws(A); const t1 = tok(s1, '7'); const v = await raw(A, 'verify_state', { ...W, expect: [{ element: { selector: { role: 'AXButton', label_contains: '7' }, exists: true } }], timeout_ms: 0 }); console.log('   verify:', txt(v).replace(/\s+/g, ' ').slice(0, 160)); console.log('   click after it:', await click(A, t1)); }

console.log('\nP4 is a token still good after a screenshot-only read (include_accessibility_tree:false)?');
{ const s1 = await gws(A); const t1 = tok(s1, '8'); await raw(A, 'get_window_state', { ...W, include_accessibility_tree: false }); console.log('   click after it:', await click(A, t1)); }

for (const s of ['hubprobe-m', 'hubprobe-o']) await raw(A, 'end_session', { session: s });
await raw(B, 'end_session', { session: 'hubprobe-b' });
await raw(A, 'press_key', { pid: W.pid, window_id: W.window_id, key: 'escape' });
await A.close(); await B.close();
