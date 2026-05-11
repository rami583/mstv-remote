# Virtual Background Prototype

Standalone browser proof-of-concept for evaluating browser-based AI background replacement quality.

This is intentionally isolated from MSTV Visio:

- no LiveKit
- no Electron
- no upload
- no persistence
- no MSTV integration

## What It Tests

Pipeline:

1. Local webcam capture
2. MediaPipe Selfie Segmentation
3. Real-time canvas composition
4. Background modes:
   - original webcam
   - blurred background
   - professional image background
5. Approximate FPS display
6. Safari blur engine comparison:
   - Canvas `ctx.filter`
   - CSS filtered layer
   - SVG `feGaussianBlur`
   - multi-pass canvas approximation
   - lightweight JS blur fallback

Rendering note:

- Webcam output is intentionally non-mirrored to match the MSTV Visio Guest page.
- Blur mode keeps the blurred background and sharp foreground on the exact same framing/crop.

Controls:

- `Choisir une image de fond`: import a JPG, PNG or WebP background image for image mode
- `Blur engine`: switch blur implementations live, useful for Safari comparison
- `Blur amount`: adjust visible webcam background blur
- `Edge softness`: feather the segmentation mask to reduce hard/jagged contours

Use it to evaluate:

- edge quality
- hair quality
- movement quality
- latency
- CPU/fan behavior
- overall “Teams-level” perception

## Run Locally

From the repository root:

```sh
python3 -m http.server 8088 --directory prototypes/virtual-background
```

Open:

```text
http://127.0.0.1:8088
```

Then click `Start Camera`.

## Notes

The page loads React and MediaPipe from public CDNs, so it needs internet access the first time it is opened.

For a fair test:

- test with normal studio lighting
- test with glasses and hair movement
- test with a corporate webcam framing
- compare image background vs blur background
- try a custom corporate image background
- adjust edge softness until contours are smoother without creating a visible halo
- watch whether FPS remains stable over several minutes
