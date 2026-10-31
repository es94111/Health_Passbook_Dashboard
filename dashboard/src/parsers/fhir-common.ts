export type FhirObject = Record<string, unknown>;

export const object = (value: unknown): FhirObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as FhirObject : {};
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export function concept(value: unknown): string {
  const code = object(value);
  return string(code.text) || array(code.coding).map(item => {
    const coding = object(item);
    return string(coding.display) || string(coding.code);
  }).filter(Boolean).join('、');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = object(value);
    return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function sha256(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function fhirDate(...values: unknown[]): Date | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00)))?$/.exec(value);
    if (!match) continue;
    const [, year, month, day] = match;
    const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
    if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() + 1 !== Number(month) || calendar.getUTCDate() !== Number(day)) continue;
    if (Number(year) === 0) continue;
    const date = value.length === 10 ? new Date(`${year}-${month}-${day}T00:00:00`) : new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  return null;
}

export function resourceSource(resource: FhirObject, fullUrl = ''): string {
  const explicit = string(object(resource.meta).source);
  if (explicit) return explicit;
  if (/^https?:\/\//i.test(fullUrl)) {
    return fullUrl.replace(/\/[A-Z][A-Za-z]+\/[^/]+(?:\/_history\/[^/]+)?\/?$/, '');
  }
  return 'NHI-FHIR Bridge';
}

export function referenceIndex(resources: FhirObject[], entries: FhirObject[] = []) {
  const exact = new Map<string, FhirObject>();
  const relative = new Map<string, FhirObject[]>();
  for (const resource of resources) {
    const id = string(resource.id);
    if (!id) continue;
    const key = `${string(resource.resourceType)}/${id}`;
    relative.set(key, [...(relative.get(key) ?? []), resource]);
  }
  for (const entry of entries) {
    const fullUrl = string(entry.fullUrl);
    if (fullUrl) exact.set(fullUrl, object(entry.resource));
  }
  const fullUrls = new Map(entries.map(entry => [entry.resource, string(entry.fullUrl)]));
  const sources = new Map(resources.map(resource => [resource, resourceSource(resource, fullUrls.get(resource))]));
  return (value: unknown, owner?: FhirObject): FhirObject | undefined => {
    const ref = typeof value === 'string' ? value : string(object(value).reference);
    if (!ref) return undefined;
    if (ref.startsWith('#')) return array(owner?.contained).map(object).find(resource => resource.id === ref.slice(1));
    if (exact.has(ref)) return exact.get(ref);
    const key = ref.replace(/\/_history\/[^/]+$/, '');
    const matches = relative.get(key) ?? [];
    if (matches.length === 1) return matches[0];
    const scoped = owner ? matches.filter(resource => sources.get(resource) === sources.get(owner)) : [];
    return scoped.length === 1 ? scoped[0] : undefined;
  };
}
