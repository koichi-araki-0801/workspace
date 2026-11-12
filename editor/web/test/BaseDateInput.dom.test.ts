// =============================================================================
// BaseDateInput.dom.test.ts — 基準日の入力部品(打ち込み・貼り付け・候補選択)
// =============================================================================
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import BaseDateInput from '@/components/ui/BaseDateInput.vue';

function setup(options: string[], modelValue?: string, extra: Record<string, unknown> = {}) {
  const w = mount(BaseDateInput, {
    props: { options, modelValue, ...extra },
    attachTo: document.body,
  });
  const input = w.find('input');
  return { w, input };
}

function emitted(w: ReturnType<typeof setup>['w']): unknown[] {
  return (w.emitted('update:modelValue') ?? []).map((e) => e[0]);
}

describe('BaseDateInput', () => {
  it('shows model value', () => {
    const { input } = setup(['20240710'], '20240710');
    expect((input.element as HTMLInputElement).value).toBe('20240710');
  });

  it('commits candidate on select', async () => {
    const { w, input } = setup(['20240710']);
    await input.trigger('focus');
    await w.find('[role="option"]').trigger('click');
    expect(emitted(w)).toEqual(['20240710']);
  });

  it('commits typed date on enter', async () => {
    const { w, input } = setup([]);
    await input.setValue('2026/9/30');
    await input.trigger('keydown', { key: 'Enter' });
    expect(emitted(w)).toEqual(['20260930']);
  });

  it('commits typed date on blur', async () => {
    const { w, input } = setup([]);
    await input.setValue('2026-9-30');
    await input.trigger('blur');
    expect(emitted(w)).toEqual(['20260930']);
  });

  it('commits typed date on paste', async () => {
    const { w, input } = setup([]);
    await input.trigger('paste', { clipboardData: { getData: () => ' 2026/9/30 ' } });
    expect(emitted(w)).toEqual(['20260930']);
    expect((input.element as HTMLInputElement).value).toBe('20260930');
  });

  it('leaves the field to the browser when clipboard data is unreadable', async () => {
    const { w, input } = setup([]);
    await input.trigger('paste');
    expect(emitted(w)).toEqual([]);
    await input.setValue('2026/9/30');
    await input.trigger('blur');
    expect(emitted(w)).toEqual(['20260930']);
  });

  it('selects a candidate that is not a date', async () => {
    const { w, input } = setup(['202405']);
    await input.trigger('focus');
    await w.find('[role="option"]').trigger('click');
    expect(emitted(w)).toEqual(['202405']);
    expect(w.text()).not.toContain('日付として読めません');
  });

  it('commits a typed non-date candidate as is', async () => {
    const { w, input } = setup(['202405']);
    await input.setValue('202405');
    await input.trigger('keydown', { key: 'Enter' });
    expect(emitted(w)).toEqual(['202405']);
  });

  it('opens when the box (not the input) is clicked, also after escape', async () => {
    const { w, input } = setup(['20240710']);
    await input.trigger('focus');
    await input.trigger('keydown', { key: 'Escape' });
    expect(w.findAll('[role="option"]')).toHaveLength(0);
    await w.find('svg').trigger('click');
    expect(w.findAll('[role="option"]')).toHaveLength(1);
    expect(document.activeElement).toBe(input.element);
  });

  it('does not open from a box click when disabled', async () => {
    const { w } = setup(['20240710'], undefined, { disabled: true });
    await w.find('svg').trigger('click');
    expect(w.findAll('[role="option"]')).toHaveLength(0);
  });

  it('shows the label of an option and commits by value', async () => {
    const { w, input } = setup([{ label: '2024年7月10日', value: '20240710' }], '20240710');
    expect((input.element as HTMLInputElement).value).toBe('2024年7月10日');
    await input.trigger('focus');
    expect(w.find('[role="option"]').text()).toBe('2024年7月10日');
    await w.find('[role="option"]').trigger('click');
    expect(emitted(w)).toEqual([]);
    await input.setValue('2024年7月');
    expect(w.findAll('[role="option"]')).toHaveLength(1);
    await input.setValue('2024年7月10日');
    await input.trigger('keydown', { key: 'Enter' });
    expect(emitted(w)).toEqual([]);
  });

  it('moves the highlight with arrow keys and commits it on enter', async () => {
    const { w, input } = setup(['20240710', '20251117']);
    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'ArrowDown' });
    const id = input.attributes('aria-activedescendant');
    expect(id).toBeTruthy();
    expect(w.findAll('[role="option"]')[1].attributes('id')).toBe(id);
    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'ArrowUp' });
    await input.trigger('keydown', { key: 'ArrowUp' });
    await input.trigger('keydown', { key: 'ArrowUp' });
    await input.trigger('keydown', { key: 'Enter' });
    expect(emitted(w)).toEqual(['20251117']);
  });

  it('exposes combobox aria', async () => {
    const { w, input } = setup(['20240710']);
    expect(input.attributes('role')).toBe('combobox');
    expect(input.attributes('aria-expanded')).toBe('false');
    await input.trigger('focus');
    expect(input.attributes('aria-expanded')).toBe('true');
    expect(w.find('[role="listbox"]').attributes('id')).toBe(input.attributes('aria-controls'));
  });

  it('commits typed text on enter when no candidate is highlighted', async () => {
    const { w, input } = setup(['20240710']);
    await input.setValue('2026/9/30');
    await input.trigger('keydown', { key: 'Enter' });
    expect(emitted(w)).toEqual(['20260930']);
  });

  it('restores the text and clears the error on escape', async () => {
    const { w, input } = setup([], '20240710');
    await input.setValue('2026930');
    await input.trigger('keydown', { key: 'Enter' });
    expect(w.text()).toContain('日付として読めません');
    await input.trigger('keydown', { key: 'Escape' });
    expect((input.element as HTMLInputElement).value).toBe('20240710');
    expect(w.text()).not.toContain('日付として読めません');
    await input.trigger('blur');
    expect(w.text()).not.toContain('日付として読めません');
  });

  it('matches dashed candidate', async () => {
    const { w, input } = setup(['2024-05-17']);
    await input.setValue('20240517');
    await input.trigger('keydown', { key: 'Enter' });
    expect(emitted(w)).toEqual(['2024-05-17']);
  });

  it('rejects 7 digits', async () => {
    const { w, input } = setup([]);
    await input.setValue('2026930');
    await input.trigger('keydown', { key: 'Enter' });
    expect(emitted(w)).toEqual([]);
    expect(w.text()).toContain('日付として読めません（例: 2026/09/30）');
  });

  it('rejects invalid date', async () => {
    const { w, input } = setup([]);
    await input.setValue('2026/02/30');
    await input.trigger('keydown', { key: 'Enter' });
    expect(emitted(w)).toEqual([]);
    expect(w.text()).toContain('実在しない日付です');
  });

  it('clears the message when the input is edited again', async () => {
    const { w, input } = setup([]);
    await input.setValue('2026930');
    await input.trigger('keydown', { key: 'Enter' });
    await input.setValue('2026/9/30');
    expect(w.text()).not.toContain('日付として読めません');
  });

  it('filters candidates by prefix', async () => {
    const { w, input } = setup(['20240710', '20251117']);
    await input.setValue('2025');
    const items = w.findAll('[role="option"]');
    expect(items.map((i) => i.text())).toEqual(['20251117']);
  });

  it('lists every candidate when the input still shows the model value', async () => {
    const { w, input } = setup(['20240710', '20251117'], '20240710');
    await input.trigger('focus');
    expect(w.findAll('[role="option"]')).toHaveLength(2);
  });

  it('does not emit when the committed value equals the model', async () => {
    const { w, input } = setup(['2024-07-10'], '2024-07-10');
    await input.trigger('keydown', { key: 'Enter' });
    await input.setValue('20240710');
    await input.trigger('blur');
    expect(emitted(w)).toEqual([]);
  });

  it('restores the model text on blur with empty input', async () => {
    const { w, input } = setup([], '20240710');
    await input.setValue('');
    await input.trigger('blur');
    expect(emitted(w)).toEqual([]);
    expect((input.element as HTMLInputElement).value).toBe('20240710');
  });

  it('follows external model changes', async () => {
    const { w, input } = setup([], '20240710');
    await w.setProps({ modelValue: '20251117' });
    expect((input.element as HTMLInputElement).value).toBe('20251117');
  });

  it('closes the list on escape and opens on arrow down', async () => {
    const { w, input } = setup(['20240710']);
    await input.trigger('focus');
    expect(w.findAll('[role="option"]')).toHaveLength(1);
    await input.trigger('keydown', { key: 'Escape' });
    expect(w.findAll('[role="option"]')).toHaveLength(0);
    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(w.findAll('[role="option"]')).toHaveLength(1);
  });

  it('does not open when disabled', async () => {
    const { w, input } = setup(['20240710'], undefined, { disabled: true });
    await input.trigger('focus');
    expect(w.findAll('[role="option"]')).toHaveLength(0);
  });
});
