const MAX_ENTRIES = 50;
const SUCCESS_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_TTL_MS = 60 * 1000;
const FAILURE_TTL_MS = 10 * 1000;
const drafts = new Map();

export function replyDraftKey({ userEmail, emailId, tone, language, subject, body }) {
  let hash = 2166136261;
  const content = `${subject || ''}\n${body || ''}`;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return [
    (userEmail || '').toLowerCase(),
    emailId,
    tone,
    language,
    (hash >>> 0).toString(36)
  ].join(':');
}

export async function getOrCreateReplyDraft(key, createDraft) {
  const cached = drafts.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    drafts.delete(key);
    drafts.set(key, cached);
    return cached.value || cached.promise;
  }
  if (cached) drafts.delete(key);

  const pending = Promise.resolve().then(createDraft);
  const pendingEntry = { promise: pending, expiresAt: Date.now() + SUCCESS_TTL_MS };
  drafts.set(key, pendingEntry);
  while (drafts.size > MAX_ENTRIES) {
    drafts.delete(drafts.keys().next().value);
  }

  try {
    const result = await pending;
    if (!result?.replyText) {
      if (drafts.get(key) === pendingEntry) drafts.delete(key);
      return result;
    }
    const ttl = result.degraded
      ? result.fallbackReason === 'rate_limited' ? RATE_LIMIT_TTL_MS : FAILURE_TTL_MS
      : SUCCESS_TTL_MS;
    if (drafts.get(key) === pendingEntry) {
      drafts.set(key, { value: result, expiresAt: Date.now() + ttl });
    }
    return result;
  } catch (error) {
    if (drafts.get(key) === pendingEntry) drafts.delete(key);
    throw error;
  }
}
