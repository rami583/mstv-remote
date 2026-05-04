# MSTV Remote Desktop

## Runtime Architecture

The macOS app is the operator workstation for MSTV Remote. It opens only the
native Control window and Program Output window, and in packaged mode it starts
its own local Next server for those desktop surfaces.

Guests always remain browser-based and must join from a normal public web route:

```text
https://visio.monstudiotv.com/guest/[roomSlug]
```

In development, keep the normal web server running for browser guests:

```bash
npm run dev
```

The guest URL is still served by the web app, for example:

```bash
http://localhost:3000/guest/studio
```

The desktop app serves Control and Program internally on the operator machine,
normally at:

```bash
http://127.0.0.1:3100/control/studio
http://127.0.0.1:3100/program/studio
```

For production, deploy the guest web app somewhere reachable by guests, and run
the macOS app on the studio machine for Control and Program Output. Both must use
the same LiveKit server and room slug.

Configure the room slug used by the desktop app with:

```bash
MSTV_DESKTOP_ROOM=studio
```

Configure the public guest link shown in the Control window with:

```bash
GUEST_PUBLIC_BASE_URL=https://visio.monstudiotv.com
```

With these values, the desktop opens its internal operator surfaces for
`studio`, and the Control window displays/copies:

```text
https://visio.monstudiotv.com/guest/studio
```

`npm run dev` is only for local development/testing. It is not the production
guest hosting model.

## Environment

The desktop app needs the LiveKit server credentials on the server side:

```bash
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
MSTV_DESKTOP_ROOM=studio
GUEST_PUBLIC_BASE_URL=https://visio.monstudiotv.com
```

These values are loaded by the Electron main process before it starts the bundled Next server. They are not injected into the renderer window.

For desktop development, place `.env.local` at the project root:

```bash
/Users/rami/Desktop/Visio MSTV/.env.local
```

For the packaged macOS app, use one of these options:

```bash
~/Library/Application Support/MSTV Remote/.env.local
~/.mstv-remote/.env.local
```

During local packaged testing from this repository, the app also searches parent folders above the `.app`, so the project-root `.env.local` is found when launching:

```bash
/Users/rami/Desktop/Visio MSTV/dist/mac-arm64/MSTV Remote.app
```

To force a specific env file path:

```bash
MSTV_DESKTOP_ENV_FILE=/absolute/path/to/.env.local npm run desktop:dev
```

The desktop log reports which env file was found and which required keys are present or missing. It never logs secret values.

```bash
~/Library/Application Support/MSTV Remote/desktop.log
```

## macOS Camera And Microphone Permissions

MSTV Remote must be allowed to use camera and microphone devices before STUDIO
or REGIE inputs can publish a return feed. The packaged app includes
`NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, and the macOS camera
and audio-input entitlements on the main app and Electron helper bundles.

If an input shows `Permission denied`, open:

```text
System Settings > Privacy & Security > Camera
System Settings > Privacy & Security > Microphone
```

Enable `MSTV Remote`, then quit and reopen the app. On some development builds,
macOS may ask again after rebuilding the `.app`.

If MSTV Remote still does not appear, launch the rebuilt `.app` once from Finder
or with `npm run desktop:open`, then select a STUDIO/REGIE video or audio input
so macOS receives an actual camera/microphone access request.
