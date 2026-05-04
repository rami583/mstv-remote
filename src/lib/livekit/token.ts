import { AccessToken } from "livekit-server-sdk";
import { getLiveKitServerEnv } from "@/lib/livekit/env";
import { getGrantProfile } from "@/lib/livekit/permissions";
import { getLiveKitRoomName, normalizeRoomSlug } from "@/lib/livekit/topology";
import type { TokenRequestPayload, TokenResponsePayload } from "@/lib/types/livekit";

export async function createScopedAccessToken(
  input: TokenRequestPayload
): Promise<TokenResponsePayload> {
  const env = getLiveKitServerEnv();
  const roomSlug = normalizeRoomSlug(input.room);
  const roomName = getLiveKitRoomName(roomSlug, input.channel);
  const grants = getGrantProfile(input.surfaceRole, input.channel);

  const token = new AccessToken(env.apiKey, env.apiSecret, {
    identity: input.participantId,
    name: input.displayName,
    metadata: JSON.stringify({
      roomSlug,
      surfaceRole: input.surfaceRole,
      controlRole: input.controlRole ?? null,
      channel: input.channel,
      sourceLabel: input.sourceLabel ?? null
    })
  });

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: grants.canPublish,
    canSubscribe: grants.canSubscribe,
    canPublishData: input.surfaceRole !== "program"
  });

  return {
    token: await token.toJwt(),
    wsUrl: env.livekitUrl,
    roomName,
    roomSlug,
    channel: input.channel,
    surfaceRole: input.surfaceRole,
    displayName: input.displayName,
    participantId: input.participantId,
    grants
  };
}
