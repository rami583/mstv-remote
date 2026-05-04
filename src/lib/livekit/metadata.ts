import type { ControlRole, SessionChannel, SurfaceRole } from "@/lib/types/roles";
import type { ReturnSource } from "@/lib/types/runtime";

export interface ParticipantMetadata {
  roomSlug: string;
  surfaceRole: SurfaceRole;
  controlRole: ControlRole | null;
  channel: SessionChannel;
  sourceLabel?: ReturnSource | null;
  assignedReturnSource?: ReturnSource | null;
  isInProgram?: boolean | null;
  canControlSlides?: boolean | null;
  returnRoutingVersion?: number | null;
}

export function parseParticipantMetadata(metadata?: string): ParticipantMetadata | null {
  if (!metadata) {
    return null;
  }

  try {
    const parsed = JSON.parse(metadata) as ParticipantMetadata;

    if (!parsed.surfaceRole || !parsed.channel) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}
