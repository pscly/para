/// <reference types="vite/client" />

export type GalleryItem = {
  id: string;
  status: string;
  created_at: string;
  prompt: string;
  thumb_data_url?: string | null;
  image_data_url?: string | null;
};

export type TimelineEventItem = {
  id: string;
  saveId: string;
  eventType: string;
  content: string;
  createdAt: string;
};

export type DesktopApi = {
  ping: () => Promise<string>;
  versions: {
    electron: string;
    node: string;
    chrome: string;
  };
  knowledge: {
    uploadMaterial: (payload: {
      bytes: ArrayBuffer;
      filename: string;
      mimeType?: string;
      saveId: string;
    }) => Promise<{ id: string; status: 'pending' | 'indexed' | 'failed'; error?: string }>;
    materialStatus: (id: string) => Promise<{ id: string; status: 'pending' | 'indexed' | 'failed'; error?: string }>;
  };
  vision: {
    uploadScreenshot: (payload: {
      saveId: string;
      imageBase64: string;
      privacyMode: 'strict' | 'standard';
    }) => Promise<{ suggestion: string }>;
  };
  gallery: {
    generate: (payload: { saveId: string; prompt: string }) => Promise<{ id: string; status: string }>;
    list: (saveId: string) => Promise<GalleryItem[]>;
  };
  timeline: {
    simulate: (payload: {
      saveId: string;
      eventType?: string;
      content?: string;
    }) => Promise<{ taskId: string; timelineEventId?: string }>;
    list: (payload: {
      saveId: string;
      cursor?: string;
      limit?: number;
    }) => Promise<{ items: TimelineEventItem[]; nextCursor: string }>;
  };
  auth: {
    login: (email: string, password: string) => Promise<{ user_id: string | number; email: string }>;
    me: () => Promise<{ user_id: string | number; email: string }>;
    logout: () => Promise<void>;
  };
  ws: {
    connect: (
      saveId: string,
    ) => Promise<{
      status: 'connected' | 'reconnecting' | 'disconnected';
      saveId: string | null;
      lastSeq: number;
    }>;
    disconnect: () => Promise<void>;
    chatSend: (text: string, clientRequestId?: string) => Promise<void>;
    interrupt: () => Promise<void>;
    onEvent: (handler: (frame: unknown) => void) => () => void;
    onStatus: (handler: (status: unknown) => void) => () => void;
  };
  assistant: {
    setEnabled: (enabled: boolean, saveId: string) => Promise<void>;
    setIdleEnabled: (enabled: boolean) => Promise<void>;
    onSuggestion: (handler: (payload: { suggestion: string; category: string }) => void) => () => void;
    writeClipboardText: (text: string) => Promise<void>;
  };
};

declare global {
  interface Window {
    desktopApi?: DesktopApi;
  }
}
