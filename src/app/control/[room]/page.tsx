import { ControlRoomClient } from "@/components/studio/control-room-client";

export default async function ControlRoomPage({
  params
}: {
  params: Promise<{ room: string }>;
}) {
  const { room } = await params;

  return <ControlRoomClient room={decodeURIComponent(room)} />;
}
