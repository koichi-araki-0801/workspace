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
});
