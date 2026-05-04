import { NextResponse } from "next/server";
import { z } from "zod";
import { setProgramGuestIds } from "@/lib/studio/production-state";

const sceneSchema = z.object({
  guestIds: z.array(z.string().trim().min(1).max(180))
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

  return NextResponse.json({
    room,
    guestIds: setProgramGuestIds(room, parsed.data.guestIds)
  });
}
