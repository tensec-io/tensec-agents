# Dev Server Preview

## Summary

Tunnel the sandbox's dev server port through Modal so users can browse the app the agent is building
in their own browser. Same pattern as code-server tunneling — no VNC, no Xvfb, no additional
dependencies. Users get native browser performance with full devtools.

The dev server port is configurable per repo. Traffic flows directly through Modal tunnels, bypassing
Cloudflare Workers entirely.

The existing screenshot tool remains unchanged for cases where a live preview isn't practical (mobile,
async review, session replay).

## Requirements

- **Full browser control** — users interact with the app in their own browser
- **Per-repo port config** — dev server port varies by framework (3000, 5173, 8000, etc.); configured
  via the existing repo env vars (`DEV_SERVER_PORT`)
- **No new sandbox dependencies** — just another Modal tunnel
- **Independent of screenshot tool** — screenshot tool stays headless and ephemeral

## Architecture

```
Sandbox                           Modal                           User's Browser
  npm run dev (:3000)  ──→  encrypted_ports=[8080, 3000]  ──→  tunnel URL (HTTPS)
                                                                     ↓
                                                              User opens URL directly
                                                              (native browser, full devtools)
```

**Data flow:**
```
User's Browser  ──HTTPS──→  Modal tunnel (direct, no CF)  ──→  dev server :3000
```

The CF Worker only sends the tunnel URL once via a WebSocket message. All subsequent traffic goes
directly through Modal.

## Changes by Package

### 1. Sandbox Image (`packages/modal-infra/src/images/base.py`)

No changes. The dev server is started by the project itself (e.g., `npm run dev`), not by the
sandbox infrastructure.

### 2. Sandbox Entrypoint (`packages/modal-infra/src/sandbox/entrypoint.py`)

No changes. The dev server is started by the agent or by the repo's `.openinspect/start.sh` hook,
not by the supervisor. The tunnel is established at sandbox creation time regardless of whether a
process is listening on the port yet.

### 3. Sandbox Manager (`packages/modal-infra/src/sandbox/manager.py`)

Mirror the code-server tunnel pattern. The dev server port comes from `user_env_vars["DEV_SERVER_PORT"]`
(set as a repo env var by the user):

```python
# In SandboxInfo dataclass:
dev_server_url: str | None = None

# In create_sandbox() and restore_from_snapshot(), before modal.Sandbox.create():
dev_server_port: int | None = None
if config.user_env_vars:
    port_str = config.user_env_vars.get("DEV_SERVER_PORT")
    if port_str:
        dev_server_port = int(port_str)

encrypted_ports = [CODE_SERVER_PORT]
if dev_server_port:
    encrypted_ports.append(dev_server_port)

# New method (mirrors _resolve_code_server_tunnel):
@staticmethod
async def _resolve_dev_server_tunnel(
    sandbox: modal.Sandbox, port: int, sandbox_id: str
) -> str | None:
    """Resolve the dev server tunnel URL from Modal."""
    # Same implementation as _resolve_code_server_tunnel but for the configured port
```

**`encrypted_ports`**: Change from `[CODE_SERVER_PORT]` to
`[CODE_SERVER_PORT, dev_server_port]` when `DEV_SERVER_PORT` is present in `user_env_vars`.

**`create_sandbox()` and `restore_from_snapshot()`**: Add dev server tunnel resolution alongside
the existing code-server logic. No password needed — the tunnel URL is the auth boundary (Modal
generates a unique, unguessable URL). Both methods already receive `user_env_vars`, so no new
plumbing is needed on the control-plane side.

### 4. Shared Types (`packages/shared/src/types/index.ts`)

Add to `ServerMessage`:

```typescript
| { type: "dev_server_info"; url: string }
```

Add to `SessionState`:

```typescript
devServerUrl?: string | null;
```

### 5. Control Plane

**Schema** (`packages/control-plane/src/session/schema.ts`):

```sql
ALTER TABLE sandbox ADD COLUMN dev_server_url TEXT;
```

**Repository** (`packages/control-plane/src/session/repository.ts`):

- Add `updateSandboxDevServer(url)` method (mirrors `updateSandboxCodeServer`)

**Types** (`packages/control-plane/src/session/types.ts`):

- Add `dev_server_url: string | null` to `SandboxRow`

**Provider** (`packages/control-plane/src/sandbox/provider.ts`):

- Add `devServerUrl?` to `SandboxInfo` and `SandboxCreateResult`

**Client** (`packages/control-plane/src/sandbox/client.ts`):

- Add `dev_server_url` to API response parsing (mirrors code-server fields)

**Modal Provider** (`packages/control-plane/src/sandbox/providers/modal-provider.ts`):

- Pass through `devServerUrl` from result

**Lifecycle Manager** (`packages/control-plane/src/sandbox/lifecycle/manager.ts`):

- Add `storeAndBroadcastDevServer()` method (mirrors `storeAndBroadcastCodeServer`)
- Call it after sandbox creation/restore when dev server URL is present

**Durable Object** (`packages/control-plane/src/session/durable-object.ts`):

- Include `devServerUrl` in `SessionState` sent to clients on subscribe

### 6. Repo Config — No Changes

The dev server port is configured via the existing **repo env vars** mechanism. The user sets
`DEV_SERVER_PORT=3000` (or 5173, 8000, etc.) in the repo's environment variables through the
existing web UI.

No new D1 columns, no new API endpoints, no new UI for repo config. The sandbox manager reads
`DEV_SERVER_PORT` from `user_env_vars` at sandbox creation time.

When `DEV_SERVER_PORT` is set, the sandbox manager includes that port in `encrypted_ports` and
resolves its tunnel URL. When not set, no dev server tunnel is created.

### 7. Web Client (`packages/web/`)

- Surface the dev server URL in the session UI (e.g., an "Open Preview" button/link)
- Opens in a new tab or embedded iframe
- Listens for `dev_server_info` messages on the session WebSocket
- Also available from `SessionState.devServerUrl` on initial subscribe

No special client library needed — it's just a URL.

## What's NOT in Scope

- VNC / remote desktop (separate design doc: `2026-03-08-vnc-live-browser-view-design.md`)
- Auto-detecting the dev server port (user configures it per repo)
- HMR/WebSocket proxying complications (Modal tunnel handles HTTPS; HMR WebSocket connections from
  the app should work if the dev server's WS endpoint is on the same port)
- Authentication beyond the unguessable Modal tunnel URL

## Implementation Note: Reserved Keys

Add `DEV_SERVER_PORT` to the reserved keys list in `packages/control-plane/src/db/secrets-validation.ts`
so the system can recognize it as a well-known key (and prevent it from being overwritten by system
env vars in the sandbox manager).

## Open Questions

- **Multiple ports**: Some projects run frontend + backend on different ports. Support one port for
  v1, or allow a list?
- **Tunnel lifetime**: Modal tunnels persist as long as the sandbox is alive. If the dev server
  isn't running yet, the user sees a connection error. Should the UI show a "dev server not ready"
  state, or just let the browser show its native error?
