import { NextResponse } from "next/server";
import { z } from "zod";
import { setGuestVideoFraming, setProgramGuestIds } from "@/lib/studio/production-state";

const sceneSchema = z.object({
  guestIds: z.array(z.string().trim().min(1).max(180)).optional(),
  guestVideoFraming: z
    .object({
      guestId: z.string().trim().min(1).max(180),
      framing: z.object({
        zoom: z.number().min(1).max(2),
        x: z.number().min(-50).max(50),
        y: z.number().min(-50).max(50)
      })
    })
    .optional()
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ room: string }> }
) {
  const { room } = await params;
  const body = await request.json().catch(() => null);
  const parsed = sceneSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid scene payload.",
        issues: parsed.error.flatten()
      },
      { status: 400 }
    );
  }

  const guestIds = parsed.data.guestIds ? setProgramGuestIds(room, parsed.data.guestIds) : undefined;
  const guestVideoFraming = parsed.data.guestVideoFraming
    ? setGuestVideoFraming({
        room,
        guestId: parsed.data.guestVideoFraming.guestId,
        framing: parsed.data.guestVideoFraming.framing
      })
    : undefined;

  return NextResponse.json({
    room,
    guestIds,
    guestVideoFraming
  });
}
