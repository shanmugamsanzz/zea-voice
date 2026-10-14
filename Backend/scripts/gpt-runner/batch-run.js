import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, loadConfiguration, ConfigurationError } from './config.js';
import { runBatch } from './batch.js';
import { main as runOne } from './run.js';
export async function batchMain(args = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, invoke = runOne } = {}) {
  try {
    let manifestPath; let dryRun=false; let live=false; let allowed=false;
    for(let index=0;index<args.length;index++){
      if(args[index]==='--manifest'&&!manifestPath){manifestPath=args[++index];if(!manifestPath||manifestPath.startsWith('--'))throw new ConfigurationError('A local manifest path is required.');}
      else if(args[index]==='--dry-run'&&!dryRun)dryRun=true;
      else if(args[index]==='--live'&&!live)live=true;
      else if(args[index]==='--allow-session-records'&&!allowed)allowed=true;
      else throw new ConfigurationError('Unknown or duplicate batch option.');
    }
    if(!manifestPath||dryRun&&(live||allowed)||!dryRun&&(!live||!allowed))throw new ConfigurationError('Batch requires a manifest and either --dry-run or both explicit live permission flags.');
    const manifestFile=path.resolve(manifestPath);const manifest=await readJson(manifestFile,'Batch manifest');
    if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||Object.keys(manifest).some(k=>!['configs','concurrency'].includes(k))
      ||!Array.isArray(manifest.configs)||manifest.configs.length<1||manifest.configs.length>10
      ||!Number.isInteger(manifest.concurrency)||manifest.concurrency<1||manifest.concurrency>3)throw new ConfigurationError('Batch requires one to ten configs and concurrency between one and three.');
    const jobs=manifest.configs.map(value=>{
      if(typeof value!=='string'||!value||value.length>4096||/[\u0000-\u001f]/u.test(value)||/^[a-z]+:\/\//iu.test(value)||value.startsWith('\\\\')||value.startsWith('//'))throw new ConfigurationError('Batch config must be a local file path.');
      return path.resolve(path.dirname(manifestFile),value);
    });
    // Validate every local config before allowing any job to start.
    const settings=await Promise.all(jobs.map(value=>loadConfiguration(value)));
    if(dryRun){stdout.write(JSON.stringify({mode:'dry-run',jobs:jobs.length,concurrency:manifest.concurrency,
      languages:[...new Set(settings.map(value=>value.config.language))],networkRequests:0,sessionsCreated:0},null,2)+'\n');return 0;}
    if(settings.some(value=>value.config.placeholder||!value.config.callerConfigPath))throw new ConfigurationError('All live jobs require real links and caller configuration.');
    const results=await runBatch(jobs,{concurrency:manifest.concurrency,run:async configPath=>{
      let output='';let error='';
      const exitCode=await invoke(['--config',configPath,'--live','--allow-session-records'],{
        stdout:{write(value){output+=value;}},stderr:{write(value){error+=value;}}
      });
      // Child summaries are sanitized by the single-run CLI; do not echo error text or paths.
      let summary=null;try{summary=JSON.parse(output);}catch{}
      return {exitCode,liveTestVerified:summary?.liveTestVerified===true,failureCode:summary?.failureCode??(error?'RUN_FAILED':null)};
    }});
    stdout.write(JSON.stringify({mode:'live-batch',results,serverCapacityCertified:false,
      limitation:'No server CPU/memory, provider quota or sustainable capacity is certified by this runner.'},null,2)+'\n');
    return results.some(value=>value.status!=='completed'||value.result.exitCode!==0)?1:0;
  }catch(error){stderr.write('GPT Runner batch: '+(error instanceof ConfigurationError?error.message:'Batch failed; private details omitted.')+'\n');return 2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await batchMain();
