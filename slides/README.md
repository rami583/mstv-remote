# MSTV Slides Receiver

MSTV Slides Receiver is a small macOS app for the slide-display Mac.

It runs a local HTTP server on port `4317`:

- `GET /health`
- `POST /next`
- `POST /prev`

`POST /next` advances slides. `POST /prev` goes back.

For Microsoft PowerPoint, the receiver first tries direct PowerPoint AppleScript in slideshow mode, then falls back to keyboard events. PowerPoint should be in slideshow/presentation mode for reliable control.

## Use

1. Open `MSTV Slides Receiver.app` on the Mac showing Keynote, PowerPoint, or another slide app.
2. Confirm the app says `Running`.
3. Start the Keynote or PowerPoint presentation/slideshow.
4. In MSTV Remote Control, set Slide Receiver host to the receiver Mac address, for example `mac-slides.local` or `192.168.1.40`.
5. Keep port `4317`.

## macOS Permission

The receiver needs Accessibility permission to send keyboard arrow events.

Open:

System Settings > Privacy & Security > Accessibility

Then enable `MSTV Slides Receiver`.

If permission is missing, the app shows a warning.
