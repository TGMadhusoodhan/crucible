// DEV-ONLY: seeds a fake session at a specific gate phase for UI testing.
// Blocked in production.

import { eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { db, schema } from '@/lib/db'
import { decrypt } from '@/lib/crypto'
import { generateId } from '@/lib/utils'
import { saveSessionState } from '@/lib/pipeline/orchestrator'
import type {
  ApiResponse,
  ArbitrationPackage,
  HunkConflict,
  PipelineSessionState,
  Provider,
  ReviewHunk,
} from '@/types'

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ success: false, error: 'Not available in production' }, { status: 403 })
  }

  const body = await request.json() as { gate?: string; projectId?: string }
  const gate = (body.gate ?? 'phase3_micro_gate') as 'phase3_micro_gate' | 'phase3_arbitration'

  // Pick the first project, or use a provided projectId
  const projects = await db.select().from(schema.projects).limit(1)
  const project  = projects[0]
  if (!project) {
    return NextResponse.json({ success: false, error: 'No projects found — create one first' }, { status: 400 })
  }

  async function getKey(provider: string): Promise<string> {
    const [row] = await db
      .select({ encryptedKey: schema.apiCredentials.encryptedKey, isValid: schema.apiCredentials.isValid })
      .from(schema.apiCredentials)
      .where(eq(schema.apiCredentials.provider, provider))
      .limit(1)
    if (!row?.isValid) return 'dummy-key'
    try { return decrypt(row.encryptedKey) } catch { return 'dummy-key' }
  }

  const [coderKey, r1Key, r2Key] = await Promise.all([
    getKey('deepseek'),
    getKey(project.r1Provider),
    getKey(project.r2Provider),
  ])

  const sessionId = generateId()

  // Fabricated overlapping hunks — same lines touched by both reviewers so the
  // merge produces a genuine conflict, not two resolved hunks.
  const r1Hunk: ReviewHunk = {
    id:          'test_h_r1_001',
    filename:    'math.ts',
    line_start:  3,
    line_end:    7,
    severity:    'HIGH',
    issue:       'Division by zero — denominator not checked before divide',
    fixed_code:  'export function divide(a: number, b: number): number {\n  if (b === 0) throw new Error("Division by zero")\n  return a / b\n}',
    category:    'correctness',
    source:      'R1',
  }

  const r2Hunk: ReviewHunk = {
    id:          'test_h_r2_001',
    filename:    'math.ts',
    line_start:  3,
    line_end:    7,
    severity:    'HIGH',
    issue:       'Division by zero — should return NaN, not throw, to match JS semantics',
    fixed_code:  'export function divide(a: number, b: number): number {\n  if (b === 0) return NaN\n  return a / b\n}',
    category:    'correctness',
    source:      'R2',
  }

  const conflict: HunkConflict = {
    id:            'conflict_test_h_r1_001_test_h_r2_001',
    filename:      'math.ts',
    line_start:    3,
    line_end:      7,
    r1_hunk:       r1Hunk,
    r2_hunk:       r2Hunk,
    original_code: 'export function divide(a: number, b: number): number {\n  return a / b\n}',
  }

  const r1ArbitrationHunk: ReviewHunk = { ...r1Hunk, id: 'arb_r1_001', source: 'R1' }
  const r2ArbitrationHunk: ReviewHunk = { ...r2Hunk, id: 'arb_r2_001', source: 'R2' }

  const arbitrationPkg: ArbitrationPackage = {
    filename:         'math.ts',
    round:            3,
    unresolved_hunks: [r1ArbitrationHunk, r2ArbitrationHunk],
    r1_summary:       'R1 insists throw is correct (breaks caller contract otherwise)',
    r2_summary:       'R2 insists NaN matches JS arithmetic conventions',
  }

  const state: PipelineSessionState = {
    sessionId,
    projectId:   project.id,
    userId:      'local',
    phase:       gate,
    config: {
      coderProvider:  'deepseek',
      coderModelId:   'deepseek-v4-pro',
      coderApiKey:    coderKey,
      r1Provider:     project.r1Provider as Provider,
      r1ModelId:      project.r1ModelId,
      r1ApiKey:       r1Key,
      r2Provider:     project.r2Provider as Provider,
      r2ModelId:      project.r2ModelId,
      r2ApiKey:       r2Key,
    },

    currentFileIdx:    0,
    currentFilename:   'math.ts',
    totalFiles:        1,
    round:             gate === 'phase3_arbitration' ? 3 : 1,

    taskDescription:   '[TEST] Seed session — conflict path test',

    currentFileCode:   'export function add(a: number, b: number): number { return a + b }\nexport function subtract(a: number, b: number): number { return a - b }\nexport function divide(a: number, b: number): number {\n  return a / b\n}',
    r1Hunks:           [r1Hunk],
    r2Hunks:           [r2Hunk],
    conflicts:         gate === 'phase3_micro_gate' ? [conflict] : [],
    resolvedHunks:     [],
    patchedCode:       undefined,
    arbitrationPkg:    gate === 'phase3_arbitration' ? arbitrationPkg : undefined,

    acceptedFiles:     {},
    streamingCode:     '',

    fileManifest: {
      mode:             'single',
      files:            [{ filename: 'math.ts', purpose: 'Math utilities', exports: ['add', 'subtract', 'divide'], imports: {} }],
      generation_order: ['math.ts'],
      reasoning:        'Test manifest',
    },

    pendingHumanOverrides: [],
    conversationHistory:   [],
    budgetMode:            'FULL',
    createdAt:             Date.now(),
    updatedAt:             Date.now(),
  }

  await saveSessionState(state)

  return NextResponse.json({
    success: true,
    data: { sessionId, projectId: project.id, gate },
  })
}
