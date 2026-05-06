import type { StudioMessage } from "@/lib/types/messaging";
import type { ControlRole, SessionChannel, SurfaceRole } from "@/lib/types/roles";

export const returnSources = ["STUDIO", "REGIE", "IMAGE"] as const;
export type ReturnSource = (typeof returnSources)[number];

export type SlideControlCommandType = "NEXT_SLIDE" | "PREV_SLIDE";

export interface PendingSlideControlCommand {
  commandId: string;
  room: string;
  command: SlideControlCommandType;
}

export interface SlideControlCommandMessage {
  type: "slide-control-command";
  commandId: string;
  room: string;
  command: SlideControlCommandType;
  guestParticipantId: string;
  guestName: string;
  createdAt: string;
}

export type PrivateChatSenderRole = "control" | "guest";

export interface PrivateChatMessage {
  type: "private-chat-message";
  messageId: string;
  room: string;
  body: string;
  fromParticipantId: string;
  fromName: string;
  fromRole: PrivateChatSenderRole;
  targetParticipantId: string;
  targetRole: PrivateChatSenderRole;
  createdAt: string;
}

export interface TrackRuntimeState {
  published: boolean;
  muted: boolean;
  missing: boolean;
}

export interface RuntimeParticipantState {
  participantId: string;
  displayName: string;
  surfaceRole: SurfaceRole;
  channel: SessionChannel | "unknown";
  controlRole?: ControlRole;
  connectionQuality: "poor" | "good" | "excellent" | "lost" | "unknown";
  cameraPublished: boolean;
  microphonePublished: boolean;
  cameraTrackState: TrackRuntimeState;
  microphoneTrackState: TrackRuntimeState;
}

export interface LiveRoomSnapshot {
  channel: SessionChannel;
  connectionState: string;
  participantCount: number;
  videoTrackCount: number;
  hasProgramFeed: boolean;
  programFeedLabel?: string;
  localCameraPublished: boolean;
  localMicrophonePublished: boolean;
  localCameraTrackState: TrackRuntimeState;
  localMicrophoneTrackState: TrackRuntimeState;
  remoteParticipants: RuntimeParticipantState[];
}

export interface ProductionParticipantState {
  room: string;
  roomName: string;
  participantId: string;
  displayName: string;
  surfaceRole: SurfaceRole;
  channel: SessionChannel;
  controlRole?: ControlRole;
  connectionState: string;
  participantCount: number;
  videoTrackCount: number;
  cameraPublished: boolean;
  microphonePublished: boolean;
  cameraTrackState: TrackRuntimeState;
  microphoneTrackState: TrackRuntimeState;
  hasProgramFeed: boolean;
  isMicrophoneMutedByControl: boolean;
  joinedAt: string;
  arrivalIndex: number;
  lastSeen: string;
  updatedAt: string;
}

export interface StudioControlCommand {
  id: string;
  room: string;
  type: "mute-microphone";
  targetParticipantId: string;
  createdBy: string;
  createdAt: string;
  acknowledgedAt?: string;
  status: "pending" | "acknowledged";
}

export interface GuestVideoFraming {
  zoom: number;
  x: number;
  y: number;
}

export interface ProductionSnapshot {
  room: string;
  programGuestIds: string[];
  guestVideoFraming: Record<string, GuestVideoFraming | undefined>;
  globalReturnSource: ReturnSource;
  guestReturnOverrides: Record<string, ReturnSource | undefined>;
  participants: ProductionParticipantState[];
  messages: StudioMessage[];
  commands: StudioControlCommand[];
  updatedAt: string;
}
