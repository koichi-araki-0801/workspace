import { describe, expect, it } from 'vitest';
import {
  parseTemplateFileName,
  TEMPLATE_FILENAME_RE,
  type TemplateAttributes,
  templateFileName,
  templateIdFromFileName,
} from '../src/index';

const SAMPLE: TemplateAttributes = {
  companyCode: 'AM01',
  fundCode: '510037',
  baseDate: '20240710',
  editionType: 'kr',
};
const SAMPLE_FILE = 'AM01_510037_20240710_kr.html';

describe('parseTemplateFileName', () => {
  it('parses the four attributes from a valid filename', () => {
    expect(parseTemplateFileName(SAMPLE_FILE)).toEqual(SAMPLE);
  });

  it('returns null for a name with the wrong number of segments', () => {
    expect(parseTemplateFileName('AM01_510037_20240710.html')).toBeNull();
  });

  it('returns null when the .html extension is missing', () => {
    expect(parseTemplateFileName('AM01_510037_20240710_kr.txt')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseTemplateFileName('')).toBeNull();
  });
});

describe('templateFileName', () => {
  it('joins attributes into the filename convention', () => {
    expect(templateFileName(SAMPLE)).toBe(SAMPLE_FILE);
  });
});

describe('templateIdFromFileName', () => {
  it('strips the .html extension', () => {
    expect(templateIdFromFileName(SAMPLE_FILE)).toBe('AM01_510037_20240710_kr');
  });

  it('leaves a name without extension unchanged', () => {
    expect(templateIdFromFileName('AM01_510037_20240710_kr')).toBe('AM01_510037_20240710_kr');
  });
});

describe('round-trip', () => {
  it('parse -> templateFileName reproduces the original filename', () => {
    const attrs = parseTemplateFileName(SAMPLE_FILE);
    expect(attrs).toEqual(SAMPLE);
    if (attrs) expect(templateFileName(attrs)).toBe(SAMPLE_FILE);
  });

  it('attributes -> filename -> id is stable', () => {
    const file = templateFileName(SAMPLE);
    expect(templateIdFromFileName(file)).toBe('AM01_510037_20240710_kr');
  });
});

describe('TEMPLATE_FILENAME_RE', () => {
  it('matches a valid filename and rejects an invalid one', () => {
    expect(TEMPLATE_FILENAME_RE.test(SAMPLE_FILE)).toBe(true);
    expect(TEMPLATE_FILENAME_RE.test('not-a-template.html')).toBe(false);
  });
});
