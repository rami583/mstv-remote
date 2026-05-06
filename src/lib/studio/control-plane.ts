import type { StudioMessage } from "@/lib/types/messaging";
import type {
  GuestVideoFraming,
  ProductionParticipantState,
  ProductionSnapshot,
  ReturnSource,
  StudioControlCommand
} from "@/lib/types/runtime";

export async function publishParticipantState(
  room: string,
  participant: Omit<ProductionParticipantState, "updatedAt" | "lastSeen" | "joinedAt" | "arrivalIndex">
) {
  await fetch(`/api/production/${encodeURIComponent(room)}/state`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(participant)
  });
}

export async function fetchProductionSnapshot(room: string): Promise<ProductionSnapshot> {
  const response = await fetch(`/api/production/${encodeURIComponent(room)}/state`, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error("Unable to load production snapshot.");
  }

  return (await response.json()) as ProductionSnapshot;
}

export async function updateProgramScene(room: string, guestIds: string[]) {
  const response = await fetch(`/api/production/${encodeURIComponent(room)}/scene`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      guestIds
    })
  });

  if (!response.ok) {
    throw new Error("Unable to update program scene.");
  }

  return (await response.json()) as { room: string; guestIds: string[] };
}

export async function updateGuestVideoFraming(
  room: string,
  guestId: string,
  framing: GuestVideoFraming
) {
  const response = await fetch(`/api/production/${encodeURIComponent(room)}/scene`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      guestVideoFraming: {
        guestId,
        framing
      }
    })
  });

  if (!response.ok) {
    throw new Error("Unable to update guest framing.");
  }

  return (await response.json()) as {
    room: string;
    guestVideoFraming: Record<string, GuestVideoFraming | undefined>;
  };
}

export async function updateGlobalReturnSource(room: string, source: ReturnSource) {
  const response = await fetch(`/api/production/${encodeURIComponent(room)}/return`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "set-global",
      source
    })
  });

  if (!response.ok) {
    throw new Error("Unable to update global return source.");
  }

  return (await response.json()) as {
    room: string;
    globalReturnSource: ReturnSource;
    guestReturnOverrides: Record<string, ReturnSource | undefined>;
  };
}

export async function updateGuestReturnOverride(
  room: string,
  guestId: string,
  source?: ReturnSource
) {
  const response = await fetch(`/api/production/${encodeURIComponent(room)}/return`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "set-override",
      guestId,
      source
    })
  });

  if (!response.ok) {
    throw new Error("Unable to update guest return override.");
  }

  return (await response.json()) as {
    room: string;
    globalReturnSource: ReturnSource;
    guestReturnOverrides: Record<string, ReturnSource | undefined>;
  };
}

export async function fetchAudienceMessages(input: {
  room: string;
  participantId?: string;
  surfaceRole?: string;
}): Promise<StudioMessage[]> {
  const searchParams = new URLSearchParams();

  if (input.participantId) {
    searchParams.set("participantId", input.participantId);
  }

  if (input.surfaceRole) {
    searchParams.set("surfaceRole", input.surfaceRole);
  }

  const response = await fetch(
    `/api/production/${encodeURIComponent(input.room)}/messages?${searchParams.toString()}`,
    {
      cache: "no-store"
    }
  );

  if (!response.ok) {
    throw new Error("Unable to load messages.");
  }

  return (await response.json()) as StudioMessage[];
}

export async function sendStudioMessage(room: string, message: Omit<StudioMessage, "id" | "room" | "createdAt">) {
  const response = await fetch(`/api/production/${encodeURIComponent(room)}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(message)
  });

  if (!response.ok) {
    throw new Error("Unable to send studio message.");
  }

  return (await response.json()) as StudioMessage;
}

export async function fetchPendingCommands(
  room: string,
  participantId: string
): Promise<StudioControlCommand[]> {
  const response = await fetch(
    `/api/production/${encodeURIComponent(room)}/commands?participantId=${encodeURIComponent(participantId)}`,
    {
      cache: "no-store"
    }
  );

  if (!response.ok) {
    throw new Error("Unable to load commands.");
  }

  return (await response.json()) as StudioControlCommand[];
}

export async function enqueueMuteCommand(room: string, targetParticipantId: string, createdBy: string) {
  const response = await fetch(`/api/production/${encodeURIComponent(room)}/commands`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "enqueue",
      type: "mute-microphone",
      targetParticipantId,
      createdBy
    })
  });

  if (!response.ok) {
    throw new Error("Unable to queue mute command.");
  }

  return (await response.json()) as StudioControlCommand;
}

export async function acknowledgeStudioCommand(
  room: string,
  commandId: string,
  participantId: string
) {
  const response = await fetch(`/api/production/${encodeURIComponent(room)}/commands`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "acknowledge",
      commandId,
      participantId
    })
  });

  if (!response.ok) {
    throw new Error("Unable to acknowledge command.");
  }

  return (await response.json()) as StudioControlCommand;
}

export async function disconnectGuest(room: string, participantId: string) {
  const response = await fetch(`/api/production/${encodeURIComponent(room)}/disconnect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      participantId
    })
  });

  if (!response.ok) {
    throw new Error("Unable to disconnect guest.");
  }

  return (await response.json()) as {
    room: string;
    disconnectedParticipantIds: string[];
  };
}
