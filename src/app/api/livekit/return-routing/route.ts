import { NextResponse } from "next/server";
import { z } from "zod";
import { getRoomServiceClient } from "@/lib/livekit/admin";
import { parseParticipantMetadata } from "@/lib/livekit/metadata";
import { getLiveKitRoomName, normalizeRoomSlug } from "@/lib/livekit/topology";
import { returnSources, type ReturnSource } from "@/lib/types/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const returnRoutingSyncSchema = z.object({
  room: z.string().trim().min(1).max(120),
  globalReturnSource: z.enum(returnSources),
  programGuestIds: z.array(z.string().trim().min(1).max(180)),
  programMutedGuestIds: z.array(z.string().trim().min(1).max(180)).optional(),
  regieMutedGuestIds: z.array(z.string().trim().min(1).max(180)).optional(),
  slideControlEnabledGuestIds: z.array(z.string().trim().min(1).max(180)).optional(),
  guestReturnOverrides: z.record(z.enum(returnSources).optional()),
  routingVersion: z.number().finite().positive()
});

function deriveContributionParticipantId(programParticipantId: string) {
  return programParticipantId.replace(":guest:program:", ":guest:contribution:");
}

function getEffectiveReturnSource(input: {
  contributionParticipantId: string;
  programGuestIds: string[];
  globalReturnSource: ReturnSource;
  guestReturnOverrides: Record<string, ReturnSource | undefined>;
}) {
  if (input.programGuestIds.includes(input.contributionParticipantId)) {
    return "STUDIO";
  }

  return input.guestReturnOverrides[input.contributionParticipantId] ?? input.globalReturnSource;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = returnRoutingSyncSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid return routing sync payload.",
        issues: parsed.error.flatten()
      },
      { status: 400 }
    );
  }

  const roomSlug = normalizeRoomSlug(parsed.data.room);
  const programRoomName = getLiveKitRoomName(roomSlug, "program");
  const roomClient = getRoomServiceClient();
  const participants = await roomClient.listParticipants(programRoomName).catch(() => []);
  const updatedGuests: Array<{ participantId: string; assignedReturnSource: ReturnSource }> = [];
  const failedGuests: Array<{ participantId: string; error: string }> = [];

  for (const participant of participants) {
    const metadata = parseParticipantMetadata(participant.metadata);

    if (metadata?.surfaceRole !== "guest" || metadata.channel !== "program") {
      continue;
    }

    const contributionParticipantId = deriveContributionParticipantId(participant.identity);
    const isInProgram = parsed.data.programGuestIds.includes(contributionParticipantId);
    const programAudioMuted = (parsed.data.programMutedGuestIds ?? []).includes(
      contributionParticipantId
    );
    const regieAudioMuted = (parsed.data.regieMutedGuestIds ?? []).includes(
      contributionParticipantId
    );
    const canControlSlides = (parsed.data.slideControlEnabledGuestIds ?? []).includes(
      contributionParticipantId
    );
    const assignedReturnSource = getEffectiveReturnSource({
      contributionParticipantId,
      programGuestIds: parsed.data.programGuestIds,
      globalReturnSource: parsed.data.globalReturnSource,
      guestReturnOverrides: parsed.data.guestReturnOverrides
    });
    const nextMetadata = {
      ...metadata,
      assignedReturnSource,
      isInProgram,
      programAudioMuted,
      regieAudioMuted,
      canControlSlides,
      returnRoutingVersion: parsed.data.routingVersion
    };

    try {
      await roomClient.updateParticipant(programRoomName, participant.identity, {
        metadata: JSON.stringify(nextMetadata),
        name: participant.name
      });
      updatedGuests.push({
        participantId: participant.identity,
        assignedReturnSource
      });
    } catch (error) {
      failedGuests.push({
        participantId: participant.identity,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return NextResponse.json({
    room: roomSlug,
    programRoomName,
    updatedGuests,
    failedGuests
  });
}
