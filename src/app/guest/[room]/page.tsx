import { GuestRoomClient } from "@/components/studio/guest-room-client";

export default async function GuestRoomPage({
  params
}: {
  params: Promise<{ room: string }>;
}) {
  const { room } = await params;

  return <GuestRoomClient room={decodeURIComponent(room)} />;
}
