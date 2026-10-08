// =============================================================================
// rawTextClose.test.ts — `</style` / `</script` の中和とインライン化できる script の type
// =============================================================================
import { describe, expect, it } from 'vitest';
import { INLINEABLE_SCRIPT_TYPES, neutralizeRawTextClose } from '../src/security/rawTextClose.js';

// 置き換え前の 4 か所(web `sanitizeCss.ts`・`previewSelfContain.ts`、サーバ `inlineCss.ts`・
// `inlineDocScripts.ts`)の正規表現と置換文字列の写し。共有した関数が同じ結果を返すことを確かめる。
const OLD = { style: /<\/(?=style)/gi, script: /<\/(?=script)/gi } as const;
const OLD_REPLACEMENT = '<\\/';

describe('neutralizeRawTextClose — raw text 要素を閉じられなくする', () => {
  const inputs = [
    '',
    'a{}',
    '</style>',
    '</STYLE><script>x</script>',
    '</Style ',
    '</script>',
    '</SCRIPT x',
    '<\\/style>',
    '</styl',
    '</ſtyle>',
    '</ſcript>',
    '</style></style></script></script>',
    `content:"</style><script>alert(1)</script>"`,
  ];
  it.each(inputs)('%j: 置き換え前と同じ結果になる', (text) => {
    for (const tag of ['style', 'script'] as const) {
      expect(neutralizeRawTextClose(text, tag)).toBe(text.replace(OLD[tag], OLD_REPLACEMENT));
    }
  });

  it('`</` の `/` だけを `\\/` にし、対象の要素名だけを潰す', () => {
    expect(neutralizeRawTextClose('a</style>b</script>', 'style')).toBe('a<\\/style>b</script>');
    expect(neutralizeRawTextClose('a</style>b</script>', 'script')).toBe('a</style>b<\\/script>');
    expect(neutralizeRawTextClose('</STYLE>', 'style')).toBe('<\\/STYLE>');
  });

  it('非 ASCII の字は要素名の字と同じと見ない(`ſ` は `s` ではない)', () => {
    expect(neutralizeRawTextClose('</ſtyle>', 'style')).toBe('</ſtyle>');
  });

  it('続けて呼んでも同じ結果になる(lastIndex を持ち越さない)', () => {
    expect(neutralizeRawTextClose('</style>', 'style')).toBe('<\\/style>');
    expect(neutralizeRawTextClose('</style>', 'style')).toBe('<\\/style>');
  });
});

describe('INLINEABLE_SCRIPT_TYPES', () => {
  it('classic と module の JS の type だけ', () => {
    expect([...INLINEABLE_SCRIPT_TYPES]).toEqual([
      '',
      'module',
      'text/javascript',
      'application/javascript',
    ]);
  });
});
