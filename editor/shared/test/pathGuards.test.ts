// パス安全性ゲート(`domain/template.ts`)の回帰テスト。ここの表(TRAVERSAL_PAYLOADS)は
// server 側の I/O 層テスト(`server/test/pathGuards.test.ts`)からも同じ意図で使い回す。
import { describe, expect, it } from 'vitest';
import {
  assertAnyTemplateId,
  assertPairKey,
  assertSkeletonFileName,
  assertTemplateAttributeToken,
  assertTemplateFileName,
  assertTemplateId,
  isValidAnyTemplateId,
  isValidPairKey,
  isValidSkeletonId,
  isValidTemplateId,
  isValidTemplateToken,
  parseTemplateFileName,
  TEMPLATE_FILENAME_RE,
} from '../src/index';
import { TemplateId } from '../src/schemas';

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

describe('isValidTemplateToken (ファンドコード)', () => {
  it('accepts the numeric fund codes in use', () => {
    for (const code of ['510037', '110024', '510003', '510124', '510155']) {
      expect(isValidTemplateToken(code)).toBe(true);
    }
  });

  it('rejects Windows reserved device names, with or without an extension', () => {
    for (const name of ['CON', 'nul', 'COM1', 'aux.css', 'PRN', 'lpt1.html', 'Nul.HTML']) {
      expect(isValidTemplateToken(name)).toBe(false);
    }
  });

  it('does not over-reject names that merely start with a reserved prefix', () => {
    for (const name of ['CONSOLE', 'COM10', 'PRINTER', 'AUXILIARY']) {
      expect(isValidTemplateToken(name)).toBe(true);
    }
  });

  it('rejects every traversal payload', () => {
    for (const payload of TRAVERSAL_PAYLOADS) {
      expect(isValidTemplateToken(payload)).toBe(false);
    }
  });

  it('rejects an underscore because it is the filename token separator', () => {
    expect(isValidTemplateToken('510037_x')).toBe(false);
  });

  it('rejects a drive-qualified name', () => {
    expect(isValidTemplateToken('C:evil')).toBe(false);
  });
});

describe('assertTemplateId / assertTemplateAttributeToken', () => {
  it('returns the input unchanged when it is valid', () => {
    expect(assertTemplateId(VALID_ID)).toBe(VALID_ID);
    expect(assertTemplateAttributeToken('ファンドコード', '510037')).toBe('510037');
  });

  it('throws a validation AppError carrying the offending value', () => {
    expect(() => assertTemplateId('../evil')).toThrowError(
      expect.objectContaining({ kind: 'validation' }),
    );
    expect(() => assertTemplateAttributeToken('ファンドコード', '../evil')).toThrowError(
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

describe('assertPairKey', () => {
  const VALID_PAIR_KEY = 'AM01_510037_20240710';

  it('accepts the canonical company_fund_baseDate form', () => {
    expect(isValidPairKey(VALID_PAIR_KEY)).toBe(true);
    expect(assertPairKey(VALID_PAIR_KEY)).toBe(VALID_PAIR_KEY);
  });

  it('テンプレート側の company_fund(2 つ区切り)も受ける', () => {
    expect(isValidPairKey('AM01_510037')).toBe(true);
    expect(isValidPairKey('AM01_../evil')).toBe(false);
  });

  it('rejects every traversal payload', () => {
    for (const payload of TRAVERSAL_PAYLOADS) {
      expect(isValidPairKey(payload)).toBe(false);
    }
  });

  it('rejects a key with one token or four tokens', () => {
    expect(isValidPairKey('AM01')).toBe(false);
    expect(isValidPairKey('AM01_510037_20240710_交付版')).toBe(false);
  });

  it('rejects a key with an empty token', () => {
    expect(isValidPairKey('AM01__20240710')).toBe(false);
  });

  it('assertPairKey throws a validation AppError carrying the offending value', () => {
    expect(() => assertPairKey('../../evil')).toThrowError(
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

describe('テンプレート(3 つ区切り)の id とどちらの形も受ける入口', () => {
  const SKELETON_ID = 'AM01_510037_交付版';

  it('isValidSkeletonId は 3 つ区切りだけ、isValidTemplateId は 4 つ区切りだけを受ける', () => {
    expect(isValidSkeletonId(SKELETON_ID)).toBe(true);
    expect(isValidSkeletonId(VALID_ID)).toBe(false);
    expect(isValidTemplateId(SKELETON_ID)).toBe(false);
  });

  it('isValidAnyTemplateId は両方の形を受け、どちらでもない形は受けない', () => {
    expect(isValidAnyTemplateId(SKELETON_ID)).toBe(true);
    expect(isValidAnyTemplateId(VALID_ID)).toBe(true);
    expect(isValidAnyTemplateId('AM01_510037')).toBe(false);
    expect(isValidAnyTemplateId('AM01_510037_20240710_交付版_extra')).toBe(false);
  });

  it('どちらの形でもトラバーサル・空白・制御文字・長すぎる値は通らない(片方だけ緩む穴が無い)', () => {
    for (const payload of TRAVERSAL_PAYLOADS) expect(isValidAnyTemplateId(payload)).toBe(false);
    expect(isValidAnyTemplateId('AM01_510037_../../evil')).toBe(false);
    expect(isValidAnyTemplateId('AM01 _510037_交付版')).toBe(false);
    expect(isValidAnyTemplateId(`${SKELETON_ID} `)).toBe(false);
    expect(isValidAnyTemplateId(`${SKELETON_ID}.`)).toBe(false);
    expect(isValidAnyTemplateId('AM01_510037_\u001f版')).toBe(false);
    expect(isValidAnyTemplateId(`AM01_510037_${'あ'.repeat(300)}`)).toBe(false);
  });

  it('assertAnyTemplateId は通らなければ validation を投げ、通れば入力を返す', () => {
    expect(assertAnyTemplateId(SKELETON_ID)).toBe(SKELETON_ID);
    expect(() => assertAnyTemplateId('../evil')).toThrowError(
      expect.objectContaining({ kind: 'validation' }),
    );
  });

  it('assertSkeletonFileName は 3 つ区切りのファイル名だけを受ける', () => {
    expect(assertSkeletonFileName(`${SKELETON_ID}.html`)).toBe(`${SKELETON_ID}.html`);
    for (const bad of [`${VALID_ID}.html`, '../../evil.html', 'AM01 _510037_交付版.html']) {
      expect(() => assertSkeletonFileName(bad)).toThrowError(
        expect.objectContaining({ kind: 'validation' }),
      );
    }
  });

  it('契約の TemplateId は両方の形を受ける', () => {
    expect(TemplateId.safeParse(SKELETON_ID).success).toBe(true);
    expect(TemplateId.safeParse(VALID_ID).success).toBe(true);
    expect(TemplateId.safeParse('../evil').success).toBe(false);
  });
});
