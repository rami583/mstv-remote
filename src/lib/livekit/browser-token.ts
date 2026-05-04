import type { TokenRequestPayload, TokenResponsePayload } from "@/lib/types/livekit";

export async function fetchLiveKitToken(
  payload: TokenRequestPayload
): Promise<TokenResponsePayload> {
  const response = await fetch("/api/livekit/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => null);
    const message = error?.error ?? "Token request failed.";
    throw new Error(message);
  }

  return (await response.json()) as TokenResponsePayload;
}
