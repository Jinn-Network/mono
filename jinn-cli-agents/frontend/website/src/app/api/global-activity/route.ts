import { NextResponse } from "next/server";
import { getGlobalActivity } from "@/lib/service-queries";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
    try {
        const data = await getGlobalActivity();
        return NextResponse.json(data, {
            headers: {
                "Cache-Control": "no-store, max-age=0",
            },
        });
    } catch (error) {
        console.error("Failed to fetch global activity:", error);
        return NextResponse.json(
            { requests: [], deliveries: [] },
            {
                status: 500,
                headers: {
                    "Cache-Control": "no-store, max-age=0",
                },
            }
        );
    }
}
