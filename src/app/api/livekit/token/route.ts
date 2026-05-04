import { NextResponse } from "next/server";
import { z } from "zod";
import { createScopedAccessToken } from "@/lib/livekit/token";
import { controlRoles, sessionChannels, surfaceRoles } from "@/lib/types/roles";
import { returnSources } from "@/lib/types/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const tokenRequestSchema = z.object({
  room: z.string().trim().min(1).max(120),
  participantId: z.string().trim().min(1).max(120),
  displayName: z.string().trim().min(1).max(120),
  surfaceRole: z.enum(surfaceRoles),
  channel: z.enum(sessionChannels),
  controlRole: z.enum(controlRoles).optional(),
  sourceLabel: z.enum(returnSources).optional()
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = tokenRequestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid token request.",
        issues: parsed.error.flatten()
      },
      { status: 400 }
    );
  }

  try {
    const token = await createScopedAccessToken(parsed.data);
    return NextResponse.json(token);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create token.";

    return NextResponse.json(
      {
        error: message
      },
      { status: 500 }
    );
  }
}
