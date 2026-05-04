import { RoomServiceClient } from "livekit-server-sdk";
import { getLiveKitServerEnv } from "@/lib/livekit/env";

export function getRoomServiceClient() {
  const env = getLiveKitServerEnv();
  const adminUrl = new URL(env.livekitUrl);

  if (adminUrl.protocol === "wss:") {
    adminUrl.protocol = "https:";
  } else if (adminUrl.protocol === "ws:") {
    adminUrl.protocol = "http:";
  }

  return new RoomServiceClient(adminUrl.toString(), env.apiKey, env.apiSecret);
}
