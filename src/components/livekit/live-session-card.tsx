"use client";

import {
  LiveKitRoom,
  RoomAudioRenderer,
  type TrackReference,
  useLocalParticipant,
  useRemoteParticipants,
  VideoTrack,
  useConnectionState,
  useTracks
} from "@livekit/components-react";
import { Track } from "livekit-client";
import { useEffect, useMemo, useRef } from "react";
import { parseParticipantMetadata } from "@/lib/livekit/metadata";
import type { TokenResponsePayload } from "@/lib/types/livekit";
import type { LiveRoomSnapshot, RuntimeParticipantState, StudioControlCommand } from "@/lib/types/runtime";
import type { SessionChannel } from "@/lib/types/roles";

interface LiveSessionCardProps {
  title: string;
  description: string;
  session: TokenResponsePayload | null;
  emptyLabel: string;
  channel: SessionChannel;
  publishAudio?: boolean;
  publishVideo?: boolean;
  allowVideoGrid?: boolean;
  onSnapshot?: (snapshot: LiveRoomSnapshot) => void;
  pendingCommand?: StudioControlCommand | null;
  onCommandApplied?: (commandId: string) => void;
}

function SessionInspector({
  channel,
  allowVideoGrid,
  onSnapshot,
  pendingCommand,
  onCommandApplied
}: {
  channel: SessionChannel;
  allowVideoGrid: boolean;
  onSnapshot?: (snapshot: LiveRoomSnapshot) => void;
  pendingCommand?: StudioControlCommand | null;
  onCommandApplied?: (commandId: string) => void;
}) {
  const connectionState = useConnectionState();
  const remoteParticipants = useRemoteParticipants();
  const { isCameraEnabled, isMicrophoneEnabled, localParticipant, cameraTrack, microphoneTrack } =
    useLocalParticipant();
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
  const concreteVideoTracks = videoTracks.filter(
    (trackRef): trackRef is TrackReference => trackRef.publication !== undefined
  );
  const lastAppliedCommandRef = useRef<string | null>(null);
  const lastSnapshotSignatureRef = useRef<string | null>(null);
  const remoteParticipantStates: RuntimeParticipantState[] = useMemo(
    () =>
      remoteParticipants.map((participant) => {
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
      }),
    [remoteParticipants]
  );
  const snapshot = useMemo<LiveRoomSnapshot>(() => {
    const programFeedParticipant = remoteParticipantStates.find(
      (participant) => participant.surfaceRole === "programFeed"
    );

    return {
      channel,
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
    channel,
    concreteVideoTracks.length,
    connectionState,
    isCameraEnabled,
    isMicrophoneEnabled,
    microphoneTrack,
    remoteParticipantStates,
    remoteParticipants.length
  ]);

  useEffect(() => {
    if (!onSnapshot) {
      return;
    }

    const snapshotSignature = JSON.stringify(snapshot);

    if (lastSnapshotSignatureRef.current === snapshotSignature) {
      return;
    }

    lastSnapshotSignatureRef.current = snapshotSignature;
    onSnapshot(snapshot);
  }, [onSnapshot, snapshot]);

  useEffect(() => {
    if (!pendingCommand || pendingCommand.type !== "mute-microphone") {
      return;
    }

    if (lastAppliedCommandRef.current === pendingCommand.id) {
      return;
    }

    lastAppliedCommandRef.current = pendingCommand.id;

    void localParticipant.setMicrophoneEnabled(false).then(() => {
      onCommandApplied?.(pendingCommand.id);
    });
  }, [localParticipant, onCommandApplied, pendingCommand]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Connection</p>
          <p className="mt-2 text-lg font-medium text-slate-100">{connectionState}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Participants</p>
          <p className="mt-2 text-lg font-medium text-slate-100">{remoteParticipants.length + 1}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Video Feeds</p>
          <p className="mt-2 text-lg font-medium text-slate-100">{concreteVideoTracks.length}</p>
        </div>
      </div>

      {allowVideoGrid ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {concreteVideoTracks.length > 0 ? (
            concreteVideoTracks.map((trackRef) => (
              <div
                key={trackRef.publication?.trackSid ?? trackRef.participant.identity}
                className="overflow-hidden rounded-[22px] border border-white/10 bg-black"
              >
                <VideoTrack trackRef={trackRef} className="aspect-video w-full object-cover" />
                <div className="border-t border-white/10 bg-ink/80 px-4 py-3 text-sm text-slate-200">
                  {trackRef.participant.name || trackRef.participant.identity}
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-[22px] border border-dashed border-white/15 bg-white/[0.03] p-6 text-sm text-slate-400">
              Awaiting remote video feeds for this session.
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-[22px] border border-dashed border-white/15 bg-white/[0.03] p-6 text-sm text-slate-400">
          {channel === "program"
            ? "Program return is connected without exposing multi-party meeting chrome."
            : "Contribution monitoring is connected without exposing meeting-style room plumbing."}
        </div>
      )}

      <RoomAudioRenderer />
    </div>
  );
}

export function LiveSessionCard({
  title,
  description,
  session,
  emptyLabel,
  channel,
  publishAudio = false,
  publishVideo = false,
  allowVideoGrid = false,
  onSnapshot,
  pendingCommand,
  onCommandApplied
}: LiveSessionCardProps) {
  return (
    <section className="panel rounded-[24px] p-5 md:p-6">
      <div className="mb-5">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">{description}</p>
      </div>

      {session ? (
        <LiveKitRoom
          token={session.token}
          serverUrl={session.wsUrl}
          connect
          audio={publishAudio}
          video={publishVideo}
          data-lk-theme="default"
          className="contents"
        >
          <SessionInspector
            channel={channel}
            allowVideoGrid={allowVideoGrid}
            onSnapshot={onSnapshot}
            pendingCommand={pendingCommand}
            onCommandApplied={onCommandApplied}
          />
        </LiveKitRoom>
      ) : (
        <div className="rounded-[22px] border border-dashed border-white/15 bg-white/[0.03] p-6 text-sm text-slate-400">
          {emptyLabel}
        </div>
      )}
    </section>
  );
}
