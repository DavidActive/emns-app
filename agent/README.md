# Active SOS eMNS Desktop Agent

Windows tray app (Electron). See `../docs/DESKTOP_AGENT.md` for the full design and IT notes.

    cd agent
    npm install
    npm test        # core logic tests
    npm start       # run from source
    npm run dist    # NSIS + MSI in dist/ (run on Windows; sign with your certificate)

Core logic lives in `src/core` (no Electron dependency). Electron wiring is in `src/main.cjs`.
