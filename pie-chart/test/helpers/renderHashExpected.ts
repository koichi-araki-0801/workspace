// =============================================================================
// renderHashExpected.ts — 合成入力 26 ケースの SVG SHA256 (定数表)
// =============================================================================
// スナップショットでなく定数表にするのは、vitest がローカル実行で未知の snapshot 名を黙って
// 書き足す (`updateSnapshot` の既定 `'new'`) ためで、ケース名を 1 文字違えると旧ハッシュが
// 検査されないまま緑になる。定数表なら `-u` も無言の追加も存在せず、更新は必ずこのファイルの
// diff として現れる。値の更新は挙動変更を意図した時だけ許される。ケースの脱落・綴り違いは
// `render_hash.test.ts` が `Object.keys(EXPECTED)` と生成ケース名の集合一致で固定する。
// =============================================================================

export const EXPECTED: Readonly<Record<string, string>> = {
  gen_dominant_85: 'b26e7727696719e9d143d5fcb9a3141cb6ac3f4f01b88396fb680d70cc0a74da',
  gen_dominant_92: '811fca462fede413d261ccd019c6ae6c4432ef03d2480eb6b67185674d5355e7',
  gen_equal_4: '7cebed42d987a611caa23b72e1e188f82714c62455c3db6f4392b8bed66a5cbd',
  gen_long_10_other: '455268e4b94cceae760d9d48fb723cd5afefba795f3a185543b3d16f8e2b0331',
  gen_long_12_other: 'e35c0157ad673a4c0daaa4fa1c7e4faa429ce9fcaa1a05e899c9acc6433ddee2',
  gen_long_14_other: 'e35c0157ad673a4c0daaa4fa1c7e4faa429ce9fcaa1a05e899c9acc6433ddee2',
  gen_long_2_other: '3f9a015a87f43d78248a34efc938663ad969b9415c0cd23d4646359c453426f4',
  gen_long_3: '27e54fe35a9bb04b9d08752aefa6ad71482cec4d1a12e01f62ca90ab7eaabfa6',
  gen_long_4_other: '8b00f6baf2cbc04cefa2e7362069865977af7e697e6ef35e7ad94ce99958c040',
  gen_long_5: '7b34ca7bd28d865c5029f7df7bcae8b6b0344b274af214df24260e8fb6516af5',
  gen_long_6_other: 'da2c05a2864267f9d8a4527813aa5dac851c7d16fae3892db079171c91ba23a4',
  gen_long_7: '22a172fcdb2314924bf213a6afa576a6892fdb4820fc46ff11b90b7e53b12f3f',
  gen_long_8_other: 'fe2358c1917b99c021daf6efb007596ebf2f0768bb094c6f772a5ee6eaf19ab3',
  gen_long_9: 'd3c3b569d6331e28b528b9739726de7dcdeeb018fd443c3fa8840b1cd1e61464',
  gen_long_pair: 'baa7f3845760fda8cc93e59291a3f1af85b0753d46024cb5267a17dbdf2e7bc5',
  gen_short_10_other: '6d03773ce1fc9ee48845cdff564b64b29bf8c6e931c2752a3399a58fbdc60f58',
  gen_short_12_other: '9ac8a02ab0240a0728774b41e0e430e269a8c502c4ba53ba38b3731069298892',
  gen_short_14_other: '9ac8a02ab0240a0728774b41e0e430e269a8c502c4ba53ba38b3731069298892',
  gen_short_2_other: '68f0d42caa5a5a2dca3e7c47e45044556b6e0dfe2895bac8337b0d67d5ce2265',
  gen_short_3: 'd914f138afa896b76fccb6908090a86a747342799f621be9582536f86a8f8dab',
  gen_short_4_other: '77bf23cbbda83a132a73247c148e8676fe6702b027037510b90aa6dae90bda8d',
  gen_short_5: 'fa07834dd75fd7d29a240c879ce07eb01ced56695d07deab29cfbc8c1753ea6b',
  gen_short_6_other: '7afefdb168e7c2c4608633efcf574bb72126cc101275ef2e4a1a2f32d644d5f3',
  gen_short_7: 'c4328cd41eb1124b48346abd0a9efa5442af02801b69bd9dabea6661fdb25072',
  gen_short_8_other: 'f6fafc3949a8afe3f5319e18b0c6080401e4c5efc2a0a151a2e83636e55209ed',
  gen_short_9: '5be5aefec046ee73c5603486368b5ed50829c516884ba73d45ba8cb9200bd56e',
};
