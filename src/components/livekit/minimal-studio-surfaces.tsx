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
import { ConnectionQuality, Room, RoomEvent, Track } from "livekit-client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AudioLevelMeter } from "@/components/studio/audio-level-meter";
import { parseParticipantMetadata } from "@/lib/livekit/metadata";
import { getIndicatorClasses, type MediaStatusIndicator } from "@/lib/studio/media-status";
import type { TokenResponsePayload } from "@/lib/types/livekit";
import type {
  GuestVideoFraming,
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
  onProgramAudioMutedChange?: (isMuted: boolean) => void;
  onRegieAudioMutedChange?: (isMuted: boolean) => void;
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
  guestVideoFraming?: Record<string, GuestVideoFraming | undefined>;
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
    connectionQuality: RuntimeParticipantState["connectionQuality"];
    programAudioMuted: boolean;
    regieAudioMuted: boolean;
    returnSourceControlDisabled: boolean;
    disconnectControlDisabled: boolean;
    slideControlEnabled: boolean;
    videoFraming: GuestVideoFraming;
  }>;
  onToggleGuest: (participantId: string) => void;
  onToggleProgramAudioMute?: (participantId: string) => void;
  onToggleRegieAudioMute?: (participantId: string) => void;
  onToggleGuestSlideControl?: (participantId: string) => void;
  onAdjustGuestVideoFraming?: (participantId: string, action: GuestVideoFramingAction) => void;
  onSelectGuestReturnSource?: (participantId: string, source: ReturnSource) => void;
  onDisconnectGuest?: (participantId: string) => void;
  onPresentGuestIdsChange?: (participantIds: string[]) => void;
  onLiveGuestStatesChange?: (participants: RuntimeParticipantState[]) => void;
  recordingCommand?: ProgramRecordingCommand | null;
  onRecordingStatusChange?: (status: ProgramRecordingStatus) => void;
  programAudioOutputDeviceId?: string | null;
  regieMonitorOutputDeviceId?: string | null;
  gridClassName?: string;
}

export type GuestVideoFramingAction = "zoom-in" | "zoom-out" | "up" | "down" | "left" | "right" | "reset";

const defaultGuestVideoFraming: GuestVideoFraming = {
  zoom: 1,
  x: 0,
  y: 0
};

function getVideoFramingTransform(framing?: GuestVideoFraming) {
  const nextFraming = framing ?? defaultGuestVideoFraming;

  return {
    transform: `translate(${nextFraming.x}%, ${nextFraming.y}%) scale(${nextFraming.zoom})`,
    transformOrigin: "center"
  };
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

export interface ProgramRecordingCommand {
  action: "start" | "stop";
  requestId: number;
}

export interface ProgramRecordingStatus {
  state: "idle" | "starting" | "recording" | "stopping" | "saving" | "error";
  startedAt: number | null;
  filePath?: string | null;
  fileSizeBytes?: number | null;
  error?: string | null;
}

interface ProgramReturnRoutingPayload {
  type: "return-routing";
  room: string;
  globalReturnSource: ReturnSource;
  programGuestIds: string[];
  programMutedGuestIds?: string[];
  regieMutedGuestIds?: string[];
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
      connectionQuality: participant.connectionQuality,
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

function getConnectionQualityBarCount(quality: RuntimeParticipantState["connectionQuality"]) {
  switch (quality) {
    case ConnectionQuality.Excellent:
      return 3;
    case ConnectionQuality.Good:
      return 2;
    case ConnectionQuality.Poor:
      return 1;
    default:
      return 0;
  }
}

function ConnectionQualityIndicator({
  quality
}: {
  quality: RuntimeParticipantState["connectionQuality"];
}) {
  const activeBars = getConnectionQualityBarCount(quality);
  const activeClassName =
    quality === ConnectionQuality.Poor
      ? "bg-[#d4301f]"
      : activeBars > 0
        ? "bg-sky-500"
        : "bg-slate-500";

  return (
    <div
      className="flex h-8 items-end gap-1 rounded-full border border-transparent bg-slate-600 px-2 py-1.5 shadow-[0_2px_10px_rgba(0,0,0,0.35)]"
      title={`Connection quality: ${quality}`}
      aria-label={`Connection quality: ${quality}`}
    >
      {[1, 2, 3].map((bar) => (
        <span
          key={bar}
          className={`w-1.5 rounded-full ${bar <= activeBars ? activeClassName : "bg-slate-400/35"}`}
          style={{
            height: `${bar * 5 + 3}px`
          }}
        />
      ))}
    </div>
  );
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
  onProgramAudioMutedChange,
  onRegieAudioMutedChange,
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
  onProgramAudioMutedChange?: (isMuted: boolean) => void;
  onRegieAudioMutedChange?: (isMuted: boolean) => void;
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

    if (typeof localMetadata?.programAudioMuted === "boolean") {
      onProgramAudioMutedChange?.(localMetadata.programAudioMuted);
    }

    if (typeof localMetadata?.regieAudioMuted === "boolean") {
      onRegieAudioMutedChange?.(localMetadata.regieAudioMuted);
    }

    if (typeof localMetadata?.canControlSlides === "boolean") {
      onSlideControlAuthorizedChange?.(localMetadata.canControlSlides);
    }
  }, [
    localMetadata?.canControlSlides,
    localMetadata?.isInProgram,
    localMetadata?.programAudioMuted,
    localMetadata?.regieAudioMuted,
    onProgramAudioMutedChange,
    onRegieAudioMutedChange,
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
        const nextProgramAudioMuted = (parsed.programMutedGuestIds ?? []).some((participantId) =>
          possibleProgramStatusIds.has(participantId)
        );
        const nextRegieAudioMuted = (parsed.regieMutedGuestIds ?? []).some((participantId) =>
          possibleProgramStatusIds.has(participantId)
        );
        onProgramStatusChange?.(nextIsInProgram);
        onProgramAudioMutedChange?.(nextProgramAudioMuted);
        onRegieAudioMutedChange?.(nextRegieAudioMuted);
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
    onProgramAudioMutedChange,
    onRegieAudioMutedChange,
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

const PROGRAM_RECORDING_WIDTH = 1920;
const PROGRAM_RECORDING_HEIGHT = 1080;
const PROGRAM_RECORDING_FPS = 25;
const PROGRAM_RECORDING_VIDEO_BITRATE = 5_000_000;
const PROGRAM_RECORDING_AUDIO_BITRATE = 160_000;

function formatProgramRecordingFileName(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");

  return [
    "MSTV-Program-",
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    ".mp4"
  ].join("");
}

function getProgramRecordingMimeType() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) {
    return null;
  }

  return (
    [
      'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4"
    ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? null
  );
}

function drawVideoCover(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number,
  y: number,
  width: number,
  height: number,
  framing?: GuestVideoFraming
) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;

  if (!sourceWidth || !sourceHeight) {
    context.fillStyle = "#000000";
    context.fillRect(x, y, width, height);
    return;
  }

  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = width / height;
  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;
  let cropX = 0;
  let cropY = 0;

  if (sourceRatio > targetRatio) {
    cropWidth = sourceHeight * targetRatio;
    cropX = (sourceWidth - cropWidth) / 2;
  } else {
    cropHeight = sourceWidth / targetRatio;
    cropY = (sourceHeight - cropHeight) / 2;
  }

  if (framing) {
    const zoom = Math.max(1, Math.min(2, framing.zoom));
    const zoomedCropWidth = cropWidth / zoom;
    const zoomedCropHeight = cropHeight / zoom;
    const maxCropX = sourceWidth - zoomedCropWidth;
    const maxCropY = sourceHeight - zoomedCropHeight;

    cropX =
      cropX +
      (cropWidth - zoomedCropWidth) / 2 -
      (Math.max(-50, Math.min(50, framing.x)) / 100) * zoomedCropWidth;
    cropY =
      cropY +
      (cropHeight - zoomedCropHeight) / 2 -
      (Math.max(-50, Math.min(50, framing.y)) / 100) * zoomedCropHeight;
    cropWidth = zoomedCropWidth;
    cropHeight = zoomedCropHeight;
    cropX = Math.max(0, Math.min(maxCropX, cropX));
    cropY = Math.max(0, Math.min(maxCropY, cropY));
  }

  context.drawImage(video, cropX, cropY, cropWidth, cropHeight, x, y, width, height);
}

function getMediaStreamTrack(trackRef: TrackReference) {
  const track = trackRef.publication.track as
    | (NonNullable<TrackReference["publication"]["track"]> & { mediaStreamTrack?: MediaStreamTrack })
    | undefined;

  return track?.mediaStreamTrack ?? null;
}

function ProgramRecordingBridge({
  guests,
  participantTrackMap,
  participantAudioTrackMap,
  recordingCommand,
  onRecordingStatusChange
}: {
  guests: ControlGuestGridSurfaceProps["guests"];
  participantTrackMap: Map<string, TrackReference>;
  participantAudioTrackMap: Map<string, TrackReference>;
  recordingCommand?: ProgramRecordingCommand | null;
  onRecordingStatusChange?: (status: ProgramRecordingStatus) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latestGuestsRef = useRef(guests);
  const latestVideoTracksRef = useRef(participantTrackMap);
  const latestAudioTracksRef = useRef(participantAudioTrackMap);
  const videoElementsRef = useRef(new Map<string, HTMLVideoElement>());
  const videoTrackSidsRef = useRef(new Map<string, string>());
  const drawIntervalRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const audioNodesRef = useRef<Array<MediaStreamAudioSourceNode>>([]);
  const statusRef = useRef<ProgramRecordingStatus>({ state: "idle", startedAt: null });
  const handledCommandIdRef = useRef<number | null>(null);
  const outputPathRef = useRef<string | null>(null);

  useEffect(() => {
    latestGuestsRef.current = guests;
    latestVideoTracksRef.current = participantTrackMap;
    latestAudioTracksRef.current = participantAudioTrackMap;
  }, [guests, participantAudioTrackMap, participantTrackMap]);

  const setStatus = (status: ProgramRecordingStatus) => {
    statusRef.current = status;
    onRecordingStatusChange?.(status);
  };

  const cleanupVideoElements = () => {
    for (const [participantId, video] of videoElementsRef.current.entries()) {
      const trackRef = latestVideoTracksRef.current.get(participantId);
      trackRef?.publication.track?.detach(video);
      video.srcObject = null;
    }

    videoElementsRef.current.clear();
    videoTrackSidsRef.current.clear();
  };

  const syncVideoElements = () => {
    const selectedGuests = latestGuestsRef.current.filter((guest) => guest.inProgram).slice(0, 3);
    const selectedIds = new Set(selectedGuests.map((guest) => guest.participantId));

    for (const [participantId, video] of videoElementsRef.current.entries()) {
      if (selectedIds.has(participantId)) {
        continue;
      }

      latestVideoTracksRef.current.get(participantId)?.publication.track?.detach(video);
      video.srcObject = null;
      videoElementsRef.current.delete(participantId);
      videoTrackSidsRef.current.delete(participantId);
    }

    for (const guest of selectedGuests) {
      const trackRef = latestVideoTracksRef.current.get(guest.participantId);
      const track = trackRef?.publication.track;
      const trackSid = trackRef?.publication.trackSid ?? "";

      if (!track || !trackRef) {
        continue;
      }

      const existingTrackSid = videoTrackSidsRef.current.get(guest.participantId);
      const existingVideo = videoElementsRef.current.get(guest.participantId);

      if (existingVideo && existingTrackSid === trackSid) {
        continue;
      }

      if (existingVideo) {
        track.detach(existingVideo);
        existingVideo.srcObject = null;
      }

      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      track.attach(video);
      void video.play().catch(() => undefined);
      videoElementsRef.current.set(guest.participantId, video);
      videoTrackSidsRef.current.set(guest.participantId, trackSid);
    }
  };

  const drawFrame = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context) {
      return;
    }

    syncVideoElements();

    const selectedGuests = latestGuestsRef.current.filter((guest) => guest.inProgram).slice(0, 3);
    context.fillStyle = "#000000";
    context.fillRect(0, 0, canvas.width, canvas.height);

    if (selectedGuests.length === 0) {
      return;
    }

    const slotWidth = canvas.width / selectedGuests.length;

    selectedGuests.forEach((guest, index) => {
      const x = Math.round(index * slotWidth);
      const nextX = Math.round((index + 1) * slotWidth);
      const width = nextX - x;
      const video = videoElementsRef.current.get(guest.participantId);

      if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        drawVideoCover(context, video, x, 0, width, canvas.height, guest.videoFraming);
      } else {
        context.fillStyle = "#000000";
        context.fillRect(x, 0, width, canvas.height);
      }
    });

    if (selectedGuests.length > 1) {
      context.fillStyle = "#ffffff";

      for (let index = 1; index < selectedGuests.length; index += 1) {
        const x = Math.round(index * slotWidth - 2.5);
        context.fillRect(x, 0, 5, canvas.height);
      }
    }
  };

  const cleanupAudioGraph = () => {
    for (const node of audioNodesRef.current) {
      node.disconnect();
    }

    audioNodesRef.current = [];
  };

  const syncAudioGraph = () => {
    const audioContext = audioContextRef.current;
    const destination = audioDestinationRef.current;

    if (!audioContext || !destination) {
      return;
    }

    cleanupAudioGraph();

    const activeProgramGuests = latestGuestsRef.current.filter(
      (guest) => guest.inProgram && !guest.programAudioMuted
    );

    for (const guest of activeProgramGuests) {
      const trackRef = latestAudioTracksRef.current.get(guest.participantId);

      if (!trackRef) {
        continue;
      }

      const mediaStreamTrack = getMediaStreamTrack(trackRef);

      if (!mediaStreamTrack) {
        continue;
      }

      const source = audioContext.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
      source.connect(destination);
      audioNodesRef.current.push(source);
    }
  };

  useEffect(() => {
    if (statusRef.current.state === "recording") {
      syncAudioGraph();
    }
  });

  const cleanupRecording = () => {
    if (drawIntervalRef.current !== null) {
      window.clearInterval(drawIntervalRef.current);
      drawIntervalRef.current = null;
    }

    cleanupVideoElements();
    cleanupAudioGraph();
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    audioDestinationRef.current = null;
    mediaRecorderRef.current = null;
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;

    if (!recorder || recorder.state === "inactive") {
      return;
    }

    setStatus({ ...statusRef.current, state: "stopping" });
    recorder.stop();
  };

  const startRecording = async () => {
    const canvas = canvasRef.current;
    const desktopApi = (window as Window & {
      mstvDesktop?: {
        chooseProgramRecordingPath?: (input: {
          defaultFileName: string;
        }) => Promise<{ canceled: boolean; filePath: string | null }>;
        saveProgramRecording?: (input: {
          bytes: ArrayBuffer;
          filePath: string;
        }) => Promise<{ ok: boolean; filePath: string; fileSizeBytes?: number }>;
      };
    }).mstvDesktop;

    if (!canvas || typeof canvas.captureStream !== "function") {
      setStatus({
        state: "error",
        startedAt: null,
        error: "Le compositor Program interne n’est pas disponible."
      });
      return;
    }

    if (!desktopApi?.chooseProgramRecordingPath || !desktopApi.saveProgramRecording) {
      setStatus({
        state: "error",
        startedAt: null,
        error: "L’enregistrement local est disponible uniquement dans MSTV Visio desktop."
      });
      return;
    }

    const mimeType = getProgramRecordingMimeType();

    if (!mimeType) {
      setStatus({
        state: "error",
        startedAt: null,
        error:
          "Encodeur MP4 H.264/AAC indisponible dans ce runtime. Il faudra embarquer FFmpeg pour garantir le MP4."
      });
      return;
    }

    const defaultFileName = formatProgramRecordingFileName(new Date());
    const selectedPath = await desktopApi.chooseProgramRecordingPath({ defaultFileName });

    if (selectedPath.canceled || !selectedPath.filePath) {
      outputPathRef.current = null;
      setStatus({ state: "idle", startedAt: null, error: null, filePath: null });
      return;
    }

    outputPathRef.current = selectedPath.filePath;
    setStatus({ state: "starting", startedAt: null, error: null, filePath: null });
    console.info("[MSTV Recording] recording started", {
      outputPath: selectedPath.filePath,
      width: PROGRAM_RECORDING_WIDTH,
      height: PROGRAM_RECORDING_HEIGHT,
      fps: PROGRAM_RECORDING_FPS,
      videoBitrate: PROGRAM_RECORDING_VIDEO_BITRATE,
      audioBitrate: PROGRAM_RECORDING_AUDIO_BITRATE,
      mimeType
    });
    chunksRef.current = [];
    canvas.width = PROGRAM_RECORDING_WIDTH;
    canvas.height = PROGRAM_RECORDING_HEIGHT;
    drawFrame();

    const AudioContextConstructor = window.AudioContext;
    const audioContext = new AudioContextConstructor({ sampleRate: 48_000 });
    const audioDestination = audioContext.createMediaStreamDestination();
    audioContextRef.current = audioContext;
    audioDestinationRef.current = audioDestination;
    syncAudioGraph();

    const videoStream = canvas.captureStream(PROGRAM_RECORDING_FPS);
    const recordingStream = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioDestination.stream.getAudioTracks()
    ]);
    const recorder = new MediaRecorder(recordingStream, {
      mimeType,
      videoBitsPerSecond: PROGRAM_RECORDING_VIDEO_BITRATE,
      audioBitsPerSecond: PROGRAM_RECORDING_AUDIO_BITRATE
    });

    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };
    recorder.onerror = () => {
      cleanupRecording();
      setStatus({
        state: "error",
        startedAt: null,
        error: "Erreur pendant l’enregistrement Program."
      });
    };
    recorder.onstop = () => {
      const chunks = chunksRef.current;
      const outputPath = outputPathRef.current;

      console.info("[MSTV Recording] recording stopped", {
        chunks: chunks.length,
        outputPath
      });
      setStatus({ ...statusRef.current, state: "saving" });
      cleanupRecording();

      if (!outputPath) {
        setStatus({
          state: "error",
          startedAt: null,
          error: "Aucun chemin d’enregistrement sélectionné."
        });
        return;
      }

      void new Blob(chunks, { type: mimeType })
        .arrayBuffer()
        .then((bytes) => desktopApi.saveProgramRecording!({ bytes, filePath: outputPath }))
        .then((result) => {
          console.info("[MSTV Recording] recording saved", {
            outputPath: result.filePath,
            fileSizeBytes: result.fileSizeBytes ?? null,
            ffmpegExitCode: null
          });
          setStatus({
            state: "idle",
            startedAt: null,
            filePath: result.filePath,
            fileSizeBytes: result.fileSizeBytes ?? null,
            error: null
          });
        })
        .catch((error) => {
          setStatus({
            state: "error",
            startedAt: null,
            error: error instanceof Error ? error.message : "Impossible d’écrire le MP4."
          });
        });
    };

    recorder.start(1000);
    drawIntervalRef.current = window.setInterval(drawFrame, 1000 / PROGRAM_RECORDING_FPS);
    setStatus({ state: "recording", startedAt: Date.now(), error: null, filePath: null });
  };

  useEffect(() => {
    if (!recordingCommand || handledCommandIdRef.current === recordingCommand.requestId) {
      return;
    }

    handledCommandIdRef.current = recordingCommand.requestId;

    if (recordingCommand.action === "start") {
      void startRecording();
    } else {
      stopRecording();
    }
  });

  useEffect(() => {
    return () => {
      cleanupRecording();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={PROGRAM_RECORDING_WIDTH}
      height={PROGRAM_RECORDING_HEIGHT}
      className="hidden"
    />
  );
}

function ProgramVideoSlot({
  trackRef,
  framing
}: {
  trackRef?: TrackReference;
  framing?: GuestVideoFraming;
}) {
  return (
    <div className="h-full w-full overflow-hidden bg-black">
      {trackRef ? (
        <VideoTrack
          trackRef={trackRef}
          className="h-full w-full object-cover object-center"
          style={getVideoFramingTransform(framing)}
        />
      ) : null}
    </div>
  );
}

function ProgramOutputContent({
  programGuestIds,
  guestVideoFraming = {}
}: {
  programGuestIds: string[];
  guestVideoFraming?: Record<string, GuestVideoFraming | undefined>;
}) {
  const { selectedVideoSlots } = useSelectedProgramMedia(programGuestIds);

  if (selectedVideoSlots.length === 0) {
    return <div className="h-full w-full bg-black" />;
  }

  if (selectedVideoSlots.length === 1) {
    return (
      <ProgramVideoSlot
        trackRef={selectedVideoSlots[0].trackRef}
        framing={guestVideoFraming[selectedVideoSlots[0].participantId]}
      />
    );
  }

  if (selectedVideoSlots.length === 2) {
    return (
      <div className="relative h-full w-full bg-black">
        <div className="grid h-full w-full grid-cols-2 bg-black">
          {selectedVideoSlots.map((slot) => (
            <ProgramVideoSlot
              key={slot.participantId}
              trackRef={slot.trackRef}
              framing={guestVideoFraming[slot.participantId]}
            />
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
          <ProgramVideoSlot
            key={slot.participantId}
            trackRef={slot.trackRef}
            framing={guestVideoFraming[slot.participantId]}
          />
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
      const previewTracks = [nextVideoTrack, nextAudioTrack].filter(
        (track): track is MediaStreamTrack => track !== null
      );
      const previewStream = previewTracks.length > 0 ? new MediaStream(previewTracks) : null;

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
  onToggleProgramAudioMute,
  onToggleRegieAudioMute,
  onToggleGuestSlideControl,
  onAdjustGuestVideoFraming,
  onSelectGuestReturnSource,
  onDisconnectGuest,
  onPresentGuestIdsChange,
  onLiveGuestStatesChange,
  recordingCommand,
  onRecordingStatusChange,
  programAudioOutputDeviceId,
  regieMonitorOutputDeviceId,
  gridClassName
}: Pick<
  ControlGuestGridSurfaceProps,
  | "guests"
  | "onToggleGuest"
  | "onToggleProgramAudioMute"
  | "onToggleRegieAudioMute"
  | "onToggleGuestSlideControl"
  | "onAdjustGuestVideoFraming"
  | "onSelectGuestReturnSource"
  | "onDisconnectGuest"
  | "onPresentGuestIdsChange"
  | "onLiveGuestStatesChange"
  | "recordingCommand"
  | "onRecordingStatusChange"
  | "programAudioOutputDeviceId"
  | "regieMonitorOutputDeviceId"
  | "gridClassName"
>) {
  const remoteParticipants = useRemoteParticipants();
  const room = useRoomContext();
  const [connectionQualityVersion, setConnectionQualityVersion] = useState(0);
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
    .filter((guest) => guest.inProgram && !guest.programAudioMuted)
    .map((guest) => participantAudioTrackMap.get(guest.participantId))
    .filter((trackRef): trackRef is TrackReference => trackRef !== undefined);
  const regieMonitorAudioTracks = guests
    .filter(
      (guest) =>
        !guest.inProgram && guest.effectiveReturnSource === "REGIE" && !guest.regieAudioMuted
    )
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
    const handleConnectionQualityChanged = () => {
      setConnectionQualityVersion((version) => version + 1);
    };

    room.on(RoomEvent.ConnectionQualityChanged, handleConnectionQualityChanged);

    return () => {
      room.off(RoomEvent.ConnectionQualityChanged, handleConnectionQualityChanged);
    };
  }, [room]);

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
  }, [connectionQualityVersion, onLiveGuestStatesChange, remoteParticipants]);

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
        <ProgramRecordingBridge
          guests={guests}
          participantTrackMap={participantTrackMap}
          participantAudioTrackMap={participantAudioTrackMap}
          recordingCommand={recordingCommand}
          onRecordingStatusChange={onRecordingStatusChange}
        />
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
        const isActiveInRegie = !guest.inProgram && guest.effectiveReturnSource === "REGIE";
        const audibleAudioTrackRef =
          guest.inProgram && !guest.programAudioMuted
            ? participantAudioTrackMap.get(guest.participantId)
            : isActiveInRegie && !guest.regieAudioMuted
              ? participantAudioTrackMap.get(guest.participantId)
              : undefined;
        const audibleAudioTrack = audibleAudioTrackRef ? getMediaStreamTrack(audibleAudioTrackRef) : null;
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
                : "border-slate-600 bg-white/[0.03] hover:border-slate-600 hover:bg-white/[0.05]"
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
                  style={getVideoFramingTransform(guest.videoFraming)}
                />
              ) : (
                <div className="h-full w-full bg-black pointer-events-none" />
              )}

              <div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />
              <AudioLevelMeter track={audibleAudioTrack} />
              <div
                className="absolute left-4 top-1/2 z-30 grid -translate-y-1/2 grid-cols-3 gap-1 rounded-2xl border border-white/10 bg-black/55 p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.35)] backdrop-blur-sm"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                {[
                  { action: "zoom-out", label: "−", title: "Zoom -" },
                  { action: "up", label: "↑", title: "Monter" },
                  { action: "zoom-in", label: "+", title: "Zoom +" },
                  { action: "left", label: "←", title: "Gauche" },
                  { action: "reset", label: "R", title: "Réinitialiser" },
                  { action: "right", label: "→", title: "Droite" },
                  { action: "down", label: "↓", title: "Descendre" }
                ].map((control) => (
                  <button
                    key={control.action}
                    type="button"
                    title={control.title}
                    className={`flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-slate-700 text-[11px] font-semibold leading-none text-white shadow-[0_2px_8px_rgba(0,0,0,0.25)] transition hover:bg-slate-500 ${
                      control.action === "down" ? "col-start-2" : ""
                    }`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onAdjustGuestVideoFraming?.(
                        guest.participantId,
                        control.action as GuestVideoFramingAction
                      );
                    }}
                  >
                    {control.label}
                  </button>
                ))}
              </div>

              <div className="pointer-events-none absolute left-4 top-4 z-20 flex gap-2">
                {guest.inProgram || isActiveInRegie ? (
                  <button
                    type="button"
                    aria-pressed={guest.inProgram ? !guest.programAudioMuted : !guest.regieAudioMuted}
                    title={
                      guest.inProgram
                        ? guest.programAudioMuted
                          ? "Réactiver le micro dans le Program"
                          : "Couper le micro dans le Program"
                        : guest.regieAudioMuted
                          ? "Réactiver le micro dans la Régie"
                          : "Couper le micro dans la Régie"
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      if (guest.inProgram) {
                        onToggleProgramAudioMute?.(guest.participantId);
                      } else {
                        onToggleRegieAudioMute?.(guest.participantId);
                      }
                    }}
                    className={`${pillBaseClassName} pointer-events-auto transition ${
                      (guest.inProgram ? guest.programAudioMuted : guest.regieAudioMuted)
                        ? getIndicatorClasses("red")
                        : getIndicatorClasses("green")
                    }`}
                  >
                    Mic
                  </button>
                ) : (
                  <div
                    className={`${pillBaseClassName} ${getIndicatorClasses(
                      guest.microphoneIndicator.tone
                    )}`}
                  >
                    Mic
                  </div>
                )}
                <div
                  className={`${pillBaseClassName} ${getIndicatorClasses(
                    guest.cameraIndicator.tone
                  )}`}
                >
                  Cam
                </div>
              </div>

              {guest.selectionOrder ? (
                <div className="pointer-events-none absolute right-4 top-4 z-20 flex flex-col items-end gap-2">
                  <ConnectionQualityIndicator quality={guest.connectionQuality} />
                  <div className="mstv-ui-badge border border-transparent bg-emerald-500 text-white shadow-[0_2px_10px_rgba(0,0,0,0.35)]">
                    {guest.selectionOrder}
                  </div>
                </div>
              ) : (
                <div className="pointer-events-none absolute right-4 top-4 z-20">
                  <ConnectionQualityIndicator quality={guest.connectionQuality} />
                </div>
              )}

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
  onProgramAudioMutedChange,
  onRegieAudioMutedChange,
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
        onProgramAudioMutedChange={onProgramAudioMutedChange}
        onRegieAudioMutedChange={onRegieAudioMutedChange}
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
  guestVideoFraming,
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
      <ProgramOutputContent programGuestIds={programGuestIds} guestVideoFraming={guestVideoFraming} />
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
  onToggleProgramAudioMute,
  onToggleRegieAudioMute,
  onToggleGuestSlideControl,
  onAdjustGuestVideoFraming,
  onSelectGuestReturnSource,
  onDisconnectGuest,
  onPresentGuestIdsChange,
  onLiveGuestStatesChange,
  recordingCommand,
  onRecordingStatusChange,
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
        onToggleProgramAudioMute={onToggleProgramAudioMute}
        onToggleRegieAudioMute={onToggleRegieAudioMute}
        onToggleGuestSlideControl={onToggleGuestSlideControl}
        onAdjustGuestVideoFraming={onAdjustGuestVideoFraming}
        onSelectGuestReturnSource={onSelectGuestReturnSource}
        onDisconnectGuest={onDisconnectGuest}
        onPresentGuestIdsChange={onPresentGuestIdsChange}
        onLiveGuestStatesChange={onLiveGuestStatesChange}
        recordingCommand={recordingCommand}
        onRecordingStatusChange={onRecordingStatusChange}
        programAudioOutputDeviceId={programAudioOutputDeviceId}
        regieMonitorOutputDeviceId={regieMonitorOutputDeviceId}
        gridClassName={gridClassName}
      />
    </LiveKitRoom>
  ) : (
    <div className={emptyClassName} />
  );
}
