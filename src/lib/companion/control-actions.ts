export type CompanionControlAction =
  | {
      action: "selectGuest";
      guestIndex: number;
    }
  | {
      action: "togglePip";
    }
  | {
      action: "muteAllProgramGuests";
    }
  | {
      action: "unmuteAllProgramGuests";
    };

export interface CompanionControlCommand {
  id: string;
  room: string | null;
  action: CompanionControlAction;
  createdAt: string;
  status: "pending" | "acknowledged";
  acknowledgedAt?: string;
}

declare global {
  var __mstvCompanionControlCommands: CompanionControlCommand[] | undefined;
}

function getCommandStore() {
  if (!globalThis.__mstvCompanionControlCommands) {
    globalThis.__mstvCompanionControlCommands = [];
  }

  return globalThis.__mstvCompanionControlCommands;
}

export function enqueueCompanionControlCommand(input: {
  room?: string | null;
  action: CompanionControlAction;
}) {
  const store = getCommandStore();
  const command: CompanionControlCommand = {
    id: crypto.randomUUID(),
    room: input.room?.trim() || null,
    action: input.action,
    createdAt: new Date().toISOString(),
    status: "pending"
  };

  store.unshift(command);

  return command;
}

export function listPendingCompanionControlCommands(room?: string | null) {
  const normalizedRoom = room?.trim() || null;

  return getCommandStore()
    .filter(
      (command) =>
        command.status === "pending" &&
        (!command.room || !normalizedRoom || command.room === normalizedRoom)
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function acknowledgeCompanionControlCommand(commandId: string) {
  const command = getCommandStore().find((entry) => entry.id === commandId);

  if (!command) {
    return null;
  }

  command.status = "acknowledged";
  command.acknowledgedAt = new Date().toISOString();

  return command;
}
