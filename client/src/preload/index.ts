import { contextBridge, ipcRenderer } from 'electron';

type AuthMe = {
  user_id: string | number;
  email: string;
};

type WsStatus = 'connected' | 'reconnecting' | 'disconnected';

type WsConnectResult = {
  status: WsStatus;
  saveId: string | null;
  lastSeq: number;
};

type SaveListItem = {
  id: string;
  name: string;
  persona_id?: string | null;
};

type SaveCreateResult = {
  id: string;
  name: string;
};

type SaveBindPersonaResult = {
  save_id: string;
  persona_id: string;
};

type PersonaListItem = {
  id: string;
  name: string;
  version: number;
};

type KnowledgeUploadPayload = {
  bytes: ArrayBuffer;
  filename: string;
  mimeType?: string;
  saveId: string;
};

type KnowledgeMaterialStatus = 'pending' | 'indexed' | 'failed';

type KnowledgeMaterial = {
  id: string;
  status: KnowledgeMaterialStatus;
  error?: string;
};

type VisionPrivacyMode = 'strict' | 'standard';

type VisionUploadPayload = {
  saveId: string;
  imageBase64: string;
  privacyMode: VisionPrivacyMode;
};

type VisionSuggestionResponse = {
  suggestion: string;
};

type GalleryGeneratePayload = {
  saveId: string;
  prompt: string;
};

type GalleryGenerateResult = {
  id: string;
  status: string;
};

type GalleryItem = Record<string, unknown>;

type TimelineSimulatePayload = {
  saveId: string;
  eventType?: string;
  content?: string;
};

type TimelineSimulateResult = {
  taskId: string;
  timelineEventId?: string;
};

type TimelineEventItem = {
  id: string;
  saveId: string;
  eventType: string;
  content: string;
  createdAt: string;
};

type TimelineListResult = {
  items: TimelineEventItem[];
  nextCursor: string;
};

contextBridge.exposeInMainWorld('desktopApi', {
  ping: async () => 'pong',
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  },
  knowledge: {
    uploadMaterial: async (payload: KnowledgeUploadPayload): Promise<KnowledgeMaterial> => {
      return ipcRenderer.invoke('knowledge:uploadMaterial', payload) as Promise<KnowledgeMaterial>;
    },
    materialStatus: async (id: string): Promise<KnowledgeMaterial> => {
      return ipcRenderer.invoke('knowledge:materialStatus', { id }) as Promise<KnowledgeMaterial>;
    }
  },
  vision: {
    uploadScreenshot: async (payload: VisionUploadPayload): Promise<VisionSuggestionResponse> => {
      return ipcRenderer.invoke('vision:uploadScreenshot', payload) as Promise<VisionSuggestionResponse>;
    }
  },
  gallery: {
    generate: async (payload: GalleryGeneratePayload): Promise<GalleryGenerateResult> => {
      return ipcRenderer.invoke('gallery:generate', payload) as Promise<GalleryGenerateResult>;
    },
    list: async (saveId: string): Promise<GalleryItem[]> => {
      return ipcRenderer.invoke('gallery:list', { saveId }) as Promise<GalleryItem[]>;
    }
  },
  timeline: {
    simulate: async (payload: TimelineSimulatePayload): Promise<TimelineSimulateResult> => {
      return ipcRenderer.invoke('timeline:simulate', payload) as Promise<TimelineSimulateResult>;
    },
    list: async (payload: { saveId: string; cursor?: string; limit?: number }): Promise<TimelineListResult> => {
      return ipcRenderer.invoke('timeline:list', payload) as Promise<TimelineListResult>;
    }
  },
  auth: {
    login: async (email: string, password: string): Promise<AuthMe> => {
      return ipcRenderer.invoke('auth:login', { email, password }) as Promise<AuthMe>;
    },
    me: async (): Promise<AuthMe> => {
      return ipcRenderer.invoke('auth:me') as Promise<AuthMe>;
    },
    logout: async (): Promise<void> => {
      await ipcRenderer.invoke('auth:logout');
    }
  },
  saves: {
    list: async (): Promise<SaveListItem[]> => {
      return ipcRenderer.invoke('saves:list') as Promise<SaveListItem[]>;
    },
    create: async (name: string): Promise<SaveCreateResult> => {
      return ipcRenderer.invoke('saves:create', { name }) as Promise<SaveCreateResult>;
    },
    bindPersona: async (
      saveId: string,
      personaId: string,
    ): Promise<void | SaveBindPersonaResult> => {
      return ipcRenderer.invoke('saves:bindPersona', { saveId, personaId }) as Promise<
        void | SaveBindPersonaResult
      >;
    }
  },
  personas: {
    list: async (): Promise<PersonaListItem[]> => {
      return ipcRenderer.invoke('personas:list') as Promise<PersonaListItem[]>;
    }
  },
  ws: {
    connect: async (saveId: string): Promise<WsConnectResult> => {
      return ipcRenderer.invoke('ws:connect', { saveId }) as Promise<WsConnectResult>;
    },
    disconnect: async (): Promise<void> => {
      await ipcRenderer.invoke('ws:disconnect');
    },
    chatSend: async (text: string, clientRequestId?: string): Promise<void> => {
      await ipcRenderer.invoke('ws:chatSend', { text, clientRequestId });
    },
    interrupt: async (): Promise<void> => {
      await ipcRenderer.invoke('ws:interrupt');
    },
    onEvent: (handler: (frame: unknown) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, frame: unknown) => {
        handler(frame);
      };

      ipcRenderer.on('ws:event', listener);
      return () => ipcRenderer.removeListener('ws:event', listener);
    },
    onStatus: (handler: (status: unknown) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: unknown) => {
        handler(status);
      };

      ipcRenderer.on('ws:status', listener);
      return () => ipcRenderer.removeListener('ws:status', listener);
    }
  },
  assistant: {
    setEnabled: async (enabled: boolean, saveId: string): Promise<void> => {
      await ipcRenderer.invoke('assistant:setEnabled', { enabled, saveId });
    },
    setIdleEnabled: async (enabled: boolean): Promise<void> => {
      await ipcRenderer.invoke('assistant:setIdleEnabled', { enabled });
    },
    onSuggestion: (handler: (payload: unknown) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        handler(payload);
      };

      ipcRenderer.on('assistant:suggestion', listener);
      return () => ipcRenderer.removeListener('assistant:suggestion', listener);
    },
    writeClipboardText: async (text: string): Promise<void> => {
      await ipcRenderer.invoke('assistant:writeClipboardText', { text });
    }
  }
});
