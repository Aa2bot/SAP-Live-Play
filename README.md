# SAP Live Play (Chrome Extension)

This extension runs on the SAP web client and continuously captures `arena/watch` and `versus/watch` request/response data.

## What it does

- Injects a network hook into SAP game frames (`teamwood.itch.io`, `itch.zone`, `hwcdn.net`).
- Captures outbound `POST` data to:
  - `https://api.teamwood.games/0.45/api/arena/watch`
  - `https://api.teamwood.games/0.45/api/versus/watch`
- Captures matching response payloads.
- Stores entries in extension storage as a rolling log.
- Shows a live monitor panel on the game page with:
  - copy latest entry
  - copy full log
  - clear log

## Install

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder.

## Usage

1. Open Super Auto Pets web build.
2. Play normally.
3. Use the bottom-left `SAP Live Play Monitor` panel to inspect/copy captures.
