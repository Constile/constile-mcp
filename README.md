# constile-mcp

An MCP server that gives an AI assistant a `read_article` tool. When a
publisher's page carries a Constile ad, the tool handles it the way the person
chose.

Constile lets publishers keep being paid when assistants read their pages.
Instead of the page's ads, the person sees one labeled sponsored message in the
assistant's answer, and the advertiser pays the publisher. It costs the person
nothing and shares nothing about them.

## Add it to your assistant

It needs Node.js 20 or later. In any client that runs MCP servers over stdio,
add a server that runs `npx -y constile-mcp`. For example, in a client's
`mcpServers` settings:

```json
{
  "mcpServers": {
    "constile": { "command": "npx", "args": ["-y", "constile-mcp"] }
  }
}
```

In Claude Code:

```sh
claude mcp add constile -- npx -y constile-mcp
```

## Tools

| Tool | What it does |
|---|---|
| `read_article` | Fetches a page. When the page carries a Constile ad, it follows the person's saved choice, and returns the page with the sponsored message to show. |
| `report_sponsored_message` | Tells the publisher the message is in the answer (`prepared`) or that the person has seen it (`delivered`). |
| `set_constile_preference` | Saves the person's choice: `accept`, `ask`, or `decline`. Call it only when the person says so. |
| `get_constile_preference` | Returns the saved choice. Until one is saved, it's `ask`. |

## Settings

| Variable | What it sets | Default |
|---|---|---|
| `CONSTILE_PREFS` | Where the person's choice is saved | `~/.config/constile/preferences.json` |
| `CONSTILE_UA` | The user agent the tool fetches with | `ConstileMCP-User/0.1 (+https://constile.app)` |

The server keeps only that choice, on the person's own machine. It sends
nothing about the person or the conversation.

## Build from source

The source is at <https://github.com/Constile/constile-mcp>.

```sh
npm install
npm test
npm run build
```

## Support

Write to <hello@constile.app>. For building your own agent, see
[`constile-agent-sdk`](https://www.npmjs.com/package/constile-agent-sdk), and
for the API, <https://constile.app/developers>.

## License

MIT. See LICENSE.
