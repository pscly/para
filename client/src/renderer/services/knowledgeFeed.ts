type DesktopApiExt = NonNullable<Window['desktopApi']>;

export type KnowledgeApi = DesktopApiExt['knowledge'];
export type KnowledgeMaterial = Awaited<ReturnType<KnowledgeApi['materialStatus']>>;

export function getErrorCode(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return 'UNKNOWN';
}

export function toReadableKnowledgeError(err: unknown): string {
  const code = getErrorCode(err);
  if (code.includes('INVALID_PAYLOAD')) return '文件不正确';
  if (code.includes('NETWORK_ERROR')) return '网络错误';
  if (code.includes('API_FAILED')) return '请求失败';
  if (code.includes('TIMEOUT')) return '索引超时';
  return '投喂失败';
}

export function isMdFile(file: File): boolean {
  const name = file.name.toLowerCase();
  if (name.endsWith('.md')) return true;
  if (file.type === 'text/markdown') return true;
  return false;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function pollMaterialUntilDone(knowledge: KnowledgeApi, id: string, signal: AbortSignal): Promise<KnowledgeMaterial> {
  const started = Date.now();
  while (!signal.aborted) {
    const m = await knowledge.materialStatus(id);
    if (m.status === 'indexed' || m.status === 'failed') return m;
    if (Date.now() - started > 30_000) {
      throw new Error('TIMEOUT');
    }
    await sleep(400, signal);
  }
  throw new Error('ABORTED');
}
