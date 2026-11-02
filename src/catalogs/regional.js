// Official useful presets, verified 2026-10-31. These are not account discovery.
// Volcengine: https://docs.volcengine.com/docs/doubao-voice/tone-list-3?lang=zh
// Tencent: https://cloud.tencent.com/document/product/1073/92668 (基础语音合成)
const VOLC_VOICES = [
  ['zh_female_vv_uranus_bigtts', 'Vivi 2.0 · 通用女声'],
  ['zh_female_xiaohe_uranus_bigtts', '小何 2.0 · 通用女声'],
  ['zh_male_m191_uranus_bigtts', '云舟 2.0 · 通用男声'],
  ['zh_male_taocheng_uranus_bigtts', '小天 2.0 · 通用男声'],
  ['zh_male_liufei_uranus_bigtts', '刘飞 2.0 · 通用男声'],
  ['zh_female_sophie_uranus_bigtts', '魅力苏菲 2.0'],
  ['zh_female_qingxinnvsheng_uranus_bigtts', '清新女声 2.0'],
  ['zh_female_cancan_uranus_bigtts', '知性灿灿 2.0'],
  ['zh_female_sajiaoxuemei_uranus_bigtts', '撒娇学妹 2.0'],
  ['zh_female_tianmeixiaoyuan_uranus_bigtts', '甜美小源 2.0'],
  ['zh_female_tianmeitaozi_uranus_bigtts', '甜美桃子 2.0'],
  ['zh_female_shuangkuaisisi_uranus_bigtts', '爽快思思 2.0'],
];
const TENCENT_VOICES = [
  ['101001', '智瑜 · 情感女声'],
  ['101004', '智云 · 通用男声'],
  ['101011', '智燕 · 新闻女声'],
  ['101013', '智辉 · 新闻男声'],
  ['101015', '智萌 · 男童声'],
  ['101016', '智甜 · 女童声'],
  ['101019', '智彤 · 粤语女声'],
  ['101021', '智瑞 · 新闻男声'],
  ['101026', '智希 · 通用女声'],
  ['101027', '智梅 · 通用女声'],
  ['101030', '智柯 · 通用男声'],
  ['101050', 'WeJack · 英文男声'],
  ['101054', '智友 · 通用男声'],
  ['101055', '智付 · 通用女声'],
  ['402000', '云晓芙 · 聊天女声'],
  ['402001', '云小团 · 温柔甜美女声'],
  ['402002', '云大围 · 磁性男声'],
  ['502001', '智小柔 · 聊天女声'],
  ['502003', '智小敏 · 聊天女声'],
  ['502004', '智小满 · 营销女声'],
  ['502005', '智小解 · 解说男声'],
  ['502006', '智小悟 · 聊天男声'],
  ['502007', '智小虎 · 聊天童声'],
];

export function builtinRegionalCatalog(provider) {
  if (provider === 'volcengine') return {
    models: [{ id: 'seed-tts-2.0', label: '豆包语音合成 2.0' }],
    voices: VOLC_VOICES.map(([id, label]) => ({ id, label, models: ['seed-tts-2.0'], locale: 'zh-CN', kind: 'system' })),
    source: 'preset',
    note: '火山官方常用音色预置目录，并非账号授权列表。完整在线目录需要云 API 的 AK/SK，当前语音 API Key 不适用；其他音色可手动填写。',
  };
  if (provider === 'tencent') return {
    models: [{ id: '1', label: '腾讯云基础语音合成 · ModelType 1' }],
    voices: TENCENT_VOICES.map(([id, label]) => ({ id, label, models: ['1'], locale: id === '101050' ? 'en-US' : 'zh-CN', kind: 'system' })),
    source: 'preset',
    note: '腾讯云官方基础语音合成常用音色预置目录，并非账号授权列表；其他官方音色可手动填写。',
  };
  return { models: [], voices: [], source: 'preset', note: '此服务暂无官方预置目录，可手动填写。' };
}
