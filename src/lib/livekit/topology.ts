import type { SessionChannel, SurfaceRole } from "@/lib/types/roles";

const channelSuffixes: Record<SessionChannel, string> = {
  contribution: "contribution",
  program: "program"
};

export function normalizeRoomSlug(room: string) {
  return room.trim().toLowerCase().replace(/\s+/g, "-");
}

export function getLiveKitRoomName(room: string, channel: SessionChannel) {
  const normalized = normalizeRoomSlug(room);
  return `${normalized}--${channelSuffixes[channel]}`;
}

export function getSupportedChannels(surfaceRole: SurfaceRole): SessionChannel[] {
  switch (surfaceRole) {
    case "guest":
      return ["contribution", "program"];
    case "control":
      return ["contribution", "program"];
    case "program":
    case "programFeed":
      return ["program"];
  }
}
