# MSTV Visio

Next.js scaffold for an asymmetrical studio contribution system built with TypeScript, Tailwind CSS, LiveKit, and Node.js token routes.

## Stack

- Next.js App Router
- TypeScript
- Tailwind CSS
- LiveKit client + server SDK
- Node.js route handlers for token generation

## Start here

- Architecture overview: [docs/architecture.md](/Users/rami/Desktop/Visio%20MSTV/docs/architecture.md)
- Guest surface: `/guest/[room]`
- Control surface: `/control/[room]`
- Program monitor: `/program/[room]`

## Environment

Copy `.env.example` to `.env.local` and provide:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

## Notes

This scaffold deliberately avoids a generic multi-party meeting model. Each production room is split into:

- one LiveKit contribution room for guest upstream feeds
- one LiveKit program room for downstream studio return

That separation is what prevents guest-to-guest audio/video paths.
