import { createContext, useContext } from 'react';
import type { TransferProgress } from '@ponswarp/core';

export interface PonsWarpReactAdapter {
  readonly progress: TransferProgress | null;
  readonly status: 'idle' | 'creating' | 'joining' | 'transferring' | 'complete' | 'error';
  createSession(files: File[]): Promise<void>;
  joinSession(sessionId: string): Promise<void>;
}

export const PonsWarpContext = createContext<PonsWarpReactAdapter | null>(null);

export function usePonsWarp(): PonsWarpReactAdapter {
  const adapter = useContext(PonsWarpContext);
  if (!adapter) throw new Error('usePonsWarp must be used within PonsWarpContext.Provider');
  return adapter;
}
