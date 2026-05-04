# Architecture Overview

## Product Model

Visio MSTV is a supervised studio workflow, not a peer meeting app.

- Guests publish contribution feeds upstream.
- Guests receive only the studio program return.
- Guests never see or hear each other.
- Control room users supervise all participants.
- Program monitoring is downstream-only.

## LiveKit Topology

Each production room slug expands into two LiveKit rooms:

- `roomSlug--contribution`
  For guest camera/mic contribution feeds and control-room monitoring.
- `roomSlug--program`
  For studio return video/audio and confidence monitoring.

This dual-room topology enforces asymmetry at the transport level:

- Guest surface joins `--contribution` as publish-only.
- Guest surface joins `--program` as subscribe-only.
- Control surface joins both as monitor-only.
- Program surface joins `--program` as subscribe-only.

Guests never connect to a shared guest gallery, so there is no guest-to-guest media path to accidentally expose.

## Request Flow

1. A surface loads `/guest/[room]`, `/control/[room]`, or `/program/[room]`.
2. The client requests one or more scoped tokens from `POST /api/livekit/token`.
3. The token route derives the real LiveKit room name from the room slug and session channel.
4. The route issues LiveKit JWT grants with publish and subscribe permissions scoped to the requested surface.
5. The browser connects only to the channels it is allowed to use.

## Simple Workflow Mapping

Using your real workflow, a single production such as `morning-show-a` works like this:

1. Guest A joins `morning-show-a--contribution` as publish-only.
2. Guest A also joins `morning-show-a--program` as subscribe-only.
3. Guest B does the same, but with separate participant identities.
4. The control room joins both rooms as subscribe-only monitors.
5. The program monitor joins `morning-show-a--program` as subscribe-only.

That gives you structural clarity:

- All guest cameras and microphones go into the contribution room.
- The control room watches that contribution room to supervise every guest.
- The studio output is published into the program room.
- Every guest listens only to the program room, never to another guest.

## Clear Answers To The Topology Questions

### 1. Which participants join which room

- Each guest joins two rooms:
  `roomSlug--contribution` to send camera and microphone upstream.
  `roomSlug--program` to receive the studio return downstream.
- Control-room users join both rooms:
  `roomSlug--contribution` to monitor guest feeds.
  `roomSlug--program` to monitor what guests are receiving.
- Program monitors join only `roomSlug--program`.

### 2. How control_room monitors all guests

Every guest publishes into the same contribution room for that production. The control room subscribes to that contribution room, so it can see and hear every guest feed in one place. No guest needs visibility into any other guest for the control room to supervise all of them.

### 3. How each guest receives only the program return

Guests do not subscribe to the contribution room at all. Their receive path is a separate connection to the program room, where the only intended downstream feed is the studio program return. Because guests never receive from the contribution room, they never hear or see each other.

### 4. How private and broadcast messaging works

Messaging stays app-level and role-aware rather than becoming room chat.

- Private guest cue:
  Control room sends a message targeted to one guest identity. Only that guest UI renders it.
- Guest broadcast:
  Control room fan-outs the same cue to multiple guest identities, but it is still delivered as directed operator messaging, not open chat.
- Control-room broadcast:
  Routing and health alerts target control-room identities only.
- Program log:
  Tally and downstream status can target the program monitor log without appearing on guest surfaces.

The important part is that messaging does not depend on putting guests in a shared social room. Media topology and messaging topology remain separate.

### 5. How room names and identities are structured

- Room names:
  `roomSlug--contribution`
  `roomSlug--program`
- Participant identity format:
  `roomSlug:surfaceRole:channel:roleLabel:instanceId`

Examples:

- `morning-show-a:guest:contribution:guest:4f3b9c2a`
- `morning-show-a:guest:program:guest:4f3b9c2a`
- `morning-show-a:control:contribution:operator:desk-a`
- `morning-show-a:program:program:program:monitor-1`

This keeps naming predictable and makes it easy to inspect logs, tokens, and telemetry.

## Concrete Operational Flow

### One guest

For a room slug such as `election-night`:

1. The guest opens `/guest/election-night`.
2. The guest page requests two tokens:
   one for `election-night--contribution`
   one for `election-night--program`
3. The guest opens two LiveKit connections:
   a publish-only connection to the contribution room
   a subscribe-only connection to the program room
4. The guest sends mic/camera upstream on the contribution connection.
5. The guest receives only the studio output on the program connection.

The guest never subscribes to the contribution room, so there is no path to hear or see other guests.

### One control-room operator

1. The operator opens `/control/election-night`.
2. The control page requests two tokens:
   one for the contribution room
   one for the program room
3. The operator opens two LiveKit monitor connections:
   subscribe-only to `election-night--contribution`
   subscribe-only to `election-night--program`
4. In the contribution room, the operator monitors every guest feed.
5. In the program room, the operator confirms the downstream return being sent back to guests.

### One program_feed publisher

The program feed publisher is the component or workstation that inserts the actual studio program into the program room.

1. The publisher connects to `election-night--program`.
2. It publishes the downstream studio program audio/video there.
3. Guests and control-room monitors subscribe to that same program room.

This can be a dedicated web surface later, but the architecture already assumes a single publisher path feeding the program room.

## Connection Counts

- Each guest opens 2 LiveKit connections.
  One to `roomSlug--contribution`, one to `roomSlug--program`.
- Each control-room operator opens 2 LiveKit connections.
  One to monitor contribution, one to monitor program.
- The program feed publisher opens 1 LiveKit connection.
  It publishes only to `roomSlug--program`.

This is still operationally simple because every room slug expands to only two media rooms, and each role has a fixed connection pattern.

## Failure Modes

### Guest can publish but cannot receive program

Meaning:
The guest contribution room is healthy, but the guest program-room connection or downstream program feed is broken.

Operational effect:
- Control room still sees the guest.
- Guest cannot hear or see studio return.

Where to check:
- guest token for `roomSlug--program`
- program room connection state on guest surface
- presence of a program publisher in `roomSlug--program`

### Guest receives program but cannot publish mic/cam

Meaning:
The guest program-room connection is healthy, but the contribution connection or local capture publish path is broken.

Operational effect:
- Guest still hears or sees studio return.
- Control room loses the guest’s upstream feed.

Where to check:
- guest token for `roomSlug--contribution`
- browser capture permission
- contribution room publish state

### Control room sees contribution but not program

Meaning:
The control operator is subscribed correctly to the contribution room but not successfully connected to the program room, or the program room has no active publisher.

Operational effect:
- Operator can supervise guests.
- Operator cannot verify what guests are receiving downstream.

Where to check:
- control token for `roomSlug--program`
- operator program-room connection state
- program publisher presence

### Program feed is missing

Meaning:
No active publisher is feeding `roomSlug--program`.

Operational effect:
- Guests remain isolated from each other, which is good.
- Guests receive silence or black instead of the studio return.
- Control room can still monitor guest contribution in the contribution room.

This separation is why the two-room architecture is robust in live operation: contribution failure and program-return failure are isolated, easier to diagnose, and less likely to create accidental cross-guest exposure.

## Folder Structure

```text
/Users/rami/Desktop/Visio MSTV
├── docs/
│   └── architecture.md
├── src/
│   ├── app/
│   │   ├── api/livekit/token/route.ts
│   │   ├── control/[room]/page.tsx
│   │   ├── guest/[room]/page.tsx
│   │   ├── program/[room]/page.tsx
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── components/
│   │   ├── livekit/
│   │   │   └── live-session-card.tsx
│   │   └── studio/
│   │       ├── control-room-client.tsx
│   │       ├── guest-room-client.tsx
│   │       ├── message-rail.tsx
│   │       ├── program-room-client.tsx
│   │       └── surface-shell.tsx
│   └── lib/
│       ├── livekit/
│       │   ├── browser-token.ts
│       │   ├── env.ts
│       │   ├── identity.ts
│       │   ├── permissions.ts
│       │   ├── token.ts
│       │   └── topology.ts
│       ├── studio/
│       │   └── demo-state.ts
│       └── types/
│           ├── livekit.ts
│           ├── messaging.ts
│           └── roles.ts
├── .env.example
├── next.config.ts
├── package.json
├── postcss.config.js
├── tailwind.config.ts
└── tsconfig.json
```

## Core Modules

- `src/lib/types/roles.ts`
  Role and surface definitions for guest, control, program, and control-room specialties.
- `src/lib/types/messaging.ts`
  Operator cue and system-message schema. This is not a chat model.
- `src/lib/livekit/topology.ts`
  Converts route room slugs into concrete LiveKit room names.
- `src/lib/livekit/identity.ts`
  Builds stable participant identities so every route follows the same naming convention.
- `src/lib/livekit/permissions.ts`
  Encodes publish and subscribe grants for each surface and channel pairing.
- `src/lib/livekit/token.ts`
  Creates scoped LiveKit access tokens on the server.
- `src/lib/livekit/browser-token.ts`
  Client helper for requesting tokens from the Next.js route handler.
- `src/components/livekit/live-session-card.tsx`
  Reusable session wrapper that connects to LiveKit and renders monitoring state.
- `src/components/studio/*`
  Surface-specific shells for guest, control, and program routing.

## Messaging Data Model

Messaging is limited to operator cues, tally state, routing alerts, and acknowledgements. There is no guest-to-guest chat channel in the model.

- `cue`
  Operator instruction sent to one guest or a control-room group.
- `tally`
  On-air, standby, or cleared state.
- `routing`
  Media-path status such as return loss or contribution muted.
- `system`
  Session lifecycle and connection health.
- `ack`
  Confirmation that a cue or alert was received.

Targets are explicit:

- a single guest
- a set of guests
- the control room
- the program monitor log

That keeps communication aligned with supervision and routing rather than social interaction.
