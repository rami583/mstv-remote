import { NextResponse } from "next/server";
import { z } from "zod";
import {
  acknowledgeCommand,
  enqueueMuteMicrophoneCommand,
  getPendingCommands
} from "@/lib/studio/production-state";

const commandQuerySchema = z.object({
  participantId: z.string().trim().min(1).max(180)
});

const enqueueSchema = z.object({
  action: z.literal("enqueue"),
  type: z.literal("mute-microphone"),
  targetParticipantId: z.string().trim().min(1).max(180),
  createdBy: z.string().trim().min(1).max(180)
});

const acknowledgeSchema = z.object({
  action: z.literal("acknowledge"),
  commandId: z.string().trim().min(1).max(180),
  participantId: z.string().trim().min(1).max(180)
});

const commandSchema = z.union([enqueueSchema, acknowledgeSchema]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ room: string }> }
) {
  const { room } = await params;
  const searchParams = new URL(request.url).searchParams;
  const parsed = commandQuerySchema.safeParse({
    participantId: searchParams.get("participantId")
  });

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid command query."
      },
      { status: 400 }
    );
  }

  return NextResponse.json(getPendingCommands(room, parsed.data.participantId));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ room: string }> }
) {
  const { room } = await params;
  const body = await request.json().catch(() => null);
  const parsed = commandSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid command payload.",
        issues: parsed.error.flatten()
      },
      { status: 400 }
    );
  }

  if (parsed.data.action === "enqueue") {
    return NextResponse.json(
      enqueueMuteMicrophoneCommand({
        room,
        targetParticipantId: parsed.data.targetParticipantId,
        createdBy: parsed.data.createdBy
      })
    );
  }

  const acknowledged = acknowledgeCommand({
    room,
    commandId: parsed.data.commandId,
    participantId: parsed.data.participantId
  });

  if (!acknowledged) {
    return NextResponse.json(
      {
        error: "Command not found."
      },
      { status: 404 }
    );
  }

  return NextResponse.json(acknowledged);
}
