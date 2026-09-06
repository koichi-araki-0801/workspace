import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BackButton from '../src/components/ui/BackButton.vue';

// Mock vue-router so the component can be mounted in isolation (no real router).
const { back, push } = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));
vi.mock('vue-router', () => ({ useRouter: () => ({ back, push }) }));

beforeEach(() => {
  back.mockClear();
  push.mockClear();
});

describe('BackButton', () => {
  it('renders the visible label and uses it as the accessible name', () => {
    const wrapper = mount(BackButton, { props: { fallback: '/home', label: '戻る' } });
    const button = wrapper.get('button');
    expect(button.text()).toContain('戻る');
    expect(button.attributes('aria-label')).toBe('戻る');
  });

  it('falls back to ariaLabel when there is no visible label', () => {
    const wrapper = mount(BackButton, { props: { fallback: '/home', ariaLabel: '前に戻る' } });
    const button = wrapper.get('button');
    expect(button.text()).toBe('');
    expect(button.attributes('aria-label')).toBe('前に戻る');
  });

  it('goes back in history when there is a previous entry', async () => {
    window.history.replaceState({ back: '/prev' }, '');
    const wrapper = mount(BackButton, { props: { fallback: '/home', ariaLabel: 'back' } });
    await wrapper.get('button').trigger('click');
    expect(back).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('navigates to the fallback when there is no history to go back to', async () => {
    window.history.replaceState({}, '');
    const wrapper = mount(BackButton, { props: { fallback: '/home', ariaLabel: 'back' } });
    await wrapper.get('button').trigger('click');
    expect(push).toHaveBeenCalledWith('/home');
    expect(back).not.toHaveBeenCalled();
  });
});
