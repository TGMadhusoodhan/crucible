import { NextResponse } from 'next/server'
// This route was replaced by POST /api/pipeline/message with type='resolve_conflict'
export async function GET()  { return NextResponse.json({ success: false, error: 'Use POST /api/pipeline/message' }, { status: 410 }) }
export async function POST() { return NextResponse.json({ success: false, error: 'Use POST /api/pipeline/message' }, { status: 410 }) }
