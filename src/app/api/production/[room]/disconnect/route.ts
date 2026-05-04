import { NextResponse } from "next/server";
import { z } from "zod";
import { getRoomServiceClient } from "@/lib/livekit/admin";
import { deriveParticipantIdentityChannel } from "@/lib/livekit/identity";
import { getLiveKitRoomName } from "@/lib/livekit/topology";
import { getProductionSnapshot, removeParticipantState } from "@/lib/studio/production-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const disconnectSchema = z.object({
  participantId: z.string().trim().min(1).max(180)
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ room: string }> }
) {
  const { room } = await params;
  const body = await request.json().catch(() => null);
  const parsed = disconnectSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid disconnect payload.",
        issues: parsed.error.flatten()
      },
      { status: 400 }
    );
  }

  const contributionParticipantId = parsed.data.participantId;
  const snapshot = getProductionSnapshot(room);

  if (snapshot.programGuestIds.includes(contributionParticipantId)) {
    return NextResponse.json({
      room,
      disconnectedParticipantIds: [],
      skipped: true,
      reason: "participant-in-program"
    });
  }

  const programParticipantId =
    deriveParticipantIdentityChannel(contributionParticipantId, "program") ?? contributionParticipantId;
  const contributionRoomName = getLiveKitRoomName(room, "contribution");
  const programRoomName = getLiveKitRoomName(room, "program");
  const roomService = getRoomServiceClient();

  const removals = [
    roomService.removeParticipant(contributionRoomName, contributionParticipantId),
    roomService.removeParticipant(programRoomName, programParticipantId)
  ];

  const settled = await Promise.allSettled(removals);
  const failure = settled.find(
    (result) => result.status === "rejected" && !(result.reason instanceof Error && /not\s*found/i.test(result.reason.message))
  );

  if (failure && failure.status === "rejected") {
    return NextResponse.json(
      {
        error: failure.reason instanceof Error ? failure.reason.message : "Unable to disconnect guest."
      },
      { status: 500 }
    );
  }

  removeParticipantState(room, contributionParticipantId);
  removeParticipantState(room, programParticipantId);

  return NextResponse.json({
    room,
    disconnectedParticipantIds: [contributionParticipantId, programParticipantId]
  });
}
