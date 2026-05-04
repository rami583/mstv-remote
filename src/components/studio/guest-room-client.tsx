"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GuestContributionSurface,
  GuestProgramReturnSurface
} from "@/components/livekit/minimal-studio-surfaces";
import { fetchLiveKitToken } from "@/lib/livekit/browser-token";
import { buildParticipantIdentity, deriveParticipantIdentityChannel } from "@/lib/livekit/identity";
import { getIndicatorClasses, type MediaStatusIndicator } from "@/lib/studio/media-status";
import type { TokenResponsePayload } from "@/lib/types/livekit";
import type { StudioMessage } from "@/lib/types/messaging";
import type {
  LiveRoomSnapshot,
  PendingSlideControlCommand,
  ProductionSnapshot,
  ReturnSource,
  SlideControlCommandType,
  StudioControlCommand
} from "@/lib/types/runtime";
import {
  acknowledgeStudioCommand,
  fetchAudienceMessages,
  fetchProductionSnapshot,
  fetchPendingCommands,
  publishParticipantState
} from "@/lib/studio/control-plane";

interface GuestRoomClientProps {
  room: string;
}

function programGuestIdsIncludeGuest(
  programGuestIds: string[],
  identity: {
    contribution: ReturnType<typeof buildParticipantIdentity>;
    program: ReturnType<typeof buildParticipantIdentity>;
  }
) {
  const possibleIds = new Set([
    identity.contribution.participantId,
    identity.program.participantId,
    deriveParticipantIdentityChannel(identity.contribution.participantId, "program"),
    deriveParticipantIdentityChannel(identity.program.participantId, "contribution")
  ]);

  return programGuestIds.some((guestId) => possibleIds.has(guestId));
}

interface MediaAccessState {
  camera: boolean;
  microphone: boolean;
}

function hasLiveTrack(stream: MediaStream | null, kind: "audio" | "video") {
  const tracks = kind === "video" ? stream?.getVideoTracks() : stream?.getAudioTracks();

  return Boolean(tracks?.some((track) => track.readyState === "live"));
}

function getMediaReadinessErrorMessage(access: MediaAccessState) {
  if (!access.camera && !access.microphone) {
    return "Activez la caméra et le micro pour continuer.";
  }

  if (!access.camera) {
    return "Activez votre caméra pour continuer.";
  }

  if (!access.microphone) {
    return "Activez votre micro pour continuer.";
  }

  return null;
}
function LocalPreviewGuide() {
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <svg
        viewBox="0 0 512 288"
        aria-hidden="true"
        className="absolute inset-0 h-full w-full"
        preserveAspectRatio="xMidYMid meet"
      >
        <path
          d="M0,0v288h124.1409c3.6912-55.8155,31.1188-124.1636,95.0611-128.8007-28.3053-18.6201-42.2738-50.0542-32.9759-83.5618,19.6272-70.7319,123.1171-68.8975,140.2263,2.3879,7.8926,32.8846-6.1232,63.0387-33.6544,81.1739,63.942,4.637,91.3702,72.9854,95.0611,128.8007h124.1409V0H0Z"
          fill="rgba(0,0,0,0.3)"
          fillRule="evenodd"
          clipRule="evenodd"
        />
      </svg>
    </div>
  );
}

function LocalStreamPreview({ stream }: { stream: MediaStream }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = videoRef.current;

    if (!element) {
      return;
    }

    element.srcObject = stream;
    void element.play().catch(() => undefined);

    return () => {
      if (element.srcObject === stream) {
        element.srcObject = null;
      }
    };
  }, [stream]);

  return <video ref={videoRef} muted playsInline autoPlay className="h-full w-full object-cover object-center" />;
}

export function GuestRoomClient({ room }: GuestRoomClientProps) {
  const [guestName, setGuestName] = useState("");
  const [greenRoomStream, setGreenRoomStream] = useState<MediaStream | null>(null);
  const [mediaAccess, setMediaAccess] = useState<MediaAccessState>({
    camera: false,
    microphone: false
  });
  const [isCheckingMediaAccess, setIsCheckingMediaAccess] = useState(false);
  const [identity, setIdentity] = useState<{
    contribution: ReturnType<typeof buildParticipantIdentity>;
    program: ReturnType<typeof buildParticipantIdentity>;
    displayName: string;
  } | null>(null);
  const [contributionSession, setContributionSession] = useState<TokenResponsePayload | null>(null);
  const [programSession, setProgramSession] = useState<TokenResponsePayload | null>(null);
  const [contributionSnapshot, setContributionSnapshot] = useState<LiveRoomSnapshot | null>(null);
  const [programSnapshot, setProgramSnapshot] = useState<LiveRoomSnapshot | null>(null);
  const [messages, setMessages] = useState<StudioMessage[]>([]);
  const [pendingMuteCommand, setPendingMuteCommand] = useState<StudioControlCommand | null>(null);
  const [productionSnapshot, setProductionSnapshot] = useState<ProductionSnapshot | null>(null);
  const [liveProgramGuestIds, setLiveProgramGuestIds] = useState<string[] | null>(null);
  const [liveProgramStatus, setLiveProgramStatus] = useState<boolean | null>(null);
  const [liveAssignedReturnSource, setLiveAssignedReturnSource] = useState<ReturnSource | null>(null);
  const [slideControlAuthorized, setSlideControlAuthorized] = useState(false);
  const [pendingSlideCommand, setPendingSlideCommand] =
    useState<PendingSlideControlCommand | null>(null);
  const [isJoiningLive, setIsJoiningLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSlideCommandAtRef = useRef(0);

  useEffect(() => {
    return () => {
      greenRoomStream?.getTracks().forEach((track) => track.stop());
    };
  }, [greenRoomStream]);

  const requestGreenRoomAccess = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      const nextAccess = {
        camera: false,
        microphone: false
      };

      setMediaAccess(nextAccess);
      setError(getMediaReadinessErrorMessage(nextAccess));
      return nextAccess;
    }

    setIsCheckingMediaAccess(true);

    let nextVideoStream: MediaStream | null = null;
    let nextAccess: MediaAccessState = {
      camera: false,
      microphone: false
    };

    try {
      const videoResult = await navigator.mediaDevices
        .getUserMedia({
          video: true,
          audio: false
        })
        .then((stream) => ({ status: "fulfilled" as const, stream }))
        .catch((mediaError) => ({ status: "rejected" as const, mediaError }));
      const audioResult = await navigator.mediaDevices
        .getUserMedia({
          video: false,
          audio: true
        })
        .then((stream) => ({ status: "fulfilled" as const, stream }))
        .catch((mediaError) => ({ status: "rejected" as const, mediaError }));

      if (videoResult.status === "fulfilled") {
        if (hasLiveTrack(videoResult.stream, "video")) {
          nextVideoStream = videoResult.stream;
        } else {
          videoResult.stream.getTracks().forEach((track) => track.stop());
        }
      }

      const audioTrackIsLive =
        audioResult.status === "fulfilled" && hasLiveTrack(audioResult.stream, "audio");

      if (audioResult.status === "fulfilled") {
        audioResult.stream.getTracks().forEach((track) => track.stop());
      }

      nextAccess = {
        camera: hasLiveTrack(nextVideoStream, "video"),
        microphone: audioTrackIsLive
      };
      setGreenRoomStream((current) => {
        if (current && current !== nextVideoStream) {
          current.getTracks().forEach((track) => track.stop());
        }

        return nextVideoStream;
      });
      setMediaAccess(nextAccess);
      setError(getMediaReadinessErrorMessage(nextAccess));
      return nextAccess;
    } finally {
      setIsCheckingMediaAccess(false);
    }
  }, []);

  useEffect(() => {
    if (identity) {
      return;
    }

    void requestGreenRoomAccess();
  }, [identity, requestGreenRoomAccess]);

  useEffect(() => {
    if (identity || typeof navigator === "undefined" || !navigator.mediaDevices) {
      return;
    }

    const handleDeviceChange = () => {
      void requestGreenRoomAccess();
    };

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [identity, requestGreenRoomAccess]);

  function publishContributionHeartbeat(snapshot: LiveRoomSnapshot) {
    if (!identity) {
      return;
    }

    void publishParticipantState(room, {
      room,
      roomName: contributionSession?.roomName ?? `${room}--contribution`,
      participantId: identity.contribution.participantId,
      displayName: identity.displayName,
      surfaceRole: "guest",
      channel: "contribution",
      connectionState: snapshot.connectionState,
      participantCount: snapshot.participantCount,
      videoTrackCount: snapshot.videoTrackCount,
      cameraPublished: snapshot.localCameraPublished,
      microphonePublished: snapshot.localMicrophonePublished,
      cameraTrackState: snapshot.localCameraTrackState,
      microphoneTrackState: snapshot.localMicrophoneTrackState,
      hasProgramFeed: false,
      isMicrophoneMutedByControl: pendingMuteCommand?.status === "pending"
    });
  }

  function publishProgramHeartbeat(snapshot: LiveRoomSnapshot) {
    if (!identity) {
      return;
    }

    void publishParticipantState(room, {
      room,
      roomName: programSession?.roomName ?? `${room}--program`,
      participantId: identity.program.participantId,
      displayName: identity.displayName,
      surfaceRole: "guest",
      channel: "program",
      connectionState: snapshot.connectionState,
      participantCount: snapshot.participantCount,
      videoTrackCount: snapshot.videoTrackCount,
      cameraPublished: false,
      microphonePublished: false,
      cameraTrackState: snapshot.localCameraTrackState,
      microphoneTrackState: snapshot.localMicrophoneTrackState,
      hasProgramFeed: snapshot.hasProgramFeed,
      isMicrophoneMutedByControl: false
    });
  }

  useEffect(() => {
    if (!contributionSnapshot || !identity) {
      return;
    }

    publishContributionHeartbeat(contributionSnapshot);
  }, [contributionSession?.roomName, contributionSnapshot, identity, pendingMuteCommand?.status, room]);

  useEffect(() => {
    if (!programSnapshot || !identity) {
      return;
    }

    publishProgramHeartbeat(programSnapshot);
  }, [identity, programSession?.roomName, programSnapshot, room]);

  useEffect(() => {
    if (!identity) {
      return;
    }

    const interval = window.setInterval(() => {
      if (contributionSnapshot) {
        publishContributionHeartbeat(contributionSnapshot);
      }

      if (programSnapshot) {
        publishProgramHeartbeat(programSnapshot);
      }
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [
    contributionSnapshot,
    contributionSession?.roomName,
    identity,
    pendingMuteCommand?.status,
    programSession?.roomName,
    programSnapshot,
    room
  ]);

  useEffect(() => {
    if (!identity) {
      return;
    }

    const pollAudienceState = () => {
      void fetchAudienceMessages({
        room,
        participantId: identity.contribution.participantId,
        surfaceRole: "guest"
      }).then(setMessages);

      void fetchPendingCommands(room, identity.contribution.participantId).then((commands) => {
        setPendingMuteCommand(commands.find((command) => command.type === "mute-microphone") ?? null);
      });

      void fetchProductionSnapshot(room).then((snapshot) => {
        setProductionSnapshot(snapshot);
      });
    };

    pollAudienceState();
    const interval = window.setInterval(pollAudienceState, 1500);

    return () => {
      window.clearInterval(interval);
    };
  }, [identity, room]);

  const isInProgram = useMemo(
    () => {
      if (!identity) {
        return false;
      }

      if (liveProgramStatus !== null) {
        return liveProgramStatus;
      }

      const programGuestIds = liveProgramGuestIds ?? productionSnapshot?.programGuestIds ?? [];

      return programGuestIdsIncludeGuest(programGuestIds, identity);
    },
    [identity, liveProgramGuestIds, liveProgramStatus, productionSnapshot]
  );
  const assignedReturnSource = useMemo<ReturnSource>(() => {
    if (liveAssignedReturnSource) {
      return liveAssignedReturnSource;
    }

    if (!identity || !productionSnapshot) {
      return "STUDIO";
    }

    if (productionSnapshot.programGuestIds.includes(identity.contribution.participantId)) {
      return "STUDIO";
    }

    return (
      productionSnapshot.guestReturnOverrides[identity.contribution.participantId] ??
      productionSnapshot.globalReturnSource
    );
  }, [identity, liveAssignedReturnSource, productionSnapshot]);

  const isGuestActiveForControlRoom = isInProgram || assignedReturnSource === "REGIE";
  const guestProgramStatusIndicator: MediaStatusIndicator = isGuestActiveForControlRoom
    ? {
        tone: "green",
        label: "LIVE",
        detail: "LIVE",
        description: "Active with the control room."
      }
    : {
        tone: "red",
        label: "MUTED",
        detail: "MUTED_REGIE",
        description: "Not selected in Program."
      };

  function handleSlideCommand(command: SlideControlCommandType) {
    if (!slideControlAuthorized) {
      return;
    }

    const now = Date.now();

    if (now - lastSlideCommandAtRef.current < 500) {
      return;
    }

    lastSlideCommandAtRef.current = now;
    setPendingSlideCommand({
      commandId:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${now}-${Math.random().toString(36).slice(2)}`,
      room,
      command
    });
  }

  const handleProgramGuestIdsChange = useCallback((nextProgramGuestIds: string[]) => {
    setLiveProgramGuestIds((current) => {
      if (
        current &&
        current.length === nextProgramGuestIds.length &&
        current.every((guestId, index) => guestId === nextProgramGuestIds[index])
      ) {
        return current;
      }

      return nextProgramGuestIds;
    });
  }, []);

  async function handleConfirmJoin() {
    if (isJoiningLive || isCheckingMediaAccess) {
      return;
    }

    if (!guestName.trim()) {
      setError("Entrez votre nom pour continuer.");
      return;
    }

    const latestAccess = await requestGreenRoomAccess();
    const mediaError = getMediaReadinessErrorMessage(latestAccess);

    if (mediaError) {
      setError(mediaError);
      return;
    }

    setIsJoiningLive(true);
    setError(null);

    const instanceId = crypto.randomUUID();
    const nextIdentity = {
      contribution: buildParticipantIdentity({
        room,
        surfaceRole: "guest",
        channel: "contribution",
        instanceId
      }),
      program: buildParticipantIdentity({
        room,
        surfaceRole: "guest",
        channel: "program",
        instanceId
      }),
      displayName: guestName.trim()
    };

    try {
      const [snapshot, contribution, program] = await Promise.all([
        fetchProductionSnapshot(room),
        fetchLiveKitToken({
          room,
          participantId: nextIdentity.contribution.participantId,
          displayName: nextIdentity.displayName,
          surfaceRole: "guest",
          channel: "contribution"
        }),
        fetchLiveKitToken({
          room,
          participantId: nextIdentity.program.participantId,
          displayName: nextIdentity.displayName,
          surfaceRole: "guest",
          channel: "program"
        })
      ]);

      greenRoomStream?.getTracks().forEach((track) => track.stop());
      setGreenRoomStream(null);
      setProductionSnapshot(snapshot);
      setContributionSession(contribution);
      setProgramSession(program);
      setIdentity(nextIdentity);
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : "Impossible de rejoindre le direct.");
    } finally {
      setIsJoiningLive(false);
    }
  }

  if (!identity) {
    const readinessMessage = getMediaReadinessErrorMessage(mediaAccess);
    const previewMessage =
      error?.startsWith("Votre caméra") ||
      error?.startsWith("Votre micro") ||
      error?.startsWith("Votre caméra et votre micro")
        ? error
        : readinessMessage;

    return (
      <main className="h-[100svh] overflow-hidden bg-black px-2 py-2 text-white">
        <div className="mx-auto flex h-full w-full items-center justify-center">
          <div className="flex h-full w-full flex-col items-center justify-center">
            <div
              className="relative aspect-video overflow-hidden rounded-[14px] bg-black"
              style={{
                maxHeight: "70svh",
                maxWidth: "1120px",
                width: "min(1120px, calc(70svh * 1.77778), 100%)"
              }}
            >
              {greenRoomStream ? <LocalStreamPreview stream={greenRoomStream} /> : null}
              <LocalPreviewGuide />
              {previewMessage ? (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 px-3 text-center">
                  <div>
                    <p className="text-xs font-medium text-signal">{previewMessage}</p>
                    <p className="mt-1 text-[10px] text-slate-300">
                      Cliquez sur l’icône caméra dans la barre d’adresse pour modifier les autorisations.
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleConfirmJoin();
              }}
              className="mx-auto flex w-full max-w-sm flex-col items-center gap-2.5 px-2 pt-3 text-center"
            >
              <p className="text-sm text-slate-200">Placez-vous correctement dans l’image.</p>
              <input
                value={guestName}
                onChange={(event) => {
                  setGuestName(event.target.value);
                  if (error === "Entrez votre nom pour continuer.") {
                    setError(null);
                  }
                }}
                placeholder="Votre nom"
                className="w-full rounded-lg border border-white/10 bg-black px-3 py-2.5 text-sm text-slate-100 outline-none"
              />
              <button
                type="submit"
                disabled={isJoiningLive || isCheckingMediaAccess}
                className="rounded-lg border border-air/30 bg-air/10 px-5 py-2.5 text-sm font-medium text-air transition hover:bg-air/15 disabled:opacity-60"
              >
                {isJoiningLive
                  ? "Connexion..."
                  : isCheckingMediaAccess
                    ? "Autorisation..."
                    : "Rejoindre le direct"}
              </button>
              {error && error !== previewMessage ? (
                <p className="text-xs text-signal">{error}</p>
              ) : null}
            </form>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="h-[100svh] overflow-hidden bg-black text-white">
      <div className="relative mx-auto flex h-full w-full flex-col items-center justify-center gap-3 p-2">
        <div
          className="relative aspect-video overflow-hidden rounded-[14px] bg-black"
          style={{
            maxHeight: slideControlAuthorized ? "calc(100svh - 6.75rem)" : "calc(100svh - 1rem)",
            maxWidth: "1180px",
            width: slideControlAuthorized
              ? "min(1180px, calc((100svh - 6.75rem) * 1.77778), 100%)"
              : "min(1180px, calc((100svh - 1rem) * 1.77778), 100%)"
          }}
        >
          <GuestProgramReturnSurface
            session={programSession}
            channel="program"
            onSnapshot={setProgramSnapshot}
            assignedReturnSource={assignedReturnSource}
            onAssignedReturnSourceChange={setLiveAssignedReturnSource}
            onProgramGuestIdsChange={handleProgramGuestIdsChange}
            onProgramStatusChange={setLiveProgramStatus}
            onSlideControlAuthorizedChange={setSlideControlAuthorized}
            pendingSlideCommand={pendingSlideCommand}
            onSlideCommandSent={(commandId) => {
              setPendingSlideCommand((current) =>
                current?.commandId === commandId ? null : current
              );
            }}
          />

          <div className="absolute bottom-2 right-2 w-[23%] min-w-[140px] max-w-[240px] overflow-hidden rounded-[12px] border border-white/15 bg-black md:bottom-3 md:right-3">
            <div className="relative aspect-video overflow-hidden bg-black">
              <GuestContributionSurface
                session={contributionSession}
                channel="contribution"
                onSnapshot={setContributionSnapshot}
                pendingCommand={pendingMuteCommand}
                onCommandApplied={(commandId) => {
                  void acknowledgeStudioCommand(room, commandId, identity!.contribution.participantId).then(() => {
                    setPendingMuteCommand(null);
                  });
                }}
              />
              <LocalPreviewGuide />

              <div className="absolute left-2 top-2 z-20 flex gap-1.5">
                <div
                  className={`rounded-full border px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.14em] ${getIndicatorClasses(guestProgramStatusIndicator.tone)}`}
                >
                  Mic
                </div>
                <div
                  className={`rounded-full border px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.14em] ${getIndicatorClasses(guestProgramStatusIndicator.tone)}`}
                >
                  Cam
                </div>
              </div>
            </div>
          </div>

          {messages.length > 0 ? (
            <div className="absolute bottom-2 left-2 max-w-[280px] space-y-1">
              {messages.slice(0, 3).map((message) => (
                <div
                  key={message.id}
                  className="rounded-md border border-white/10 bg-black/75 px-2.5 py-1.5 text-[11px] text-slate-100 backdrop-blur"
                >
                  {message.body}
                </div>
              ))}
            </div>
          ) : null}

        </div>
        {slideControlAuthorized ? (
          <div className="flex flex-col items-center gap-2">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
              Télécommande slides
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => handleSlideCommand("PREV_SLIDE")}
                className="rounded-full border border-white/15 bg-white/10 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-white/15"
              >
                ← Précédent
              </button>
              <button
                type="button"
                onClick={() => handleSlideCommand("NEXT_SLIDE")}
                className="rounded-full border border-white/15 bg-white/10 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-white/15"
              >
                Suivant →
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
