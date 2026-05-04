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
  const guestPublicBaseUrl = normalizeBaseUrl(process.env.GUEST_PUBLIC_BASE_URL);

  console.info("[MSTV Desktop Config] runtime env", {
    guestPublicBaseUrlPresent: Boolean(guestPublicBaseUrl),
    desktopRoomSlug: process.env.MSTV_DESKTOP_ROOM || "studio"
  });

  return NextResponse.json({
    guestPublicBaseUrl,
    desktopRoomSlug: process.env.MSTV_DESKTOP_ROOM || "studio"
  });
}
