#!/usr/bin/env node
// Test fixture: an MCP backend whose tool responses violate its own declared
// outputSchema — exactly what cua-driver 0.20.0 does (envelope fields like
// status/code are declared required but omitted, depending on the action).
// The hub must pass such responses through verbatim. Two tools cover the two
// SDK client checks that arm after listTools():
//   list_windows — structuredContent present but schema-invalid (-32602)
//   content_only — outputSchema declared, no structuredContent at all (-32600;
//                  this check fires on a merely TRUTHY cached validator,
//                  before the validator function is even invoked)
// Spawned by smoke.mjs via DESKTOP_HUB_CUA_BIN; the "mcp" argv is ignored.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "schema-violating-backend", version: "0" }, { capabilities: { tools: {} } });

const OUTPUT_SCHEMA = {
  type: "object",
  required: ["field_the_response_lacks"],
  properties: { field_the_response_lacks: { type: "string" } },
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_windows",
      description: "returns structuredContent that violates this very schema",
      inputSchema: { type: "object" },
      outputSchema: OUTPUT_SCHEMA,
    },
    {
      name: "content_only",
      description: "declares an outputSchema but returns no structuredContent",
      inputSchema: { type: "object" },
      outputSchema: OUTPUT_SCHEMA,
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) =>
  req.params.name === "content_only"
    ? { content: [{ type: "text", text: "content-only-ok" }] }
    : { content: [{ type: "text", text: "violating-ok" }], structuredContent: { some_other_field: 1 } }
);

await server.connect(new StdioServerTransport());
