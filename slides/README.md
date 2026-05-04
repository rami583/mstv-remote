# MSTV Click

MSTV Click is a small macOS app for the slide-display Mac.

## Compatibility Builds

`npm run slides:build` generates two MSTV Click apps:

- Intel / Catalina Mac: `dist-slides/mac/MSTV Click.app`
- Apple Silicon / recent macOS Mac: `dist-slides/mac-arm64/MSTV Click.app`

Both builds pin MSTV Click to Electron `27.3.11`. This keeps the Intel build compatible with macOS 10.15 Catalina while also producing a native Apple Silicon build. This compatibility pin applies only to MSTV Click; MSTV Visio keeps its own Electron version.

It runs a local HTTP server on port `4317`:

- `GET /health`
- `POST /next`
- `POST /prev`

`POST /next` advances slides. `POST /prev` goes back.

For Microsoft PowerPoint, the receiver first tries direct PowerPoint AppleScript in slideshow mode, then falls back to keyboard events. PowerPoint should be in slideshow/presentation mode for reliable control.

## Use

1. Open `MSTV Click.app` on the Mac showing Keynote, PowerPoint, or another slide app.
2. Confirm the app says `EN ATTENTE` or `CONNECTÉ`.
3. Select the target app in the receiver: `PowerPoint`, `Aperçu`, or `Keynote`. PowerPoint is selected by default.
4. Start the Keynote or PowerPoint presentation/slideshow, or open the PDF presentation in Preview.
5. In MSTV Visio Control, set Slide Receiver host to the receiver Mac address, for example `mac-slides.local` or `192.168.1.40`.
6. Keep port `4317`.

## macOS Permission

The receiver needs Accessibility permission to send keyboard arrow events.

Open:

System Settings > Privacy & Security > Accessibility

Then enable `MSTV Click`.

If permission is missing, the app shows a warning.
