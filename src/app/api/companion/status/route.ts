import { NextResponse } from "next/server";
import { z } from "zod";
import { getCompanionStatus, setCompanionStatus } from "@/lib/companion/status";

const companionStatusSchema = z.object({
  pipEnabled: z.boolean(),
  globalMuteEnabled: z.boolean(),
  programGuestIndexes: z.array(z.number().int().min(1).max(9)),
  programMutedGuestIndexes: z.array(z.number().int().min(1).max(9)),
  regieGuestIndexes: z.array(z.number().int().min(1).max(9)),
  regieMutedGuestIndexes: z.array(z.number().int().min(1).max(9)),
  connectedGuestCount: z.number().int().min(0).max(99)
});

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

  return NextResponse.json(getCompanionStatus());
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
  const parsed = companionStatusSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid Companion status payload.",
        issues: parsed.error.flatten()
      },
      { status: 400 }
    );
  }

  return NextResponse.json(setCompanionStatus(parsed.data));
}
