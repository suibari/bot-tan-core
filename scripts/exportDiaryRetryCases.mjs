/** Read-only snapshot for evaluateDiaryRetryFormats.mts. Run from repository root.
 * node --env-file=.env scripts/exportDiaryRetryCases.mjs --since=2026-10-15 --until=2026-10-22 --out=/tmp/diary-cases.json
 * Output includes private diary/post data; never commit it.
 */
import postgres from 'postgres';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const sinceDate = arg('since');
const untilDate = arg('until');
const out = arg('out');
if (!out || !sinceDate || !untilDate || ![sinceDate, untilDate].every(v => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v))) || sinceDate >= untilDate) throw new Error('--since, --until (exclusive), and --out are required');
const {buildUserDiaryContext, selectUserDiaryMediaReference, withPreferredName, getTimezoneFromLang, localHourToUtc} = await import(pathToFileURL(resolve('packages/clients/dist/index.js')).href);
const {client} = await import(pathToFileURL(resolve('packages/database/dist/index.js')).href);
console.log = (...args) => console.error(...args);
const sql = postgres(process.env.DATABASE_URL, {max:1});
try {
 await sql`set default_transaction_read_only=on`;
 const diaries = await sql`select subject_did, diary_date, text, langs, record_created_at, title_ja, title_en from nagi.diaries where diary_date >= ${sinceDate} and diary_date < ${untilDate} order by record_created_at desc limit 240`;
 const pool=[];
 for (const d of diaries) {
  const lang=d.langs?.[0]; const timezone=getTimezoneFromLang(lang); const until=localHourToUtc(d.diary_date,22,timezone); const since=new Date(until.getTime()-86400000);
  const posts=await sql`select text, langs from nagi.posts where did=${d.subject_did} and deleted_at is null and record_created_at >= ${since.toISOString()}::timestamptz and record_created_at < ${until.toISOString()}::timestamptz order by record_created_at`;
  if (!posts.length) continue;
  const english=(lang??'').startsWith('en');
  pool.push({did:d.subject_did,date:d.diary_date,timezone,since,until,english,posts:posts.map(p=>p.text),baselineDiary:d.text, baselineTitle:{ja:d.title_ja,en:d.title_en}, group:english?'english':posts.length<=2?'sparse':'dense'});
 }
 const chosen=[]; const keys=new Set(); const perSubject=new Map();
 for (const group of ['english','sparse','dense']) {
  for (let cap=1;cap<=8 && chosen.filter(c=>c.group===group).length<8;cap++) {
   for (const c of pool.filter(c=>c.group===group)) {
    const key=`${c.did}:${c.date}`;
    if(keys.has(key)||(perSubject.get(c.did)??0)>=cap||chosen.filter(c=>c.group===group).length>=8)continue;
    chosen.push(c);keys.add(key);perSubject.set(c.did,(perSubject.get(c.did)??0)+1);
   }
  }
 }
 for(const c of pool){const key=`${c.did}:${c.date}`;if(chosen.length>=24)break;if(!keys.has(key)){chosen.push(c);keys.add(key);}}
 if (chosen.length !== 24) throw new Error(`Need 24 real cases; found ${chosen.length}`);
 const cases=[];
 for (const c of chosen) {
  const profile=await sql`select coalesce(p.display_name,a.handle,a.did) as name from nagi.actors a left join nagi.profiles p on p.did=a.did where a.did=${c.did} limit 1`;
  const userinfo=await withPreferredName({follower:{did:c.did,handle:c.did,displayName:profile[0]?.name??''},posts:c.posts,langStr:c.english?'English':'日本語'});
  const dayContext=await buildUserDiaryContext({did:c.did,date:c.date,since:c.since,until:c.until,timezone:c.timezone,japanese:!c.english});
  const mediaReference=await selectUserDiaryMediaReference(c.did,c.date);
  cases.push({...c,userinfo,dayContext,mediaReference});
 }
 await writeFile(out, JSON.stringify({exportedAt:new Date().toISOString(),sinceDate,untilDate,window:'scheduled local 22:00, preceding 24h',source:'nagi.diaries and nondeleted nagi.posts; context reconstructed from current retained history',cases}), {mode:0o600});
 console.error(JSON.stringify({exportedCases:cases.length,subjects:new Set(cases.map(c=>c.did)).size}));
} catch(e) { console.error(e);process.exitCode=1; } finally {await sql.end();await client.end();}
