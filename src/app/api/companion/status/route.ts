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

function isCompanionNetworkRequest(request: Request) {
  const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const privateIpv4Pattern =
    /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})$/;

  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".local") ||
    privateIpv4Pattern.test(hostname)
  );
}

export async function GET(request: Request) {
  if (!isCompanionNetworkRequest(request)) {
    return NextResponse.json(
      {
        error: "Companion API is LAN only."
      },
      { status: 403 }
    );
  }

  return NextResponse.json(getCompanionStatus());
}

export async function POST(request: Request) {
  if (!isCompanionNetworkRequest(request)) {
    return NextResponse.json(
      {
        error: "Companion API is LAN only."
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
