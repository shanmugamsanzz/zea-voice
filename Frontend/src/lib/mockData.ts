/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Company, Developer, ProviderConfig, PhoneNumber, CallSession, QueueStatus, PaymentRecord, VoiceAgent, Campaign } from '../types';

export const MOCK_COMPANIES: Company[] = [
  {
    id: 'comp-1',
    name: 'Acme Voice Systems',
    status: 'active',
    billingTier: 'Enterprise',
    createdAt: '2025-01-15',
    developersCount: 8,
    creditsBalance: 4250.50,
    phoneNumbersCount: 14,
    monthlySpend: 2450.00,
    primaryContact: 'Sarah Jenkins (sjenkins@acmevoice.com)',
  },
  {
    id: 'comp-2',
    name: 'Initech Retail Corp',
    status: 'active',
    billingTier: 'Pro',
    createdAt: '2025-03-22',
    developersCount: 3,
    creditsBalance: 840.20,
    phoneNumbersCount: 5,
    monthlySpend: 620.00,
    primaryContact: 'Peter Gibbons (peter@initech.com)',
  },
  {
    id: 'comp-3',
    name: 'Globex Logistics LLC',
    status: 'active',
    billingTier: 'Enterprise',
    createdAt: '2024-11-02',
    developersCount: 12,
    creditsBalance: 12450.00,
    phoneNumbersCount: 38,
    monthlySpend: 5800.00,
    primaryContact: 'Hank Scorpio (hscorpio@globex.org)',
  },
  {
    id: 'comp-4',
    name: 'Umbrella Biotech',
    status: 'suspended',
    billingTier: 'Pro',
    createdAt: '2025-05-10',
    developersCount: 4,
    creditsBalance: 12.40,
    phoneNumbersCount: 2,
    monthlySpend: 450.00,
    primaryContact: 'Albert Wesker (awesker@umbrella.com)',
  },
  {
    id: 'comp-5',
    name: 'Stark Industries Inc',
    status: 'active',
    billingTier: 'Enterprise',
    createdAt: '2023-08-19',
    developersCount: 24,
    creditsBalance: 85200.00,
    phoneNumbersCount: 120,
    monthlySpend: 15400.00,
    primaryContact: 'Pepper Potts (pepper@stark.com)',
  },
  {
    id: 'comp-6',
    name: 'Hooli Tech',
    status: 'pending',
    billingTier: 'Starter',
    createdAt: '2026-07-01',
    developersCount: 1,
    creditsBalance: 100.00,
    phoneNumbersCount: 1,
    monthlySpend: 0.00,
    primaryContact: 'Gavin Belson (gavin@hooli.xyz)',
  }
];

export const MOCK_DEVELOPERS: Developer[] = [
  {
    id: 'dev-1',
    name: 'Alice Johnson',
    email: 'alice@acmevoice.com',
    companyId: 'comp-1',
    companyName: 'Acme Voice Systems',
    status: 'active',
    lastActive: '2026-07-09 13:22',
    role: 'admin'
  },
  {
    id: 'dev-2',
    name: 'Bob Miller',
    email: 'bob@acmevoice.com',
    companyId: 'comp-1',
    companyName: 'Acme Voice Systems',
    status: 'active',
    lastActive: '2026-07-08 17:45',
    role: 'member'
  },
  {
    id: 'dev-3',
    name: 'Michael Bolton',
    email: 'mbolton@initech.com',
    companyId: 'comp-2',
    companyName: 'Initech Retail Corp',
    status: 'active',
    lastActive: '2026-07-09 11:05',
    role: 'admin'
  },
  {
    id: 'dev-4',
    name: 'Samir Naga',
    email: 'samir@initech.com',
    companyId: 'comp-2',
    companyName: 'Initech Retail Corp',
    status: 'active',
    lastActive: '2026-07-09 09:12',
    role: 'member'
  },
  {
    id: 'dev-5',
    name: 'Richard Hendricks',
    email: 'richard@hooli.xyz',
    companyId: 'comp-6',
    companyName: 'Hooli Tech',
    status: 'invited',
    lastActive: 'Never',
    role: 'admin'
  }
];

export const MOCK_PROVIDERS: ProviderConfig[] = [
  { 
    id: 'p-1', 
    name: 'Twilio Telephony', 
    type: 'telephony', 
    status: 'connected', 
    latency: '42ms', 
    usageCount: 184500,
    parameters: [
      { key: 'sid', value: 'AC839281a17b' },
      { key: 'region', value: 'us-east-1' }
    ]
  },
  { 
    id: 'p-2', 
    name: 'ElevenLabs Voice', 
    type: 'tts', 
    status: 'connected', 
    latency: '120ms', 
    usageCount: 142900,
    parameters: [
      { key: 'voice_id', value: '21m00Tcm4TlvDq8ikWAM' },
      { key: 'stability', value: '0.75' }
    ]
  },
  { 
    id: 'p-3', 
    name: 'Deepgram STT', 
    type: 'stt', 
    status: 'connected', 
    latency: '65ms', 
    usageCount: 201200,
    parameters: [
      { key: 'model', value: 'nova-2' },
      { key: 'language', value: 'en-US' }
    ]
  },
  { id: 'p-4', name: 'OpenAI GPT-4o Brain', type: 'llm', status: 'connected', latency: '320ms', usageCount: 198400 },
  { id: 'p-5', name: 'Groq Llama-3-70B', type: 'llm', status: 'connected', latency: '140ms', usageCount: 54100 },
  { id: 'p-6', name: 'Retell AI Telephony', type: 'telephony', status: 'disconnected', latency: 'N/A', usageCount: 12000 },
  { id: 'p-7', name: 'PlayHT TTS Engine', type: 'tts', status: 'error', latency: '540ms', usageCount: 4200 }
];

export const MOCK_PHONE_NUMBERS: PhoneNumber[] = [
  { id: 'num-1', number: '+1 (800) 555-0192', provider: 'Twilio', type: 'Bidirectional', status: 'active', assignedTo: 'Sarah Sales Agent', monthlyCost: 15.00 },
  { id: 'num-2', number: '+1 (888) 293-1029', provider: 'Twilio', type: 'Inbound', status: 'active', assignedTo: 'Support Desk Bot', monthlyCost: 15.00 },
  { id: 'num-3', number: '+1 (312) 584-9301', provider: 'Twilio', type: 'Bidirectional', status: 'active', assignedTo: 'Q3 Cold Outreach Campaign', monthlyCost: 2.50 },
  { id: 'num-4', number: '+1 (415) 390-4822', provider: 'Retell', type: 'Outbound', status: 'released', monthlyCost: 2.50 },
  { id: 'num-5', number: '+1 (212) 993-4819', provider: 'Twilio', type: 'Bidirectional', status: 'pending', monthlyCost: 2.50 }
];

export const MOCK_QUEUES: QueueStatus[] = [
  { id: 'q-1', name: 'Acme General Inbound', activeCalls: 8, waitingCalls: 2, maxWaitTime: 45, avgWaitTime: 12, status: 'normal' },
  { id: 'q-2', name: 'Initech Black Friday Promo Queue', activeCalls: 24, waitingCalls: 11, maxWaitTime: 280, avgWaitTime: 95, status: 'critical' },
  { id: 'q-3', name: 'Globex Logistics Outbound Dialing', activeCalls: 14, waitingCalls: 0, maxWaitTime: 0, avgWaitTime: 2, status: 'normal' },
  { id: 'q-4', name: 'Stark VIP Concierge Queue', activeCalls: 3, waitingCalls: 5, maxWaitTime: 120, avgWaitTime: 40, status: 'congested' }
];

export const MOCK_PAYMENTS: PaymentRecord[] = [
  { id: 'pay-1', companyName: 'Acme Voice Systems', amount: 2450.00, type: 'Subscription', status: 'succeeded', date: '2026-07-01', paymentMethod: 'Visa Ending 4242' },
  { id: 'pay-2', companyName: 'Globex Logistics LLC', amount: 5000.00, type: 'Credit Refill', status: 'succeeded', date: '2026-07-05', paymentMethod: 'Bank Transfer' },
  { id: 'pay-3', companyName: 'Initech Retail Corp', amount: 620.00, type: 'Subscription', status: 'succeeded', date: '2026-07-01', paymentMethod: 'Mastercard Ending 8901' },
  { id: 'pay-4', companyName: 'Umbrella Biotech', amount: 450.00, type: 'Subscription', status: 'failed', date: '2026-07-01', paymentMethod: 'Visa Ending 1111' },
  { id: 'pay-5', companyName: 'Stark Industries Inc', amount: 15400.00, type: 'Subscription', status: 'succeeded', date: '2026-06-19', paymentMethod: 'Corporate Wire' }
];

export const MOCK_AGENTS: VoiceAgent[] = [
  {
    id: 'agent-1',
    name: 'Sarah - Sales Qualifier',
    status: 'active',
    voiceId: 'elevenlabs-alloy-warm',
    temperature: 0.7,
    prompt: 'You are Sarah, a bubbly, professional sales development representative for Zea Voice. Your goal is to qualify lead companies. Ask about their daily inbound call volume, their current CRM integrations, and set up a demo with one of our directors. Be incredibly polite, use active listening, and keep your responses under 2-3 sentences. Never reveal you are an AI unless explicitly asked, in which case admit it proudly!',
    interruptionSensitivity: 0.3,
    silenceTimeout: 600,
    sttProvider: 'Deepgram Nova-2',
    ttsProvider: 'ElevenLabs Multilingual v2',
    llmModel: 'OpenAI GPT-4o',
    createdAt: '2025-02-14',
    updatedAt: '2026-07-01',
    totalCalls: 4580,
    avgDuration: 132,
    successRate: 74
  },
  {
    id: 'agent-2',
    name: 'Michael - Support Desk Bot',
    status: 'active',
    voiceId: 'elevenlabs-adam-deep',
    temperature: 0.4,
    prompt: 'You are Michael, a patient and technical customer support specialist. Help callers troubleshoot connection, microphone, and SIP credentials issues. Search our documentation system dynamically. Take ownership of the issue and express sympathy when users are frustrated.',
    interruptionSensitivity: 0.5,
    silenceTimeout: 800,
    sttProvider: 'Deepgram Nova-2',
    ttsProvider: 'PlayHT Hyper-Realistic Male',
    llmModel: 'OpenAI GPT-4o-mini',
    createdAt: '2025-04-10',
    updatedAt: '2026-06-15',
    totalCalls: 12900,
    avgDuration: 245,
    successRate: 88
  },
  {
    id: 'agent-3',
    name: 'Elena - Real Estate Assistant',
    status: 'draft',
    voiceId: 'elevenlabs-rachel-playful',
    temperature: 0.8,
    prompt: 'You are Elena, a real estate coordinator. Friendly, energetic, and detail-oriented. Answer incoming calls from buyers inquiring about active listings.',
    interruptionSensitivity: 0.2,
    silenceTimeout: 500,
    sttProvider: 'Deepgram Nova-2',
    ttsProvider: 'ElevenLabs Multilingual v2',
    llmModel: 'Groq Llama-3-70B',
    createdAt: '2026-06-30',
    updatedAt: '2026-07-08',
    totalCalls: 0,
    avgDuration: 0,
    successRate: 0
  }
];

export const MOCK_CAMPAIGNS: Campaign[] = [
  {
    id: 'camp-1',
    name: 'Q3 Cold Outreach Campaign',
    status: 'running',
    agentId: 'agent-1',
    agentName: 'Sarah - Sales Qualifier',
    phoneNumberId: 'num-3',
    phoneNumber: '+1 (312) 584-9301',
    totalLeads: 1500,
    calledLeads: 624,
    connectedCalls: 412,
    convertedCount: 98,
    scheduleStart: '2026-07-01 09:00',
    scheduleEnd: '2026-08-31 17:00'
  },
  {
    id: 'camp-2',
    name: 'Post-Support Feedback Survey',
    status: 'running',
    agentId: 'agent-2',
    agentName: 'Michael - Support Desk Bot',
    phoneNumberId: 'num-2',
    phoneNumber: '+1 (888) 293-1029',
    totalLeads: 5000,
    calledLeads: 4210,
    connectedCalls: 3105,
    convertedCount: 2410,
    scheduleStart: '2026-05-01 00:00',
    scheduleEnd: '2026-12-31 23:59'
  },
  {
    id: 'camp-3',
    name: 'Inactive Customer Re-activation',
    status: 'paused',
    agentId: 'agent-1',
    agentName: 'Sarah - Sales Qualifier',
    phoneNumberId: 'num-1',
    phoneNumber: '+1 (800) 555-0192',
    totalLeads: 250,
    calledLeads: 120,
    connectedCalls: 84,
    convertedCount: 15,
    scheduleStart: '2026-06-15 10:00',
    scheduleEnd: '2026-07-15 17:00'
  }
];

export const ACTIVE_MONITORING_CALLS: CallSession[] = [
  {
    id: 'call-active-1',
    companyName: 'Acme Voice Systems',
    agentName: 'Sarah - Sales Qualifier',
    phoneNumber: '+1 (312) 584-9301',
    direction: 'Outbound',
    status: 'connected',
    duration: 72,
    sentiment: 'positive',
    cost: 0.18,
    timestamp: '2026-07-09 13:37:05',
    transcript: [
      { speaker: 'agent', text: 'Hello, thank you for picking up! My name is Sarah from Acme Voice. How are you doing today?', time: '0:01' },
      { speaker: 'user', text: 'Hey Sarah, I am doing alright. What is this about?', time: '0:06' },
      { speaker: 'agent', text: 'We build autonomous conversational voice systems that handle incoming sales queries. I am actually an AI myself! I wanted to check what your typical daily inbound call volume looks like?', time: '0:12' },
      { speaker: 'user', text: 'Wow, really? You sound incredibly lifelike! Honestly, we get about 200 calls a day, mostly asking about product features and pricing.', time: '0:21' },
      { speaker: 'agent', text: 'That is exactly the type of load our voice agents thrive on! We can deflect up to 80% of those repetitive support and sales calls, routing complex cases directly to your specialists. Would it make sense to schedule a quick 10-minute demonstration with our team tomorrow?', time: '0:32' },
      { speaker: 'user', text: 'That actually sounds quite helpful. What times do you have available tomorrow morning?', time: '0:45' }
    ]
  },
  {
    id: 'call-active-2',
    companyName: 'Initech Retail Corp',
    agentName: 'Michael - Support Desk Bot',
    phoneNumber: '+1 (888) 293-1029',
    direction: 'Inbound',
    status: 'connected',
    duration: 185,
    sentiment: 'neutral',
    cost: 0.46,
    timestamp: '2026-07-09 13:35:12',
    transcript: [
      { speaker: 'user', text: 'Hi, I am having trouble connecting my Twilio SIP trunks to your platform. It keeps returning a 403 Forbidden error.', time: '0:02' },
      { speaker: 'agent', text: 'I am sorry to hear that you are encountering a 403 error. Let us get that sorted out. This is Michael from Support. Usually, a 403 error on SIP trunk registration happens when the IP access control list or credentials on Twilio do not match our server IP. Have you added our primary gateway IP, 54.12.98.42, to your Twilio ACL list?', time: '0:15' },
      { speaker: 'user', text: 'Oh, hold on. Let me look at my Twilio dashboard. No, I only added the secondary IP. Let me add the primary right now.', time: '0:40' },
      { speaker: 'agent', text: 'Excellent. Please apply those settings in Twilio and then hit "Test Connection" in your Zea Developer panel. I will monitor the incoming packets from my end.', time: '0:55' }
    ]
  },
  {
    id: 'call-active-3',
    companyName: 'Globex Logistics LLC',
    agentName: 'Sarah - Sales Qualifier',
    phoneNumber: '+1 (800) 555-0192',
    direction: 'Outbound',
    status: 'ringing',
    duration: 8,
    sentiment: 'neutral',
    cost: 0.00,
    timestamp: '2026-07-09 13:38:10'
  }
];

export const COMPLETED_CALL_LOGS: CallSession[] = [
  {
    id: 'log-1',
    companyName: 'Acme Voice Systems',
    agentName: 'Sarah - Sales Qualifier',
    phoneNumber: '+1 (312) 584-9301',
    direction: 'Outbound',
    status: 'completed',
    duration: 112,
    sentiment: 'positive',
    cost: 0.28,
    timestamp: '2026-07-09 13:12:44',
    transcript: [
      { speaker: 'agent', text: 'Hello, this is Sarah with Acme. I was looking to speak with the head of sales operations?', time: '0:01' },
      { speaker: 'user', text: 'Yes, this is Donald, I oversee sales ops. How can I help you?', time: '0:05' },
      { speaker: 'agent', text: 'Hi Donald! I want to share how Zea Voice helps outbound agents qualify 3x more leads. Are you currently using dialers or automated phone operators?', time: '0:12' },
      { speaker: 'user', text: 'We use manual dialers right now, but it is super slow.', time: '0:22' },
      { speaker: 'agent', text: 'That is exactly why I reached out! Sarah here can qualify cold lists in minutes and pass qualified warm transfers. I would love to send a demo link.', time: '0:35' },
      { speaker: 'user', text: 'Sure, send it over to donald@acmesales.com. Thanks!', time: '0:50' }
    ]
  },
  {
    id: 'log-2',
    companyName: 'Initech Retail Corp',
    agentName: 'Michael - Support Desk Bot',
    phoneNumber: '+1 (888) 293-1029',
    direction: 'Inbound',
    status: 'completed',
    duration: 290,
    sentiment: 'negative',
    cost: 0.72,
    timestamp: '2026-07-09 12:45:10',
    transcript: [
      { speaker: 'user', text: 'Your voice lag is driving me crazy! It takes like three seconds for you to respond.', time: '0:05' },
      { speaker: 'agent', text: 'I deeply apologize for the delay in my responses. Let me look into this. Voice lag typically happens if we are using heavy translation layers. Let me check our STT server settings. Are you calling from a VOIP softphone or a standard cell carrier?', time: '0:20' },
      { speaker: 'user', text: 'I am on a really weak Wi-Fi connection using a standard browser phone.', time: '0:45' },
      { speaker: 'agent', text: 'Ah, that explains it! WebRTC can sometimes drop audio blocks over volatile Wi-Fi networks. If you switch to standard cell audio or connect via ethernet, the response latency should drop back down to below 400 milliseconds. Shall we try switching to standard call?', time: '1:02' },
      { speaker: 'user', text: 'Alright, let me call you back on my cell. Thanks.', time: '1:45' }
    ]
  },
  {
    id: 'log-3',
    companyName: 'Stark Industries Inc',
    agentName: 'Michael - Support Desk Bot',
    phoneNumber: '+1 (888) 293-1029',
    direction: 'Inbound',
    status: 'completed',
    duration: 45,
    sentiment: 'neutral',
    cost: 0.11,
    timestamp: '2026-07-09 12:02:15',
    transcript: [
      { speaker: 'user', text: 'Is Tony Stark available to verify credentials on Jarvis?', time: '0:02' },
      { speaker: 'agent', text: 'I am sorry, Mr. Stark is currently unavailable in the laboratory. Would you like me to create an secure verification ticket for Jarvis security level 5 instead?', time: '0:08' },
      { speaker: 'user', text: 'No, I will just ping him on his personal channel. Thanks.', time: '0:20' }
    ]
  },
  {
    id: 'log-4',
    companyName: 'Globex Logistics LLC',
    agentName: 'Sarah - Sales Qualifier',
    phoneNumber: '+1 (312) 584-9301',
    direction: 'Outbound',
    status: 'completed',
    duration: 154,
    sentiment: 'positive',
    cost: 0.38,
    timestamp: '2026-07-09 11:30:55',
    transcript: [
      { speaker: 'agent', text: 'Hello, this is Sarah from Globex. Just calling to verify your shipping address for shipment 908-A.', time: '0:02' },
      { speaker: 'user', text: 'Yes, our address is 454 Cypress Street, Cypress Gardens, Florida.', time: '0:09' },
      { speaker: 'agent', text: 'Thank you! I have updated our routing system. The delivery driver will arrive around 2 PM tomorrow. Have a beautiful day!', time: '0:18' }
    ]
  }
];

export const CALL_VOLUME_CHART_DATA = [
  { name: '08:00', inbound: 45, outbound: 80, latency: 145 },
  { name: '09:00', inbound: 92, outbound: 150, latency: 152 },
  { name: '10:00', inbound: 140, outbound: 230, latency: 165 },
  { name: '11:00', inbound: 210, outbound: 290, latency: 158 },
  { name: '12:00', inbound: 185, outbound: 210, latency: 140 },
  { name: '13:00', inbound: 235, outbound: 310, latency: 148 },
  { name: '14:00', inbound: 195, outbound: 280, latency: 139 },
  { name: '15:00', inbound: 150, outbound: 190, latency: 142 },
  { name: '16:00', inbound: 110, outbound: 130, latency: 141 },
];

export const OUTCOME_DONUT_DATA = [
  { name: 'Warm Leads Qualified', value: 45, color: '#7C3AED' }, // Violet-600
  { name: 'Support Solved', value: 35, color: '#EC4899' }, // Pink-500
  { name: 'User Hung Up', value: 12, color: '#F59E0B' }, // Amber-500
  { name: 'Answering Machine', value: 8, color: '#EF4444' }, // Red-500
];

export const DURATION_BAR_DATA = [
  { range: '0-30s', count: 450, cost: 0.05 },
  { range: '31-60s', count: 890, cost: 0.12 },
  { range: '1-2m', count: 1840, cost: 0.25 },
  { range: '2-5m', count: 1240, cost: 0.58 },
  { range: '5m+', count: 580, cost: 1.25 },
];

export const LATENCY_TREND_DATA = [
  { day: 'Mon', stt: 65, llm: 310, tts: 120, total: 495 },
  { day: 'Tue', stt: 68, llm: 340, tts: 118, total: 526 },
  { day: 'Wed', stt: 62, llm: 295, tts: 125, total: 482 },
  { day: 'Thu', stt: 64, llm: 315, tts: 122, total: 501 },
  { day: 'Fri', stt: 70, llm: 350, tts: 130, total: 550 },
  { day: 'Sat', stt: 58, llm: 280, tts: 110, total: 448 },
  { day: 'Sun', stt: 55, llm: 270, tts: 105, total: 430 },
];
