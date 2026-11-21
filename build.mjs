// Bundles the server into dist/constile-mcp.js, as the npm package ships it.
import { chmodSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: ["src/bin.ts"],
  outfile: "dist/constile-mcp.js",
  bundle: true, format: "esm", platform: "node", target: "node20", legalComments: "none", logLevel: "warning",
  // The MCP SDK's dependencies use require(); give the ES module bundle one.
  banner: { js: '#!/usr/bin/env node\n// constile-mcp 0.1.1\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
});
chmodSync("dist/constile-mcp.js", 0o755);
