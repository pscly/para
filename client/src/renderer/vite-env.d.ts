/// <reference types="vite/client" />
/// <reference types="@testing-library/jest-dom/vitest" />

export type GalleryItem = {
  id: string;
  status: string;
  created_at: string;
  prompt: string;
  thumb_data_url?: string | null;
  image_data_url?: string | null;
};

export type UgcAsset = {
  id: string;
  asset_type: string;
  status?: string;
};

export type ApprovedPluginListItem = {
  id: string;
  version: string;
  name: string;
  sha256: string;
  permissions: unknown;
};

export type PluginInstalledRef = {
  id: string;
  version: string;
  name?: string;
  sha256?: string;
  permissions?: unknown;
};

export type PluginMenuItem = {
  pluginId: string;
  id: string;
  label: string;
};

export type PluginOutputPayload = {
  type: 'say' | 'suggestion';
  pluginId: string;
  text: string;
};

export type PluginStatus = {
  enabled: boolean;
  installed: PluginInstalledRef | null;
  running: boolean;
  menuItems: PluginMenuItem[];
  lastError: string | null;
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
  ugc: {
    listApproved: () => Promise<UgcAsset[]>;
  };
  plugins: {
    getStatus: () => Promise<PluginStatus>;
    setEnabled: (enabled: boolean) => Promise<PluginStatus>;
    listApproved: () => Promise<ApprovedPluginListItem[]>;
    install: (payload?: { pluginId?: string; version?: string }) => Promise<PluginStatus>;
    getMenuItems: () => Promise<PluginMenuItem[]>;
    clickMenuItem: (payload: { pluginId: string; id: string }) => Promise<{ ok: boolean }>;
    onOutput: (handler: (payload: PluginOutputPayload) => void) => () => void;
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
    }) => Promise<{ items: Array<{ id: string; saveId: string; eventType: string; content: string; createdAt: string }>; nextCursor: string }>;
  };
  saves: {
    list: () => Promise<Array<{ id: string; name: string; persona_id?: string | null }>>;
    create: (name: string) => Promise<{ id: string; name: string }>;
    bindPersona: (saveId: string, personaId: string) => Promise<unknown>;
  };
  personas: {
    list: () => Promise<Array<{ id: string; name: string; version: number }>>;
  };
  social: {
    createRoom: (payload?: { roomType?: string }) => Promise<{
      id: string;
      roomType: string;
      createdByUserId: string;
      createdAt: string;
    }>;
    invite: (payload: { roomId: string; targetUserId: string }) => Promise<{
      roomId: string;
      actorUserId: string;
      targetUserId: string;
      status: string;
    }>;
    join: (payload: { roomId: string }) => Promise<{
      roomId: string;
      actorUserId: string;
      targetUserId: string;
      status: string;
    }>;
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

declare module 'vite' {
  interface UserConfig {
    test?: unknown;
  }
}

declare global {
  interface Window {
    desktopApi?: DesktopApi;
  }
}
