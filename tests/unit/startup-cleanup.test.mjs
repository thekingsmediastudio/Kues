import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@libsql/client';
import {applyMigrations} from '../../apps/web/lib/db/migrate.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('migration failure preserves the useful diagnostic when database close is synchronous',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'keus-startup-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'test.sqlite');const db=createClient({url:'file:'+path});
 try{await applyMigrations(db);await db.execute({sql:'UPDATE schema_migrations SET checksum=? WHERE name=?',args:['deliberate-drift','0001_core.sql']});}finally{db.close()}
 const run=spawnSync(process.execPath,['apps/web/server.mjs'],{env:{PATH:process.env.PATH,TURSO_DATABASE_URL:'file:'+path,PORT:'0',NODE_ENV:'production',SYNTHETIC_SECRET:'PRIVATE_TEST_SENTINEL'},encoding:'utf8',timeout:15000});
 assert.notEqual(run.status,0);assert.match(run.stderr,/Keus startup failed: Applied migration changed on disk: 0001_core\.sql/);assert.doesNotMatch(run.stderr,/TypeError|PRIVATE_TEST_SENTINEL/);assert.doesNotMatch(run.stdout,/server listening/);
});
