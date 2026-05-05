"use client";

import {
  AudioTrack,
  LiveKitRoom,
  useLocalParticipant,
  useRemoteParticipants,
  useConnectionState,
  useRoomContext,
  useTracks,
  VideoTrack,
  type TrackReference
} from "@livekit/components-react";
import { Room, RoomEvent, Track } from "livekit-client";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseParticipantMetadata } from "@/lib/livekit/metadata";
import { getIndicatorClasses, type MediaStatusIndicator } from "@/lib/studio/media-status";
import type { TokenResponsePayload } from "@/lib/types/livekit";
import type {
  LiveRoomSnapshot,
  PendingSlideControlCommand,
  ReturnSource,
  RuntimeParticipantState,
  SlideControlCommandMessage,
  StudioControlCommand
} from "@/lib/types/runtime";
import type { SessionChannel } from "@/lib/types/roles";

interface BaseSessionProps {
  session: TokenResponsePayload | null;
  channel: SessionChannel;
  emptyClassName?: string;
}

interface GuestContributionSurfaceProps extends BaseSessionProps {
  onSnapshot?: (snapshot: LiveRoomSnapshot) => void;
  pendingCommand?: StudioControlCommand | null;
  onCommandApplied?: (commandId: string) => void;
}

interface ProgramReturnSurfaceProps extends BaseSessionProps {
  onSnapshot?: (snapshot: LiveRoomSnapshot) => void;
  assignedReturnSource: ReturnSource;
  onAssignedReturnSourceChange?: (source: ReturnSource) => void;
  onProgramGuestIdsChange?: (programGuestIds: string[]) => void;
  onProgramStatusChange?: (isInProgram: boolean) => void;
  onSlideControlAuthorizedChange?: (authorized: boolean) => void;
  pendingSlideCommand?: PendingSlideControlCommand | null;
  onSlideCommandSent?: (commandId: string) => void;
}

interface ProgramRoutingBridgeProps extends BaseSessionProps {
  routingPayload: ProgramReturnRoutingPayload | null;
  onSlideCommandReceived?: (message: SlideControlCommandMessage) => void;
}

interface ProgramOutputSurfaceProps extends BaseSessionProps {
  programGuestIds: string[];
}

interface ControlGuestGridSurfaceProps extends BaseSessionProps {
  guests: Array<{
    participantId: string;
    displayName: string;
    inProgram: boolean;
    selectionOrder: number | null;
    cameraIndicator: MediaStatusIndicator;
    microphoneIndicator: MediaStatusIndicator;
    effectiveReturnSource: ReturnSource;
    returnSourceControlDisabled: boolean;
    disconnectControlDisabled: boolean;
    slideControlEnabled: boolean;
  }>;
  onToggleGuest: (participantId: string) => void;
  onToggleGuestSlideControl?: (participantId: string) => void;
  onSelectGuestReturnSource?: (participantId: string, source: ReturnSource) => void;
  onDisconnectGuest?: (participantId: string) => void;
  onPresentGuestIdsChange?: (participantIds: string[]) => void;
  onLiveGuestStatesChange?: (participants: RuntimeParticipantState[]) => void;
  programAudioOutputDeviceId?: string | null;
  regieMonitorOutputDeviceId?: string | null;
  gridClassName?: string;
}

export interface ReturnFeedPublisherState {
  connectionState: string;
  videoActive: boolean;
  audioActive: boolean;
  error: string | null;
}

export interface ReturnFeedPublisherDebugState {
  selectedVideoDeviceId: string | null;
  selectedAudioDeviceId: string | null;
  getUserMediaState: "idle" | "requesting" | "resolved" | "failed";
  getUserMediaError: string | null;
  videoTrackCreated: boolean;
  videoTrackReadyState: string | null;
  previewStreamHasVideo: boolean;
}

interface ProgramReturnRoutingPayload {
  type: "return-routing";
  room: string;
  globalReturnSource: ReturnSource;
  programGuestIds: string[];
  slideControlEnabledGuestIds?: string[];
  guestReturnOverrides: Record<string, ReturnSource | undefined>;
  routingVersion: number;
}

function buildRemoteParticipantStates(remoteParticipants: ReturnType<typeof useRemoteParticipants>) {
  return remoteParticipants.map((participant): RuntimeParticipantState => {
    const metadata = parseParticipantMetadata(participant.metadata);
    const cameraTrack = participant.getTrackPublication(Track.Source.Camera);
    const microphoneTrack = participant.getTrackPublication(Track.Source.Microphone);

    return {
      participantId: participant.identity,
      displayName: participant.name || participant.identity,
      surfaceRole: metadata?.surfaceRole ?? "guest",
      channel: metadata?.channel ?? "unknown",
      controlRole: metadata?.controlRole ?? undefined,
      cameraPublished: Boolean(cameraTrack) && !(cameraTrack?.isMuted ?? false),
      microphonePublished: Boolean(microphoneTrack) && !(microphoneTrack?.isMuted ?? false),
      cameraTrackState: {
        published: Boolean(cameraTrack),
        muted: cameraTrack?.isMuted ?? false,
        missing: cameraTrack === undefined
      },
      microphoneTrackState: {
        published: Boolean(microphoneTrack),
        muted: microphoneTrack?.isMuted ?? false,
        missing: microphoneTrack === undefined
      }
    };
  });
}

function getMediaCaptureErrorMessage(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Autorisez MSTV Visio dans Réglages Système > Confidentialité et sécurité > Caméra / Microphone.";
    }

    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return "Aucune caméra ou aucun micro correspondant n’est détecté.";
    }

    if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      return "Ce périphérique est déjà utilisé ou ne peut pas être ouvert.";
    }
  }

  return error instanceof Error ? error.message : "Impossible de démarrer le retour invité.";
}

function useSnapshotReporter(input: {
  channel: SessionChannel;
  onSnapshot?: (snapshot: LiveRoomSnapshot) => void;
  pendingCommand?: StudioControlCommand | null;
  onCommandApplied?: (commandId: string) => void;
}) {
  const { isCameraEnabled, isMicrophoneEnabled, localParticipant, cameraTrack, microphoneTrack } =
    useLocalParticipant();
  const remoteParticipants = useRemoteParticipants();
  const videoTracks = useTracks([
    {
      source: Track.Source.Camera,
      withPlaceholder: false
    },
    {
      source: Track.Source.ScreenShare,
      withPlaceholder: false
    }
  ]);
  const connectionState = useConnectionState();
  const concreteVideoTracks = videoTracks.filter(
    (trackRef): trackRef is TrackReference => trackRef.publication !== undefined
  );
  const remoteParticipantStates = useMemo(
    () => buildRemoteParticipantStates(remoteParticipants),
    [remoteParticipants]
  );
  const lastSnapshotSignatureRef = useRef<string | null>(null);
  const lastAppliedCommandRef = useRef<string | null>(null);

  const snapshot = useMemo<LiveRoomSnapshot>(() => {
    const programFeedParticipant = remoteParticipantStates.find(
      (participant) => participant.surfaceRole === "programFeed"
    );

    return {
      channel: input.channel,
      connectionState: String(connectionState),
      participantCount: remoteParticipants.length + 1,
      videoTrackCount: concreteVideoTracks.length,
      hasProgramFeed: Boolean(programFeedParticipant),
      programFeedLabel: programFeedParticipant?.displayName,
      localCameraPublished: isCameraEnabled,
      localMicrophonePublished: isMicrophoneEnabled,
      localCameraTrackState: {
        published: Boolean(cameraTrack),
        muted: cameraTrack?.isMuted ?? false,
        missing: cameraTrack === undefined
      },
      localMicrophoneTrackState: {
        published: Boolean(microphoneTrack),
        muted: microphoneTrack?.isMuted ?? false,
        missing: microphoneTrack === undefined
      },
      remoteParticipants: remoteParticipantStates
    };
  }, [
    cameraTrack,
    concreteVideoTracks.length,
    connectionState,
    input.channel,
    isCameraEnabled,
    isMicrophoneEnabled,
    microphoneTrack,
    remoteParticipantStates,
    remoteParticipants.length
  ]);

  useEffect(() => {
    if (!input.onSnapshot) {
      return;
    }

    const snapshotSignature = JSON.stringify(snapshot);

    if (lastSnapshotSignatureRef.current === snapshotSignature) {
      return;
    }

    lastSnapshotSignatureRef.current = snapshotSignature;
    input.onSnapshot(snapshot);
  }, [input, snapshot]);

  useEffect(() => {
    if (!input.pendingCommand || input.pendingCommand.type !== "mute-microphone") {
      return;
    }

    if (lastAppliedCommandRef.current === input.pendingCommand.id) {
      return;
    }

    lastAppliedCommandRef.current = input.pendingCommand.id;

    const commandId = input.pendingCommand.id;

    void localParticipant.setMicrophoneEnabled(false).then(() => {
      input.onCommandApplied?.(commandId);
    });
  }, [input, localParticipant]);

  return {
    concreteVideoTracks,
    localParticipant,
    remoteParticipants
  };
}

function LocalPreviewContent({
  channel,
  onSnapshot,
  pendingCommand,
  onCommandApplied
}: {
  channel: SessionChannel;
  onSnapshot?: (snapshot: LiveRoomSnapshot) => void;
  pendingCommand?: StudioControlCommand | null;
  onCommandApplied?: (commandId: string) => void;
}) {
  const { concreteVideoTracks, localParticipant } = useSnapshotReporter({
    channel,
    onSnapshot,
    pendingCommand,
    onCommandApplied
  });

  const localTrack = concreteVideoTracks.find(
    (trackRef) => trackRef.participant.identity === localParticipant.identity
  );

  return localTrack ? (
    <VideoTrack trackRef={localTrack} className="h-full w-full object-cover" />
  ) : (
    <div className="h-full w-full bg-neutral-950" />
  );
}

function ProgramReturnContent({
  channel,
  onSnapshot,
  assignedReturnSource,
  onAssignedReturnSourceChange,
  onProgramGuestIdsChange,
  onProgramStatusChange,
  onSlideControlAuthorizedChange,
  pendingSlideCommand,
  onSlideCommandSent
}: {
  channel: SessionChannel;
  onSnapshot?: (snapshot: LiveRoomSnapshot) => void;
  assignedReturnSource: ReturnSource;
  onAssignedReturnSourceChange?: (source: ReturnSource) => void;
  onProgramGuestIdsChange?: (programGuestIds: string[]) => void;
  onProgramStatusChange?: (isInProgram: boolean) => void;
  onSlideControlAuthorizedChange?: (authorized: boolean) => void;
  pendingSlideCommand?: PendingSlideControlCommand | null;
  onSlideCommandSent?: (commandId: string) => void;
}) {
  const { concreteVideoTracks, remoteParticipants } = useSnapshotReporter({
    channel,
    onSnapshot
  });
  const { localParticipant } = useLocalParticipant();
  const room = useRoomContext();
  const [routedReturn, setRoutedReturn] = useState<{
    source: ReturnSource;
    version: number;
    programGuestIds: string[];
    isInProgram: boolean;
  } | null>(null);
  const localMetadata = parseParticipantMetadata(localParticipant.metadata);
  const metadataReturnSource = localMetadata?.assignedReturnSource ?? null;
  const metadataReturnVersion = localMetadata?.returnRoutingVersion ?? 0;
  const contributionParticipantId = localParticipant.identity.replace(
    ":guest:program:",
    ":guest:contribution:"
  );
  const possibleProgramStatusIds = useMemo(
    () =>
      new Set([
        contributionParticipantId,
        localParticipant.identity,
        localParticipant.identity.replace(":guest:contribution:", ":guest:program:")
      ]),
    [contributionParticipantId, localParticipant.identity]
  );
  const effectiveAssignedReturnSource =
    routedReturn?.source ?? metadataReturnSource ?? assignedReturnSource;
  const audioTracks = useTracks([{ source: Track.Source.Microphone, withPlaceholder: false }]);
  const concreteAudioTracks = audioTracks.filter(
    (trackRef): trackRef is TrackReference =>
      trackRef.publication !== undefined && !trackRef.participant.isLocal
  );
  const assignedParticipantIds = useMemo(
    () =>
      new Set(
        remoteParticipants
          .filter((participant) => {
            const metadata = parseParticipantMetadata(participant.metadata);

            return (
              metadata?.surfaceRole === "programFeed" &&
              metadata.sourceLabel === effectiveAssignedReturnSource
            );
          })
          .map((participant) => participant.identity)
      ),
    [effectiveAssignedReturnSource, remoteParticipants]
  );
  const primaryTrack = concreteVideoTracks.find((trackRef) =>
    assignedParticipantIds.has(trackRef.participant.identity)
  );
  const assignedAudioTracks = concreteAudioTracks.filter((trackRef) =>
    assignedParticipantIds.has(trackRef.participant.identity)
  );
  const lastPublishedSlideCommandRef = useRef<string | null>(null);

  useEffect(() => {
    onAssignedReturnSourceChange?.(effectiveAssignedReturnSource);
  }, [effectiveAssignedReturnSource, onAssignedReturnSourceChange]);

  useEffect(() => {
    for (const participant of remoteParticipants) {
      const metadata = parseParticipantMetadata(participant.metadata);
      const shouldSubscribe =
        metadata?.surfaceRole === "programFeed" &&
        metadata.sourceLabel === effectiveAssignedReturnSource;

      for (const publication of participant.trackPublications.values()) {
        publication.setSubscribed(shouldSubscribe);
      }
    }
  }, [effectiveAssignedReturnSource, remoteParticipants]);

  useEffect(() => {
    if (typeof localMetadata?.isInProgram === "boolean") {
      onProgramStatusChange?.(localMetadata.isInProgram);
    }

    if (typeof localMetadata?.canControlSlides === "boolean") {
      onSlideControlAuthorizedChange?.(localMetadata.canControlSlides);
    }
  }, [
    localMetadata?.canControlSlides,
    localMetadata?.isInProgram,
    onProgramStatusChange,
    onSlideControlAuthorizedChange
  ]);

  useEffect(() => {
    if (!room) {
      return;
    }

    const decoder = new TextDecoder();

    const handleData = (payload: Uint8Array) => {
      try {
        const parsed = JSON.parse(decoder.decode(payload)) as ProgramReturnRoutingPayload;

        if (parsed.type !== "return-routing") {
          return;
        }

        onProgramGuestIdsChange?.(parsed.programGuestIds);
        const nextIsInProgram = parsed.programGuestIds.some((participantId) =>
          possibleProgramStatusIds.has(participantId)
        );
        const nextCanControlSlides = (parsed.slideControlEnabledGuestIds ?? []).some((participantId) =>
          possibleProgramStatusIds.has(participantId)
        );
        onProgramStatusChange?.(nextIsInProgram);
        onSlideControlAuthorizedChange?.(nextCanControlSlides);

        const nextSource = nextIsInProgram
          ? "STUDIO"
          : parsed.guestReturnOverrides[contributionParticipantId] ?? parsed.globalReturnSource;
        const nextVersion = parsed.routingVersion ?? Date.now();

        onAssignedReturnSourceChange?.(nextSource);
        setRoutedReturn((current) =>
          current?.source === nextSource && current.version === nextVersion
            ? current
            : {
                source: nextSource,
                version: nextVersion,
                programGuestIds: parsed.programGuestIds,
                isInProgram: nextIsInProgram
              }
        );
      } catch {
        // Ignore unrelated LiveKit data messages.
      }
    };

    room.on(RoomEvent.DataReceived, handleData);

    return () => {
      room.off(RoomEvent.DataReceived, handleData);
    };
  }, [
    contributionParticipantId,
    localParticipant.identity,
    localParticipant.sid,
    onProgramGuestIdsChange,
    onAssignedReturnSourceChange,
    onProgramStatusChange,
    onSlideControlAuthorizedChange,
    possibleProgramStatusIds,
    room
  ]);

  useEffect(() => {
    if (!pendingSlideCommand) {
      return;
    }

    if (lastPublishedSlideCommandRef.current === pendingSlideCommand.commandId) {
      return;
    }

    lastPublishedSlideCommandRef.current = pendingSlideCommand.commandId;

    const message: SlideControlCommandMessage = {
      type: "slide-control-command",
      commandId: pendingSlideCommand.commandId,
      room: pendingSlideCommand.room,
      command: pendingSlideCommand.command,
      guestParticipantId: contributionParticipantId,
      guestName: localParticipant.name || localParticipant.identity,
      createdAt: new Date().toISOString()
    };

    void localParticipant
      .publishData(new TextEncoder().encode(JSON.stringify(message)), {
        reliable: true,
        topic: "mstv:slide-control"
      })
      .finally(() => {
        onSlideCommandSent?.(pendingSlideCommand.commandId);
      });
  }, [
    contributionParticipantId,
    localParticipant,
    onSlideCommandSent,
    pendingSlideCommand
  ]);

  return (
    <>
      {primaryTrack ? (
        <VideoTrack trackRef={primaryTrack} className="h-full w-full object-cover" />
      ) : (
        <div className="h-full w-full bg-black" />
      )}
      <div aria-hidden="true" className="fixed h-0 w-0 overflow-hidden">
        {assignedAudioTracks.map((trackRef) => (
          <AudioTrack key={trackRef.publication.trackSid ?? trackRef.participant.identity} trackRef={trackRef} />
        ))}
      </div>
    </>
  );
}

function ProgramRoutingBridgeContent({
  routingPayload,
  onSlideCommandReceived
}: {
  routingPayload: ProgramReturnRoutingPayload | null;
  onSlideCommandReceived?: (message: SlideControlCommandMessage) => void;
}) {
  const { localParticipant } = useLocalParticipant();
  const room = useRoomContext();
  const lastPayloadSignatureRef = useRef<string | null>(null);
  const routingPayloadRef = useRef<ProgramReturnRoutingPayload | null>(routingPayload);
  const handledSlideCommandIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    routingPayloadRef.current = routingPayload;
  }, [routingPayload]);

  useEffect(() => {
    if (!routingPayload) {
      return;
    }

    const signature = JSON.stringify(routingPayload);
    const publishRouting = () => {
      void localParticipant.publishData(new TextEncoder().encode(signature), {
        reliable: true,
        topic: "mstv:return-routing"
      });
      void fetch("/api/livekit/return-routing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: signature
      }).catch(() => undefined);
    };

    if (lastPayloadSignatureRef.current === signature) {
      const interval = window.setInterval(publishRouting, 2000);

      return () => {
        window.clearInterval(interval);
      };
    }

    lastPayloadSignatureRef.current = signature;
    publishRouting();
    const interval = window.setInterval(publishRouting, 2000);

    return () => {
      window.clearInterval(interval);
    };
  }, [localParticipant, routingPayload]);

  useEffect(() => {
    if (!room) {
      return;
    }

    const decoder = new TextDecoder();

    const handleData = (payload: Uint8Array, participant?: { identity: string; name?: string }) => {
      try {
        const parsed = JSON.parse(decoder.decode(payload)) as SlideControlCommandMessage;

        if (parsed.type !== "slide-control-command") {
          return;
        }

        const currentRouting = routingPayloadRef.current;
        const senderContributionId =
          participant?.identity?.replace(":guest:program:", ":guest:contribution:") ??
          parsed.guestParticipantId;
        const authorizedGuestIds = currentRouting?.slideControlEnabledGuestIds ?? [];
        const isAuthorized =
          parsed.room === currentRouting?.room &&
          authorizedGuestIds.includes(senderContributionId);

        if (!isAuthorized || handledSlideCommandIdsRef.current.has(parsed.commandId)) {
          return;
        }

        handledSlideCommandIdsRef.current.add(parsed.commandId);

        if (handledSlideCommandIdsRef.current.size > 100) {
          handledSlideCommandIdsRef.current = new Set(
            [...handledSlideCommandIdsRef.current].slice(-50)
          );
        }

        onSlideCommandReceived?.({
          ...parsed,
          guestParticipantId: senderContributionId,
          guestName: participant?.name || parsed.guestName || senderContributionId
        });
      } catch {
        // Ignore unrelated LiveKit data messages.
      }
    };

    room.on(RoomEvent.DataReceived, handleData);

    return () => {
      room.off(RoomEvent.DataReceived, handleData);
    };
  }, [onSlideCommandReceived, room]);

  return null;
}

function useSelectedProgramMedia(programGuestIds: string[]) {
  const selectedGuestIds = programGuestIds.slice(0, 3);
  const remoteParticipants = useRemoteParticipants();
  const videoTracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: false }]);
  const audioTracks = useTracks([{ source: Track.Source.Microphone, withPlaceholder: false }]);
  const concreteVideoTracks = videoTracks.filter(
    (trackRef): trackRef is TrackReference =>
      trackRef.publication !== undefined && !trackRef.participant.isLocal
  );
  const concreteAudioTracks = audioTracks.filter(
    (trackRef): trackRef is TrackReference =>
      trackRef.publication !== undefined && !trackRef.participant.isLocal
  );
  const videoTracksByParticipant = useMemo(
    () => new Map(concreteVideoTracks.map((trackRef) => [trackRef.participant.identity, trackRef])),
    [concreteVideoTracks]
  );
  const audioTracksByParticipant = useMemo(
    () => new Map(concreteAudioTracks.map((trackRef) => [trackRef.participant.identity, trackRef])),
    [concreteAudioTracks]
  );
  const liveGuestIds = useMemo(
    () =>
      new Set(
        remoteParticipants
          .filter((participant) => !participant.isLocal)
          .map((participant) => participant.identity)
      ),
    [remoteParticipants]
  );
  const activeSelectedGuestIds = selectedGuestIds.filter((participantId) => liveGuestIds.has(participantId));
  const selectedVideoSlots = activeSelectedGuestIds.map((participantId) => ({
    participantId,
    trackRef: videoTracksByParticipant.get(participantId)
  }));
  const selectedAudioTracks = activeSelectedGuestIds
    .map((participantId) => audioTracksByParticipant.get(participantId))
    .filter((trackRef): trackRef is TrackReference => trackRef !== undefined);

  return {
    selectedGuestIds: activeSelectedGuestIds,
    selectedVideoSlots,
    selectedAudioTracks
  };
}

function RoutedAudioTrack({
  trackRef,
  outputDeviceId
}: {
  trackRef: TrackReference;
  outputDeviceId?: string | null;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const element = audioRef.current;
    const track = trackRef.publication.track;

    if (!element || !track || typeof track.attach !== "function") {
      return;
    }

    track.attach(element);

    const setOutputDevice = async () => {
      const mediaElement = element as HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
      };

      if (mediaElement.setSinkId && outputDeviceId !== undefined) {
        await mediaElement.setSinkId(outputDeviceId ?? "");
      }

      await element.play();
    };

    void setOutputDevice().catch(() => undefined);

    return () => {
      track.detach(element);
      element.srcObject = null;
    };
  }, [outputDeviceId, trackRef.publication.track]);

  return <audio ref={audioRef} autoPlay playsInline />;
}

function ProgramOutputContent({ programGuestIds }: { programGuestIds: string[] }) {
  const { selectedVideoSlots } = useSelectedProgramMedia(programGuestIds);

  if (selectedVideoSlots.length === 0) {
    return <div className="h-full w-full bg-black" />;
  }

  if (selectedVideoSlots.length === 1) {
    return selectedVideoSlots[0].trackRef ? (
      <VideoTrack
        trackRef={selectedVideoSlots[0].trackRef}
        className="h-full w-full object-cover object-center"
      />
    ) : (
      <div className="h-full w-full bg-black" />
    );
  }

  if (selectedVideoSlots.length === 2) {
    return (
      <div className="relative h-full w-full bg-black">
        <div className="grid h-full w-full grid-cols-2 bg-black">
          {selectedVideoSlots.map((slot) => (
            <div key={slot.participantId} className="h-full w-full bg-black">
              {slot.trackRef ? (
                <VideoTrack
                  trackRef={slot.trackRef}
                  className="h-full w-full object-cover object-center"
                />
              ) : null}
            </div>
          ))}
        </div>
        <div className="pointer-events-none absolute inset-y-0 left-1/2 z-10 w-[5px] -translate-x-1/2 bg-white" />
      </div>
    );
  }

  return (
    <div className="relative h-full w-full bg-black">
      <div className="grid h-full w-full grid-cols-3 bg-black">
        {selectedVideoSlots.map((slot) => (
          <div key={slot.participantId} className="h-full w-full bg-black">
            {slot.trackRef ? (
              <VideoTrack
                trackRef={slot.trackRef}
                className="h-full w-full object-cover object-center"
              />
            ) : null}
          </div>
        ))}
      </div>
      <div className="pointer-events-none absolute inset-y-0 left-1/3 z-10 w-[5px] -translate-x-1/2 bg-white" />
      <div className="pointer-events-none absolute inset-y-0 left-2/3 z-10 w-[5px] -translate-x-1/2 bg-white" />
    </div>
  );
}

export function ControlReturnFeedPublisher({
  session,
  videoDeviceId,
  audioDeviceId,
  imageDataUrl,
  enabled,
  onStateChange,
  onPreviewStreamChange,
  onDebugStateChange
}: {
  session: TokenResponsePayload | null;
  videoDeviceId: string | null;
  audioDeviceId: string | null;
  imageDataUrl?: string | null;
  enabled: boolean;
  onStateChange?: (state: Partial<ReturnFeedPublisherState>) => void;
  onPreviewStreamChange?: (stream: MediaStream | null) => void;
  onDebugStateChange?: (state: Partial<ReturnFeedPublisherDebugState>) => void;
}) {
  const publisherRoomRef = useRef<Room | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const publishedVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const publishedAudioTrackRef = useRef<MediaStreamTrack | null>(null);
  const imageRefreshIntervalRef = useRef<number | null>(null);
  const onStateChangeRef = useRef(onStateChange);
  const onPreviewStreamChangeRef = useRef(onPreviewStreamChange);
  const onDebugStateChangeRef = useRef(onDebugStateChange);
  const [publisherConnectionState, setPublisherConnectionState] = useState("disconnected");

  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  useEffect(() => {
    onPreviewStreamChangeRef.current = onPreviewStreamChange;
  }, [onPreviewStreamChange]);

  useEffect(() => {
    onDebugStateChangeRef.current = onDebugStateChange;
  }, [onDebugStateChange]);

  useEffect(() => {
    onDebugStateChangeRef.current?.({
      selectedVideoDeviceId: videoDeviceId,
      selectedAudioDeviceId: audioDeviceId
    });
  }, [audioDeviceId, videoDeviceId]);

  useEffect(() => {
    if (!session || !enabled) {
      setPublisherConnectionState("disconnected");
      onStateChangeRef.current?.({
        connectionState: "disconnected",
        videoActive: false,
        audioActive: false,
        error: null
      });
      onPreviewStreamChangeRef.current?.(null);
      onDebugStateChangeRef.current?.({
        getUserMediaState: "idle",
        getUserMediaError: null,
        videoTrackCreated: false,
        videoTrackReadyState: null,
        previewStreamHasVideo: false
      });
      return;
    }

    const room = new Room();
    let active = true;
    const handleConnectionStateChange = (state: Room["state"]) => {
      setPublisherConnectionState(String(state));
      onStateChangeRef.current?.({
        connectionState: String(state)
      });
    };

    setPublisherConnectionState("connecting");
    onStateChangeRef.current?.({
      connectionState: "connecting",
      error: null
    });

    room.on(RoomEvent.ConnectionStateChanged, handleConnectionStateChange);

    void room
      .connect(session.wsUrl, session.token, {
        autoSubscribe: false
      })
      .then(() => {
        if (!active) {
          void room.disconnect();
          return;
        }

        publisherRoomRef.current = room;
        setPublisherConnectionState("connected");
        onStateChangeRef.current?.({
          connectionState: "connected",
          error: null
        });
      })
      .catch((error) => {
        if (!active) {
          return;
        }

        setPublisherConnectionState("failed");
        onStateChangeRef.current?.({
          connectionState: "failed",
          videoActive: false,
          audioActive: false,
          error: error instanceof Error ? error.message : "Unable to connect guest return feed."
        });
      });

    return () => {
      active = false;
      publisherRoomRef.current = null;
      publishedVideoTrackRef.current?.stop();
      publishedAudioTrackRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (imageRefreshIntervalRef.current !== null) {
        window.clearInterval(imageRefreshIntervalRef.current);
        imageRefreshIntervalRef.current = null;
      }
      publishedVideoTrackRef.current = null;
      publishedAudioTrackRef.current = null;
      streamRef.current = null;
      onPreviewStreamChangeRef.current?.(null);
      room.off(RoomEvent.ConnectionStateChanged, handleConnectionStateChange);
      void room.disconnect();
    };
  }, [enabled, session]);

  useEffect(() => {
    let cancelled = false;

    async function clearPublishedTracks() {
      const room = publisherRoomRef.current;

      if (room && publishedVideoTrackRef.current) {
        await room.localParticipant.unpublishTrack(publishedVideoTrackRef.current, false);
      }

      if (room && publishedAudioTrackRef.current) {
        await room.localParticipant.unpublishTrack(publishedAudioTrackRef.current, false);
      }

      publishedVideoTrackRef.current?.stop();
      publishedAudioTrackRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      publishedVideoTrackRef.current = null;
      publishedAudioTrackRef.current = null;
      streamRef.current = null;
      onPreviewStreamChangeRef.current?.(null);
      onDebugStateChangeRef.current?.({
        videoTrackCreated: false,
        videoTrackReadyState: null,
        previewStreamHasVideo: false
      });
    }

    async function syncSelectedDevices() {
      const activeSession = session;

      if (
        !enabled ||
        !activeSession ||
        !publisherRoomRef.current ||
        publisherConnectionState !== "connected"
      ) {
        await clearPublishedTracks();
        onStateChangeRef.current?.({
          videoActive: false,
          audioActive: false,
          error: null
        });
        return;
      }

      const hasVideo = Boolean(videoDeviceId);
      const hasAudio = Boolean(audioDeviceId);
      const hasImage = Boolean(imageDataUrl);

      if (!hasVideo && !hasAudio && !hasImage) {
        await clearPublishedTracks();
        onStateChangeRef.current?.({
          videoActive: false,
          audioActive: false,
          error: null
        });
        return;
      }

      onDebugStateChangeRef.current?.({
        getUserMediaState: "requesting",
        getUserMediaError: null
      });

      let nextStream: MediaStream;

      if (hasImage) {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const nextImage = new Image();
          nextImage.onload = () => resolve(nextImage);
          nextImage.onerror = () => reject(new Error("Unable to load image return source."));
          nextImage.src = imageDataUrl ?? "";
        });
        const canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 720;
        const context = canvas.getContext("2d");

        if (!context) {
          throw new Error("Unable to prepare image return source.");
        }

        const drawFrame = () => {
          const canvasAspect = canvas.width / canvas.height;
          const imageAspect = image.width / image.height;
          let drawWidth = canvas.width;
          let drawHeight = canvas.height;
          let offsetX = 0;
          let offsetY = 0;

          if (imageAspect > canvasAspect) {
            drawHeight = canvas.height;
            drawWidth = drawHeight * imageAspect;
            offsetX = (canvas.width - drawWidth) / 2;
          } else {
            drawWidth = canvas.width;
            drawHeight = drawWidth / imageAspect;
            offsetY = (canvas.height - drawHeight) / 2;
          }

          context.clearRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
        };

        drawFrame();
        imageRefreshIntervalRef.current = window.setInterval(drawFrame, 1000);
        nextStream = canvas.captureStream(1);
      } else {
        console.info("[MSTV Return Publisher] getUserMedia requesting", JSON.stringify({
          sourceLabel: activeSession.displayName,
          videoDeviceId,
          audioDeviceId,
          hasVideo,
          hasAudio
        }));
        nextStream = await navigator.mediaDevices.getUserMedia({
          video: hasVideo ? { deviceId: { exact: videoDeviceId ?? undefined } } : false,
          audio: hasAudio ? { deviceId: { exact: audioDeviceId ?? undefined } } : false
        });
        console.info("[MSTV Return Publisher] getUserMedia resolved", JSON.stringify({
          sourceLabel: activeSession.displayName,
          videoTracks: nextStream.getVideoTracks().map((track) => ({
            label: track.label,
            readyState: track.readyState,
            muted: track.muted
          })),
          audioTracks: nextStream.getAudioTracks().map((track) => ({
            label: track.label,
            readyState: track.readyState,
            muted: track.muted
          }))
        }));
      }

      if (cancelled) {
        nextStream.getTracks().forEach((track) => track.stop());
        return;
      }

      const room = publisherRoomRef.current;

      if (!room) {
        nextStream.getTracks().forEach((track) => track.stop());
        return;
      }

      const nextVideoTrack = nextStream.getVideoTracks()[0] ?? null;
      const nextAudioTrack = nextStream.getAudioTracks()[0] ?? null;

      await clearPublishedTracks();

      streamRef.current = nextStream;
      const previewStream = nextVideoTrack ? new MediaStream([nextVideoTrack]) : null;

      onPreviewStreamChangeRef.current?.(previewStream);
      onDebugStateChangeRef.current?.({
        getUserMediaState: "resolved",
        getUserMediaError: null,
        videoTrackCreated: Boolean(nextVideoTrack),
        videoTrackReadyState: nextVideoTrack?.readyState ?? null,
        previewStreamHasVideo: (previewStream?.getVideoTracks().length ?? 0) > 0
      });

      if (nextVideoTrack) {
        await room.localParticipant.publishTrack(nextVideoTrack, {
          source: Track.Source.Camera,
          name: "guest-return-video"
        });
        publishedVideoTrackRef.current = nextVideoTrack;
      }

      if (nextAudioTrack) {
        await room.localParticipant.publishTrack(nextAudioTrack, {
          source: Track.Source.Microphone,
          name: "guest-return-audio"
        });
        publishedAudioTrackRef.current = nextAudioTrack;
      }

      onStateChangeRef.current?.({
        videoActive: Boolean(nextVideoTrack),
        audioActive: Boolean(nextAudioTrack),
        error: null
      });
    }

    void syncSelectedDevices().catch((error) => {
      if (cancelled) {
        return;
      }

      onDebugStateChangeRef.current?.({
        getUserMediaState: "failed",
        getUserMediaError: getMediaCaptureErrorMessage(error),
        videoTrackCreated: false,
        videoTrackReadyState: null,
        previewStreamHasVideo: false
      });
      onStateChangeRef.current?.({
        videoActive: false,
        audioActive: false,
        error: getMediaCaptureErrorMessage(error)
      });
      console.info("[MSTV Return Publisher] getUserMedia failed", JSON.stringify({
        sourceLabel: session?.displayName ?? null,
        videoDeviceId,
        audioDeviceId,
        name: error instanceof DOMException ? error.name : error instanceof Error ? error.name : null,
        message: error instanceof Error ? error.message : String(error)
      }));
    });

    return () => {
      cancelled = true;
      void clearPublishedTracks().catch(() => undefined);
    };
  }, [audioDeviceId, enabled, imageDataUrl, publisherConnectionState, session, videoDeviceId]);

  return null;
}

function ControlGuestGridContent({
  guests,
  onToggleGuest,
  onToggleGuestSlideControl,
  onSelectGuestReturnSource,
  onDisconnectGuest,
  onPresentGuestIdsChange,
  onLiveGuestStatesChange,
  programAudioOutputDeviceId,
  regieMonitorOutputDeviceId,
  gridClassName
}: Pick<
  ControlGuestGridSurfaceProps,
  | "guests"
  | "onToggleGuest"
  | "onToggleGuestSlideControl"
  | "onSelectGuestReturnSource"
  | "onDisconnectGuest"
  | "onPresentGuestIdsChange"
  | "onLiveGuestStatesChange"
  | "programAudioOutputDeviceId"
  | "regieMonitorOutputDeviceId"
  | "gridClassName"
>) {
  const remoteParticipants = useRemoteParticipants();
  const videoTracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: false }]);
  const audioTracks = useTracks([{ source: Track.Source.Microphone, withPlaceholder: false }]);
  const concreteVideoTracks = videoTracks.filter(
    (trackRef): trackRef is TrackReference =>
      trackRef.publication !== undefined && !trackRef.participant.isLocal
  );
  const concreteAudioTracks = audioTracks.filter(
    (trackRef): trackRef is TrackReference =>
      trackRef.publication !== undefined && !trackRef.participant.isLocal
  );
  const participantTrackMap = useMemo(
    () => new Map(concreteVideoTracks.map((trackRef) => [trackRef.participant.identity, trackRef])),
    [concreteVideoTracks]
  );
  const participantAudioTrackMap = useMemo(
    () => new Map(concreteAudioTracks.map((trackRef) => [trackRef.participant.identity, trackRef])),
    [concreteAudioTracks]
  );
  const programAudioTracks = guests
    .filter((guest) => guest.inProgram)
    .map((guest) => participantAudioTrackMap.get(guest.participantId))
    .filter((trackRef): trackRef is TrackReference => trackRef !== undefined);
  const regieMonitorAudioTracks = guests
    .filter((guest) => !guest.inProgram && guest.effectiveReturnSource === "REGIE")
    .map((guest) => participantAudioTrackMap.get(guest.participantId))
    .filter((trackRef): trackRef is TrackReference => trackRef !== undefined);
  const presentGuests = useMemo(
    () =>
      new Set(
        remoteParticipants
          .filter((participant) => parseParticipantMetadata(participant.metadata)?.surfaceRole === "guest")
          .map((participant) => participant.identity)
      ),
    [remoteParticipants]
  );
  const lastReportedPresentGuestsRef = useRef<string | null>(null);
  const lastReportedLiveGuestsRef = useRef<string | null>(null);

  useEffect(() => {
    if (!onPresentGuestIdsChange) {
      return;
    }

    const presentGuestIds = Array.from(presentGuests);
    const signature = presentGuestIds.join("|");

    if (lastReportedPresentGuestsRef.current === signature) {
      return;
    }

    lastReportedPresentGuestsRef.current = signature;
    onPresentGuestIdsChange(presentGuestIds);
  }, [onPresentGuestIdsChange, presentGuests]);

  useEffect(() => {
    if (!onLiveGuestStatesChange) {
      return;
    }

    const liveGuestStates = buildRemoteParticipantStates(remoteParticipants).filter(
      (participant) => participant.surfaceRole === "guest" && participant.channel === "contribution"
    );
    const signature = JSON.stringify(liveGuestStates);

    if (lastReportedLiveGuestsRef.current === signature) {
      return;
    }

    lastReportedLiveGuestsRef.current = signature;
    onLiveGuestStatesChange(liveGuestStates);
  }, [onLiveGuestStatesChange, remoteParticipants]);

  if (guests.length === 0) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center rounded-[28px] border border-dashed border-white/10 bg-white/[0.03] text-sm uppercase tracking-[0.24em] text-slate-500">
        Waiting for guest feeds
      </div>
    );
  }

  return (
    <>
      <div className="hidden">
        {programAudioTracks.map((trackRef) => (
          <RoutedAudioTrack
            key={`program-${trackRef.publication.trackSid ?? trackRef.participant.identity}`}
            trackRef={trackRef}
            outputDeviceId={programAudioOutputDeviceId}
          />
        ))}
        {regieMonitorAudioTracks.map((trackRef) => (
          <RoutedAudioTrack
            key={`regie-${trackRef.publication.trackSid ?? trackRef.participant.identity}`}
            trackRef={trackRef}
            outputDeviceId={regieMonitorOutputDeviceId}
          />
        ))}
      </div>
      <div className={gridClassName ?? "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr))]"}>
        {guests.map((guest) => {
        const trackRef = participantTrackMap.get(guest.participantId);
        const selectionLimitReached = !guest.inProgram && guests.filter((item) => item.inProgram).length >= 3;
        const activeActionPillClassName =
          "border-transparent bg-sky-500 text-white shadow-[0_2px_10px_rgba(0,0,0,0.35)]";
        const pillBaseClassName =
          "mstv-ui-pill border";
        const neutralPillClassName =
          "border-transparent bg-slate-600 text-white shadow-[0_2px_10px_rgba(0,0,0,0.28)] hover:bg-slate-500";
        const toggleProgramSelection = () => {
          if (selectionLimitReached) {
            return;
          }

          onToggleGuest(guest.participantId);
        };

        return (
          <div
            key={guest.participantId}
            className={`mstv-source-tile group overflow-hidden rounded-[24px] border text-left transition ${
              guest.inProgram
                ? "border-emerald-500 bg-white/[0.06]"
                : "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]"
            } ${selectionLimitReached ? "cursor-not-allowed opacity-70" : "cursor-pointer"}`}
          >
            <div
              role="button"
              tabIndex={selectionLimitReached ? -1 : 0}
              aria-disabled={selectionLimitReached}
              aria-label={
                guest.inProgram
                  ? `Retirer ${guest.displayName} du programme`
                  : `Prendre ${guest.displayName} au programme`
              }
              onClick={toggleProgramSelection}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") {
                  return;
                }

                event.preventDefault();
                toggleProgramSelection();
              }}
              className="relative aspect-video bg-black outline-none focus-visible:ring-2 focus-visible:ring-air/70"
            >
              {trackRef ? (
                <VideoTrack
                  trackRef={trackRef}
                  className="h-full w-full object-cover object-center pointer-events-none"
                />
              ) : (
                <div className="h-full w-full bg-black pointer-events-none" />
              )}

              <div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />

              <div className="pointer-events-none absolute left-4 top-4 z-20 flex gap-2">
                <div
                  className={`${pillBaseClassName} ${getIndicatorClasses(
                    guest.microphoneIndicator.tone
                  )}`}
                >
                  Mic
                </div>
                <div
                  className={`${pillBaseClassName} ${getIndicatorClasses(
                    guest.cameraIndicator.tone
                  )}`}
                >
                  Cam
                </div>
              </div>

              {guest.selectionOrder ? (
                <div className="mstv-ui-badge pointer-events-none absolute right-4 top-4 z-20 border border-transparent bg-emerald-500 text-white shadow-[0_2px_10px_rgba(0,0,0,0.35)]">
                  {guest.selectionOrder}
                </div>
              ) : null}

              <div className="absolute bottom-0 left-0 right-0 z-20 flex items-end gap-3 p-4">
                <div className="w-[30%] min-w-0 max-w-[11rem] shrink-0">
                  <p className="truncate text-base font-semibold text-white" title={guest.displayName}>
                    {guest.displayName}
                  </p>
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className="flex min-w-0 flex-col items-end gap-1.5"
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                      {(["STUDIO", "REGIE", "IMAGE"] as const).map((source) => {
                        const isActive = guest.effectiveReturnSource === source;

                        return (
                          <button
                            key={source}
                            type="button"
                            disabled={guest.returnSourceControlDisabled}
                            onClick={(event) => {
                              event.stopPropagation();
                              onSelectGuestReturnSource?.(guest.participantId, source);
                            }}
                            className={`${pillBaseClassName} transition ${
                              isActive ? activeActionPillClassName : neutralPillClassName
                            } ${
                              guest.returnSourceControlDisabled ? "cursor-default opacity-90" : ""
                            }`}
                          >
                            {source}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggleGuestSlideControl?.(guest.participantId);
                        }}
                        className={`${pillBaseClassName} transition ${
                          guest.slideControlEnabled
                            ? activeActionPillClassName
                            : neutralPillClassName
                        }`}
                      >
                        Slides
                      </button>
                      <button
                        type="button"
                        disabled={guest.disconnectControlDisabled}
                        title={
                          guest.disconnectControlDisabled
                            ? "Retirez l’invité du programme avant de le déconnecter."
                            : undefined
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          if (guest.disconnectControlDisabled) {
                            return;
                          }
                          onDisconnectGuest?.(guest.participantId);
                        }}
                        className={`${pillBaseClassName} border-transparent bg-slate-600 text-white shadow-[0_2px_10px_rgba(0,0,0,0.28)] transition ${
                          guest.disconnectControlDisabled
                            ? "cursor-default opacity-40"
                            : "hover:bg-slate-500"
                        }`}
                      >
                        Déconnecter
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })}
      </div>
    </>
  );
}

export function GuestContributionSurface({
  session,
  channel,
  onSnapshot,
  pendingCommand,
  onCommandApplied,
  emptyClassName = "h-full w-full bg-neutral-950"
}: GuestContributionSurfaceProps) {
  return session ? (
    <LiveKitRoom
      token={session.token}
      serverUrl={session.wsUrl}
      connect
      audio
      video
      data-lk-theme="default"
      className="contents"
    >
      <LocalPreviewContent
        channel={channel}
        onSnapshot={onSnapshot}
        pendingCommand={pendingCommand}
        onCommandApplied={onCommandApplied}
      />
    </LiveKitRoom>
  ) : (
    <div className={emptyClassName} />
  );
}

export function GuestProgramReturnSurface({
  session,
  channel,
  onSnapshot,
  assignedReturnSource,
  onAssignedReturnSourceChange,
  onProgramGuestIdsChange,
  onProgramStatusChange,
  onSlideControlAuthorizedChange,
  pendingSlideCommand,
  onSlideCommandSent,
  emptyClassName = "h-full w-full bg-black"
}: ProgramReturnSurfaceProps) {
  return session ? (
    <LiveKitRoom
      token={session.token}
      serverUrl={session.wsUrl}
      connect
      data-lk-theme="default"
      className="contents"
    >
      <ProgramReturnContent
        channel={channel}
        onSnapshot={onSnapshot}
        assignedReturnSource={assignedReturnSource}
        onAssignedReturnSourceChange={onAssignedReturnSourceChange}
        onProgramGuestIdsChange={onProgramGuestIdsChange}
        onProgramStatusChange={onProgramStatusChange}
        onSlideControlAuthorizedChange={onSlideControlAuthorizedChange}
        pendingSlideCommand={pendingSlideCommand}
        onSlideCommandSent={onSlideCommandSent}
      />
    </LiveKitRoom>
  ) : (
    <div className={emptyClassName} />
  );
}

export function ControlProgramRoutingBridge({
  session,
  routingPayload,
  onSlideCommandReceived
}: ProgramRoutingBridgeProps) {
  return session ? (
    <LiveKitRoom
      token={session.token}
      serverUrl={session.wsUrl}
      connect
      data-lk-theme="default"
      className="contents"
    >
      <ProgramRoutingBridgeContent
        routingPayload={routingPayload}
        onSlideCommandReceived={onSlideCommandReceived}
      />
    </LiveKitRoom>
  ) : null;
}

export function ProgramOutputSurface({
  session,
  channel,
  programGuestIds,
  emptyClassName = "h-full w-full bg-black"
}: ProgramOutputSurfaceProps) {
  return session ? (
    <LiveKitRoom
      token={session.token}
      serverUrl={session.wsUrl}
      connect
      data-lk-theme="default"
      className="contents"
    >
      <ProgramOutputContent programGuestIds={programGuestIds} />
    </LiveKitRoom>
  ) : (
    <div className={emptyClassName} />
  );
}

export function ControlGuestGridSurface({
  session,
  channel,
  guests,
  onToggleGuest,
  onToggleGuestSlideControl,
  onSelectGuestReturnSource,
  onDisconnectGuest,
  onPresentGuestIdsChange,
  onLiveGuestStatesChange,
  programAudioOutputDeviceId,
  regieMonitorOutputDeviceId,
  gridClassName,
  emptyClassName = "min-h-[60vh] w-full rounded-[28px] bg-black"
}: ControlGuestGridSurfaceProps) {
  return session ? (
    <LiveKitRoom
      token={session.token}
      serverUrl={session.wsUrl}
      connect
      data-lk-theme="default"
      className="contents"
    >
      <ControlGuestGridContent
        guests={guests}
        onToggleGuest={onToggleGuest}
        onToggleGuestSlideControl={onToggleGuestSlideControl}
        onSelectGuestReturnSource={onSelectGuestReturnSource}
        onDisconnectGuest={onDisconnectGuest}
        onPresentGuestIdsChange={onPresentGuestIdsChange}
        onLiveGuestStatesChange={onLiveGuestStatesChange}
        programAudioOutputDeviceId={programAudioOutputDeviceId}
        regieMonitorOutputDeviceId={regieMonitorOutputDeviceId}
        gridClassName={gridClassName}
      />
    </LiveKitRoom>
  ) : (
    <div className={emptyClassName} />
  );
}
