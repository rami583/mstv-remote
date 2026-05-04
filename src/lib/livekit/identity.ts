import { normalizeRoomSlug } from "@/lib/livekit/topology";
import type { ControlRole, SessionChannel, SurfaceRole } from "@/lib/types/roles";

interface BuildParticipantIdentityOptions {
  room: string;
  surfaceRole: SurfaceRole;
  channel: SessionChannel;
  instanceId: string;
  controlRole?: ControlRole;
}

export function buildParticipantIdentity({
  room,
  surfaceRole,
  channel,
  instanceId,
  controlRole
}: BuildParticipantIdentityOptions) {
  const roomSlug = normalizeRoomSlug(room);
  const roleLabel = controlRole ?? surfaceRole;

  return {
    roomSlug,
    participantId: `${roomSlug}:${surfaceRole}:${channel}:${roleLabel}:${instanceId}`,
    displayName:
      surfaceRole === "control"
        ? `Control ${controlRole ?? "desk"}`
        : surfaceRole === "guest"
          ? `Guest ${roomSlug}`
          : surfaceRole === "program"
          ? `Program ${roomSlug}`
            : `Program Feed ${roomSlug}`
  };
}

export function deriveParticipantIdentityChannel(
  participantId: string,
  channel: SessionChannel
) {
  const parts = participantId.split(":");

  if (parts.length !== 5) {
    return null;
  }

  parts[2] = channel;
  return parts.join(":");
}
