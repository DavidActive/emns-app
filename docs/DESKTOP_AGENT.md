# eMNS Desktop Agent (P16)

A small Windows tray app that shows an eMNS alert on a work computer and lets the person answer "I'm safe" or "I need help".

## How it works
1. The employee opens **My contact** in eMNS and chooses **Get a pairing code** (8 characters, one use, short expiry).
2. They type the code into the agent on their PC. The agent receives a device token. Only SHA-256 hashes of the code and token are stored on the server.
3. The agent keeps one outbound HTTPS long-poll open to the eMNS address. Nothing connects in to the PC.
4. A sender picks the **Desktop alert** channel. Status mapping: handed to agent = *sent*; shown on screen = *delivered*; "I'm safe" / "I need help" = SAFE / SOS acknowledgement. SOS opens a critical inbox item.
5. If no agent collects the alert within 120 s (`EMNS_DESKTOP_WAIT_SECONDS`) the delivery becomes *undelivered / agent_offline* and the next fallback channel (for example text) is released. A person with no enrolled computer is skipped (`no_agent`). A computer that reconnects within 6 h still receives the alert.
6. Answering on one computer closes the alert on the person's other computers.

## For IT (Intune / SCCM)
- Installers: `ActiveSOS-eMNS-Agent-<version>-x64.exe` (NSIS) and `.msi`, per-machine. Silent install: `/S` (exe) or `msiexec /i <file>.msi /qn`.
- Optional config at `%ProgramData%\ActiveSOS\eMNS\config.json`:
  `{ "serverUrl": "https://emns.example.org", "takeover": "window" | "fullscreen", "allowQuit": false, "sound": true }`
  With `serverUrl` set, the employee only types the code.
- Network: one outbound HTTPS address (the eMNS server). It uses the system proxy and enterprise CAs.
- Code signing: sign the installers with your certificate before deployment (set `CSC_LINK` / `CSC_KEY_PASSWORD` for electron-builder).
- Starts at login; the token is encrypted with Windows DPAPI; alerts are saved to disk before display and answers are queued and retried if offline.

## Server settings
| Variable | Default | Meaning |
|---|---|---|
| `EMNS_AGENT_POLL_SECONDS` | 8 (max 25) | Long-poll length. Keep under the host's function time limit (Netlify: 10 s). |
| `EMNS_AGENT_POLL_STEP_MS` | 2000 | Check interval inside a poll. |
| `EMNS_DESKTOP_WAIT_SECONDS` | 120 | Wait before falling back. |

The portable container server has no 10 s limit, so use a longer poll there. Per-device report limit: 120/min; enroll limit: 10/min per IP; 5 devices per person.

## Deferred
SSO device-flow or IT bulk auto-enroll, auto-update, multi-monitor takeover, websocket/Realtime transport.

## Verification status
Server logic and the agent core are unit-tested (`tests/desktopAgent.test.cjs`). `supabase/tests/desktop_agent.sql` covers the database. **The Electron app and Windows installers have not been run or built in the development container** (no Windows or display); build, sign and pilot on a real PC before relying on it.
