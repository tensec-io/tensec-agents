# VNC Live Browser View

## Summary

Add an on-demand live browser view to sandboxes using Xvfb + x11vnc + websockify + noVNC. Users can
watch and interact with a persistent Chromium instance running inside the sandbox via their web
browser. The existing screenshot tool remains unchanged — it continues to use its own ephemeral
headless Chromium for static PNG captures.

VNC traffic flows directly through Modal tunnels (same pattern as code-server), bypassing Cloudflare
Workers entirely. The CF Worker only sends the tunnel URL once.

## Requirements

- **Browser only** — no full desktop environment, just Chromium in a minimal window manager
- **Full control** — users can click, type, scroll in the browser (not view-only)
- **Best-effort latency** — whatever the Modal tunnel provides
- **On-demand** — VNC port is always tunneled (cheap), but VNC processes only start when a user
  clicks "Enable Browser View" in the session UI. Users can also shut down VNC to reclaim memory.
- **Independent of screenshot tool** — screenshot tool stays headless and ephemeral

## Architecture

```
Sandbox Supervisor (entrypoint.py)
  ├── Xvfb :1 (1280x720x24)           ← virtual framebuffer (on-demand)
  ├── fluxbox (on :1)                  ← minimal window manager (on-demand)
  ├── Chromium (on :1, non-headless)   ← persistent browser for VNC users (on-demand)
  ├── x11vnc (port 5900, display :1)   ← captures display, accepts VNC connections (on-demand)
  ├── websockify (port 6080 → 5900)    ← VNC-to-WebSocket bridge for noVNC (on-demand)
  ├── code-server (port 8080)          ← existing, unchanged
  ├── OpenCode server (port 4096)      ← existing, unchanged
  ├── bridge.py                        ← existing, relays enable_vnc/disable_vnc commands
  └── screenshot tool                  ← existing, unchanged (own headless Chromium)
```

**Data flow:**

```
Browser (noVNC)  ──WSS──→  Modal tunnel (direct, no CF)  ──→  websockify :6080  ──→  x11vnc :5900  ──→  Xvfb :1
```

**Enable/disable flow:**

```
Web UI  ──→  CF Worker (session WS)  ──→  bridge.py  ──→  supervisor.start_vnc() / stop_vnc()
        ←──  vnc_info / vnc_stopped  ←──             ←──
```

## Changes by Package

### 1. Sandbox Image (`packages/modal-infra/src/images/base.py`)

Add VNC dependencies to `base_image` so all sandboxes are VNC-capable (~10MB added):

```python
# Add to existing apt_install or as a new apt_install chain
.apt_install(
    "xvfb",        # Virtual framebuffer (~2MB)
    "x11vnc",      # VNC server (~5MB)
    "websockify",  # VNC-to-WebSocket bridge (~1MB)
    "fluxbox",     # Minimal window manager (~3MB)
)
.run_commands(
    "mkdir -p /root/.fluxbox",
    # Hide toolbar — user only sees the browser
    "echo 'session.screen0.toolbar.visible: false' > /root/.fluxbox/init",
)
```

All image variants (`node_image`, `python_image`) inherit this since they extend `base_image`. The
VNC processes only start on-demand when a user requests it, so the ~10MB image cost is the only
overhead for sessions that never use VNC.

### 2. Sandbox Entrypoint (`packages/modal-infra/src/sandbox/entrypoint.py`)

Add new process management methods for on-demand VNC lifecycle:

- `start_vnc()` — called when bridge receives `enable_vnc` command, starts in sequence:
  1. Generate VNC password (`secrets.token_urlsafe(16)`)
  2. `Xvfb :1 -screen 0 1280x720x24` — virtual display
  3. `fluxbox` with `DISPLAY=:1` — window manager
  4. `chromium --no-sandbox --disable-gpu --start-maximized` with `DISPLAY=:1` — persistent browser
     opening `localhost:{DEV_SERVER_PORT}` if set, otherwise `about:blank`
  5. `x11vnc -display :1 -rfbport 5900 -passwd $VNC_PASSWORD -shared -forever` — VNC server
  6. `websockify 0.0.0.0:6080 localhost:5900` — WebSocket bridge
  7. Send `vnc_info` message back through bridge with password (tunnel URL is resolved by control
     plane from the already-tunneled port)
- `stop_vnc()` — called when bridge receives `disable_vnc` command, kills VNC processes in reverse
  order: websockify → x11vnc → Chromium → fluxbox → Xvfb. Sends `vnc_stopped` back through bridge.
- `_forward_vnc_logs()` — log forwarding (same pattern as code-server)
- Add VNC processes to `monitor_processes()` crash-restart loop (only when VNC is active)
- Add VNC processes to `shutdown()` cleanup

**No health check** — the tunnel URL is sent back immediately after starting processes. noVNC has
built-in reconnect/retry logic and handles the brief window before websockify is fully listening.

### 3. Sandbox Manager (`packages/modal-infra/src/sandbox/manager.py`)

```python
VNC_PORT = 6080
```

**`encrypted_ports`**: Always include `VNC_PORT` — `[CODE_SERVER_PORT, VNC_PORT]` (plus
`dev_server_port` if set). Tunneling the port is cheap; no processes run until the user enables VNC.

**`_resolve_vnc_tunnel()`**: New static method, same implementation as `_resolve_code_server_tunnel`
but for `VNC_PORT`. Called after sandbox creation to resolve the tunnel URL.

**`SandboxInfo` dataclass**: Add `vnc_url: str | None = None`.

**`create_sandbox()` and `restore_from_snapshot()`**: Add VNC tunnel resolution alongside existing
code-server logic. No VNC password generation at sandbox creation — password is generated on-demand
by the entrypoint when VNC is enabled.

### 4. Shared Types (`packages/shared/src/types/index.ts`)

Add to `ServerMessage`:

```typescript
| { type: "vnc_info"; url: string; password: string }
| { type: "vnc_stopped" }
```

Add to `ClientMessage` (or equivalent):

```typescript
| { type: "enable_vnc" }
| { type: "disable_vnc" }
```

Add to `SessionState`:

```typescript
vncUrl?: string | null;
vncPassword?: string | null;
```

### 5. Control Plane

**Schema** (`packages/control-plane/src/session/schema.ts`):

```sql
ALTER TABLE sandbox ADD COLUMN vnc_url TEXT;
ALTER TABLE sandbox ADD COLUMN vnc_password TEXT;
```

**Repository** (`packages/control-plane/src/session/repository.ts`):

- Add `updateSandboxVnc(url, password)` method (mirrors `updateSandboxCodeServer`)
- Add `clearSandboxVnc()` method for when VNC is disabled

**Types** (`packages/control-plane/src/session/types.ts`):

- Add `vnc_url: string | null` and `vnc_password: string | null` to `SandboxRow`

**Provider** (`packages/control-plane/src/sandbox/provider.ts`):

- Add `vncUrl?` to `SandboxInfo` and `SandboxCreateResult`

**Client** (`packages/control-plane/src/sandbox/client.ts`):

- Add `vnc_url` to API response parsing (mirrors code-server fields)

**Modal Provider** (`packages/control-plane/src/sandbox/providers/modal-provider.ts`):

- Pass through `vncUrl` from result

**Lifecycle Manager** (`packages/control-plane/src/sandbox/lifecycle/manager.ts`):

- Add `storeAndBroadcastVnc()` method (mirrors `storeAndBroadcastCodeServer`)
- Called when `vnc_info` message arrives from the sandbox (not at sandbox creation)

**Durable Object** (`packages/control-plane/src/session/durable-object.ts`):

- Handle `enable_vnc` / `disable_vnc` client messages — forward to sandbox via bridge
- Handle `vnc_info` / `vnc_stopped` from sandbox — store in DB, broadcast to connected clients
- Include `vncUrl` / `vncPassword` in `SessionState` sent to clients on subscribe

### 6. Web Client (`packages/web/`)

**No embedded noVNC viewer.** VNC opens in a new browser tab via the Modal tunnel URL, same pattern
as code-server's "Open Editor" link.

Add `VncSection` sidebar component (mirrors `CodeServerSection`):

```
packages/web/src/components/sidebar/vnc-section.tsx
```

**States:**

| VNC state | Sidebar UI |
|-----------|------------|
| Not started | "Enable Browser View" button |
| Starting | "Starting..." (disabled) |
| Running | "Open Browser" link (opens noVNC in new tab) + copy password button + "Disable" button |
| Stopping | "Stopping..." (disabled) |

**Behavior:**

- "Enable Browser View" sends `enable_vnc` through the session WebSocket
- When `vnc_info` arrives, sidebar transitions to the "Running" state with the link and password
- "Open Browser" opens the tunnel URL in a new tab (noVNC served by websockify)
- "Disable" sends `disable_vnc` through the session WebSocket
- When `vnc_stopped` arrives, sidebar transitions back to "Not started"
- Section is always visible in the right sidebar (unlike code-server which only shows when URL
  exists), since VNC is user-triggered

Add to `SessionRightSidebarContent` alongside the existing `CodeServerSection` and
`DevServerSection`.

## What's NOT in Scope

- Agent driving the VNC browser via CDP (future — expose `--remote-debugging-port=9222`)
- Video recording of VNC sessions
- Multi-user collaboration on the same VNC session (x11vnc `-shared` flag supports it, but no UI)
- Mobile-optimized VNC (screenshot tool covers mobile use case)

## Open Questions

- **Resolution**: Fixed 1280x720, or configurable? Fixed is simpler for v1.
- **Chromium start page**: Use `localhost:{DEV_SERVER_PORT}` if set, otherwise `about:blank`.
