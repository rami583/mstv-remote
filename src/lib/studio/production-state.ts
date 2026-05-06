import { normalizeRoomSlug } from "@/lib/livekit/topology";
import type { StudioMessage } from "@/lib/types/messaging";
import type {
  GuestVideoFraming,
  ProductionParticipantState,
  ProductionSnapshot,
  ReturnSource,
  StudioControlCommand
} from "@/lib/types/runtime";
import type { SurfaceRole } from "@/lib/types/roles";

interface RoomState {
  programGuestIds: string[];
  guestVideoFraming: Map<string, GuestVideoFraming>;
  globalReturnSource: ReturnSource;
  guestReturnOverrides: Map<string, ReturnSource>;
  participants: Map<string, ProductionParticipantState>;
  arrivalCounter: number;
  messages: StudioMessage[];
  commands: StudioControlCommand[];
  updatedAt: string;
}

const PARTICIPANT_STALE_AFTER_MS = 45_000;
const MIN_GUEST_VIDEO_ZOOM = 1;
const MAX_GUEST_VIDEO_ZOOM = 2;

declare global {
  var __visioProductionStore: Map<string, RoomState> | undefined;
}

function getStore() {
  if (!globalThis.__visioProductionStore) {
    globalThis.__visioProductionStore = new Map<string, RoomState>();
  }

  return globalThis.__visioProductionStore;
}

function getRoomState(room: string): RoomState {
  const roomSlug = normalizeRoomSlug(room);
  const store = getStore();

  if (!store.has(roomSlug)) {
    store.set(roomSlug, {
      programGuestIds: [],
      guestVideoFraming: new Map<string, GuestVideoFraming>(),
      globalReturnSource: "STUDIO",
      guestReturnOverrides: new Map<string, ReturnSource>(),
      participants: new Map<string, ProductionParticipantState>(),
      arrivalCounter: 0,
      messages: [],
      commands: [],
      updatedAt: new Date().toISOString()
    });
  }

  const roomState = store.get(roomSlug)!;
  roomState.guestVideoFraming ??= new Map<string, GuestVideoFraming>();

  return roomState;
}

export function upsertParticipantState(
  participant: Omit<
    ProductionParticipantState,
    "updatedAt" | "lastSeen" | "joinedAt" | "arrivalIndex"
  >
) {
  const roomState = getRoomState(participant.room);
  const now = new Date().toISOString();
  const existingParticipant = roomState.participants.get(participant.participantId);
  const updatedParticipant = {
    ...participant,
    room: normalizeRoomSlug(participant.room),
    joinedAt: existingParticipant?.joinedAt ?? now,
    arrivalIndex: existingParticipant?.arrivalIndex ?? ++roomState.arrivalCounter,
    lastSeen: now,
    updatedAt: now
  };

  roomState.participants.set(updatedParticipant.participantId, updatedParticipant);
  roomState.updatedAt = updatedParticipant.updatedAt;
  pruneRoomState(roomState);

  return updatedParticipant;
}

function isParticipantStale(participant: ProductionParticipantState, now: number) {
  return now - new Date(participant.lastSeen).getTime() > PARTICIPANT_STALE_AFTER_MS;
}

function pruneRoomState(roomState: RoomState) {
  const now = Date.now();
  const staleParticipantIds: string[] = [];

  for (const participant of roomState.participants.values()) {
    if (isParticipantStale(participant, now)) {
      staleParticipantIds.push(participant.participantId);
    }
  }

  if (staleParticipantIds.length === 0) {
    return;
  }

  const staleParticipantIdSet = new Set(staleParticipantIds);

  for (const participantId of staleParticipantIds) {
    roomState.participants.delete(participantId);
  }

  const nextProgramGuestIds = roomState.programGuestIds.filter(
    (participantId) => !staleParticipantIdSet.has(participantId)
  );
  for (const participantId of staleParticipantIds) {
    roomState.guestReturnOverrides.delete(participantId);
    roomState.guestVideoFraming.delete(participantId);
  }

  if (nextProgramGuestIds.length !== roomState.programGuestIds.length) {
    roomState.programGuestIds = nextProgramGuestIds;
  }

  roomState.updatedAt = new Date().toISOString();
}

function clampGuestVideoFraming(framing: GuestVideoFraming): GuestVideoFraming {
  const zoom = Math.max(
    MIN_GUEST_VIDEO_ZOOM,
    Math.min(MAX_GUEST_VIDEO_ZOOM, Number(framing.zoom.toFixed(2)))
  );
  const maxOffset = Number(((zoom - 1) * 50).toFixed(1));

  return {
    zoom,
    x: Math.max(-maxOffset, Math.min(maxOffset, Number(framing.x.toFixed(1)))),
    y: Math.max(-maxOffset, Math.min(maxOffset, Number(framing.y.toFixed(1))))
  };
}

export function getProductionSnapshot(room: string): ProductionSnapshot {
  const roomSlug = normalizeRoomSlug(room);
  const roomState = getRoomState(roomSlug);
  pruneRoomState(roomState);

  return {
    room: roomSlug,
    programGuestIds: [...roomState.programGuestIds],
    guestVideoFraming: Object.fromEntries(roomState.guestVideoFraming.entries()),
    globalReturnSource: roomState.globalReturnSource,
    guestReturnOverrides: Object.fromEntries(roomState.guestReturnOverrides.entries()),
    participants: Array.from(roomState.participants.values()).sort((left, right) => {
      const leftArrivalIndex = left.arrivalIndex ?? Number.MAX_SAFE_INTEGER;
      const rightArrivalIndex = right.arrivalIndex ?? Number.MAX_SAFE_INTEGER;

      return leftArrivalIndex - rightArrivalIndex;
    }),
    messages: [...roomState.messages].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    ),
    commands: [...roomState.commands].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    ),
    updatedAt: roomState.updatedAt
  };
}

export function setProgramGuestIds(room: string, guestIds: string[]) {
  const roomState = getRoomState(room);
  pruneRoomState(roomState);
  const activeParticipantIds = new Set(roomState.participants.keys());
  const hasLocalParticipantPresence = activeParticipantIds.size > 0;

  roomState.programGuestIds = [...guestIds].filter(
    (guestId) => !hasLocalParticipantPresence || activeParticipantIds.has(guestId)
  );
  for (const guestId of roomState.programGuestIds) {
    roomState.guestReturnOverrides.delete(guestId);
  }
  roomState.updatedAt = new Date().toISOString();

  return [...roomState.programGuestIds];
}

export function setGuestVideoFraming(input: {
  room: string;
  guestId: string;
  framing: GuestVideoFraming;
}) {
  const roomState = getRoomState(input.room);
  pruneRoomState(roomState);
  const nextFraming = clampGuestVideoFraming(input.framing);

  if (nextFraming.zoom === 1 && nextFraming.x === 0 && nextFraming.y === 0) {
    roomState.guestVideoFraming.delete(input.guestId);
  } else {
    roomState.guestVideoFraming.set(input.guestId, nextFraming);
  }

  roomState.updatedAt = new Date().toISOString();

  return Object.fromEntries(roomState.guestVideoFraming.entries());
}

export function setGlobalReturnSource(room: string, source: ReturnSource) {
  const roomState = getRoomState(room);
  pruneRoomState(roomState);
  roomState.globalReturnSource = source;
  roomState.guestReturnOverrides.clear();
  roomState.updatedAt = new Date().toISOString();

  return roomState.globalReturnSource;
}

export function setGuestReturnOverride(input: {
  room: string;
  guestId: string;
  source?: ReturnSource;
}) {
  const roomState = getRoomState(input.room);
  pruneRoomState(roomState);

  if (roomState.programGuestIds.includes(input.guestId)) {
    roomState.guestReturnOverrides.delete(input.guestId);
    roomState.updatedAt = new Date().toISOString();
    return Object.fromEntries(roomState.guestReturnOverrides.entries());
  }

  if (input.source && input.source !== roomState.globalReturnSource) {
    roomState.guestReturnOverrides.set(input.guestId, input.source);
  } else {
    roomState.guestReturnOverrides.delete(input.guestId);
  }

  roomState.updatedAt = new Date().toISOString();
  return Object.fromEntries(roomState.guestReturnOverrides.entries());
}

export function removeParticipantState(room: string, participantId: string) {
  const roomState = getRoomState(room);
  pruneRoomState(roomState);
  const existed = roomState.participants.delete(participantId);

  if (!existed) {
    return false;
  }

  roomState.programGuestIds = roomState.programGuestIds.filter((guestId) => guestId !== participantId);
  roomState.guestReturnOverrides.delete(participantId);
  roomState.guestVideoFraming.delete(participantId);
  roomState.updatedAt = new Date().toISOString();

  return true;
}

export function createStudioMessage(message: StudioMessage) {
  const roomState = getRoomState(message.room);
  const createdMessage = {
    ...message,
    room: normalizeRoomSlug(message.room)
  };

  roomState.messages.unshift(createdMessage);
  roomState.updatedAt = new Date().toISOString();

  return createdMessage;
}

export function listMessagesForAudience(
  room: string,
  options: {
    participantId?: string;
    surfaceRole?: SurfaceRole;
  }
) {
  const roomState = getRoomState(room);
  pruneRoomState(roomState);

  if (options.surfaceRole === "control") {
    return [...roomState.messages].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    );
  }

  if (options.surfaceRole === "guest" && options.participantId) {
    return roomState.messages
      .filter(
        (message) =>
          message.target.type === "guest" &&
          message.target.guestIds.includes(options.participantId as string)
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  return roomState.messages
    .filter((message) => message.target.type === "program-log")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function enqueueMuteMicrophoneCommand(input: {
  room: string;
  targetParticipantId: string;
  createdBy: string;
}) {
  const roomState = getRoomState(input.room);
  pruneRoomState(roomState);
  const command: StudioControlCommand = {
    id: crypto.randomUUID(),
    room: normalizeRoomSlug(input.room),
    type: "mute-microphone",
    targetParticipantId: input.targetParticipantId,
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
    status: "pending"
  };

  roomState.commands.unshift(command);
  roomState.updatedAt = command.createdAt;

  const participant = roomState.participants.get(input.targetParticipantId);

  if (participant) {
    roomState.participants.set(input.targetParticipantId, {
      ...participant,
      isMicrophoneMutedByControl: true,
      updatedAt: new Date().toISOString()
    });
  }

  return command;
}

export function getPendingCommands(room: string, participantId: string) {
  const roomState = getRoomState(room);
  pruneRoomState(roomState);

  return roomState.commands.filter(
    (command) => command.targetParticipantId === participantId && command.status === "pending"
  );
}

export function acknowledgeCommand(input: {
  room: string;
  commandId: string;
  participantId: string;
}) {
  const roomState = getRoomState(input.room);
  pruneRoomState(roomState);
  const command = roomState.commands.find(
    (entry) => entry.id === input.commandId && entry.targetParticipantId === input.participantId
  );

  if (!command) {
    return null;
  }

  command.status = "acknowledged";
  command.acknowledgedAt = new Date().toISOString();
  roomState.updatedAt = command.acknowledgedAt;

  const participant = roomState.participants.get(input.participantId);

  if (participant) {
    roomState.participants.set(input.participantId, {
      ...participant,
      microphonePublished: false,
      isMicrophoneMutedByControl: true,
      updatedAt: new Date().toISOString()
    });
  }

  return command;
}
