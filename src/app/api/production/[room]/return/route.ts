import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getProductionSnapshot,
  setGlobalReturnSource,
  setGuestReturnOverride
} from "@/lib/studio/production-state";
import { returnSources } from "@/lib/types/runtime";

const setGlobalSchema = z.object({
  action: z.literal("set-global"),
  source: z.enum(returnSources)
});

const setOverrideSchema = z.object({
  action: z.literal("set-override"),
  guestId: z.string().trim().min(1).max(180),
  source: z.enum(returnSources).optional()
});

const returnRoutingSchema = z.union([setGlobalSchema, setOverrideSchema]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ room: string }> }
) {
  const { room } = await params;
  const snapshot = getProductionSnapshot(room);

  return NextResponse.json({
    room: snapshot.room,
    globalReturnSource: snapshot.globalReturnSource,
    guestReturnOverrides: snapshot.guestReturnOverrides,
    programGuestIds: snapshot.programGuestIds
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ room: string }> }
) {
  const { room } = await params;
  const body = await request.json().catch(() => null);
  const parsed = returnRoutingSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid return routing payload.",
        issues: parsed.error.flatten()
      },
      { status: 400 }
    );
  }

  if (parsed.data.action === "set-global") {
    return NextResponse.json({
      room,
      globalReturnSource: setGlobalReturnSource(room, parsed.data.source),
      guestReturnOverrides: getProductionSnapshot(room).guestReturnOverrides
    });
  }

  return NextResponse.json({
    room,
    guestReturnOverrides: setGuestReturnOverride({
      room,
      guestId: parsed.data.guestId,
      source: parsed.data.source
    }),
    globalReturnSource: getProductionSnapshot(room).globalReturnSource
  });
}
