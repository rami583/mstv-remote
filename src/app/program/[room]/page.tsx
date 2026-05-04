import { ProgramRoomClient } from "@/components/studio/program-room-client";

export default async function ProgramRoomPage({
  params
}: {
  params: Promise<{ room: string }>;
}) {
  const { room } = await params;

  return <ProgramRoomClient room={decodeURIComponent(room)} />;
}
