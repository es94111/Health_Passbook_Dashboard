import { describe, expect, it } from 'vitest';
import {
  emptyPersonal, normalizePersonalData, PERSONAL_LIMITS, PERSONAL_TEXT_LIMITS,
  type LabTarget,
} from '../personalData';
import {
  checkTargetKey, describeTarget, EMPTY_TARGET_FORM, isOutsideTarget, targetToForm,
  validateLabTarget, withoutTarget, withTarget,
} from './labTargets';

function valid(low: string, high: string): LabTarget {
  const result = validateLabTarget({ low, high });
  if (!result.ok) throw new Error(`預期驗證成功，但得到：${result.error}`);
  return result.value;
}

function invalid(low: string, high: string): string {
  const result = validateLabTarget({ low, high });
  if (result.ok) throw new Error('預期驗證失敗');
  return result.error;
}

const targetsOfSize = (size: number): Record<string, LabTarget> =>
  Object.fromEntries(Array.from({ length: size }, (_, index): [string, LabTarget] => [`key-${index}`, { high: index }]));

describe('validateLabTarget', () => {
  it('accepts both bounds', () => {
    expect(valid('70', '99')).toStrictEqual({ low: 70, high: 99 });
  });

  it('accepts a single bound and leaves the other key absent', () => {
    expect(valid('70', '')).toStrictEqual({ low: 70 });
    expect(valid('', '90')).toStrictEqual({ high: 90 });
  });

  it('allows equal bounds', () => {
    expect(valid('5', '5')).toStrictEqual({ low: 5, high: 5 });
  });

  it('trims surrounding whitespace', () => {
    expect(valid('  70 ', ' 99\t')).toStrictEqual({ low: 70, high: 99 });
    expect(valid('   ', '90')).toStrictEqual({ high: 90 });
  });

  it('accepts full-width digits, point and minus typed with a Chinese IME', () => {
    expect(valid('７０', '９９')).toStrictEqual({ low: 70, high: 99 });
    expect(valid('５．５', '')).toStrictEqual({ low: 5.5 });
    expect(valid('－３', '２')).toStrictEqual({ low: -3, high: 2 });
  });

  it('accepts negatives, decimals and zero', () => {
    expect(valid('-1.5', '2.25')).toStrictEqual({ low: -1.5, high: 2.25 });
    expect(valid('0', '')).toStrictEqual({ low: 0 });
    expect(valid('0.123456', '')).toStrictEqual({ low: 0.123456 });
  });

  it('normalizes negative zero', () => {
    const target = valid('-0', '-0.0');
    expect(Object.is(target.low, 0)).toBe(true);
    expect(Object.is(target.high, 0)).toBe(true);
  });

  it('accepts the exact limits', () => {
    expect(valid('-1000000000', '1000000000')).toStrictEqual({ low: -1e9, high: 1e9 });
  });

  it('requires at least one bound', () => {
    expect(invalid('', '')).toBe('請至少填寫下限或上限');
    expect(invalid('  ', '\t')).toBe('請至少填寫下限或上限');
  });

  it('rejects a lower bound above the upper bound', () => {
    expect(invalid('100', '90')).toBe('下限不可大於上限');
    expect(invalid('-1', '-2')).toBe('下限不可大於上限');
  });

  it.each(['abc', '0x10', '1e3', 'Infinity', 'NaN', '.5', '1.', '--1', '+5', '1,000', '1 000', '5%', '1.2.3'])(
    'rejects %j as a lower bound and names the field',
    garbage => {
      expect(invalid(garbage, '')).toContain('下限');
      expect(invalid('', garbage)).toContain('上限');
    },
  );

  it('rejects more than 6 decimals so the form can round-trip', () => {
    expect(invalid('0.1234567', '')).toContain('6 位小數');
    expect(invalid('', '1.0000001')).toContain('6 位小數');
  });

  it('rejects values beyond the supported range', () => {
    expect(invalid('1000000001', '')).toContain('1,000,000,000');
    expect(invalid('', '-1000000001')).toContain('上限');
    expect(invalid('9'.repeat(400), '')).toContain('下限');
  });

  it('reports the lower bound problem before the upper bound problem', () => {
    expect(invalid('abc', 'xyz')).toContain('下限');
  });

  it('reports an upper bound problem even when the lower bound is valid', () => {
    expect(invalid('70', 'abc')).toContain('上限');
  });
});

describe('targetToForm', () => {
  it('returns empty fields without a target', () => {
    expect(targetToForm()).toStrictEqual(EMPTY_TARGET_FORM);
    expect(targetToForm(undefined)).toStrictEqual({ low: '', high: '' });
  });

  it('fills only the bounds that exist', () => {
    expect(targetToForm({ low: 70 })).toStrictEqual({ low: '70', high: '' });
    expect(targetToForm({ high: 5.5 })).toStrictEqual({ low: '', high: '5.5' });
    expect(targetToForm({ low: 0, high: 0 })).toStrictEqual({ low: '0', high: '0' });
  });

  it.each<LabTarget>([
    { low: 0.000001 }, { low: 5.5, high: 5.5 }, { high: 1e9 }, { low: -3 }, { low: -1e9, high: 1e9 },
    { low: 0, high: 0 }, { high: 0.1 }, { low: 999999999.999999 }, { low: 123456.654321, high: 123456.654322 },
  ])('round-trips %j through the form', target => {
    const result = validateLabTarget(targetToForm(target));
    expect(result).toStrictEqual({ ok: true, value: target });
  });
});

describe('describeTarget', () => {
  it('uses the same notation as lab reference ranges', () => {
    expect(describeTarget({ high: 90 })).toBe('≤ 90');
    expect(describeTarget({ low: 70 })).toBe('≥ 70');
    expect(describeTarget({ low: 70, high: 90 })).toBe('70–90');
    expect(describeTarget({ low: 0, high: 0 })).toBe('0–0');
  });
});

describe('isOutsideTarget', () => {
  const both: LabTarget = { low: 70, high: 90 };

  it('treats the boundaries as inside', () => {
    expect(isOutsideTarget(70, both)).toBe(false);
    expect(isOutsideTarget(90, both)).toBe(false);
    expect(isOutsideTarget(80, both)).toBe(false);
  });

  it('flags values beyond either bound', () => {
    expect(isOutsideTarget(69.99, both)).toBe(true);
    expect(isOutsideTarget(90.01, both)).toBe(true);
  });

  it('ignores the missing side of a one-sided target', () => {
    expect(isOutsideTarget(100, { high: 90 })).toBe(true);
    expect(isOutsideTarget(-1000, { high: 90 })).toBe(false);
    expect(isOutsideTarget(60, { low: 70 })).toBe(true);
    expect(isOutsideTarget(1000, { low: 70 })).toBe(false);
  });
});

describe('checkTargetKey', () => {
  it('accepts an ordinary key', () => {
    expect(checkTargetKey({}, 'lab-series:["code","x"]')).toBeNull();
  });

  it('rejects empty and overlong keys', () => {
    expect(checkTargetKey({}, '')).toContain('識別碼');
    expect(checkTargetKey({}, 'k'.repeat(PERSONAL_TEXT_LIMITS.key + 1))).toContain('識別碼');
    expect(checkTargetKey({}, 'k'.repeat(PERSONAL_TEXT_LIMITS.key))).toBeNull();
  });

  it('refuses a new key once the limit is reached', () => {
    const full = targetsOfSize(PERSONAL_LIMITS.targets);
    expect(checkTargetKey(full, 'brand-new')).toBe(`個人目標已達上限（${PERSONAL_LIMITS.targets} 項）`);
  });

  it('still allows editing an existing key at the limit', () => {
    expect(checkTargetKey(targetsOfSize(PERSONAL_LIMITS.targets), 'key-7')).toBeNull();
  });

  it('allows a new key just below the limit', () => {
    expect(checkTargetKey(targetsOfSize(PERSONAL_LIMITS.targets - 1), 'brand-new')).toBeNull();
  });

  it('does not mistake inherited property names for existing keys', () => {
    expect(checkTargetKey({}, 'constructor')).toBeNull();
    expect(checkTargetKey(targetsOfSize(PERSONAL_LIMITS.targets), 'constructor')).toContain('已達上限');
    expect(checkTargetKey(targetsOfSize(PERSONAL_LIMITS.targets), 'toString')).toContain('已達上限');
  });
});

describe('withTarget / withoutTarget', () => {
  const KEY = 'lab-series:["code","loinc|2345-7"]';

  it('adds a target without mutating the input', () => {
    const before = emptyPersonal();
    const after = withTarget(before, KEY, { high: 90 });
    expect(before.targets).toStrictEqual({});
    expect(after.targets).toStrictEqual({ [KEY]: { high: 90 } });
    expect(after).not.toBe(before);
  });

  it('keeps the other personal sections by reference', () => {
    const before = emptyPersonal();
    const after = withTarget(before, KEY, { low: 1 });
    expect(after.measurements).toBe(before.measurements);
    expect(after.notes).toBe(before.notes);
    expect(after.profile).toBe(before.profile);
    expect(after.refills).toBe(before.refills);
    expect(after.version).toBe(before.version);
  });

  it('replaces an existing target and keeps the other targets', () => {
    const before = { ...emptyPersonal(), targets: { a: { high: 1 }, [KEY]: { high: 90 } } };
    const after = withTarget(before, KEY, { low: 70 });
    expect(after.targets).toStrictEqual({ a: { high: 1 }, [KEY]: { low: 70 } });
    expect(before.targets[KEY]).toStrictEqual({ high: 90 });
  });

  it('removes only the requested target without mutating the input', () => {
    const before = { ...emptyPersonal(), targets: { a: { high: 1 }, [KEY]: { high: 90 } } };
    const after = withoutTarget(before, KEY);
    expect(after.targets).toStrictEqual({ a: { high: 1 } });
    expect(Object.keys(before.targets)).toEqual(['a', KEY]);
  });

  it('leaves the data equivalent when removing a missing target', () => {
    const before = { ...emptyPersonal(), targets: { a: { high: 1 } } };
    expect(withoutTarget(before, 'missing').targets).toStrictEqual({ a: { high: 1 } });
  });

  it('stores a "__proto__" key as plain data', () => {
    const after = withTarget(emptyPersonal(), '__proto__', { high: 1 });
    expect(Object.hasOwn(after.targets, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(after.targets)).toBe(Object.prototype);
    expect(Object.keys(withoutTarget(after, '__proto__').targets)).toEqual([]);
  });

  it('produces data that survives the vault validation after a JSON round trip', () => {
    const personal = withTarget(withTarget(emptyPersonal(), KEY, { low: 70, high: 90 }), 'lab-series:["name","B"]', { low: -0.5 });
    const restored = normalizePersonalData(JSON.parse(JSON.stringify(personal)));
    expect(restored.targets).toStrictEqual({ [KEY]: { low: 70, high: 90 }, 'lab-series:["name","B"]': { low: -0.5 } });
  });
});
