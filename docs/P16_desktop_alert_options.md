# P16: Desktop alert channel. Two options (nothing built yet)

Goal: an alert appears on staff computers, not only phones. The database already allows a `desktop` delivery channel, so either option plugs into the same queue, fallback rules and timeline as text, email and voice.

## Option A: Browser web push
A service worker in the eMNS web app receives push messages through the browser's push service (Chrome and Edge use Google or Microsoft services, Firefox uses Mozilla's). Staff open eMNS once, click Allow, and the browser shows a system notification.

| | |
|---|---|
| **Good** | No software to install or approve. Fastest to build (a few days). Works on Windows, Mac, Linux and Android. Pushed through the existing queue. |
| **Risks in a hospital** | Needs the browser to be running (Chrome and Edge keep a background process by default, but IT policy can turn that off). Delivery goes through Google/Microsoft/Mozilla push servers: many hospital firewalls block those outbound endpoints. Shared or non-persistent workstations (VDI, Citrix, roaming profiles) lose the permission. Windows Focus Assist / Do Not Disturb can silence it. It is a normal notification, not a full-screen alarm. Not guaranteed delivery. Browser permission must be granted per person per browser. |
| **Needs from IT** | Outbound HTTPS to the browser push services, browsers allowed to run in the background, notifications permitted by policy (can be pushed with Chrome/Edge group policy). |
| **Effort** | Small. |

## Option B: Small desktop agent
A signed Windows (and optionally Mac) tray app that signs in as the employee, keeps one outbound connection to emns.activesos.com, and shows an always-on-top alert window with sound and an "I'm safe / need help" button. IT deploys it with Intune, SCCM or group policy.

| | |
|---|---|
| **Good** | Works whether or not a browser is open. Can take over the screen with sound until acknowledged. Needs only one outbound address (our server), which is easier to allowlist than push services. Can report that it is online (a "this workstation is reachable" count in the roll-call). Pushed and configured centrally. |
| **Risks in a hospital** | Requires IT security review and approval of new software, a code-signing certificate, and an update process. Per-OS builds. Antivirus and endpoint-protection exceptions may be needed. VDI and kiosk setups need it on the image. Longer to build and to support. |
| **Needs from IT** | Software approval, a deployment method, outbound HTTPS to one address, and a decision on full-screen takeover. |
| **Effort** | Medium to large (weeks), plus ongoing maintenance. |

## Recommendation
Choose by what IT will actually allow:
- If IT allows push services and browsers stay open: **start with A** to prove the channel, because it costs little and reuses everything.
- If staff are on shared, virtual or locked-down desktops, or the alert must be impossible to miss: **B**, and treat A as an optional extra for managers.
Many hospitals end up with B for reliability. Ask IT the questions below before deciding.

## Questions for hospital IT
1. How are workstations managed (Intune, SCCM, other), and are they shared, virtual (VDI/Citrix) or personal?
2. Which browser is standard, and may it run in the background and show notifications?
3. Is outbound HTTPS to Google, Microsoft and Mozilla push services allowed?
4. Can new signed software be approved and deployed, and how long does that review take?
5. Is a full-screen, always-on-top alert allowed, and should it require acknowledgement?
6. Should the alert reach computers in clinical areas only, or all staff?
