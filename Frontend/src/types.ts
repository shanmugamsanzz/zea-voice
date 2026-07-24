/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type UserRole = 'SUPER_ADMIN' | 'DEVELOPER' | 'USER';

export interface Company {
  id: string;
  name: string;
  status: 'active' | 'suspended' | 'pending' | 'archived';
  billingTier: 'Starter' | 'Pro' | 'Enterprise';
  perMinutePrice: number;
  createdAt: string;
  developersCount: number;
  creditsBalance: number;
  phoneNumbersCount: number;
  monthlySpend: number;
  primaryContact: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  businessPhone?: string;
  address?: string;
  state?: string;
  country?: string;
  zip?: string;
  website?: string;
  timezone?: string;
}

export interface Developer {
  id: string;
  name: string;
  email: string;
  companyId: string;
  companyName: string;
  status: 'active' | 'invited' | 'inactive';
  lastActive: string;
  role: 'admin' | 'member';
  password?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  type: 'telephony' | 'llm' | 'tts' | 'stt';
  status: 'connected' | 'error' | 'disconnected';
  latency: string;
  usageCount: number;
  parameters?: Array<{ key: string; value: string }>;
}

export interface PhoneNumber {
  id: string;
  number: string;
  provider: string;
  type: 'Inbound' | 'Outbound' | 'Bidirectional';
  status: 'active' | 'released' | 'pending';
  assignedTo?: string; // agent name or campaign
  monthlyCost: number;
}

export interface CallSession {
  id: string;
  companyName: string;
  agentName: string;
  phoneNumber: string;
  direction: 'Inbound' | 'Outbound';
  status: 'ringing' | 'connected' | 'completed' | 'queued';
  duration: number; // in seconds
  sentiment: 'positive' | 'neutral' | 'negative';
  cost: number;
  timestamp: string;
  recordingUrl?: string;
  transcript?: { speaker: 'agent' | 'user'; text: string; time: string }[];
}

export interface QueueStatus {
  id: string;
  name: string;
  activeCalls: number;
  waitingCalls: number;
  maxWaitTime: number; // in seconds
  avgWaitTime: number; // in seconds
  status: 'normal' | 'congested' | 'critical';
}

export interface PaymentRecord {
  id: string;
  companyName: string;
  amount: number;
  type: 'Subscription' | 'Credit Refill' | 'Add-on';
  status: 'succeeded' | 'failed' | 'pending';
  date: string;
  paymentMethod: string;
}

export interface VoiceAgent {
  id: string;
  name: string;
  status: 'active' | 'draft' | 'archived';
  voiceId: string;
  temperature: number;
  prompt: string;
  interruptionSensitivity: number; // 0 to 1
  silenceTimeout: number; // in ms
  sttProvider: string;
  ttsProvider: string;
  llmModel: string;
  createdAt: string;
  updatedAt: string;
  totalCalls: number;
  avgDuration: number;
  successRate: number;
  description?: string;
  goal?: string;
  language?: string;
  agentUsage?: 'inbound' | 'outbound' | 'both';
  sttModel?: string;
  sttMode?: string;
  sttLanguage?: string;
  sttPunctuate?: boolean;
  sttSmartFormat?: boolean;
  sttPriceMin?: number;
  timeBasedInterruptionEnabled?: boolean;
  wordBasedInterruptionEnabled?: boolean;
  wordInterruptionMinWords?: number;
  wordInterruptionTriggerWords?: string[];
  interruptionPolicy?: 'any' | 'all';
  interruptionSensitivityLabel?: string;
  llmProvider?: string;
  greetingMode?: string;
  cachePolicy?: string;
  contextId?: string;
  welcomeMessage?: string;
  inactivityTimeout?: number;
  silentMessage?: string;
  ttsModel?: string;
  ttsAmbienceType?: string;
  ttsSpeed?: number;
  ttsStyle?: number;
  ttsLanguage?: string;
  ttsStability?: number;
  ttsPrice1k?: number;
  ttsSimilarityBoost?: number;
  pronunciationGroups?: string[];
  preCallProvider?: string;
  preCallPrompt?: string;
  preCallApiActive?: boolean;
  preCallApiUrl?: string;
  preCallApiMethod?: string;
  preCallApiHeaders?: string;
  preCallApiRequestBody?: string;
  preCallApiResponseMappings?: Array<{ key: string; path: string }>;
  postCallPrompt?: string;
  postCallMessageType?: string;
  postCallDynamicClosing?: string;
  postCallUninterruptibleReasons?: string[];
  postCallEndpointDetailsActive?: boolean;
  postCallApiMethod?: string;
  postCallApiUrl?: string;
  postCallApiHeaders?: Array<{ key: string; value: string }>;
}

export interface Campaign {
  id: string;
  name: string;
  status: 'draft' | 'running' | 'paused' | 'completed' | 'scheduled' | 'failed' | 'archived';
  agentId: string;
  agentName: string;
  phoneNumberId: string;
  phoneNumber: string;
  totalLeads: number;
  calledLeads: number;
  connectedCalls: number;
  convertedCount: number;
  scheduleStart: string;
  scheduleEnd: string;
}
