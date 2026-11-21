/** The `constile-mcp` command: the server over stdio. It always starts; server.ts only defines it, for tests. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server";

await createServer().connect(new StdioServerTransport());
