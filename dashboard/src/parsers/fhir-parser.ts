import type { CheckupReport, Hospitalization, LabResult, MedicalAttachment, MedicalReport, MedicationRecord, NHIData, Vaccination, Visit } from './types';

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const concept = (value: unknown): string => {
  const c = obj(value);
  return str(c.text) || arr(c.coding).map(item => str(obj(item).display) || str(obj(item).code)).find(Boolean) || '';
};
const dateValue = (...candidates: unknown[]): Date | null => {
  for (const value of candidates) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) continue;
    const d = new Date(value);
    if (Number.isFinite(d.getTime())) return d;
  }
  return null;
};
const facility = (resource: Obj): string => {
  const performer = arr(resource.performer).map(item => str(obj(item).display)).find(Boolean);
  return str(obj(resource.serviceProvider).display) || performer || str(obj(resource.location).display) || '';
};
const refName = (reference: unknown): string => str(obj(reference).reference).split('/').pop() || '';
const quantityNumber = (value: unknown): number | null => {
  const number = obj(value).value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
};
const normalizeAttachment = (raw: unknown) => {
  const attachment = obj(raw);
  const contentType = str(attachment.contentType).toLowerCase().split(';')[0];
  const data = str(attachment.data);
  // Never trust external URLs or untrusted MIME types as embeddable content.
  if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(contentType)) return null;
  if (!data || !/^[a-zA-Z0-9+/]*={0,2}$/.test(data) || data.length > 12 * 1024 * 1024) return null;
  return { title: str(attachment.title) || '附件', contentType: contentType as MedicalAttachment['contentType'], data };
};

export function isFhirBundle(value: unknown): value is { resourceType: 'Bundle'; entry: unknown[] } {
  const root = obj(value);
  return root.resourceType === 'Bundle' && Array.isArray(root.entry);
}

export function readFhirBundleResources(bundle: unknown): Obj[] {
  if (!isFhirBundle(bundle)) throw new Error('不是有效的 FHIR R4 Bundle（需要 resourceType=Bundle 與 entry 陣列）');
  if (bundle.entry.length > 100_000) throw new Error('FHIR 資源數量超過上限');
  const resources = bundle.entry.map(e => obj(obj(e).resource))
    .filter(r => typeof r.resourceType === 'string' && str(r.resourceType).length > 0);
  if (!resources.length) throw new Error('FHIR Bundle 沒有可匯入的資源');
  const patients = resources.filter(r => r.resourceType === 'Patient');
  const uniquePatients = new Set(patients.map(p => str(p.id) || JSON.stringify(p.identifier ?? [])));
  if (uniquePatients.size > 1) throw new Error('FHIR Bundle 包含多位病人，為避免混合病歷請分開匯入');
  return resources;
}

export function parseFhirResources(resources: Obj[]): Pick<NHIData, 'visits' | 'hospitalizations' | 'vaccinations' | 'labResults' | 'checkupReports' | 'medicalReports' | 'medications'> {
  const visits: Visit[] = [];
  const hospitalizations: Hospitalization[] = [];
  const vaccinations: Vaccination[] = [];
  const labResults: LabResult[] = [];
  const checkupReports: CheckupReport[] = [];
  const medicalReports: MedicalReport[] = [];
  const medications: MedicationRecord[] = [];
  const conditions = new Map(resources.filter(r => r.resourceType === 'Condition' && str(r.id))
    .map(r => [str(r.id), r]));
  const encounters = new Map(resources.filter(r => r.resourceType === 'Encounter' && str(r.id))
    .map(r => [str(r.id), r]));
  const getFacility = (r: Obj): string => facility(r) ||
    facility(encounters.get(refName(r.encounter)) ?? {}) || '未提供院所';
  const report = (r: Obj, title: string, text: string, date: Date, attachments: MedicalReport['attachments'] = []) => {
    medicalReports.push({ date, hospital: getFacility(r), title, text, attachments });
  };

  for (const resource of resources) {
    const type = str(resource.resourceType);
    if (type === 'Encounter') {
      const period = obj(resource.period);
      const start = dateValue(period.start);
      if (!start) continue;
      const visitDiagnoses = arr(resource.diagnosis).map(item => conditions.get(refName(obj(item).condition)))
        .filter((r): r is Obj => !!r).map(r => ({
          code: str(obj(arr(obj(r.code).coding)[0]).code),
          name: concept(r.code),
        }));
      const inpatient = ['imp', 'inpatient'].includes(str(obj(resource.class).code).toLowerCase()) ||
        concept(resource.type).toLowerCase().includes('住院');
      if (inpatient) {
        hospitalizations.push({ admitDate: start, dischargeDate: dateValue(period.end) ?? start,
          hospital: getFacility(resource), diagnoses: visitDiagnoses });
      } else {
        visits.push({ date: start, hospital: getFacility(resource), diagnoses: visitDiagnoses, procedures: [] });
      }
    }

    if (type === 'Observation') {
      const date = dateValue(resource.effectiveDateTime, obj(resource.effectivePeriod).start, resource.issued);
      if (!date) continue;
      const title = concept(resource.code) || '檢驗項目';
      const category = arr(resource.category).map(concept).filter(Boolean).join('、') || 'FHIR';
      const components = arr(resource.component).map(obj);
      const measurements = components.length ? components : [resource];
      for (const item of measurements) {
        const value = quantityNumber(item.valueQuantity);
        const label = item === resource ? title : concept(item.code) || title;
        if (value !== null) {
          const range = obj(arr(item.referenceRange)[0] ?? arr(resource.referenceRange)[0]);
          labResults.push({
            date, hospital: getFacility(resource), testGroup: category, subItem: label,
            value, refLow: quantityNumber(range.low), refHigh: quantityNumber(range.high),
            unit: str(obj(item.valueQuantity).unit) || str(obj(item.valueQuantity).code) || undefined,
          });
        } else {
          const detail = str(item.valueString) || concept(item.valueCodeableConcept) ||
            (typeof item.valueBoolean === 'boolean' ? String(item.valueBoolean) : '');
          if (detail) report(resource, label, detail, date);
        }
      }
    }

    if (type === 'DiagnosticReport' || type === 'DocumentReference' || type === 'ImagingStudy') {
      const date = dateValue(resource.effectiveDateTime, obj(resource.effectivePeriod).start,
        resource.issued, resource.date, resource.created, resource.started);
      if (!date) continue;
      const title = concept(resource.code) || str(resource.description) || str(resource.title) || type;
      const narrative = str(resource.conclusion) || str(resource.description) ||
        str(obj(resource.text).div).replace(/<[^>]*>/g, '');
      const rawAttachments = type === 'DiagnosticReport' ? arr(resource.presentedForm)
        : type === 'DocumentReference' ? arr(resource.content).map(x => obj(x).attachment) : [];
      const attachments = rawAttachments.map(normalizeAttachment)
        .filter((a): a is NonNullable<typeof a> => a !== null);
      report(resource, title, narrative, date, attachments);
    }

    if (type === 'Immunization') {
      const date = dateValue(resource.occurrenceDateTime, resource.recorded);
      if (date) vaccinations.push({ date, vaccine: concept(resource.vaccineCode) || '疫苗',
        location: str(obj(resource.location).display) || getFacility(resource) });
    }

    if (type === 'MedicationRequest' || type === 'MedicationStatement' || type === 'MedicationDispense') {
      const date = dateValue(resource.authoredOn, resource.effectiveDateTime,
        obj(resource.effectivePeriod).start, resource.whenHandedOver, resource.whenPrepared);
      if (!date) continue;
      const medication = concept(resource.medicationCodeableConcept) ||
        str(obj(resource.medicationReference).display) || '未命名藥品';
      const dosage = arr(resource.dosageInstruction).map(x => str(obj(x).text)).filter(Boolean).join('；') ||
        str(obj(resource.dosage).text);
      medications.push({ date, hospital: getFacility(resource), name: medication, dosage,
        status: str(resource.status), source: type });
    }
  }
  return { visits, hospitalizations, vaccinations, labResults, checkupReports, medicalReports, medications };
}
