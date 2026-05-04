import type { ControlRole, SessionChannel, SurfaceRole } from "@/lib/types/roles";
import type { ReturnSource } from "@/lib/types/runtime";

export interface TokenRequestPayload {
  room: string;
  participantId: string;
  displayName: string;
  surfaceRole: SurfaceRole;
  channel: SessionChannel;
  controlRole?: ControlRole;
  sourceLabel?: ReturnSource;
}

export interface GrantProfileSummary {
  canPublish: boolean;
  canSubscribe: boolean;
}

export interface TokenResponsePayload {
  token: string;
  wsUrl: string;
  roomName: string;
  roomSlug: string;
  channel: SessionChannel;
  surfaceRole: SurfaceRole;
  displayName: string;
  participantId: string;
  grants: GrantProfileSummary;
}
