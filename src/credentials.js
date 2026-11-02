import { KEY_NAME, PROVIDERS, normalizeConfig } from './config.js';

const CLEARED = '__CORTICO_NATURAL_VOICE_CLEARED__';
const ORIGINAL = ['siliconflow', 'openai', 'compatible'];

function fieldsFor(provider) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw new Error('未知的 TTS 服务。');
  return PROVIDERS[provider].credentials;
}

export function credentialName(provider, field) {
  if (!fieldsFor(provider).some(item => item.id === field)) throw new Error('此服务不支持该凭据字段。');
  return `CORTICO_NATURAL_VOICE_${provider.toUpperCase()}_${field.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
}

export function readCredentials(ctx, provider) {
  return Object.fromEntries(fieldsFor(provider).map(({ id }) => {
    const value = ctx.secret(credentialName(provider, id));
    return [id, typeof value === 'string' && value !== CLEARED ? value : ''];
  }));
}

export function credentialsReady(ctx, provider) {
  const values = readCredentials(ctx, provider);
  return fieldsFor(provider).filter(item => item.required).every(({ id }) => Boolean(values[id]));
}

export function saveCredentials(ctx, provider, provided) {
  const fields = fieldsFor(provider);
  if (!provided || typeof provided !== 'object' || Array.isArray(provided)) throw new Error('请提供有效的凭据字段。');
  const values = readCredentials(ctx, provider);
  const updates = {};
  for (const [id, raw] of Object.entries(provided)) {
    const field = fields.find(item => item.id === id);
    if (!field) throw new Error('此服务不支持该凭据字段。');
    if (typeof raw !== 'string' || /\s/.test(raw) || raw.length > 4096 || raw === CLEARED || (!raw && field.required)) throw new Error('凭据不能为空、含有空白或超过 4096 字符。');
    values[id] = raw; updates[id] = raw || CLEARED;
  }
  if (fields.some(({ id, required }) => required && !values[id])) throw new Error('请填写此服务所需的全部凭据。');
  for (const [id, value] of Object.entries(updates)) ctx.storeSecret(credentialName(provider, id), value);
  return readCredentials(ctx, provider);
}

export function clearCredentials(ctx, provider) {
  for (const { id } of fieldsFor(provider)) ctx.storeSecret(credentialName(provider, id), CLEARED);
}

export function migrateLegacyKey(ctx) {
  const current = normalizeConfig(ctx.cfg);
  if (!ORIGINAL.includes(current.provider)) return;
  if (ORIGINAL.some(provider => Boolean(ctx.secret(credentialName(provider, 'apiKey'))))) return;
  const legacy = ctx.secret(KEY_NAME);
  if (typeof legacy !== 'string' || !legacy || /\s/.test(legacy) || legacy.length > 4096) return;
  const inferred = normalizeConfig({ endpoint: current.endpoint }).provider;
  saveCredentials(ctx, inferred, { apiKey: legacy });
  ctx.cfg.provider = inferred;
  ctx.persist?.({ provider: inferred });
}
