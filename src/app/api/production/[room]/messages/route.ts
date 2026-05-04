import { NextResponse } from "next/server";
import { z } from "zod";
import { createStudioMessage, listMessagesForAudience } from "@/lib/studio/production-state";
import { controlRoles } from "@/lib/types/roles";

const querySchema = z.object({
  participantId: z.string().optional(),
  surfaceRole: z.string().optional()
});

const messageSchema = z.object({
  body: z.string().trim().min(1).max(500),
  kind: z.enum(["cue", "tally", "routing", "system", "ack"]),
  priority: z.enum(["low", "normal", "high", "critical"]),
  from: z.object({
    id: z.string().trim().min(1).max(120),
    label: z.string().trim().min(1).max(120),
    role: z.enum(["system", "operator", "producer", "supervisor", "engineer"])
  }),
  target: z.union([
    z.object({
      type: z.literal("guest"),
      guestIds: z.array(z.string().trim().min(1).max(180)).min(1)
    }),
    z.object({
      type: z.literal("control-room"),
      controlRoles: z.array(z.enum(controlRoles)).optional()
    }),
    z.object({
      type: z.literal("program-log")
    })
  ]),
  requiresAck: z.boolean().default(false),
  correlationId: z.string().trim().max(120).optional()
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ room: string }> }
) {
  const { room } = await params;
  const searchParams = new URL(request.url).searchParams;
  const parsed = querySchema.safeParse({
    participantId: searchParams.get("participantId") ?? undefined,
    surfaceRole: searchParams.get("surfaceRole") ?? undefined
  });

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid message query."
      },
      { status: 400 }
    );
  }

  return NextResponse.json(
    listMessagesForAudience(room, {
      participantId: parsed.data.participantId,
      surfaceRole: parsed.data.surfaceRole as "guest" | "control" | "program" | "programFeed" | undefined
    })
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ room: string }> }
) {
  const { room } = await params;
  const body = await request.json().catch(() => null);
  const parsed = messageSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid message payload.",
        issues: parsed.error.flatten()
      },
      { status: 400 }
    );
  }

  return NextResponse.json(
    createStudioMessage({
      id: crypto.randomUUID(),
      room,
      createdAt: new Date().toISOString(),
      ...parsed.data
    })
  );
}
