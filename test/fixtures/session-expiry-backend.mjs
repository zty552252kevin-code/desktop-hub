#!/usr/bin/env node
// Test fixture: simulates cua-driver's lifecycle-session expiry semantics so
// the hub's auto-revive layer can be tested deterministically.
//   expires_once       — rejects with cua's exact "session '…' has ended" error
//                        until start_session({session:"sess-a"}) is seen, then
//                        succeeds with structuredContent (the normal
//                        revive+retry happy path)
//   quoted_name        — same, but the session label contains an apostrophe
//                        (cua accepts free-form labels; the hub's regex must
//                        not choke on the embedded quote)
//   always_ended       — always rejects, embedding its own call count in the
//                        session name (guards against revive/retry loops: the
//                        hub must stop after exactly one retry, i.e. call 2)
//   unrevivable        — rejects naming session 'named-x'; start_session for
//                        'named-x' fails with the transport-mismatch text a
//                        cross-transport revival produces
//   generic_error      — plain isError with a call counter; must pass through
//                        with NO revive attempt and NO hub note
//   embedded_rejection — isError that merely QUOTES an inner session rejection
//                        naming a different tool (replay_trajectory shape);
//                        must NOT trigger a blind re-run of the outer call
//   revive_crash       — rejects naming 'sess-crash'; start_session for it
//                        kills this process (revive THROWS in the hub)
//   retry_crash        — rejects naming 'sess-c2'; after revival the retry
//                        kills this process (retry THROWS in the hub)
//   get_window_state   — echoes received arguments back as text
//                        (max_elements/max_depth passthrough check)
// Spawned by smoke.mjs via DESKTOP_HUB_CUA_BIN; the "mcp" argv is ignored.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "session-expiry-backend", version: "0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    "expires_once", "quoted_name", "always_ended", "unrevivable", "generic_error",
    "embedded_rejection", "revive_crash", "retry_crash", "get_window_state", "start_session",
  ].map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object" },
  })),
}));

// Byte-for-byte the error shape cua-driver 0.20.0 emits on an expired session.
const endedError = (sess, tool) => ({
  isError: true,
  content: [{
    type: "text",
    text: `session '${sess}' has ended; tool call '${tool}' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id.`,
  }],
});

const revived = new Set();
const counts = {};
const bump = (name) => (counts[name] = (counts[name] ?? 0) + 1);

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  switch (name) {
    case "start_session":
      if (args.session === "named-x") {
        return { isError: true, content: [{ type: "text", text: "session is not available to this transport" }] };
      }
      if (args.session === "sess-crash") process.exit(1);
      revived.add(args.session);
      return {
        content: [{ type: "text", text: JSON.stringify({ revived: true, session: args.session }) }],
        structuredContent: { revived: true, session: args.session },
      };
    case "expires_once":
      return revived.has("sess-a")
        ? { content: [{ type: "text", text: "revive-retry-ok" }], structuredContent: { elements: [{ element_token: "tok-1" }] } }
        : endedError("sess-a", name);
    case "quoted_name":
      return revived.has("kevin's probe")
        ? { content: [{ type: "text", text: "quoted-retry-ok" }] }
        : endedError("kevin's probe", name);
    case "always_ended":
      return endedError(`sess-b-call-${bump(name)}`, name);
    case "unrevivable":
      return endedError("named-x", name);
    case "generic_error":
      return { isError: true, content: [{ type: "text", text: `backend exploded (call ${bump(name)})` }] };
    case "embedded_rejection":
      // What replay_trajectory-style tools report: an OUTER call that already
      // executed side effects, whose error text quotes an INNER rejection.
      return {
        isError: true,
        content: [{
          type: "text",
          text: `replay stopped at step 3 (call ${bump(name)}): session 'sess-inner' has ended; tool call 'left_click' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id.`,
        }],
      };
    case "revive_crash":
      return endedError("sess-crash", name);
    case "retry_crash":
      if (revived.has("sess-c2")) process.exit(1);
      return endedError("sess-c2", name);
    case "get_window_state":
      return { content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }] };
    default:
      return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
  }
});

await server.connect(new StdioServerTransport());
