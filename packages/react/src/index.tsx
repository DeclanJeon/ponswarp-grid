import { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import { PonsWarpEngine, MemoryStorageAdapter, type FileManifest, type SessionId, type TransferProgress, type Transport } from '@ponswarp/core';

export type PonsWarpStatus = 'idle' | 'creating' | 'joining' | 'transferring' | 'complete' | 'error';

export interface PonsWarpSenderState {
  readonly status: PonsWarpStatus;
  readonly sessionId: SessionId | null;
  readonly manifest: FileManifest | null;
  readonly progress: TransferProgress | null;
  readonly error: string | null;
}

export interface PonsWarpReceiverState {
  readonly status: PonsWarpStatus;
  readonly progress: TransferProgress | null;
  readonly error: string | null;
  readonly outputName: string | null;
}

export interface PonsWarpContextValue {
  readonly sender: PonsWarpSenderState;
  readonly receiver: PonsWarpReceiverState;
  createSession(files: Blob[], pieceSize: number): Promise<{ sessionId: SessionId; manifests: FileManifest[] }>;
  joinSession(sessionId: SessionId, manifests: FileManifest[]): Promise<void>;
}

const PonsWarpContext = createContext<PonsWarpContextValue | null>(null);

export function usePonsWarp(): PonsWarpContextValue {
  const ctx = useContext(PonsWarpContext);
  if (!ctx) throw new Error('usePonsWarp must be used within <PonsWarpProvider>');
  return ctx;
}

export function usePonsWarpSender(): PonsWarpSenderState & { createSession(files: Blob[], pieceSize: number): Promise<{ sessionId: SessionId; manifests: FileManifest[] }> } {
  const { sender, createSession } = usePonsWarp();
  return { ...sender, createSession };
}

export function usePonsWarpReceiver(): PonsWarpReceiverState & { joinSession(sessionId: SessionId, manifests: FileManifest[]): Promise<void> } {
  const { receiver, joinSession } = usePonsWarp();
  return { ...receiver, joinSession };
}

export interface PonsWarpProviderProps {
  transport: Transport;
  children: React.ReactNode;
}

export function PonsWarpProvider({ transport, children }: PonsWarpProviderProps): React.JSX.Element {
  const engineRef = useRef<PonsWarpEngine | null>(null);
  const [sender, setSender] = useState<PonsWarpSenderState>({ status: 'idle', sessionId: null, manifest: null, progress: null, error: null });
  const [receiver, setReceiver] = useState<PonsWarpReceiverState>({ status: 'idle', progress: null, error: null, outputName: null });

  useEffect(() => {
    const storage = new MemoryStorageAdapter();
    const engine = new PonsWarpEngine(storage, undefined, undefined, undefined, transport);
    engineRef.current = engine;
    const unsub = engine.on('progress', (event: TransferProgress) => {
      setSender(current => current.status === 'transferring' ? { ...current, progress: event } : current);
      setReceiver(current => current.status === 'transferring' ? { ...current, progress: event } : current);
    });
    return () => { unsub(); engineRef.current = null; };
  }, [transport]);

  const createSession = useCallback(async (files: Blob[], pieceSize: number) => {
    const engine = engineRef.current;
    if (!engine) throw new Error('Engine not initialized');
    setSender({ status: 'creating', sessionId: null, manifest: null, progress: null, error: null });
    try {
      const sessionId = `sess_${Date.now()}` as SessionId;
      const session = await engine.createSession({ sessionId, files: files as Array<Blob & { name?: string; type?: string }>, pieceSize });
      const manifest = session.manifests[0];
      setSender({ status: 'idle', sessionId, manifest, progress: null, error: null });
      return { sessionId, manifests: session.manifests };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSender({ status: 'error', sessionId: null, manifest: null, progress: null, error: message });
      throw error;
    }
  }, []);

  const joinSession = useCallback(async (sessionId: SessionId, manifests: FileManifest[]) => {
    const engine = engineRef.current;
    if (!engine) throw new Error('Engine not initialized');
    setReceiver({ status: 'joining', progress: null, error: null, outputName: null });
    try {
      await engine.joinSession(sessionId, manifests);
      setReceiver({ status: 'transferring', progress: null, error: null, outputName: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setReceiver({ status: 'error', progress: null, error: message, outputName: null });
      throw error;
    }
  }, []);

  return (
    <PonsWarpContext.Provider value={{ sender, receiver, createSession, joinSession }}>
      {children}
    </PonsWarpContext.Provider>
  );
}
