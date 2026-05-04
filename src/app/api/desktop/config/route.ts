import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeBaseUrl(value: string | undefined) {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\/+$/, "");
}

export async function GET() {
  return NextResponse.json({
    guestPublicBaseUrl: normalizeBaseUrl(process.env.GUEST_PUBLIC_BASE_URL),
    desktopRoomSlug: process.env.MSTV_DESKTOP_ROOM || "studio"
  });
}
