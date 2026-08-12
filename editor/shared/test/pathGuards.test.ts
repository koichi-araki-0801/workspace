// パス安全性ゲート(`domain/template.ts`)の回帰テスト。ここの表(TRAVERSAL_PAYLOADS)は
// server 側の I/O 層テスト(`server/test/pathGuards.test.ts`)からも同じ意図で使い回す。
import { describe, expect, it } from 'vitest';
import {
  assertFundCode,
  assertTemplateFileName,
  assertTemplateId,
  isValidFundCode,
  isValidTemplateId,
  parseTemplateFileName,
  TEMPLATE_FILENAME_RE,
} from '../src/index';

const VALID_ID = 'AM01_510037_20240710_交付版';

/** ディレクトリ脱出・別名化を狙う入力の一覧。テンプレート id / fundCode の双方で不正。 */
const TRAVERSAL_PAYLOADS = [
  '../templates/AM01_510037_20240710_交付版',
  '..\\templates\\AM01_510037_20240710_交付版',
  '/etc/passwd',
  'C:\\Windows\\System32\\drivers\\etc\\hosts',
  'a/../../b',
  '.',
  '..',
  '',
];

describe('isValidTemplateId', () => {
  it('accepts an id that follows the four-token filename convention', () => {
    expect(isValidTemplateId(VALID_ID)).toBe(true);
    expect(isValidTemplateId('AM01_110024_20251117_全体版')).toBe(true);
  });

  it('rejects every traversal payload', () => {
    for (const payload of TRAVERSAL_PAYLOADS) {
      expect(isValidTemplateId(payload)).toBe(false);
    }
  });

  it('rejects an id whose token hides a path separator', () => {
    // トークンを `[^_]+` で切る判定ではこの形が 4 トークンとして通り、ディレクトリを 1 段脱出できる。
    expect(isValidTemplateId('AM01_510037_20240710_../../evil')).toBe(false);
    expect(isValidTemplateId('AM01_510037_20240710_..\\evil')).toBe(false);
  });

  it('rejects a NUL byte and other control characters', () => {
    expect(isValidTemplateId(`${VALID_ID}\u0000.txt`)).toBe(false);
    expect(isValidTemplateId(`AM01_510037_20240710_\u001f版`)).toBe(false);
  });

  it('rejects names Windows would silently rewrite', () => {
    expect(isValidTemplateId(`${VALID_ID}.`)).toBe(false);
    expect(isValidTemplateId(` ${VALID_ID}`)).toBe(false);
    expect(isValidTemplateId(`${VALID_ID} `)).toBe(false);
  });

  it('rejects an id with the wrong token count', () => {
    expect(isValidTemplateId('AM01_510037_20240710')).toBe(false);
    expect(isValidTemplateId('AM01_510037_20240710_交付版_extra')).toBe(false);
  });

  it('rejects an absurdly long id', () => {
    expect(isValidTemplateId(`AM01_510037_20240710_${'あ'.repeat(300)}`)).toBe(false);
  });
});

describe('isValidFundCode', () => {
  it('accepts the numeric fund codes in use', () => {
    for (const code of ['510037', '110024', '510003', '510124', '510155']) {
      expect(isValidFundCode(code)).toBe(true);
    }
  });

  it('rejects every traversal payload', () => {
    for (const payload of TRAVERSAL_PAYLOADS) {
      expect(isValidFundCode(payload)).toBe(false);
    }
  });

  it('rejects an underscore because it is the filename token separator', () => {
    expect(isValidFundCode('510037_x')).toBe(false);
  });

  it('rejects a drive-qualified name', () => {
    expect(isValidFundCode('C:evil')).toBe(false);
  });
});

describe('assertTemplateId / assertFundCode', () => {
  it('returns the input unchanged when it is valid', () => {
    expect(assertTemplateId(VALID_ID)).toBe(VALID_ID);
    expect(assertFundCode('510037')).toBe('510037');
  });

  it('throws a validation AppError carrying the offending value', () => {
    expect(() => assertTemplateId('../evil')).toThrowError(
      expect.objectContaining({ kind: 'validation' }),
    );
    expect(() => assertFundCode('../evil')).toThrowError(
      expect.objectContaining({ kind: 'validation' }),
    );
  });
});

describe('assertTemplateFileName', () => {
  it('normalises a valid name through parse -> join', () => {
    expect(assertTemplateFileName(`${VALID_ID}.html`)).toBe(`${VALID_ID}.html`);
  });

  it('rejects a name without the .html extension', () => {
    expect(() => assertTemplateFileName(VALID_ID)).toThrowError(
      expect.objectContaining({ kind: 'validation' }),
    );
  });

  it('rejects a traversal disguised as a template filename', () => {
    expect(() => assertTemplateFileName('../../evil.html')).toThrowError(
      expect.objectContaining({ kind: 'validation' }),
    );
  });
});

describe('TEMPLATE_FILENAME_RE', () => {
  it('no longer lets a token swallow a path separator', () => {
    expect(TEMPLATE_FILENAME_RE.test('AM01_510037_20240710_../../evil.html')).toBe(false);
    expect(TEMPLATE_FILENAME_RE.test('a/b_c_d_e.html')).toBe(false);
    expect(parseTemplateFileName('AM01_510037_20240710_../../evil.html')).toBeNull();
  });

  it('still matches the names in the fixture set', () => {
    expect(TEMPLATE_FILENAME_RE.test('AM01_510037_20240710_交付版.html')).toBe(true);
    expect(TEMPLATE_FILENAME_RE.test('AM01_510037_20240710_kr.html')).toBe(true);
  });
});
