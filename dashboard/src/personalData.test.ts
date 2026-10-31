import { describe, expect, it } from 'vitest';
import { decryptRecords, encryptRecords } from './cryptoVault';
import { emptyPersonal, isPersonalEmpty, normalizePersonalData, PERSONAL_LIMITS, PERSONAL_TEXT_LIMITS, type PersonalData } from './personalData';
import { mergeNHIJson } from './recordImport';
import { emptyRecords, flattenRecords, normalizeStoredRecords } from './recordStore';
import { syntheticNhi } from './test/fixtures';

const passphrase = 'synthetic-passphrase-only';
const damaged = (what: string) => `加密個人資料已損壞：${what}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const sample = (): PersonalData => ({
  version: 1,
  targets: { 'lab-series:["a"]': { low: 4, high: 5.6 } },
  measurements: [
    { id: 'm1', date: '2026-03-01', kind: 'glucose', value: 98, context: 'fasting' },
    { id: 'm3', date: '2026-03-02', time: '07:00', kind: 'weight', value: 65.4 },
    { id: 'm2', date: '2026-03-02', time: '08:30', note: '早晨', kind: 'bp', systolic: 128, diastolic: 82, pulse: 70 },
  ],
  notes: [
    { id: 'n2', date: '2026-03-04', kind: 'note', text: '回診前空腹' },
    { id: 'n1', date: '2026-03-05', kind: 'question', text: '詢問藥物副作用', done: true },
  ],
  profile: {
    allergies: [{ id: 'a1', name: '青黴素', reaction: '皮疹', severity: 'severe' }],
    conditions: [{ id: 'c1', name: '高血壓', sinceYear: 2019 }],
  },
  refills: [{ id: 'r1', drugName: '降血壓藥', drugCode: 'AB12345', hospital: '示範醫院', prescribedDate: '2026-01-10', daysPerFill: 28, fills: 3, taken: 2, note: '連續處方' }],
});

const base = { version: 1 };
const many = <T>(count: number, make: (index: number) => T): T[] => Array.from({ length: count }, (_, index) => make(index));
const target = (value: unknown, key = 'lab-series:["a"]') => ({ ...base, targets: { [key]: value } });
const measurement = (patch: Record<string, unknown>) => ({ ...base, measurements: [{ id: 'm1', date: '2026-03-01', kind: 'weight', value: 60, ...patch }] });
const note = (patch: Record<string, unknown>) => ({ ...base, notes: [{ id: 'n1', date: '2026-03-01', kind: 'note', text: '備忘', ...patch }] });
const allergy = (patch: Record<string, unknown>) => ({ ...base, profile: { allergies: [{ id: 'a1', name: '花生', ...patch }] } });
const condition = (patch: Record<string, unknown>) => ({ ...base, profile: { conditions: [{ id: 'c1', name: '高血壓', ...patch }] } });
const refill = (patch: Record<string, unknown>) => ({ ...base, refills: [{ id: 'r1', drugName: '降血壓藥', prescribedDate: '2026-01-10', daysPerFill: 28, fills: 3, taken: 1, ...patch }] });

describe('normalizePersonalData', () => {
  it('turns missing data into a fresh empty record', () => {
    expect(normalizePersonalData(undefined)).toEqual(emptyPersonal());
    expect(normalizePersonalData(null)).toEqual(emptyPersonal());
    expect(normalizePersonalData({ version: 1 })).toEqual(emptyPersonal());
    expect(normalizePersonalData({ version: 1, profile: {} })).toEqual(emptyPersonal());
    const first = emptyPersonal();
    const second = emptyPersonal();
    expect(first).not.toBe(second);
    expect(first.measurements).not.toBe(second.measurements);
    expect(first.profile.allergies).not.toBe(second.profile.allergies);
    expect(first.targets).not.toBe(second.targets);
  });

  it('knows whether anything has been entered', () => {
    const { targets, measurements, notes, profile, refills } = sample();
    expect(isPersonalEmpty(emptyPersonal())).toBe(true);
    expect(isPersonalEmpty(sample())).toBe(false);
    const single: PersonalData[] = [
      { ...emptyPersonal(), targets },
      { ...emptyPersonal(), measurements },
      { ...emptyPersonal(), notes },
      { ...emptyPersonal(), profile: { allergies: profile.allergies, conditions: [] } },
      { ...emptyPersonal(), profile: { allergies: [], conditions: profile.conditions } },
      { ...emptyPersonal(), refills },
    ];
    for (const item of single) expect(isPersonalEmpty(item)).toBe(false);
  });

  it('is idempotent and byte-stable across a JSON round trip', () => {
    const once = normalizePersonalData(sample());
    expect(once).toEqual(sample());
    const again = normalizePersonalData(clone(once));
    expect(again).toEqual(once);
    expect(JSON.stringify(again)).toBe(JSON.stringify(once));
  });

  it('does not mutate its input', () => {
    const input = sample();
    input.measurements.reverse();
    const before = clone(input);
    normalizePersonalData(input);
    expect(input).toEqual(before);
  });

  it('orders measurements and notes by date, time, then id', () => {
    const shuffled = sample();
    shuffled.measurements.reverse();
    shuffled.notes.reverse();
    const result = normalizePersonalData(shuffled);
    expect(result.measurements.map(item => item.id)).toEqual(['m1', 'm3', 'm2']);
    expect(result.notes.map(item => item.id)).toEqual(['n2', 'n1']);

    const ties = normalizePersonalData({
      version: 1,
      measurements: [
        { id: 'b', date: '2026-03-01', time: '08:00', kind: 'weight', value: 60 },
        { id: 'a', date: '2026-03-01', time: '08:00', kind: 'weight', value: 61 },
        { id: 'z', date: '2026-03-01', kind: 'weight', value: 62 },
      ],
    });
    expect(ties.measurements.map(item => item.id)).toEqual(['z', 'a', 'b']);
  });

  it('keeps the entered order of allergies, conditions and refill plans', () => {
    const result = normalizePersonalData({
      version: 1,
      profile: {
        allergies: [{ id: 'a2', name: '蝦' }, { id: 'a1', name: '花生' }],
        conditions: [{ id: 'c2', name: '糖尿病' }, { id: 'c1', name: '高血壓' }],
      },
      refills: [
        { id: 'r2', drugName: 'B', prescribedDate: '2026-02-01', daysPerFill: 28, fills: 3, taken: 1 },
        { id: 'r1', drugName: 'A', prescribedDate: '2026-01-01', daysPerFill: 28, fills: 3, taken: 1 },
      ],
    });
    expect(result.profile.allergies.map(item => item.id)).toEqual(['a2', 'a1']);
    expect(result.profile.conditions.map(item => item.id)).toEqual(['c2', 'c1']);
    expect(result.refills.map(item => item.id)).toEqual(['r2', 'r1']);
  });

  it('trims text and drops blank optional fields', () => {
    const result = normalizePersonalData({
      version: 1,
      profile: {
        allergies: [{ id: 'a1', name: '  花生  ', reaction: '   ', severity: null }],
        conditions: [{ id: 'c1', name: ' 糖尿病 ', sinceYear: null }],
      },
      measurements: [{ id: 'm1', date: '2026-03-01', time: '', note: '  ', kind: 'weight', value: 60 }],
      notes: [{ id: 'n1', date: '2026-03-01', kind: 'note', text: ' 記得帶健保卡 ', done: false }],
    });
    expect(Object.keys(result.profile.allergies[0])).toEqual(['id', 'name']);
    expect(result.profile.allergies[0].name).toBe('花生');
    expect(Object.keys(result.profile.conditions[0])).toEqual(['id', 'name']);
    expect(Object.keys(result.measurements[0])).toEqual(['id', 'date', 'kind', 'value']);
    expect(Object.keys(result.notes[0])).toEqual(['id', 'date', 'kind', 'text']);
    expect(result.notes[0].text).toBe('記得帶健保卡');
  });

  it('keeps a __proto__ target key as plain data', () => {
    const result = normalizePersonalData({ version: 1, targets: JSON.parse('{"__proto__":{"low":1}}') });
    expect(Object.keys(result.targets)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(result.targets)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result.targets, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).low).toBeUndefined();
  });

  it('allows the same id in different collections but not within one', () => {
    const result = normalizePersonalData({
      version: 1,
      measurements: [{ id: 'x', date: '2026-03-01', kind: 'weight', value: 60 }],
      notes: [{ id: 'x', date: '2026-03-01', kind: 'note', text: '備忘' }],
      profile: { allergies: [{ id: 'x', name: '花生' }], conditions: [{ id: 'x', name: '高血壓' }] },
      refills: [{ id: 'x', drugName: '藥', prescribedDate: '2026-01-01', daysPerFill: 28, fills: 1, taken: 1 }],
    });
    expect(result.measurements).toHaveLength(1);
    expect(result.notes).toHaveLength(1);
    expect(result.profile.allergies).toHaveLength(1);
    expect(result.profile.conditions).toHaveLength(1);
    expect(result.refills).toHaveLength(1);
  });

  it('accepts values on the documented boundaries', () => {
    const result = normalizePersonalData({
      version: 1,
      targets: { a: { low: -1e9 }, b: { high: 1e9 }, c: { low: 5, high: 5 } },
      measurements: [
        { id: 'a', date: '1900-01-01', time: '00:00', kind: 'bp', systolic: 30, diastolic: 10, pulse: 20 },
        { id: 'b', date: '2024-02-29', time: '23:59', kind: 'bp', systolic: 300, diastolic: 200, pulse: 300 },
        { id: 'c', date: '2024-02-29', kind: 'glucose', value: 10, context: 'random' },
        { id: 'd', date: '2024-02-29', kind: 'glucose', value: 1500, context: 'postMeal' },
        { id: 'e', date: '2024-02-29', kind: 'weight', value: 1 },
        { id: 'f', date: '2024-02-29', kind: 'weight', value: 500 },
      ],
      profile: { allergies: [], conditions: [{ id: 'c1', name: 'x', sinceYear: 1900 }, { id: 'c2', name: 'y', sinceYear: 2200 }] },
      refills: [{ id: 'r1', drugName: '藥', prescribedDate: '2026-01-01', daysPerFill: 180, fills: 12, taken: 12 }],
    });
    expect(Object.keys(result.targets)).toEqual(['a', 'b', 'c']);
    expect(result.measurements).toHaveLength(6);
    expect(result.profile.conditions).toHaveLength(2);
    expect(result.refills[0]).toMatchObject({ daysPerFill: 180, fills: 12, taken: 12 });
  });

  it.each<[string, unknown, string]>([
    ['an array root', [], '資料結構'],
    ['a string root', 'text', '資料結構'],
    ['a missing version', {}, '版本不支援'],
    ['a future version', { version: 2 }, '版本不支援'],
    ['a profile that is not an object', { ...base, profile: [] }, '健康檔案'],
    ['null measurements', { ...base, measurements: null }, '量測紀錄'],
    ['targets that are not an object', { ...base, targets: 'x' }, '追蹤目標'],
    ['a target that is not an object', target(5), '追蹤目標'],
    ['an empty target', target({}), '追蹤目標範圍'],
    ['an inverted target', target({ low: 5, high: 4 }), '追蹤目標範圍'],
    ['a non-numeric lower bound', target({ low: 'x' }), '目標下限'],
    ['a non-numeric upper bound', target({ high: 'x' }), '目標上限'],
    ['an empty target key', target({ low: 1 }, ''), '追蹤目標名稱'],
    ['an oversized target key', target({ low: 1 }, 'k'.repeat(PERSONAL_TEXT_LIMITS.key + 1)), '追蹤目標名稱'],
    ['too many targets', { ...base, targets: Object.fromEntries(many(PERSONAL_LIMITS.targets + 1, index => [`k${index}`, { low: 1 }] as const)) }, '追蹤目標數量'],
    ['an unknown measurement kind', measurement({ kind: 'steps' }), '量測類型'],
    ['a non-existent calendar day', measurement({ date: '2026-02-30' }), '量測日期'],
    ['a date before 1900', measurement({ date: '1899-12-31' }), '量測日期'],
    ['a date without zero padding', measurement({ date: '2026-3-1' }), '量測日期'],
    ['a 24:00 time', measurement({ time: '24:00' }), '量測時間'],
    ['an invalid measurement id', measurement({ id: 'a b' }), '量測編號'],
    ['an empty measurement id', measurement({ id: '' }), '量測編號'],
    ['an oversized measurement note', measurement({ note: 'n'.repeat(301) }), '量測備註'],
    ['a duplicate measurement id', { ...base, measurements: many(2, () => ({ id: 'dup', date: '2026-03-01', kind: 'weight', value: 60 })) }, '量測編號'],
    ['a systolic pressure out of range', measurement({ kind: 'bp', systolic: 400, diastolic: 80 }), '收縮壓'],
    ['a diastolic pressure out of range', measurement({ kind: 'bp', systolic: 120, diastolic: 5 }), '舒張壓'],
    ['a pulse out of range', measurement({ kind: 'bp', systolic: 120, diastolic: 80, pulse: 400 }), '脈搏'],
    ['a glucose value out of range', measurement({ kind: 'glucose', value: 5, context: 'fasting' }), '血糖'],
    ['an unknown glucose context', measurement({ kind: 'glucose', value: 90, context: 'bedtime' }), '血糖情境'],
    ['a zero weight', measurement({ value: 0 }), '體重'],
    ['a weight above 500', measurement({ value: 501 }), '體重'],
    ['more notes than allowed', { ...base, notes: many(PERSONAL_LIMITS.notes + 1, index => ({ id: `n${index}`, date: '2026-03-01', kind: 'note', text: 't' })) }, '備忘'],
    ['a non-boolean done flag', note({ done: 'yes' }), '備忘狀態'],
    ['an unknown note kind', note({ kind: 'todo' }), '備忘類型'],
    ['blank note text', note({ text: '  ' }), '備忘內容'],
    ['an invalid note date', note({ date: '2026-13-01' }), '備忘日期'],
    ['allergies that are not a list', { ...base, profile: { allergies: {} } }, '過敏史'],
    ['a blank allergen', allergy({ name: ' ' }), '過敏原'],
    ['an unknown allergy severity', allergy({ severity: 'critical' }), '過敏嚴重度'],
    ['a blank condition name', condition({ name: '' }), '病名'],
    ['a diagnosis year before 1900', condition({ sinceYear: 1800 }), '確診年份'],
    ['a fractional diagnosis year', condition({ sinceYear: 2019.5 }), '確診年份'],
    ['a blank drug name', refill({ drugName: ' ' }), '藥品名稱'],
    ['an oversized drug code', refill({ drugCode: 'A'.repeat(41) }), '藥品代碼'],
    ['an invalid prescription date', refill({ prescribedDate: '2026-02-30' }), '處方日期'],
    ['zero days per fill', refill({ daysPerFill: 0 }), '每次給藥天數'],
    ['fractional days per fill', refill({ daysPerFill: 1.5 }), '每次給藥天數'],
    ['more fills than a continuous prescription allows', refill({ fills: 13 }), '領藥總次數'],
    ['no fills taken', refill({ taken: 0 }), '已領藥次數'],
    ['more fills taken than planned', refill({ fills: 3, taken: 4 }), '已領藥次數'],
  ])('rejects %s', (_name, input, what) => {
    expect(() => normalizePersonalData(input)).toThrow(damaged(what));
  });
});

describe('personal data in the encrypted vault', () => {
  const limits = { inlineBytes: 2048, shardBytes: 1024 };
  const withPersonal = (personal: PersonalData) => ({
    ...normalizeStoredRecords({ r1: Object.fromEntries(many(12, index => [`r1.${index}`, { 'r1.1': `synthetic-${index}`, 'r1.4': 'y'.repeat(300) }] as const)) }),
    personal,
  });
  const collect = () => {
    const shards = new Map<string, Uint8Array<ArrayBuffer>>();
    let uploads = 0;
    const uploadShard = async ({ id, bytes }: { id: string; bytes: Uint8Array<ArrayBuffer> }) => { uploads += 1; shards.set(id, bytes); };
    return { shards, count: () => uploads, uploadShard };
  };

  it('survives an inline encrypt and decrypt without exposing plaintext', async () => {
    const records = { ...emptyRecords(), personal: sample() };
    const encrypted = await encryptRecords(records, passphrase);
    const serialized = JSON.stringify(encrypted);
    for (const secret of ['青黴素', '降血壓藥', '高血壓', '詢問藥物副作用', 'glucose', 'fasting', 'measurements']) expect(serialized).not.toContain(secret);
    const restored = await decryptRecords(JSON.parse(serialized), passphrase);
    expect(restored.personal).toEqual(sample());
    expect(restored).toEqual(records);
  });

  it('survives sharded storage and only re-uploads the trailing shards when personal data changes', async () => {
    const first = withPersonal(sample());
    const store = collect();
    const envelope = await encryptRecords(first, passphrase, null, { limits, uploadShard: store.uploadShard });
    expect(store.shards.size).toBeGreaterThan(2);
    const restored = await decryptRecords(JSON.parse(JSON.stringify(envelope)), passphrase, async shard => store.shards.get(shard.id)!);
    expect(restored).toEqual(first);

    const unchanged = collect();
    await encryptRecords(first, passphrase, envelope, { limits, uploadShard: unchanged.uploadShard });
    expect(unchanged.count()).toBe(0);

    const edited = sample();
    edited.notes.push({ id: 'n3', date: '2026-03-06', kind: 'note', text: '新增備忘' });
    const changed = withPersonal(normalizePersonalData(edited));
    const next = collect();
    const second = await encryptRecords(changed, passphrase, envelope, { limits, uploadShard: next.uploadShard });
    expect(next.count()).toBeGreaterThan(0);
    expect(next.count()).toBeLessThanOrEqual(2);
    expect(next.count()).toBeLessThan(store.shards.size);
    const everything = new Map([...store.shards, ...next.shards]);
    const reopened = await decryptRecords(JSON.parse(JSON.stringify(second)), passphrase, async shard => everything.get(shard.id)!);
    expect(reopened).toEqual(changed);
    expect(reopened.personal.notes).toHaveLength(3);
  });

  it('loads stores saved before personal data existed as empty', async () => {
    const legacy = clone(normalizeStoredRecords({ r1: { old: { 'r1.4': 'synthetic' } } })) as unknown as Record<string, unknown>;
    delete legacy.personal;
    const records = normalizeStoredRecords(legacy);
    expect(records.personal).toEqual(emptyPersonal());
    const restored = await decryptRecords(await encryptRecords(records, passphrase), passphrase);
    expect(restored.personal).toEqual(emptyPersonal());
    expect(restored.r1).toEqual(records.r1);
  });

  it('refuses a damaged personal section instead of silently dropping it', () => {
    expect(() => normalizeStoredRecords({ personal: { version: 9 } })).toThrow(damaged('版本不支援'));
    expect(() => normalizeStoredRecords({ personal: 'broken' })).toThrow(damaged('資料結構'));
  });

  it('keeps personal data when new health records are imported', async () => {
    const previous = { ...emptyRecords(), personal: sample() };
    const merged = await mergeNHIJson(previous, syntheticNhi, { confirmPatient: true });
    expect(Object.keys(merged.records.r1)).toHaveLength(1);
    expect(merged.records.personal).toEqual(sample());
    expect(previous.personal).toEqual(sample());
  });

  it('is not exposed through the flattened parser input', () => {
    const flat = flattenRecords({ ...emptyRecords(), personal: sample() });
    expect(flat).not.toHaveProperty('personal');
    expect(JSON.stringify(flat)).not.toContain('青黴素');
  });
});
