import { isErr, isOk } from '@editor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { localAuthRepo } from '@/api/local/authRepo';
import { localHistoryRepo } from '@/api/local/historyRepo';
import { localTemplateRepo } from '@/api/local/templateRepo';
import { localUserRepo } from '@/api/local/userRepo';

beforeEach(() => localStorage.clear());

async function firstMeta() {
  const list = await localTemplateRepo.listTemplates({});
  if (!isOk(list) || list.value.length === 0) throw new Error('no fixture templates');
  return list.value[0];
}

describe('localAuthRepo session lifecycle', () => {
  it('me() reflects login then logout', async () => {
    expect(isOk(await localAuthRepo.login({ username: 'admin', password: 'admin' }))).toBe(true);
    const me1 = await localAuthRepo.me();
    expect(isOk(me1)).toBe(true);
    if (isOk(me1)) expect(me1.value?.username).toBe('admin');

    expect(isOk(await localAuthRepo.logout())).toBe(true);
    const me2 = await localAuthRepo.me();
    expect(isOk(me2)).toBe(true);
    if (isOk(me2)) expect(me2.value).toBeNull();
  });

  it('rejects login for a disabled account', async () => {
    const users = await localUserRepo.listUsers();
    if (!isOk(users)) return;
    const admin = users.value.find((u) => u.username === 'admin');
    if (!admin) return;
    await localUserRepo.updateUser(admin.id, { disabled: true });

    const r = await localAuthRepo.login({ username: 'admin', password: 'admin' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.message).toBe('このアカウントは無効化されています');
  });

  it('initPassword sets a new password usable for login', async () => {
    const init = await localAuthRepo.initPassword({ username: 'admin', newPassword: 'newpass' });
    expect(isOk(init)).toBe(true);
    const login = await localAuthRepo.login({ username: 'admin', password: 'newpass' });
    expect(isOk(login)).toBe(true);
    if (isOk(login)) expect(login.value.mustChangePassword).toBe(false);
  });

  it('initPassword rejects an unknown user and a too-short password', async () => {
    const unknown = await localAuthRepo.initPassword({ username: 'ghost', newPassword: 'abcd' });
    expect(isErr(unknown)).toBe(true);
    if (isErr(unknown)) expect(unknown.error.kind).toBe('unauthorized');

    const short = await localAuthRepo.initPassword({ username: 'admin', newPassword: 'ab' });
    expect(isErr(short)).toBe(true);
    if (isErr(short)) expect(short.error.kind).toBe('validation');
  });
});

describe('localUserRepo', () => {
  it('lists seed users', async () => {
    const r = await localUserRepo.listUsers();
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.length).toBeGreaterThan(0);
  });

  it('createUser adds a user retrievable via listUsers', async () => {
    const created = await localUserRepo.createUser({
      username: 'newbie',
      displayName: '新人',
      role: 'editor',
      disabled: false,
      mustChangePassword: true,
    });
    expect(isOk(created)).toBe(true);
    const list = await localUserRepo.listUsers();
    if (isOk(list)) expect(list.value.some((u) => u.username === 'newbie')).toBe(true);
  });

  it('resetUserPassword resets to the init password and forces a change', async () => {
    const users = await localUserRepo.listUsers();
    if (!isOk(users)) return;
    const admin = users.value.find((u) => u.username === 'admin');
    if (!admin) return;

    const reset = await localUserRepo.resetUserPassword(admin.id);
    expect(isOk(reset)).toBe(true);

    const login = await localAuthRepo.login({ username: 'admin', password: 'init1234' });
    expect(isOk(login)).toBe(true);
    if (isOk(login)) expect(login.value.mustChangePassword).toBe(true);
  });

  it('resetUserPassword returns not_found for an unknown id', async () => {
    const r = await localUserRepo.resetUserPassword('u-ghost');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe('not_found');
  });
});

describe('localHistoryRepo pdf/create history', () => {
  it('records a pdf export (stamping the logged-in user) and lists it', async () => {
    await localAuthRepo.login({ username: 'admin', password: 'admin' });
    expect(isOk(await localHistoryRepo.getPdfHistory())).toBe(true);

    await localHistoryRepo.recordPdfExport('tpl-1');
    const after = await localHistoryRepo.getPdfHistory();
    expect(isOk(after)).toBe(true);
    if (isOk(after)) {
      expect(after.value).toHaveLength(1);
      expect(after.value[0].templateId).toBe('tpl-1');
      expect(after.value[0].user).not.toBe('不明'); // a logged-in user was stamped
    }
  });

  it('stamps 不明 when no user is logged in', async () => {
    await localHistoryRepo.recordPdfExport('tpl-x');
    const after = await localHistoryRepo.getPdfHistory();
    if (isOk(after)) expect(after.value[0].user).toBe('不明');
  });

  it('getCreateHistory defaults to empty', async () => {
    const r = await localHistoryRepo.getCreateHistory();
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toEqual([]);
  });
});

describe('localTemplateRepo dropdowns / generate / drafts', () => {
  it('getDropdownOptions narrows fundCodes by companyCode', async () => {
    const all = await localTemplateRepo.getDropdownOptions({});
    expect(isOk(all)).toBe(true);
    if (!isOk(all)) return;
    expect(all.value.companyCodes.length).toBeGreaterThan(0);

    const company = all.value.companyCodes[0];
    const narrowed = await localTemplateRepo.getDropdownOptions({ companyCode: company });
    if (isOk(narrowed)) {
      // narrowed fundCodes ⊆ all fundCodes
      expect(narrowed.value.fundCodes.every((f) => all.value.fundCodes.includes(f))).toBe(true);
    }
  });

  it('listTemplates filters by editionType', async () => {
    const meta = await firstMeta();
    const r = await localTemplateRepo.listTemplates({ editionType: meta.attributes.editionType });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.every((m) => m.attributes.editionType === meta.attributes.editionType)).toBe(
        true,
      );
    }
  });

  it('generate (blank) persists a draft override and records create history', async () => {
    await localAuthRepo.login({ username: 'admin', password: 'admin' });
    const base = await firstMeta();
    const r = await localTemplateRepo.generate({
      companyCode: base.attributes.companyCode,
      fundCode: base.attributes.fundCode,
      editionType: base.attributes.editionType,
    });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.template.meta.status).toBe('draft');

    // the generated template is now openable from the repo
    const reread = await localTemplateRepo.getTemplate(r.value.template.meta.id);
    expect(isOk(reread)).toBe(true);

    const hist = await localHistoryRepo.getCreateHistory();
    if (isOk(hist)) expect(hist.value.length).toBe(1);
  });

  it('generate (based on a template) copies the base html', async () => {
    const base = await firstMeta();
    const baseTpl = await localTemplateRepo.getTemplate(base.id);
    if (!isOk(baseTpl)) return;
    const r = await localTemplateRepo.generate({
      companyCode: base.attributes.companyCode,
      fundCode: base.attributes.fundCode,
      editionType: base.attributes.editionType,
      basedOnTemplateId: base.id,
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.template.html).toBe(baseTpl.value.html);
  });

  it('generate based on a missing template propagates not_found', async () => {
    const base = await firstMeta();
    const r = await localTemplateRepo.generate({
      companyCode: base.attributes.companyCode,
      fundCode: base.attributes.fundCode,
      editionType: base.attributes.editionType,
      basedOnTemplateId: 'does_not_exist',
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe('not_found');
  });

  it('listSeriesFunds filters by company and edition', async () => {
    const meta = await firstMeta();
    const r = await localTemplateRepo.listSeriesFunds(
      meta.attributes.companyCode,
      meta.attributes.fundCode,
      meta.attributes.editionType,
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(
        r.value.every(
          (m) =>
            m.attributes.companyCode === meta.attributes.companyCode &&
            m.attributes.editionType === meta.attributes.editionType,
        ),
      ).toBe(true);
    }
  });

  it('saveDraft then getDraft round-trips; missing draft is null', async () => {
    const meta = await firstMeta();
    await localTemplateRepo.saveDraft({ templateId: meta.id, html: '<p>d</p>', css: '.d{}' });
    const got = await localTemplateRepo.getDraft(meta.id);
    expect(isOk(got)).toBe(true);
    if (isOk(got)) expect(got.value?.html).toBe('<p>d</p>');

    const none = await localTemplateRepo.getDraft('no_such_template');
    if (isOk(none)) expect(none.value).toBeNull();
  });

  it('getSampleData returns {} for an unknown fund', async () => {
    const r = await localTemplateRepo.getSampleData('zzz-unknown');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toEqual({});
  });
});
