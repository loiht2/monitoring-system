import { describe, it, expect } from 'vitest';
import { seriesKey, assignColors, seriesLabel } from './series';
import { SERIES, OTHER } from './theme';

describe('seriesKey', () => {
  it('is independent of label insertion order', () => {
    expect(seriesKey({ pod: 'a', gpu: '1' })).toBe(seriesKey({ gpu: '1', pod: 'a' }));
  });

  it('separates series that differ in any label', () => {
    expect(seriesKey({ pod: 'a' })).not.toBe(seriesKey({ pod: 'b' }));
  });
});

describe('assignColors', () => {
  it('gives each series a distinct slot', () => {
    const c = assignColors([{ pod: 'a' }, { pod: 'b' }, { pod: 'c' }], {});
    expect(new Set(Object.values(c)).size).toBe(3);
  });

  it('keeps a series colour when the input order changes', () => {
    // Colour follows the entity, not its rank: re-sorting must not repaint anything.
    const forward = assignColors([{ pod: 'a' }, { pod: 'b' }, { pod: 'c' }], {});
    const reverse = assignColors([{ pod: 'c' }, { pod: 'b' }, { pod: 'a' }], {});
    expect(reverse).toEqual(forward);
  });

  it('keeps survivors on their colour when a series is filtered out', () => {
    // The freed slot must NOT be back-filled: dropping 'b' has to leave 'c' where it was.
    // This is why the previous assignment is an input — see §1.3.
    const all = assignColors([{ pod: 'a' }, { pod: 'b' }, { pod: 'c' }], {});
    const fewer = assignColors([{ pod: 'a' }, { pod: 'c' }], all);
    expect(fewer[seriesKey({ pod: 'a' })]).toBe(all[seriesKey({ pod: 'a' })]);
    expect(fewer[seriesKey({ pod: 'c' })]).toBe(all[seriesKey({ pod: 'c' })]);
  });

  it('gives a genuinely new series the lowest free slot', () => {
    const prev = { [seriesKey({ pod: 'a' })]: SERIES[1] };
    const next = assignColors([{ pod: 'a' }, { pod: 'z' }], prev);
    expect(next[seriesKey({ pod: 'a' })]).toBe(SERIES[1]);   // retained
    expect(next[seriesKey({ pod: 'z' })]).toBe(SERIES[0]);   // lowest free
  });

  it('carries a filtered-out series forward so its slot stays reserved', () => {
    const all = assignColors([{ pod: 'a' }, { pod: 'b' }], {});
    const fewer = assignColors([{ pod: 'a' }], all);
    expect(fewer[seriesKey({ pod: 'b' })]).toBe(all[seriesKey({ pod: 'b' })]);
  });

  it('folds the ninth series into Other rather than reusing slot 1', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ pod: `p${String(i).padStart(2, '0')}` }));
    const c = assignColors(many, {});
    const used = Object.values(c);
    expect(used.filter((x) => x === OTHER).length).toBe(2);
    expect(used.filter((x) => x === SERIES[0]).length).toBe(1);
  });

  it('uses every slot before folding', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ pod: `p${i}` }));
    expect(new Set(Object.values(assignColors(eight, {})))).toEqual(new Set(SERIES));
  });
});

describe('seriesLabel', () => {
  const fmt = '{{node}} gpu{{gpu}} · {{GPU_I_PROFILE}}';

  it('distinguishes two instances that share a profile', () => {
    // GPU_I_PROFILE alone made id 5 and id 6 read identically on the same chart.
    const a = seriesLabel(fmt, { node: 'a30-node', gpu: '1', GPU_I_PROFILE: '1g.6gb', GPU_I_ID: '5' });
    const b = seriesLabel(fmt, { node: 'a30-node', gpu: '1', GPU_I_PROFILE: '1g.6gb', GPU_I_ID: '6' });
    expect(a).toBe('a30-node gpu1 · 1g.6gb · id 5');
    expect(b).toBe('a30-node gpu1 · 1g.6gb · id 6');
  });

  it('leaves a device series untouched', () => {
    expect(seriesLabel('{{node}} gpu{{gpu}}', { node: 'a30-node', gpu: '0', GPU_I_ID: '' }))
      .toBe('a30-node gpu0');
    expect(seriesLabel('{{node}} gpu{{gpu}}', { node: 'a30-node', gpu: '0' }))
      .toBe('a30-node gpu0');
  });

  it('does not append twice when the format already names the id', () => {
    expect(seriesLabel('gpu{{gpu}} id {{GPU_I_ID}}', { gpu: '1', GPU_I_ID: '5' }))
      .toBe('gpu1 id 5');
  });

  it('falls back to the label set when there is no legend format', () => {
    expect(seriesLabel('', { gpu: '1', GPU_I_ID: '5' })).toBe('1 5 · id 5');
  });
});
