# MSTV Slides Receiver

MSTV Slides Receiver is a small macOS app for the slide-display Mac.

## Compatibility Builds

`npm run slides:build` generates two MSTV Slides Receiver apps:

- Intel / Catalina Mac: `dist-slides/mac/MSTV Slides Receiver.app`
- Apple Silicon / recent macOS Mac: `dist-slides/mac-arm64/MSTV Slides Receiver.app`

Both builds pin MSTV Slides Receiver to Electron `27.3.11`. This keeps the Intel build compatible with macOS 10.15 Catalina while also producing a native Apple Silicon build. This compatibility pin applies only to MSTV Slides Receiver; MSTV Remote keeps its own Electron version.

It runs a local HTTP server on port `4317`:

- `GET /health`
- `POST /next`
- `POST /prev`

`POST /next` advances slides. `POST /prev` goes back.

For Microsoft PowerPoint, the receiver first tries direct PowerPoint AppleScript in slideshow mode, then falls back to keyboard events. PowerPoint should be in slideshow/presentation mode for reliable control.

## Use

1. Open `MSTV Slides Receiver.app` on the Mac showing Keynote, PowerPoint, or another slide app.
2. Confirm the app says `EN ATTENTE` or `CONNECTÉ`.
3. Select the target app in the receiver: `PowerPoint`, `Keynote`, or `Aperçu / Preview`. PowerPoint is selected by default.
4. Start the Keynote or PowerPoint presentation/slideshow, or open the PDF presentation in Preview.
5. In MSTV Remote Control, set Slide Receiver host to the receiver Mac address, for example `mac-slides.local` or `192.168.1.40`.
6. Keep port `4317`.

## macOS Permission

The receiver needs Accessibility permission to send keyboard arrow events.

Open:

System Settings > Privacy & Security > Accessibility

Then enable `MSTV Slides Receiver`.

If permission is missing, the app shows a warning.
