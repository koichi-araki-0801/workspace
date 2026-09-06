// =============================================================================
// StepperInput.test.ts — 増減ステッパー付き数値入力の回帰テスト
// =============================================================================
// clamp・確定は呼び出し側(`Inspector.vue` の `commitNum`)の責務なので、ここでは
// 「blur で commit / ステッパーと上下キーで step が出る」という契約だけを固定する。
import { mount } from '@vue/test-utils';
import { TooltipProvider } from 'reka-ui';
import { describe, expect, it } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import StepperInput from '../src/components/ui/StepperInput.vue';

// 内部の Tooltip が Provider 必須のため、App.vue と同様に Provider で包んで mount する。
const mountStepper = (props: Record<string, unknown> = {}) => {
  const model = ref('50');
  const commits: string[] = [];
  const steps: number[] = [];
  const Host = defineComponent({
    setup() {
      return () =>
        h(TooltipProvider, null, () =>
          h(StepperInput, {
            modelValue: model.value,
            'onUpdate:modelValue': (v: string) => {
              model.value = v;
            },
            unit: '%',
            decLabel: '減らす',
            incLabel: '増やす',
            onCommit: () => commits.push(model.value),
            onStep: (d: number) => steps.push(d),
            ...props,
          }),
        );
    },
  });
  return { wrapper: mount(Host), model, commits, steps };
};

describe('StepperInput', () => {
  it('v-model の値と単位を描画する', () => {
    const { wrapper } = mountStepper();
    expect(wrapper.get('input').element.value).toBe('50');
    expect(wrapper.text()).toContain('%');
  });

  it('入力の blur で commit を emit する', async () => {
    const { wrapper, model, commits } = mountStepper();
    const input = wrapper.get('input');
    await input.setValue('72');
    expect(model.value).toBe('72');
    await input.trigger('blur');
    expect(commits).toEqual(['72']);
  });

  it('ステッパーのクリックで step(±1) を emit する', async () => {
    const { wrapper, steps } = mountStepper();
    await wrapper.get('[aria-label="減らす"]').trigger('click');
    await wrapper.get('[aria-label="増やす"]').trigger('click');
    expect(steps).toEqual([-1, 1]);
  });

  it('上下キーで step を emit する', async () => {
    const { wrapper, steps } = mountStepper();
    const input = wrapper.get('input');
    await input.trigger('keydown', { key: 'ArrowUp' });
    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(steps).toEqual([1, -1]);
  });

  it('invalid で警告クラスを付ける', () => {
    const { wrapper } = mountStepper({ invalid: true });
    expect(wrapper.get('.ins-num').classes()).toContain('ins-num-invalid');
  });
});
