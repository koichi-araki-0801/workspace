import { afterEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the vi.mock factory (also hoisted) can reference it.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { generateTemplate } from '../src/generate/pyTemplate';

const attrs = { companyCode: 'C1', fundCode: 'F1', editionType: 'monthly' };

afterEach(() => vi.clearAllMocks());

describe('generateTemplate', () => {
  it('resolves with stdout and passes the attributes as a JSON arg', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, '<html>ok</html>', '');
      return { on: vi.fn() };
    });

    await expect(generateTemplate(attrs)).resolves.toBe('<html>ok</html>');

    const calledArgs = execFileMock.mock.calls[0][1] as string[];
    expect(calledArgs[calledArgs.length - 1]).toContain('"fundCode":"F1"');
  });

  it('rejects with a wrapped error (including stderr) when the process fails', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(new Error('spawn fail'), '', 'stderr detail');
      return { on: vi.fn() };
    });

    await expect(generateTemplate(attrs)).rejects.toThrow(/Python生成器の実行に失敗/);
  });

  it('rejects when the generator returns empty output', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, '   ', '');
      return { on: vi.fn() };
    });

    await expect(generateTemplate(attrs)).rejects.toThrow(/空の出力/);
  });

  it('basedOnTemplateId は生成器へ渡す前に検査し、規約外なら Python を起動しない', () => {
    // 検査は Promise 化する前(関数本体の同期部分)で行われるため、失敗は reject ではなく
    // 同期 throw になる。
    expect(() => generateTemplate({ ...attrs, basedOnTemplateId: '../etc/passwd' })).toThrow();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('基にする id が規約内なら引数として渡る', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, '<html/>', '');
      return { on: vi.fn() };
    });

    await generateTemplate({ ...attrs, basedOnTemplateId: 'AM01_510037_20240710_交付版' });

    const calledArgs = execFileMock.mock.calls[0][1] as string[];
    expect(calledArgs[calledArgs.length - 1]).toContain('AM01_510037_20240710_交付版');
  });

  it('stderr が空の失敗は message だけで組む(末尾に改行を足さない)', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(new Error('exit 1'), '', '');
      return { on: vi.fn() };
    });

    await expect(generateTemplate(attrs)).rejects.toThrow(/Python生成器の実行に失敗: exit 1$/);
  });
});
