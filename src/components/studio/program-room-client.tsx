"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ProgramOutputSurface } from "@/components/livekit/minimal-studio-surfaces";
import { fetchLiveKitToken } from "@/lib/livekit/browser-token";
import { buildParticipantIdentity } from "@/lib/livekit/identity";
import { fetchProductionSnapshot } from "@/lib/studio/control-plane";
import type { TokenResponsePayload } from "@/lib/types/livekit";

interface ProgramRoomClientProps {
  room: string;
}

export function ProgramRoomClient({ room }: ProgramRoomClientProps) {
  const identity = useMemo(
    () =>
      buildParticipantIdentity({
        room,
        surfaceRole: "control",
        channel: "contribution",
        controlRole: "producer",
        instanceId: crypto.randomUUID()
      }),
    [room]
  );
  const [session, setSession] = useState<TokenResponsePayload | null>(null);
  const [programGuestIds, setProgramGuestIds] = useState<string[]>([]);
  const lastSceneSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadSession() {
      const token = await fetchLiveKitToken({
        room,
        participantId: identity.participantId,
        displayName: identity.displayName,
        surfaceRole: "control",
        channel: "contribution",
        controlRole: "producer"
      });

      if (!active) {
        return;
      }

      console.info("[MSTV Program] LiveKit session ready", JSON.stringify({
        roomName: token.roomName,
        participantId: token.participantId
      }));
      setSession(token);
    }

    void loadSession().catch((error) => {
      console.info(
        "[MSTV Program] LiveKit session failed",
        error instanceof Error ? error.message : String(error)
      );
    });

    return () => {
      active = false;
    };
  }, [identity.displayName, identity.participantId, room]);

  useEffect(() => {
    let active = true;

    async function refreshScene() {
      const snapshot = await fetchProductionSnapshot(room);

      if (!active) {
        return;
      }

      const nextGuestIds = snapshot.programGuestIds.slice(0, 3);
      const signature = JSON.stringify(nextGuestIds);

      if (lastSceneSignatureRef.current !== signature) {
        lastSceneSignatureRef.current = signature;
        console.info("[MSTV Program] Scene updated", JSON.stringify({
          room: snapshot.room,
          selectedGuestCount: nextGuestIds.length,
          programGuestIds: nextGuestIds
        }));
      }

      setProgramGuestIds(nextGuestIds);
    }

    const refreshSceneSafely = () => {
      void refreshScene().catch((error) => {
        console.info(
          "[MSTV Program] Scene refresh failed",
          error instanceof Error ? error.message : String(error)
        );
      });
    };

    refreshSceneSafely();

    const interval = window.setInterval(refreshSceneSafely, 500);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [room]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-black">
      <div className="aspect-video h-auto w-screen max-h-screen bg-black">
        <ProgramOutputSurface session={session} channel="contribution" programGuestIds={programGuestIds} />
      </div>
    </main>
  );
}
