import type { GrantProfileSummary } from "@/lib/types/livekit";
import type { SessionChannel, SurfaceRole } from "@/lib/types/roles";

export function getGrantProfile(
  surfaceRole: SurfaceRole,
  channel: SessionChannel
): GrantProfileSummary {
  if (surfaceRole === "guest" && channel === "contribution") {
    return {
      canPublish: true,
      canSubscribe: false
    };
  }

  if (surfaceRole === "guest" && channel === "program") {
    return {
      canPublish: false,
      canSubscribe: true
    };
  }

  if (surfaceRole === "control" && (channel === "contribution" || channel === "program")) {
    return {
      canPublish: false,
      canSubscribe: true
    };
  }

  if (surfaceRole === "program" && channel === "program") {
    return {
      canPublish: false,
      canSubscribe: true
    };
  }

  if (surfaceRole === "programFeed" && channel === "program") {
    return {
      canPublish: true,
      canSubscribe: false
    };
  }

  throw new Error(`Unsupported surface/channel pairing: ${surfaceRole}:${channel}`);
}
