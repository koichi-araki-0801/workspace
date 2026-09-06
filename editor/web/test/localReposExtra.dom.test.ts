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

  it('me() returns null after the app epoch changes (server/dev restart)', async () => {
    // 配信側が注入する起動 epoch を meta で模す。login 時の epoch を保存し、後で変える。
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'x-app-epoch');
    meta.setAttribute('content', 'epoch-1');
    document.head.appendChild(meta);
    try {
      expect(isOk(await localAuthRepo.login({ username: 'admin', password: 'admin' }))).toBe(true);
      // 同一 epoch のうちはログイン状態を保つ。
      const me1 = await localAuthRepo.me();
      if (isOk(me1)) expect(me1.value?.username).toBe('admin');
      // epoch が変わる = サーバ/dev 再起動。セッションは無効化され未ログインになる。
      meta.setAttribute('content', 'epoch-2');
      const me2 = await localAuthRepo.me();
      expect(isOk(me2)).toBe(true);
      if (isOk(me2)) expect(me2.value).toBeNull();
    } finally {
      meta.remove();
    }
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
    const init = await localAuthRepo.initPassword({
      username: 'admin',
      currentPassword: 'admin',
      newPassword: 'newpassword',
    });
    expect(isOk(init)).toBe(true);
    const login = await localAuthRepo.login({ username: 'admin', password: 'newpassword' });
    expect(isOk(login)).toBe(true);
    if (isOk(login)) expect(login.value.mustChangePassword).toBe(false);
  });

  it('initPassword rejects an unknown user and a too-short password', async () => {
    const unknown = await localAuthRepo.initPassword({
      username: 'ghost',
      currentPassword: 'ghost',
      newPassword: 'abcdefgh',
    });
    expect(isErr(unknown)).toBe(true);
    if (isErr(unknown)) expect(unknown.error.kind).toBe('unauthorized');

    const short = await localAuthRepo.initPassword({
      username: 'admin',
      currentPassword: 'admin',
      newPassword: 'ab',
    });
    expect(isErr(short)).toBe(true);
    if (isErr(short)) expect(short.error.kind).toBe('validation');
  });

  it('initPassword refuses to change the password without the current one', async () => {
    // 所有証明が無いまま書き換えられると、任意アカウント(admin 含む)の乗っ取りになる。
    const wrong = await localAuthRepo.initPassword({
      username: 'admin',
      currentPassword: 'not-the-current-password',
      newPassword: 'newpassword',
    });
    expect(isErr(wrong)).toBe(true);
    if (isErr(wrong)) expect(wrong.error.kind).toBe('unauthorized');
    // 失敗後も元のパスワードのまま使える(部分適用されていない)。
    expect(isOk(await localAuthRepo.login({ username: 'admin', password: 'admin' }))).toBe(true);
  });
});

describe('localTemplateRepo draft lifecycle', () => {
  it('saveDraft → getDraft → discardDraft round-trip', async () => {
    const meta = await firstMeta();
    expect(
      isOk(
        await localTemplateRepo.saveDraft({ templateId: meta.id, html: '<p>d</p>', css: '.d{}' }),
      ),
    ).toBe(true);

    const got = await localTemplateRepo.getDraft(meta.id);
    expect(isOk(got)).toBe(true);
    if (isOk(got)) {
      expect(got.value?.html).toBe('<p>d</p>');
      expect(got.value?.css).toBe('.d{}');
    }

    // 破棄するとドラフトは消え、次回ロードは null(= 元テンプレートから再開)。
    expect(isOk(await localTemplateRepo.discardDraft(meta.id))).toBe(true);
    const after = await localTemplateRepo.getDraft(meta.id);
    expect(isOk(after)).toBe(true);
    if (isOk(after)) expect(after.value).toBeNull();
  });

  it('discardDraft is idempotent (no draft → still ok)', async () => {
    const meta = await firstMeta();
    expect(isOk(await localTemplateRepo.discardDraft(meta.id))).toBe(true);
  });
});

describe('localUserRepo', () => {
  it('lists seed users', async () => {
    const r = await localUserRepo.listUsers();
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.length).toBeGreaterThan(0);
  });

  it('createUser issues a random temporary password, not the login id', async () => {
    const created = await localUserRepo.createUser({
      username: 'newbie',
      displayName: '新人',
      role: 'editor',
      disabled: false,
      mustChangePassword: true,
    });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    const { user, temporaryPassword } = created.value;
    expect(user.username).toBe('newbie');
    // ログインID と同じ初期パスワードへは戻さない(ID を知る者に乗っ取られる)。
    expect(temporaryPassword).not.toBe('newbie');
    expect(temporaryPassword).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/);

    const list = await localUserRepo.listUsers();
    if (isOk(list)) expect(list.value.some((u) => u.username === 'newbie')).toBe(true);
    // 払い出した平文でだけログインできる。
    expect(
      isOk(await localAuthRepo.login({ username: 'newbie', password: temporaryPassword })),
    ).toBe(true);
    expect(isErr(await localAuthRepo.login({ username: 'newbie', password: 'newbie' }))).toBe(true);
  });

  it('resetUserPassword issues a fresh temporary password and forces a change', async () => {
    const users = await localUserRepo.listUsers();
    if (!isOk(users)) return;
    const admin = users.value.find((u) => u.username === 'admin');
    if (!admin) return;

    const reset = await localUserRepo.resetUserPassword(admin.id);
    expect(isOk(reset)).toBe(true);
    if (!isOk(reset)) return;

    // 旧パスワード(seed の 'admin')は使えず、払い出した値だけが通る。
    expect(isErr(await localAuthRepo.login({ username: 'admin', password: 'admin' }))).toBe(true);
    const login = await localAuthRepo.login({
      username: 'admin',
      password: reset.value.temporaryPassword,
    });
    expect(isOk(login)).toBe(true);
    if (isOk(login)) expect(login.value.mustChangePassword).toBe(true);
  });

  it('never repeats a temporary password across resets', async () => {
    const users = await localUserRepo.listUsers();
    if (!isOk(users)) return;
    const admin = users.value.find((u) => u.username === 'admin');
    if (!admin) return;

    const first = await localUserRepo.resetUserPassword(admin.id);
    const second = await localUserRepo.resetUserPassword(admin.id);
    if (!isOk(first) || !isOk(second)) return;
    expect(first.value.temporaryPassword).not.toBe(second.value.temporaryPassword);
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

  // 各候補は「自分より上位の選択」だけで絞る。版種を選んでも候補がその版種 1 件へ潰れず、
  // 同一会社・ファンド・基準日の別版種(例: 全体版)へ選び直せること(再選択不能バグの回帰)。
  it('getDropdownOptions keeps sibling editionTypes/baseDates after selecting the lowest level', async () => {
    const list = await localTemplateRepo.listTemplates({});
    expect(isOk(list)).toBe(true);
    if (!isOk(list)) return;
    // 同一 (会社, ファンド, 基準日) で版種が複数あるグループを探す。
    const groups = new Map<string, Set<string>>();
    for (const m of list.value) {
      const a = m.attributes;
      const key = `${a.companyCode} ${a.fundCode} ${a.baseDate}`;
      (groups.get(key) ?? groups.set(key, new Set()).get(key))?.add(a.editionType);
    }
    const multi = [...groups.entries()].find(([, eds]) => eds.size > 1);
    expect(multi, 'fixtures に版種違いの同一基準日テンプレが必要').toBeTruthy();
    if (!multi) return;
    const [key, editions] = multi;
    const [companyCode, fundCode, baseDate] = key.split(' ');
    const editionType = [...editions][0]; // 片方の版種を選んだ状態を模す

    const opts = await localTemplateRepo.getDropdownOptions({
      companyCode,
      fundCode,
      baseDate,
      editionType,
    });
    expect(isOk(opts)).toBe(true);
    if (!isOk(opts)) return;
    // 選択中の版種だけに潰れず、その基準日の全版種が候補に残る。
    for (const ed of editions) expect(opts.value.editionTypes).toContain(ed);
    // 基準日候補も自身で潰れず、選択中の基準日を含む。
    expect(opts.value.baseDates).toContain(baseDate);
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

  it('getSampleData returns the common dummy for an unknown fund (code overridden, placeholder name)', async () => {
    const r = await localTemplateRepo.getSampleData('zzz-unknown');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const fund = r.value.fund as { code: string; name: string };
      expect(fund.code).toBe('zzz-unknown');
      // master 未収録なので名称は placeholder のまま、本体はパーツ別共通ダミー。
      expect(fund.name).toBe('サンプルファンド');
      expect(Array.isArray(r.value.holdings)).toBe(true);
    }
  });
});
