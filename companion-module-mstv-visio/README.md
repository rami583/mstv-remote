# Companion Module: MSTV Visio

Bitfocus Companion module for controlling MSTV Visio from a StreamDeck.

The module talks to the local MSTV Visio Companion API:

- `POST http://HOST:3100/api/companion/action`
- `GET http://HOST:3100/api/companion/status`

## Requirements

- MSTV Visio running on the control Mac
- MSTV Visio Control window open
- Bitfocus Companion with local/custom module support
- Network access from Companion to the MSTV Visio host and port

## Install

For local development/custom installation:

1. Copy or clone `companion-module-mstv-visio` into your Companion module development folder.
2. From the module folder, run:

   ```sh
   yarn install
   ```

3. Restart Companion or reload local modules.
4. Add the `MSTV Visio` connection.

If you package the module, run:

```sh
yarn package
```

## Configuration

Connection fields:

- `MSTV Visio Host`
  - default: `127.0.0.1`
  - use the IP address or hostname of the Mac running MSTV Visio if Companion runs elsewhere
- `Port`
  - default: `3100`

For the standard one-Mac setup, keep:

```text
Host: 127.0.0.1
Port: 3100
```

## Actions

The module exposes these actions:

- `Select Guest 1`
- `Select Guest 2`
- `Select Guest 3`
- `Select Guest 4`
- `Select Guest 5`
- `Select Guest 6`
- `Select Guest 7`
- `Select Guest 8`
- `Select Guest 9`
- `Toggle PIP`
- `Toggle Mute All`

Guest indexes match the guest tile order shown in MSTV Visio Control.

## Feedbacks

The module polls MSTV Visio every `400ms` and updates button feedbacks.

Available feedbacks:

- `Guest button active`
  - green when that guest index is currently in Program
  - neutral gray otherwise
- `PIP active`
  - green when PIP is enabled
  - neutral gray otherwise
- `Mute active`
  - red when global mute is active
  - neutral gray otherwise

## Presets

Ready-to-use presets are included:

- `Guest 1` through `Guest 9`
- `PIP`
- `MUTE`

Each preset includes its action and feedback color.

## Notes

- This module intentionally uses HTTP polling only.
- No WebSocket, guest names, or advanced variables are included yet.
- MSTV Visio must keep the Control window open so it can apply queued Companion actions.
