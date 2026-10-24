import { WebSocket } from 'ws';
import { env } from '../../../config/env.js';
import { AppError } from '../../../middleware/errors.js';
import { audioDurationMs, resolveModelAudioFormat } from '../../audio/audio-format.js';
import { SttEventChannel } from './stt.interface.js';

export function isSarvamRealtime(config) {
  return config.modelKey === 'saaras:v3-realtime'
    || /\/speech-to-text-realtime\/ws\/?$/u.test(String(config.baseUrl ?? '').split('?')[0]);
}
export function resolveSarvamRealtimeConfiguration(config) {
  const settings = config.effectiveSettings ?? config.modelSettings ?? {};
  const format = resolveModelAudioFormat(config, 'input');
  if (format.channels !== 1 || format.encoding !== 'pcm_s16le' || ![8000,16000].includes(format.sampleRate))
    throw new AppError(409,'Sarvam Realtime requires mono little-endian PCM at 8000 or 16000 Hz','STT_AUDIO_FORMAT_UNSUPPORTED');
  const apiKey = Object.entries(config.parameters ?? {}).find(([key]) =>
    ['SARVAM_API_KEY','SARVAM_API_SUBSCRIPTION_KEY','API_SUBSCRIPTION_KEY','API_KEY','TOKEN'].includes(key.toUpperCase()))?.[1];
  if (!apiKey) throw new AppError(503,'Selected Sarvam provider has no API key','STT_API_KEY_MISSING');
  let endpoint;
  try { endpoint=new URL(config.baseUrl); } catch { throw new AppError(503,'Invalid Sarvam Realtime URL','STT_BASE_URL_INVALID'); }
  if(endpoint.protocol==='https:')endpoint.protocol='wss:';
  if(endpoint.protocol==='http:')endpoint.protocol='ws:';
  if(!['ws:','wss:'].includes(endpoint.protocol))throw new AppError(503,'Sarvam requires a WebSocket URL','STT_BASE_URL_INVALID');
  if(['','/','/speech-to-text/ws'].includes(endpoint.pathname))endpoint.pathname='/speech-to-text-realtime/ws';
  if(!/^\/speech-to-text-realtime\/ws\/?$/u.test(endpoint.pathname))throw new AppError(409,'Select the Sarvam Realtime endpoint','STT_BASE_URL_INVALID');
  if(!['saaras:v3-realtime','saaras:v4'].includes(config.modelKey))throw new AppError(409,'Unsupported Sarvam Realtime model','STT_MODEL_UNSUPPORTED');
  const language=settings.language_code ?? settings.languageCode ?? settings.sttLanguage ?? settings.language ?? 'auto';
  if(!['auto','en-IN','hi-IN','bn-IN','kn-IN','ml-IN','mr-IN','or-IN','pa-IN','ta-IN','te-IN','gu-IN','as-IN','ur-IN','ne-IN','kok-IN','ks-IN','sd-IN','sa-IN','sat-IN','mni-IN','brx-IN','mai-IN','doi-IN'].includes(language))
    throw new AppError(409,'Unsupported Realtime language; use auto or a supported BCP-47 code','STT_LANGUAGE_UNSUPPORTED');
  const streamType=settings.stream_type ?? settings.streamType ?? 'fast';
  const mode=settings.mode ?? settings.sarvamMode ?? 'transcribe';
  if(!['fast','balanced','simulated'].includes(streamType) || !['transcribe','translate','verbatim','translit','codemix'].includes(mode))
    throw new AppError(409,'Invalid Realtime stream type or mode','STT_SETTINGS_INVALID');
  if(settings.endpointing && settings.endpointing!=='vad')throw new AppError(409,'This adapter uses server VAD endpointing','STT_SETTINGS_INVALID');
  const query={language_code:language,model:config.modelKey,stream_type:streamType,mode,endpointing:'vad',encoding:'linear16',sample_rate:format.sampleRate};
  for(const [key,min,max] of [['threshold',0,1],['silence_duration_ms',1,10000],['min_speech_duration_ms',1,10000]]){
    if(settings[key]===undefined)continue;
    const v=Number(settings[key]);
    if(!Number.isFinite(v)||v<min||v>max||(key!=='threshold'&&!Number.isInteger(v)))throw new AppError(409,'Invalid Realtime VAD setting','STT_SETTINGS_INVALID',{field:key});
    query[key]=v;
  }
  // Do not forward legacy VAD fields or arbitrary endpoint query parameters.
  endpoint.search='';for(const [k,v] of Object.entries(query))endpoint.searchParams.set(k,String(v));
  return Object.freeze({endpoint:endpoint.toString(),apiKey,language,audioFormat:format,query});
}
function providerError(error,retryable=false){return {type:'error',code:String(error.code??'STT_PROVIDER_ERROR'),message:String(error.message??error),retryable};}
export function createSarvamRealtimeSttAdapter({providerConfig,runtimeContext={}}){
  const configuration=resolveSarvamRealtimeConfiguration(providerConfig);
  const channel=new SttEventChannel({providerId:providerConfig.providerId,modelId:providerConfig.modelId,language:configuration.language});
  const createWebSocket=runtimeContext.webSocketFactory ?? ((url,options)=>new WebSocket(url,options));
  let socket=null,closed=false,connected=false,pingTimer=null,sentBytes=0,reportedBytes=0;
  function usage(durationMs=null){
    const bytes=Math.max(0,sentBytes-reportedBytes);reportedBytes=sentBytes;
    if(bytes)channel.publish({type:'usage',audioBytes:bytes,audioDurationMs:durationMs??audioDurationMs(bytes,configuration.audioFormat)});
  }
  function publishProviderMessage(raw){
    if(closed)return;
    let m;try{m=JSON.parse(raw.toString('utf8'));}catch{channel.publish(providerError(new Error('Invalid Sarvam Realtime JSON')));return;}
    const requestId=m.request_id??m.session_id??null;
    if(m.event==='vad.speech_start'){channel.publish({type:'speech_started',requestId});return;}
    if(m.event==='vad.speech_end'){channel.publish({type:'speech_ended',requestId});return;}
    if(m.event==='transcript.partial' || m.event==='transcript.final'){
      const text=typeof m.text==='string'?m.text.trim():'';if(!text)return;
      const final=m.event==='transcript.final';
      if(final)channel.publish({type:'speech_ended',requestId});
      channel.publish({type:final?'final_transcript':'partial_transcript',text,language:m.language??configuration.language,requestId,confidence:null});
      return;
    }
    if(m.event==='error')channel.publish(providerError({message:m.message??'Sarvam Realtime failed',code:m.code},m.is_fatal!==true));
    if(m.event==='session.end')usage();
  }
  async function connect() {
    if (closed) throw new AppError(409, 'Sarvam STT adapter is closed', 'STT_ADAPTER_CLOSED');
    if (connected && socket?.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const candidate = createWebSocket(configuration.endpoint, {
        headers: { 'Api-Subscription-Key': configuration.apiKey },
        perMessageDeflate: false,
      });
      socket = candidate;
      const timeout = setTimeout(() => {
        cleanup();
        // ws emits an `error` when a CONNECTING socket is terminated. The
        // initial connection listener has just been removed by cleanup(), so
        // keep a one-shot listener for that expected termination event. Without
        // it, Node treats the event as unhandled and terminates the process.
        candidate.once('error', () => {});
        try { candidate.terminate?.(); } catch { /* timeout remains authoritative */ }
        reject(new AppError(504, 'Sarvam STT connection timed out', 'STT_CONNECT_TIMEOUT'));
      }, runtimeContext.connectTimeoutMs ?? env.STT_CONNECT_TIMEOUT_MS);
      timeout.unref?.();
      const cleanup = () => {
        clearTimeout(timeout);
        candidate.off('open', onOpen);
        candidate.off('error', onInitialError);
        candidate.off('close', onInitialClose);
      };
      const onOpen = () => {
        cleanup();
        connected = true;
        pingTimer=setInterval(()=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({event:'ping'}));},15000);
        pingTimer.unref?.();
        candidate.on('message', publishProviderMessage);
        candidate.on('error', (error) => channel.publish(providerError(error, true)));
        candidate.on('close', (code, reason) => {
          connected = false;
          clearInterval(pingTimer);usage();
          if (!closed && code !== 1000) channel.publish(providerError(
            new Error(`Sarvam STT connection closed (${code}): ${reason.toString()}`),
            code === 1001 || code === 1006 || code === 1011,
          ));
        });
        resolve();
      };
      const onInitialError = (error) => {
        cleanup();
        reject(new AppError(502, `Sarvam STT connection failed: ${error.message}`, 'STT_CONNECT_FAILED'));
      };
      const onInitialClose = (code, reason) => {
        cleanup();
        reject(new AppError(502, `Sarvam STT rejected the connection (${code}): ${reason.toString()}`, 'STT_CONNECT_REJECTED'));
      };
      candidate.once('open', onOpen);
      candidate.once('error', onInitialError);
      candidate.once('close', onInitialClose);
    });
  }

  function requireConnection() {
    if (!connected || socket?.readyState !== WebSocket.OPEN) {
      throw new AppError(409, 'Sarvam STT WebSocket is not connected', 'STT_NOT_CONNECTED');
    }
  }

  function sendAudio(audio){requireConnection();if(!Buffer.isBuffer(audio)||!audio.length)throw new TypeError('STT audio must be a non-empty Buffer');sentBytes+=audio.length;socket.send(JSON.stringify({event:'audio_input',audio:audio.toString('base64')}));}
  // flush is manual-endpointing-only. Server VAD owns finalization here.
  function flush(){}
  function cancel(reason='cancelled'){clearInterval(pingTimer);usage();connected=false;const current=socket;socket=null;if(current&&current.readyState!==WebSocket.CLOSED)current.close(1000,String(reason).slice(0,123));}
  function close(){if(closed)return;cancel('closed');closed=true;channel.close();}
  return {configuration,connect,sendAudio,flush,cancel,close,onEvent:fn=>channel.subscribe(fn),events:()=>channel.iterate()};
}
