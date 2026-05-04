import { NextResponse } from "next/server";
import { z } from "zod";
import { getProductionSnapshot, upsertParticipantState } from "@/lib/studio/production-state";
import { controlRoles, sessionChannels, surfaceRoles } from "@/lib/types/roles";

const participantStateSchema = z.object({
  room: z.string().trim().min(1).max(120),
  roomName: z.string().trim().min(1).max(180),
  participantId: z.string().trim().min(1).max(180),
  displayName: z.string().trim().min(1).max(180),
  surfaceRole: z.enum(surfaceRoles),
  channel: z.enum(sessionChannels),
  controlRole: z.enum(controlRoles).optional(),
  connectionState: z.string().trim().min(1).max(80),
  participantCount: z.number().int().min(0),
  videoTrackCount: z.number().int().min(0),
  cameraPublished: z.boolean(),
  microphonePublished: z.boolean(),
  cameraTrackState: z.object({
    published: z.boolean(),
    muted: z.boolean(),
    missing: z.boolean()
  }),
  microphoneTrackState: z.object({
    published: z.boolean(),
    muted: z.boolean(),
    missing: z.boolean()
  }),
  hasProgramFeed: z.boolean(),
  isMicrophoneMutedByControl: z.boolean()
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ room: string }> }
) {
  const { room } = await params;
  return NextResponse.json(getProductionSnapshot(room));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ room: string }> }
) {
  const { room } = await params;
  const body = await request.json().catch(() => null);
  const parsed = participantStateSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid participant state payload.",
        issues: parsed.error.flatten()
      },
      { status: 400 }
    );
  }

  return NextResponse.json(upsertParticipantState({ ...parsed.data, room }));
}
