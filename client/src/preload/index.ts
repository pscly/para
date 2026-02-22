import { contextBridge, ipcRenderer } from 'electron';

type AuthMe = {
  user_id: string | number;
  email: string;
  debug_allowed: boolean;
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

type SocialCreateRoomResult = {
  id: string;
  roomType: string;
  createdByUserId: string;
  createdAt: string;
};

type SocialInvitePayload = {
  roomId: string;
  targetUserId: string;
};

type SocialInviteResult = {
  roomId: string;
  actorUserId: string;
  targetUserId: string;
  status: string;
};

type SocialJoinPayload = {
  roomId: string;
};

type SocialJoinResult = {
  roomId: string;
  actorUserId: string;
  targetUserId: string;
  status: string;
};

type UgcApprovedAssetListItem = {
  id: string;
  asset_type: string;
};

type ApprovedPluginListItem = {
  id: string;
  version: string;
  name: string;
  sha256: string;
  permissions: unknown;
};

type PluginInstalledRef = {
  id: string;
  version: string;
  name?: string;
  sha256?: string;
  permissions?: unknown;
};

type PluginMenuItem = {
  pluginId: string;
  id: string;
  label: string;
};

type PluginOutputPayload = {
  type: 'say' | 'suggestion';
  pluginId: string;
  text: string;
};

type PluginStatus = {
  enabled: boolean;
  installed: PluginInstalledRef | null;
  running: boolean;
  menuItems: PluginMenuItem[];
  lastError: string | null;
};

type PluginInstallPayload = {
  pluginId?: string;
  version?: string;
};

type UpdateProgress = {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
};

type UpdateState = {
  enabled: boolean;
  phase: string;
  currentVersion: string;
  availableVersion: string | null;
  progress: UpdateProgress | null;
  error: string | null;
  lastCheckedAt: string | null;
  allowDowngrade: boolean;
  source: string;
};

type UserDataInfo = {
  userDataDir: string;
  source: string;
  configPath: string;
  envOverrideActive: boolean;
};

type UserDataPickDirResult = {
  canceled: boolean;
  path: string | null;
};

type UserDataMigrateResult = {
  targetDir: string;
};

type AppEncStatus = {
  desiredEnabled: boolean;
  effectiveEnabled: boolean;
  error: string | null;
  configPath: string;
};

type DevOptionsStatus = {
  desiredEnabled: boolean;
  effectiveEnabled: boolean;
  error: string | null;
  configPath: string;
};

contextBridge.exposeInMainWorld('desktopApi', {
  ping: async () => 'pong',
  getAppVersion: async (): Promise<string> => {
    return ipcRenderer.invoke('app:getVersion') as Promise<string>;
  },
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  },
  labsEnabled: process.env.PARA_LABS === '1',
  devModeEnabled: process.env.PARA_DEV_MODE === '1',
  security: {
    getAppEncStatus: async (): Promise<AppEncStatus> => {
      return ipcRenderer.invoke('security:appEnc:getStatus') as Promise<AppEncStatus>;
    },
    setAppEncEnabled: async (enabled: boolean): Promise<AppEncStatus> => {
      return ipcRenderer.invoke('security:appEnc:setEnabled', { enabled }) as Promise<AppEncStatus>;
    },
    getDevOptionsStatus: async (): Promise<DevOptionsStatus> => {
      return ipcRenderer.invoke('security:devOptions:getStatus') as Promise<DevOptionsStatus>;
    },
    setDevOptionsEnabled: async (enabled: boolean): Promise<DevOptionsStatus> => {
      return ipcRenderer.invoke('security:devOptions:setEnabled', { enabled }) as Promise<DevOptionsStatus>;
    }
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
    },
    download: async (payload: { galleryId: string; kind: 'thumb' | 'image' }): Promise<ArrayBuffer> => {
      return ipcRenderer.invoke('gallery:download', payload) as Promise<ArrayBuffer>;
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
  social: {
    createRoom: async (payload?: { roomType?: string }): Promise<SocialCreateRoomResult> => {
      return ipcRenderer.invoke('social:createRoom', payload ?? {}) as Promise<SocialCreateRoomResult>;
    },
    invite: async (payload: SocialInvitePayload): Promise<SocialInviteResult> => {
      return ipcRenderer.invoke('social:invite', payload) as Promise<SocialInviteResult>;
    },
    join: async (payload: SocialJoinPayload): Promise<SocialJoinResult> => {
      return ipcRenderer.invoke('social:join', payload) as Promise<SocialJoinResult>;
    }
  },
  ugc: {
    listApproved: async (): Promise<UgcApprovedAssetListItem[]> => {
      return ipcRenderer.invoke('ugc:listApproved') as Promise<UgcApprovedAssetListItem[]>;
    }
  },
  plugins: {
    getStatus: async (): Promise<PluginStatus> => {
      return ipcRenderer.invoke('plugins:getStatus') as Promise<PluginStatus>;
    },
    getMenuItems: async (): Promise<PluginMenuItem[]> => {
      return ipcRenderer.invoke('plugins:getMenuItems') as Promise<PluginMenuItem[]>;
    },
    clickMenuItem: async (payload: { pluginId: string; id: string }): Promise<{ ok: boolean }> => {
      return ipcRenderer.invoke('plugins:menuClick', payload) as Promise<{ ok: boolean }>;
    },
    setEnabled: async (enabled: boolean): Promise<PluginStatus> => {
      return ipcRenderer.invoke('plugins:setEnabled', { enabled }) as Promise<PluginStatus>;
    },
    listApproved: async (): Promise<ApprovedPluginListItem[]> => {
      return ipcRenderer.invoke('plugins:listApproved') as Promise<ApprovedPluginListItem[]>;
    },
    install: async (payload?: PluginInstallPayload): Promise<PluginStatus> => {
      if (payload) {
        return ipcRenderer.invoke('plugins:install', payload) as Promise<PluginStatus>;
      }
      return ipcRenderer.invoke('plugins:install') as Promise<PluginStatus>;
    },
    onOutput: (handler: (payload: PluginOutputPayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: PluginOutputPayload) => {
        handler(payload);
      };

      ipcRenderer.on('plugins:output', listener);
      return () => ipcRenderer.removeListener('plugins:output', listener);
    }
  },
  update: {
    getState: async (): Promise<UpdateState> => {
      return ipcRenderer.invoke('update:getState') as Promise<UpdateState>;
    },
    check: async (): Promise<UpdateState> => {
      return ipcRenderer.invoke('update:check') as Promise<UpdateState>;
    },
    download: async (): Promise<UpdateState> => {
      return ipcRenderer.invoke('update:download') as Promise<UpdateState>;
    },
    install: async (): Promise<UpdateState> => {
      return ipcRenderer.invoke('update:install') as Promise<UpdateState>;
    },
    onState: (handler: (state: UpdateState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: UpdateState) => {
        handler(state);
      };

      ipcRenderer.on('update:state', listener);
      return () => ipcRenderer.removeListener('update:state', listener);
    }
  },
  auth: {
    login: async (email: string, password: string): Promise<AuthMe> => {
      return ipcRenderer.invoke('auth:login', { email, password }) as Promise<AuthMe>;
    },
    register: async (email: string, password: string, inviteCode?: string): Promise<AuthMe> => {
      return ipcRenderer.invoke('auth:register', { email, password, inviteCode }) as Promise<AuthMe>;
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
  byok: {
    getConfig: async () => {
      return ipcRenderer.invoke('byok:getConfig') as Promise<{
        enabled: boolean;
        base_url: string;
        model: string;
        api_key_present: boolean;
        secure_storage_available: boolean;
      }>;
    },
    setConfig: async (payload: { enabled: boolean; base_url: string; model: string }) => {
      return ipcRenderer.invoke('byok:setConfig', payload) as Promise<{
        enabled: boolean;
        base_url: string;
        model: string;
        api_key_present: boolean;
        secure_storage_available: boolean;
      }>;
    },
    updateApiKey: async (apiKey: string) => {
      return ipcRenderer.invoke('byok:updateApiKey', { api_key: apiKey }) as Promise<{
        enabled: boolean;
        base_url: string;
        model: string;
        api_key_present: boolean;
        secure_storage_available: boolean;
      }>;
    },
    clearApiKey: async () => {
      return ipcRenderer.invoke('byok:clearApiKey') as Promise<{
        enabled: boolean;
        base_url: string;
        model: string;
        api_key_present: boolean;
        secure_storage_available: boolean;
      }>;
    },
    chatSend: async (text: string) => {
      return ipcRenderer.invoke('byok:chatSend', { text }) as Promise<{ content: string }>;
    },
    chatAbort: async () => {
      return ipcRenderer.invoke('byok:chatAbort') as Promise<{ ok: boolean }>;
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
  },
  userData: {
    getInfo: async (): Promise<UserDataInfo> => {
      return ipcRenderer.invoke('userdata:getInfo') as Promise<UserDataInfo>;
    },
    pickDir: async (): Promise<UserDataPickDirResult> => {
      return ipcRenderer.invoke('userdata:pickDir') as Promise<UserDataPickDirResult>;
    },
    migrate: async (targetDir: string): Promise<UserDataMigrateResult> => {
      return ipcRenderer.invoke('userdata:migrate', { targetDir }) as Promise<UserDataMigrateResult>;
    }
  },
  app: {
    relaunch: async (): Promise<void> => {
      await ipcRenderer.invoke('app:relaunch');
    }
  }
});
