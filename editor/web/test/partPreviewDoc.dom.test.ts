import { describe, expect, it } from 'vitest';
import { buildPartPreviewDoc } from '@/features/editor/partPreviewDoc';

describe('buildPartPreviewDoc', () => {
  it('content が body に入る', () => {
    const doc = buildPartPreviewDoc('<p id="x">hello</p>', '', 794);
    const parsed = new DOMParser().parseFromString(doc, 'text/html');
    expect(parsed.body.innerHTML).toContain('<p id="x">hello</p>');
  });

  it('css に </style><script> を含めても中和され script 要素が生成されない', () => {
    const css = 'body{color:red}</style><script>alert(1)</script>';
    const doc = buildPartPreviewDoc('<p>x</p>', css, 794);
    const parsed = new DOMParser().parseFromString(doc, 'text/html');
    expect(parsed.querySelectorAll('script')).toHaveLength(0);
  });

  it('width が body の余白計算に反映される', () => {
    const doc = buildPartPreviewDoc('<p>x</p>', '', 500);
    expect(doc).toContain('width:500px');
  });
});
