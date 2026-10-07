import { withPlatformAdminContext } from '../src/infrastructure/database-context.js';
import { database } from '../src/infrastructure/database.js';
import { backfillConversationCallLinks } from '../src/calls/conversation-thread.service.js';

const args=process.argv.slice(2);
const option=name=>args.find(value=>value.startsWith(`${name}=`))?.slice(name.length+1);
const allowed=new Set(['--apply','--tenant','--batch-size','--max-batches']);
if(args.some(arg=>!allowed.has(arg.split('=')[0]) || (arg !== '--apply' && !/^--(?:tenant|batch-size|max-batches)=.+$/.test(arg))))throw new Error('Unknown or missing backfill option');
if(new Set(args.map(arg=>arg.split('=')[0])).size!==args.length)throw new Error('Duplicate backfill option');
const tenantId=option('--tenant');
const limit=Number(option('--batch-size')??200);
const maximum=Number(option('--max-batches')??10);
if(!Number.isInteger(maximum)||maximum<1||maximum>10000)throw new Error('max-batches must be 1–10000');
if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('batch-size must be 1–1000');
if(tenantId!==undefined&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(tenantId))throw new Error('tenant must be a company UUID');
if(!args.includes('--apply')) {
  console.log('No database changes. Use --apply, optionally --tenant=<company UUID>, --batch-size=200 and --max-batches=10.');
} else {
  try {
    let total=0;
    for(let batch=0;batch<maximum;batch++) {
      const result=await withPlatformAdminContext(null,async client=> {
        await client.query("SET LOCAL statement_timeout = '10000ms'");
        return backfillConversationCallLinks(client,{tenantId,limit});
      });
      total+=result.linked;
      console.log(JSON.stringify({batch:batch+1,...result,total}));
      if(result.selected===0)break;
    }
  } finally {await database.end();}
}
