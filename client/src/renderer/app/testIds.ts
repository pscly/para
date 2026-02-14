export const TEST_IDS = {
  loginEmail: 'login-email',
  loginPassword: 'login-password',
  loginSubmit: 'login-submit',
  loginError: 'login-error',

  chatInput: 'chat-input',
  chatSend: 'chat-send',
  chatStop: 'chat-stop',
  chatLastAiMessage: 'chat-last-ai-message',

  feedDropzone: 'feed-dropzone',
  feedProgress: 'feed-progress',
  feedDone: 'feed-done',

  toggleVision: 'toggle-vision',
  visionConsentPanel: 'vision-consent-panel',
  visionConsentAccept: 'vision-consent-accept',
  visionConsentDecline: 'vision-consent-decline',
  visionSendTestScreenshot: 'vision-send-test-screenshot',
  visionSuggestion: 'vision-suggestion',

  toggleAssistant: 'toggle-assistant',
  toggleAssistantIdle: 'toggle-assistant-idle',
  assistantCopyEnglish: 'assistant-copy-english',
  assistantSuggestion: 'assistant-suggestion',

  galleryGenerate: 'gallery-generate',
  galleryRefresh: 'gallery-refresh',
  galleryMasonry: 'gallery-masonry',
  galleryItem: 'gallery-item',

  timelineCard: 'timeline-card',
  timelineSimulate: 'timeline-simulate',
  timelineRefresh: 'timeline-refresh',
  timelineList: 'timeline-list',
  timelineItem: 'timeline-item',

  socialRoomCard: 'social-room-card',
  socialRoomId: 'social-room-id',
  socialTargetUserId: 'social-target-user-id',
  socialCreateRoom: 'social-create-room',
  socialInvite: 'social-invite',
  socialJoin: 'social-join',
  socialEventList: 'social-event-list',
  socialEventItem: 'social-event-item',

  ugcCard: 'ugc-card',
  ugcRefresh: 'ugc-refresh',
  ugcList: 'ugc-list',
  ugcItem: 'ugc-item',

  pluginsCard: 'plugins-card',
  pluginsToggle: 'plugins-toggle',
  pluginsConsentPanel: 'plugins-consent-panel',
  pluginsConsentAccept: 'plugins-consent-accept',
  pluginsConsentDecline: 'plugins-consent-decline',
  pluginsRefresh: 'plugins-refresh',
  pluginsSelect: 'plugins-select',
  pluginsInstall: 'plugins-install',
  pluginsStatus: 'plugins-status',
  pluginsError: 'plugins-error',
  pluginsMenuList: 'plugins-menu-list',
  pluginsMenuItem: 'plugins-menu-item'
} as const;

export type TestIdKey = keyof typeof TEST_IDS;
