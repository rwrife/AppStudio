export interface MockServer { url: string; requests: Record<string, any>[]; close: () => Promise<void> }
export function startMockServer(options?: {
  rejectTools?: boolean
  thinking?: boolean
  analysis?: Record<string, unknown>
  answer?: Record<string, unknown>
  failAnalysis?: boolean
  delayAnalysisMs?: number
  delayAgentMs?: number
}): Promise<MockServer>
