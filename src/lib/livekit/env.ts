export interface LiveKitServerEnv {
  livekitUrl: string;
  apiKey: string;
  apiSecret: string;
}

export function getLiveKitServerEnv(): LiveKitServerEnv {
  const livekitUrl = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!livekitUrl || !apiKey || !apiSecret) {
    throw new Error("Missing LiveKit environment variables. Check .env.local.");
  }

  return {
    livekitUrl,
    apiKey,
    apiSecret
  };
}
