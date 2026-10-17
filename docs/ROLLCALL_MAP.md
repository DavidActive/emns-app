# Roll-call map and Active SOS app alerts (P17)

- An Active SOS app alert (SOS or Safe) from a person who is part of an open notification now counts as their answer in that notification's roll-call, with the app's GPS coordinates. The inbox item is created as before.
- Matching: the person's most recent notification that asked for an answer, within 72 hours (any channel). A person who was never contacted (for example no consent), another organization's person, or someone with no open notification is not matched; their alert behaves exactly as before.
- A Safe alert whose reason contains a crisis keyword is escalated to SOS, as it already is for the inbox.
- The roll-call page shows a map: red = SOS, green = safe. People who answered without a location are listed under the map. The map fits to the pins once, so a live refresh does not move it.
- Tiles: OpenStreetMap by default. Set `VITE_MAP_TILE_URL` (and `VITE_MAP_ATTRIBUTION`) at build time to use an approved tile server on a network that blocks OpenStreetMap. Without tiles the pins and the list still work.
- Not covered yet: location on answers from text, voice or desktop. Only the Active SOS app attaches GPS.
- Database: migration `20261016001800_app_alert_rollcall.sql`, test `supabase/tests/app_alert_rollcall.sql`.
