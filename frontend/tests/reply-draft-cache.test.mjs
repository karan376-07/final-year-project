import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getOrCreateReplyDraft, replyDraftKey } from '../src/utils/replyDraftCache.js';

const base = {
  userEmail: 'person@example.com',
  emailId: 'gmail-id',
  tone: 'Professional',
  language: 'en',
  subject: 'Meeting time',
  body: 'Can we meet tomorrow?'
};

assert.equal(replyDraftKey(base), replyDraftKey({ ...base }));
assert.notEqual(replyDraftKey(base), replyDraftKey({ ...base, tone: 'Friendly' }));
assert.notEqual(replyDraftKey(base), replyDraftKey({ ...base, language: 'ta' }));
assert.notEqual(replyDraftKey(base), replyDraftKey({ ...base, userEmail: 'other@example.com' }));
assert.notEqual(replyDraftKey(base), replyDraftKey({ ...base, body: 'Can we meet Friday?' }));

let calls = 0;
const generator = async () => {
  calls += 1;
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { replyText: 'Thanks, tomorrow works.' };
};
const key = replyDraftKey(base);
const [first, concurrent] = await Promise.all([
  getOrCreateReplyDraft(key, generator),
  getOrCreateReplyDraft(key, generator)
]);
assert.deepEqual(first, concurrent);
assert.equal(calls, 1, 'concurrent identical requests should share one generation');
await getOrCreateReplyDraft(key, generator);
assert.equal(calls, 1, 'successful drafts should be reused');

const detailSource = readFileSync(new URL('../src/components/EmailDetail.jsx', import.meta.url), 'utf8');
assert.match(detailSource, /response\?\.reply_text\s*\|\|\s*response\?\.reply_body/);
assert.match(detailSource, /typeof activeEmail\.body === 'string'/);

const apiSource = readFileSync(new URL('../../supabase/functions/api/index.js', import.meta.url), 'utf8');
assert.match(apiSource, /url\.searchParams\.get\("language"\)/);
assert.match(apiSource, /generateReply\(email\.subject, email\.body, tone, undefined, style \?\? undefined, language\)/);

const geminiSource = readFileSync(new URL('../../supabase/functions/api/_shared/gemini.js', import.meta.url), 'utf8');
assert.match(geminiSource, /responseMimeType:\s*"application\/json"/);
assert.match(geminiSource, /ask\(prompt, undefined, 320\)/);
assert.match(geminiSource, /quotaCooldownUntil/);

console.log('  14 reply-draft and API contract checks passed');
