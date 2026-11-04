export interface MockServer { url: string; requests: Record<string, any>[]; close: () => Promise<void> }
export function startMockServer(options?: { rejectTools?: boolean; thinking?: boolean }): Promise<MockServer>
