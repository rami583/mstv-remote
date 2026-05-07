import { NextResponse } from "next/server";
import { z } from "zod";
import {
  acknowledgeCompanionControlCommand,
  enqueueCompanionControlCommand,
  listPendingCompanionControlCommands
} from "@/lib/companion/control-actions";

const selectGuestActionSchema = z.object({
  action: z.literal("selectGuest"),
  guestIndex: z.number().int().min(1).max(9),
  room: z.string().trim().min(1).max(120).optional()
});

const togglePipActionSchema = z.object({
  action: z.literal("togglePip"),
  room: z.string().trim().min(1).max(120).optional()
});

const muteAllProgramGuestsActionSchema = z.object({
  action: z.literal("muteAllProgramGuests"),
  room: z.string().trim().min(1).max(120).optional()
});

const unmuteAllProgramGuestsActionSchema = z.object({
  action: z.literal("unmuteAllProgramGuests"),
  room: z.string().trim().min(1).max(120).optional()
});

const acknowledgeActionSchema = z.object({
  action: z.literal("acknowledge"),
  commandId: z.string().trim().min(1).max(180)
});

const companionActionSchema = z.union([
  selectGuestActionSchema,
  togglePipActionSchema,
  muteAllProgramGuestsActionSchema,
  unmuteAllProgramGuestsActionSchema,
  acknowledgeActionSchema
]);

function isLocalRequest(request: Request) {
  const hostname = new URL(request.url).hostname;

  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export async function GET(request: Request) {
  if (!isLocalRequest(request)) {
    return NextResponse.json(
      {
        error: "Companion API is local only."
      },
      { status: 403 }
    );
  }

  const room = new URL(request.url).searchParams.get("room");

  return NextResponse.json({
    commands: listPendingCompanionControlCommands(room)
  });
}

export async function POST(request: Request) {
  if (!isLocalRequest(request)) {
    return NextResponse.json(
      {
        error: "Companion API is local only."
      },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = companionActionSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid Companion action payload.",
        issues: parsed.error.flatten()
      },
      { status: 400 }
    );
  }

  if (parsed.data.action === "acknowledge") {
    const command = acknowledgeCompanionControlCommand(parsed.data.commandId);

    if (!command) {
      return NextResponse.json(
        {
          error: "Companion command not found."
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      command
    });
  }

  const command = enqueueCompanionControlCommand({
    room: parsed.data.room,
    action:
      parsed.data.action === "selectGuest"
        ? {
            action: "selectGuest",
            guestIndex: parsed.data.guestIndex
          }
        : {
            action: parsed.data.action
          }
  });

  return NextResponse.json({
    ok: true,
    command
  });
}
