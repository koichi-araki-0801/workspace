import { isErr, isOk, type PartHistoryEntry } from '@editor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { localAuthRepo } from '@/api/local/authRepo';
import { localHistoryRepo } from '@/api/local/historyRepo';
import { localPartRepo } from '@/api/local/partRepo';
import { K, partCatalog } from '@/api/local/store';
import { localTemplateRepo } from '@/api/local/templateRepo';
import { localUserRepo } from '@/api/local/userRepo';

beforeEach(() => localStorage.clear());

describe('localAuthRepo.login', () => {
  it('returns ok for valid seed credentials', async () => {
    const r = await localAuthRepo.login({ username: 'admin', password: 'admin' });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.user.username).toBe('admin');
  });

  it('returns err(unauthorized) for a wrong password', async () => {
    const r = await localAuthRepo.login({ username: 'admin', password: 'nope' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe('unauthorized');
      expect(r.error.message).toBe('ユーザーIDまたはパスワードが違います');
    }
  });

  it('returns err(unauthorized) for an unknown user', async () => {
    const r = await localAuthRepo.login({ username: 'ghost', password: 'x' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe('unauthorized');
  });
});

describe('localTemplateRepo.getTemplate', () => {
  it('returns err(not_found) for a missing id', async () => {
    const r = await localTemplateRepo.getTemplate('does_not_exist');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe('not_found');
  });
});

describe('localTemplateRepo confirmSave round-trip', () => {
  it('persists html/css and marks the template published', async () => {
    const list = await localTemplateRepo.listTemplates({});
    expect(isOk(list)).toBe(true);
    if (!isOk(list) || list.value.length === 0) return;
    const target = list.value[0];

    const saved = await localTemplateRepo.confirmSave({
      templateId: target.id,
      html: '<p>round-trip</p>',
      css: '.x{}',
      fundCode: target.attributes.fundCode,
    });
    expect(isOk(saved)).toBe(true);
    if (isOk(saved)) expect(saved.value.status).toBe('published');

    const reread = await localTemplateRepo.getTemplate(target.id);
    expect(isOk(reread)).toBe(true);
    if (isOk(reread)) expect(reread.value.html).toBe('<p>round-trip</p>');
  });
});

describe('localUserRepo.updateUser', () => {
  it('returns err(not_found) for an unknown id', async () => {
    const r = await localUserRepo.updateUser('u-ghost', { disabled: true });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe('not_found');
  });
});

describe('confirmSave version snapshots', () => {
  it('captures a snapshot retrievable via getSnapshot and listVersions', async () => {
    const list = await localTemplateRepo.listTemplates({});
    if (!isOk(list) || list.value.length === 0) return;
    const target = list.value[0];

    const saved = await localTemplateRepo.confirmSave({
      templateId: target.id,
      html: '<p>v1</p>',
      css: '.v1{}',
      fundCode: target.attributes.fundCode,
    });
    expect(isOk(saved)).toBe(true);

    // The newest edit-history entry should have a matching snapshot.
    const hist = await localHistoryRepo.getEditHistory();
    expect(isOk(hist)).toBe(true);
    if (!isOk(hist)) return;
    const entry = hist.value.find((e) => e.templateId === target.id);
    expect(entry).toBeDefined();
    if (!entry) return;

    const snap = await localHistoryRepo.getSnapshot(entry.id);
    expect(isOk(snap)).toBe(true);
    if (isOk(snap)) {
      expect(snap.value.html).toBe('<p>v1</p>');
      expect(snap.value.css).toBe('.v1{}');
      expect(snap.value.fundCode).toBe(target.attributes.fundCode);
    }

    const versions = await localHistoryRepo.listVersions(target.id);
    expect(isOk(versions)).toBe(true);
    if (isOk(versions)) {
      expect(versions.value.some((v) => v.historyId === entry.id)).toBe(true);
    }
  });

  it('returns err(not_found) from getSnapshot for an unknown history id', async () => {
    const r = await localHistoryRepo.getSnapshot('eh-ghost');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe('not_found');
  });
});

describe('localPartRepo', () => {
  it('lists every catalog part when unfiltered', async () => {
    const r = await localPartRepo.listParts({});
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toHaveLength(partCatalog.length);
  });

  it('filters listParts by category', async () => {
    const category = partCatalog[0].classification.category;
    const expected = partCatalog.filter((i) => i.classification.category === category);
    const r = await localPartRepo.listParts({ category });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toHaveLength(expected.length);
      expect(r.value.every((i) => i.classification.category === category)).toBe(true);
    }
  });

  it('cascades classification options (major classes scoped to the chosen category)', async () => {
    const category = partCatalog[0].classification.category;
    const r = await localPartRepo.getPartClassificationOptions({ category });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      // categories list is always the full set; majors narrow to the category
      expect(r.value.categories.length).toBeGreaterThan(0);
      const expectedMajors = [
        ...new Set(
          partCatalog
            .filter((i) => i.classification.category === category)
            .map((i) => i.classification.majorClass),
        ),
      ].sort();
      expect(r.value.majorClasses).toEqual(expectedMajors);
    }
  });

  it('getPartHistory returns only entries matching templateId and partId', async () => {
    const entries: PartHistoryEntry[] = [
      { id: 'p1', templateId: 'T1', partId: 'A', change: 'x', timestamp: 't', user: 'u' },
      { id: 'p2', templateId: 'T1', partId: 'B', change: 'y', timestamp: 't', user: 'u' },
      { id: 'p3', templateId: 'T2', partId: 'A', change: 'z', timestamp: 't', user: 'u' },
    ];
    localStorage.setItem(K.partHist, JSON.stringify(entries));
    const r = await localPartRepo.getPartHistory('T1', 'A');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.map((e) => e.id)).toEqual(['p1']);
  });

  it('getPartHistory returns [] when nothing is stored', async () => {
    const r = await localPartRepo.getPartHistory('none', 'none');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toEqual([]);
  });
});
