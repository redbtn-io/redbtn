# MCP Servers

Model Context Protocol (MCP) servers power Red AI's tool ecosystem. Each server runs in its own package so it can be shipped, versioned, and tested independently while still being launched from the main `@redbtn/ai` workspace.

## Directory Layout

```
ai/src/mcp-servers/
├── README.md                # This file
├── home-assistant/          # Example MCP server with regex-based command routing
└── ...                      # Add additional servers here
```

Every subfolder is a standalone Node package with its own `package.json`, `tsconfig.json`, and build output in `dist/`. Servers communicate with the core runtime over stdio, exactly as required by the MCP specification.

## Available Servers

### `home-assistant`

- **Purpose:** Provides intent-detection resources and tools for issuing smart-home style commands (lights and locks). Useful for the router/precheck nodes when the agent needs to interpret natural-language device requests.
- **Resources:**
  - `pattern://home-assistant/commands` &rarr; JSON payload describing regex patterns, parameter mappings, and confidence scores the router can inspect before calling a tool.
- **Tools:**
  - `control_light` &rarr; Toggle lights on/off based on location.
  - `set_brightness` &rarr; Adjust brightness (0-100%) and implicitly manage light state.
  - `control_lock` &rarr; Lock or unlock doors.
- **Mock State:** Ships with in-memory device metadata so you can exercise the server without a live Home Assistant deployment. Swap the `mockDevices` map with real API calls when you're ready to integrate.

## Running Servers

From `ai/` you can launch every server via the existing npm script:

```bash
npm run mcp:start
```

This command runs `src/mcp-servers.ts`, which spins up each server (including the ones in this directory) and registers them with the MCP registry the Red runtime consumes.

### Developing a Single Server

```bash
cd ai/src/mcp-servers/home-assistant
npm install
npm run build   # or npm run watch during development
./dist/index.js # executes the stdio server (bin is also exposed as "mcp-home-assistant")
```

To make the server available to the core runtime while hacking, either run the binary manually and connect over stdio, or re-run `npm run mcp:start` from the `ai/` root so the registry refreshes.

## Creating a New MCP Server

1. **Scaffold a folder** under `ai/src/mcp-servers/<name>` with its own `package.json` (set `type: "module"` and a `bin` entry pointing at `dist/index.js`).
2. **Copy `tsconfig.json`** from the existing server or set up your preferred compiler settings.
3. **Implement the server** using `@modelcontextprotocol/sdk`. At minimum you'll register handlers for `ListTools`, `CallTool`, and optionally `ListResources`/`ReadResource` if you want to expose context.
4. **Add dependencies** required by the tool (SDK plus any SDK clients such as Redis, HTTP, etc.).
5. **Export the binary** so `npm run mcp:start` (and downstream tooling) can spawn it via stdio.
6. **Document the tools** in this README so downstream teams know what inputs/outputs to expect.

When you introduce a new server, update `src/mcp-servers.ts` to spawn it and pass the resulting transport into the shared MCP registry.

## Testing & Validation

- **Unit testing:** Each server can ship with its own test runner. For stdio integration tests you can use `@modelcontextprotocol/sdk`'s client utilities.
- **Manual testing:** Run the server directly and use `mcp-cli` (or the LangGraph inspector) to invoke tools.
- **Documentation hygiene:** Because this directory sits under `ai/`, the shared `scripts/pre-commit-cleanup.sh ./ai` hook also enforces the markdown relocation policy for any docs you add here.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Server exits immediately when launched from `npm run mcp:start` | Ensure the `bin` path in the subpackage `package.json` points at a transpiled file and that `npm run build` has been executed. |
| `Unknown resource` errors | Double-check `ReadResourceRequestSchema` handler URIs; they must match the ones returned by `ListResources`. |
| Tools not discoverable | Confirm your handler for `ListToolsRequestSchema` returns the tool metadata and that the server advertises `capabilities.tools`. |
| JSON parsing failures | Use `JSON.stringify` for tool responses (as shown in `home-assistant`) or the SDK's structured content helpers to avoid malformed payloads. |

For additional context on how these servers plug into the larger system, see the "MCP Architecture" and "Tool Execution Storage" sections in `ai/README.md`.
