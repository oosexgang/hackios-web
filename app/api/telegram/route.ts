import { NextResponse } from "next/server";
import { getTelegramSubscribers } from "@/lib/telegram";
import { TELEGRAM } from "@/lib/site";

export const revalidate = 1800;

// GET /api/telegram -> { channel, subscribers }
export async function GET() {
  const subscribers = await getTelegramSubscribers();
  return NextResponse.json({ channel: TELEGRAM.channel, subscribers });
}
