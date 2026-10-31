import type { Hospitalization, ImagingDetails, ImagingSeries, LabResult, MedicalReport, MedicationRecord, NHIData, RecordOrigin, TextLabResult, Vaccination, Visit } from './types';
import { array, canonicalJson, concept, fhirDate, object, referenceIndex, resourceSource, string, type FhirObject } from './fhir-common';
import { normalizeMedicalAttachment } from '../medicalAttachments';

type ClinicalData = Pick<NHIData, 'visits' | 'hospitalizations' | 'vaccinations' | 'labResults' | 'textLabResults' | 'checkupReports' | 'medicalReports' | 'medications'>;

export function isFhirBundle(value: unknown): value is FhirObject & { resourceType: 'Bundle'; entry: unknown[] } {
  return object(value).resourceType === 'Bundle' && Array.isArray(object(value).entry);
}

export function patientIdentifiers(patient: FhirObject): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const item of array(patient.identifier)) {
    const identifier = object(item);
    const system = string(identifier.system);
    const value = string(identifier.value);
    if (!system || !value || identifier.use === 'old' || identifier.use === 'temp') continue;
    result.set(system, new Set([...(result.get(system) ?? []), value]));
  }
  return result;
}

export function comparePatients(left: FhirObject, right: FhirObject): 'same' | 'different' | 'unknown' {
  const previous = patientIdentifiers(left);
  const incoming = patientIdentifiers(right);
  let shared = false;
  for (const [system, values] of incoming) {
    const old = previous.get(system);
    if (!old) continue;
    if (![...values].some(value => old.has(value))) return 'different';
    shared = true;
  }
  // Resource.id is a local reference, not an authoritative person identifier.
  return shared ? 'same' : 'unknown';
}

export function readFhirBundleResources(value: unknown): FhirObject[] {
  if (!isFhirBundle(value)) throw new Error('不是有效的 FHIR R4 Bundle（需要 resourceType=Bundle 與 entry 陣列）');
  const bundle = value;
  if (bundle.type !== undefined && !['collection', 'document', 'searchset'].includes(string(bundle.type))) {
    throw new Error('目前僅支援 collection、document 或完整 searchset Bundle，不執行交易或刪除指令');
  }
  if (!bundle.entry.length || bundle.entry.length > 100_000) throw new Error('FHIR Bundle 資源數量必須介於 1 至 100,000');
  if (array(bundle.link).some(link => object(link).relation === 'next') ||
      (bundle.type === 'searchset' && typeof bundle.total === 'number' && bundle.total > bundle.entry.length)) {
    throw new Error('FHIR Bundle 仍有未下載分頁，請匯出完整資料後再匯入');
  }
  const entries = bundle.entry.map(object);
  const resources = entries.map(entry => object(entry.resource));
  if (resources.some(resource => !/^[A-Z][A-Za-z0-9]+$/.test(string(resource.resourceType)) ||
      (resource.id !== undefined && !/^[A-Za-z0-9.-]{1,64}$/.test(string(resource.id))))) {
    throw new Error('FHIR entry 含有缺漏或格式錯誤的 resource，已中止整份匯入');
  }
  const fullUrls = entries.map(entry => string(entry.fullUrl)).filter(Boolean);
  if (new Set(fullUrls).size !== fullUrls.length) throw new Error('FHIR Bundle 含有重複的 fullUrl，無法安全關聯資源');
  const patients = resources.filter(resource => resource.resourceType === 'Patient');
  if (patients.length !== 1) throw new Error('FHIR Bundle 必須包含且只能包含一位 Patient，請將不同病人資料分開匯入');
  const patient = patients[0];
  if (!string(patient.id) && !patientIdentifiers(patient).size && !string(entries[resources.indexOf(patient)].fullUrl)) {
    throw new Error('Patient 缺少可建立關聯的 id、fullUrl 或 identifier');
  }
  const resolve = referenceIndex(resources, entries);
  const samePatient = (reference: unknown, owner: FhirObject): boolean => {
    const ref = object(reference);
    const target = resolve(reference, owner);
    if (target) return target === patient || (target.resourceType === 'Patient' && comparePatients(patient, target) === 'same');
    const identifier = object(ref.identifier);
    return !!string(identifier.value) && comparePatients(patient, { identifier: [identifier] }) === 'same';
  };
  const checkSubject = (resource: FhirObject) => {
    if (resource.resourceType === 'Patient' && resource !== patient && comparePatients(patient, resource) !== 'same') {
      throw new Error('FHIR contained 資源包含另一位或無法確認身分的病人');
    }
    for (const key of ['subject', 'patient', 'beneficiary']) {
      if (resource[key] !== undefined && !samePatient(resource[key], resource)) {
        throw new Error('FHIR 病人參照不一致或無法解析，已中止匯入以避免混合病歷');
      }
    }
    for (const contained of array(resource.contained)) checkSubject(object(contained));
  };
  const checkPatientReferences = (value: unknown, owner: FhirObject): void => {
    if (Array.isArray(value)) { value.forEach(item => checkPatientReferences(item, owner)); return; }
    if (!value || typeof value !== 'object') return;
    const node = object(value);
    if (typeof node.reference === 'string') {
      const target = resolve(node, owner);
      if ((target?.resourceType === 'Patient' || node.type === 'Patient' || /(?:^|\/)Patient\//.test(node.reference)) && !samePatient(node, owner)) {
        throw new Error('FHIR 巢狀資源參照另一位或無法確認身分的病人');
      }
    }
    Object.values(node).forEach(child => checkPatientReferences(child, owner));
  };
  for (const resource of resources) { checkSubject(resource); checkPatientReferences(resource, resource); }
  return resources;
}

function quantity(value: unknown): number | null {
  const number = object(value).value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

function quantityText(value: unknown): string {
  const item = object(value);
  return item.value === undefined ? '' : `${string(item.comparator)}${String(item.value)} ${string(item.unit) || string(item.code)}`.trim();
}

function observationText(item: FhirObject): string {
  if (item.valueQuantity !== undefined) return quantityText(item.valueQuantity);
  if (typeof item.valueInteger === 'number') return String(item.valueInteger);
  if (typeof item.valueBoolean === 'boolean') return String(item.valueBoolean);
  if (item.valueString !== undefined) return string(item.valueString);
  if (item.valueCodeableConcept !== undefined) return concept(item.valueCodeableConcept);
  if (item.valueRange !== undefined) return `${quantityText(object(item.valueRange).low)} – ${quantityText(object(item.valueRange).high)}`;
  if (item.valueRatio !== undefined) return `${quantityText(object(item.valueRatio).numerator)} / ${quantityText(object(item.valueRatio).denominator)}`;
  if (item.dataAbsentReason !== undefined) return `未提供結果：${concept(item.dataAbsentReason)}`;
  for (const key of ['valueDateTime', 'valueTime', 'valueDate']) if (item[key]) return string(item[key]);
  return '';
}

function plainNarrative(value: unknown): string {
  return string(value).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function referenceRanges(item: FhirObject, parent: FhirObject, unit: string): { refLow: number | null; refHigh: number | null; refText?: string } {
  const ranges = array(item.referenceRange ?? parent.referenceRange).map(object);
  const descriptions = ranges.map(range => [string(range.text),
    (range.low || range.high) ? `${quantityText(range.low) || '−∞'} – ${quantityText(range.high) || '∞'}` : '',
    concept(range.type), ...array(range.appliesTo).map(concept), range.age ? `年齡 ${quantityText(object(range.age).low)} – ${quantityText(object(range.age).high)}` : '',
  ].filter(Boolean).join('；'));
  const range = ranges.length === 1 ? ranges[0] : {};
  const incompatible = ['low', 'high'].some(key => {
    const rangeUnit = string(object(range[key]).unit) || string(object(range[key]).code);
    return !!rangeUnit && rangeUnit !== unit;
  });
  // Age/applicability-specific ranges are not safely comparable without clinical context.
  const conditional = !!range.age || array(range.appliesTo).length > 0;
  return { refLow: incompatible || conditional ? null : quantity(range.low),
    refHigh: incompatible || conditional ? null : quantity(range.high), refText: descriptions.filter(Boolean).join(' / ') || undefined };
}

const IMAGING_TEXT = /影像|放射|攝影|造影|電腦斷層|磁振|核磁|超音波|x\s*光|radiolog|imaging|tomograph|magnetic resonance|ultrasound|mammogra|fluoroscop|angiogra/i;
const IMAGING_CODES = new Set(['RAD', 'IMG', 'RX', 'CT', 'MR', 'MRI', 'US', 'CR', 'DX', 'MG', 'PT', 'NM', 'XA', 'RF', 'BMD', 'ES', 'TG', 'OCT', 'IVUS']);

type Resolve = (value: unknown, owner?: FhirObject) => FhirObject | undefined;

function codingLabel(value: unknown): string {
  const item = object(value);
  return string(item.display) || string(item.code);
}

function imagingLabel(value: unknown): string {
  return concept(value) || codingLabel(value);
}

function imagingConcepts(value: unknown): string[] {
  return array(value).map(imagingLabel).filter(Boolean);
}

function firstImagingLabel(value: unknown): string {
  return Array.isArray(value) ? imagingConcepts(value)[0] || '' : imagingLabel(value);
}

function imagingConcept(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(imagingConcept);
  const label = imagingLabel(value);
  if (label && IMAGING_TEXT.test(label)) return true;
  const codes = [...array(object(value).coding).map(item => string(object(item).code).toUpperCase()), string(object(value).code).toUpperCase()];
  return codes.some(code => !!code && IMAGING_CODES.has(code));
}

function isImagingReport(resource: FhirObject, type: string): boolean {
  if (type === 'ImagingStudy' || type === 'Media') return true;
  if (type === 'DiagnosticReport') {
    return array(resource.imagingStudy).length > 0 || array(resource.modality).length > 0 ||
      array(resource.image).length > 0 || array(resource.media).length > 0 ||
      array(resource.category).some(imagingConcept) || imagingConcept(resource.code);
  }
  if (type === 'DocumentReference') {
    return array(resource.category).some(imagingConcept) || imagingConcept(resource.type) ||
      IMAGING_TEXT.test(string(resource.description));
  }
  return false;
}

function buildImagingDetails(resource: FhirObject, type: string, resolve: Resolve): ImagingDetails {
  const modalities = new Set<string>();
  const bodySites = new Set<string>();
  const series: ImagingSeries[] = [];
  let instanceCount = 0;
  let studyDescription = string(resource.description);
  const addSeries = (value: unknown) => {
    const item = object(value);
    const modality = imagingLabel(item.modality);
    const bodySite = imagingLabel(item.bodySite);
    const instances = typeof item.numberOfInstances === 'number' && Number.isFinite(item.numberOfInstances)
      ? item.numberOfInstances
      : array(item.instance).length;
    if (modality) modalities.add(modality);
    if (bodySite) bodySites.add(bodySite);
    instanceCount += instances;
    series.push({ number: series.length + 1, modality, description: string(item.description), bodySite, instances });
  };
  if (type === 'ImagingStudy') {
    array(resource.series).forEach(addSeries);
    imagingConcepts(resource.modality).forEach(item => modalities.add(item));
  } else if (type === 'Media') {
    const modality = imagingLabel(resource.modality);
    if (modality) modalities.add(modality);
    const bodySite = imagingLabel(resource.bodySite);
    if (bodySite) bodySites.add(bodySite);
    studyDescription = studyDescription || string(object(resource.content).title);
    const frames = resource.frames;
    instanceCount = typeof frames === 'number' && Number.isFinite(frames) && frames > 0 ? frames : 1;
  } else if (type === 'DiagnosticReport') {
    imagingConcepts(resource.modality).forEach(item => modalities.add(item));
    imagingConcepts(resource.bodySite).forEach(item => bodySites.add(item));
    for (const ref of array(resource.imagingStudy)) {
      const study = resolve(ref, resource);
      if (study?.resourceType !== 'ImagingStudy') continue;
      const nested = buildImagingDetails(study, 'ImagingStudy', resolve);
      nested.modalities.forEach(item => modalities.add(item));
      nested.bodySites.forEach(item => bodySites.add(item));
      for (const item of nested.series) series.push({ ...item, number: series.length + 1 });
      instanceCount += nested.instanceCount;
      studyDescription = studyDescription || nested.studyDescription;
    }
  }
  return {
    modalities: [...modalities],
    bodySites: [...bodySites],
    series,
    instanceCount,
    status: string(resource.status),
    studyDescription,
  };
}

export function parseFhirResources(resources: FhirObject[], entries: FhirObject[] = []): ClinicalData {
  const visits: Visit[] = [];
  const hospitalizations: Hospitalization[] = [];
  const vaccinations: Vaccination[] = [];
  const labResults: LabResult[] = [];
  const textLabResults: TextLabResult[] = [];
  const medicalReports: MedicalReport[] = [];
  const medications: MedicationRecord[] = [];
  const resolve = referenceIndex(resources, entries);
  const fullUrls = new Map(entries.map(entry => [object(entry.resource), string(entry.fullUrl)]));
  const source = (resource: FhirObject) => resourceSource(resource, fullUrls.get(resource));
  const origins = (resource: FhirObject): RecordOrigin[] => [{ format: 'FHIR', resourceType: string(resource.resourceType), id: string(resource.id) || undefined, source: source(resource) }];
  const id = (resource: FhirObject) => fullUrls.get(resource) || `${source(resource)}|${string(resource.resourceType)}/${string(resource.id) || canonicalJson(resource)}`;
  const referenceLabel = (value: unknown, owner?: FhirObject): string => {
    const ref = object(value);
    const target = resolve(value, owner);
    if (!target) return string(ref.display) || string(ref.reference);
    const name = target.resourceType === 'Organization' ? string(target.name) : concept(target.code) || concept(target.type) || string(target.name);
    return string(ref.display) || name || `${string(target.resourceType)}/${string(target.id)}`;
  };
  const facility = (resource: FhirObject): string => {
    const provider = referenceLabel(resource.serviceProvider, resource) || referenceLabel(resource.location, resource);
    if (provider) return provider;
    for (const performer of array(resource.performer)) {
      const ref = object(performer).actor ?? performer;
      const target = resolve(ref, resource);
      if (target?.resourceType === 'Organization' || string(object(ref).display)) return referenceLabel(ref, resource);
    }
    return '';
  };
  const getFacility = (resource: FhirObject): string => {
    const encounter = resolve(resource.encounter ?? array(object(resource.context).encounter)[0], resource);
    return facility(resource) || (encounter ? facility(encounter) : '') || referenceLabel(resource.custodian, resource) || '未提供院所';
  };
  const attachment = (value: unknown, owner: FhirObject) => {
    const raw = object(value);
    if (raw.data || raw.__vaultAttachment) return normalizeMedicalAttachment(raw);
    const binary = resolve(raw.url, owner);
    return binary?.resourceType === 'Binary' ? normalizeMedicalAttachment({ ...binary, title: raw.title }) : null;
  };
  const addReport = (resource: FhirObject, title: string, text: string, rawAttachments: unknown[] = [], related: unknown[] = [], imaging: ImagingDetails | null = null) => {
    const attachments = rawAttachments.map(value => attachment(value, resource)).filter(item => item !== null);
    medicalReports.push({ id: id(resource), date: fhirDate(resource.effectiveDateTime, object(resource.effectivePeriod).start, resource.issued, resource.date, resource.created, resource.createdDateTime, resource.started, object(resource.period).start),
      hospital: getFacility(resource), title, text, attachments, relatedResources: related.map(ref => string(object(ref).reference)).filter(Boolean),
      externalAttachmentCount: rawAttachments.filter(value => string(object(value).url) && !attachment(value, resource)).length,
      kind: imaging ? 'imaging' : 'general', ...(imaging ? { imaging } : {}),
      rawResource: resource, origins: origins(resource) });
  };

  for (const resource of resources) {
    const type = string(resource.resourceType);
    if (type === 'Encounter') {
      const start = fhirDate(object(resource.period).start);
      const diagnoses = array(resource.diagnosis).map(value => {
        const ref = object(value).condition;
        const condition = resolve(ref, resource);
        return { code: string(object(array(object(condition?.code).coding)[0]).code), name: condition ? concept(condition.code) : referenceLabel(ref, resource) };
      }).filter(value => value.code || value.name);
      const classCode = string(object(resource.class).code).toLowerCase();
      if (!start || !['amb', 'outpatient', 'imp', 'inpatient', 'emer', 'emergency'].includes(classCode)) {
        addReport(resource, '就醫紀錄（日期或就醫分類未完整提供）', [string(resource.status), ...diagnoses.map(item => item.name)].filter(Boolean).join('；'));
        continue;
      }
      if (['imp', 'inpatient'].includes(classCode)) {
        const end = fhirDate(object(resource.period).end);
        if (!end) {
          addReport(resource, '住院紀錄（尚未提供出院日期）', diagnoses.map(item => item.name).join('；'));
        } else {
          hospitalizations.push({ admitDate: start, dischargeDate: end, hospital: getFacility(resource), diagnoses, origins: origins(resource) });
        }
      } else {
        const procedures = resources.filter(candidate => candidate.resourceType === 'Procedure' && resolve(candidate.encounter, candidate) === resource)
          .map(candidate => ({ name: concept(candidate.code) || '醫療處置', code: string(object(array(object(candidate.code).coding)[0]).code), qty: 1 }));
        visits.push({ date: start, hospital: getFacility(resource), diagnoses, procedures, origins: origins(resource) });
      }
    }

    if (type === 'Observation') {
      const date = fhirDate(resource.effectiveDateTime, object(resource.effectivePeriod).start, resource.issued);
      const title = concept(resource.code) || '未命名檢驗';
      const testGroup = array(resource.category).map(concept).filter(Boolean).join('、') || 'FHIR';
      const measurements = [resource, ...array(resource.component).map(object)];
      for (const item of measurements) {
        const text = observationText(item);
        if (!text) continue;
        const value = quantity(item.valueQuantity) ?? (typeof item.valueInteger === 'number' && Number.isFinite(item.valueInteger) ? item.valueInteger : null);
        const unit = string(object(item.valueQuantity).unit) || string(object(item.valueQuantity).code);
        const subItem = concept(item.code) || title;
        const range = referenceRanges(item, resource, unit);
        const code = array(object(item.code).coding).map(coding => `${string(object(coding).system)}|${string(object(coding).code)}`).filter(item => item !== '|').join(';');
        const invalid = ['entered-in-error', 'cancelled'].includes(string(resource.status));
        if (value !== null && date && !string(object(item.valueQuantity).comparator) && !invalid) {
          labResults.push({ date, hospital: getFacility(resource), testGroup, subItem, value, unit: unit || undefined,
            code: code || undefined, source: source(resource), ...range, origins: origins(resource) });
        } else {
          textLabResults.push({ date, hospital: getFacility(resource), testGroup, subItem,
            text: invalid ? `${text}（${string(resource.status)}，不納入數值趨勢）` : text,
            unit: unit || undefined, refText: range.refText, source: source(resource), origins: origins(resource) });
        }
      }
    }

    if (['DiagnosticReport', 'DocumentReference', 'ImagingStudy', 'Media'].includes(type)) {
      const imaging = isImagingReport(resource, type) ? buildImagingDetails(resource, type, resolve) : null;
      const title = concept(resource.code) || concept(resource.type) || firstImagingLabel(resource.procedureCode) ||
        string(resource.description) || string(resource.title) || firstImagingLabel(resource.modality) || type;
      const related = [...array(resource.result), ...array(resource.imagingStudy), ...array(resource.basedOn),
        ...array(resource.derivedFrom), ...array(resource.relatesTo).map(item => object(item).target), ...array(object(resource.context).related),
        ...array(resource.image), ...array(resource.media).map(item => object(item).link)];
      const observations = array(resource.result).map(ref => resolve(ref, resource)).filter((item): item is FhirObject => item?.resourceType === 'Observation');
      const details = observations.flatMap(result => [result, ...array(result.component).map(object)].map(item => {
        const text = observationText(item);
        return text ? `${concept(item.code) || concept(result.code)}：${text}` : '';
      })).filter(Boolean);
      const attachments = type === 'DiagnosticReport' ? [...array(resource.presentedForm), ...array(resource.media).map(item => resolve(object(item).link, resource)?.content), ...array(resource.image).map(ref => resolve(ref, resource)?.content)]
        : type === 'DocumentReference' ? array(resource.content).map(item => object(item).attachment)
          : type === 'Media' ? [resource.content] : [];
      const seriesText = imaging?.series.map(item => [item.description, item.modality, item.bodySite].filter(Boolean).join(' · ')).filter(Boolean) ?? [];
      const studyText = imaging?.studyDescription && imaging.studyDescription !== string(resource.description) ? [imaging.studyDescription] : [];
      const notes = array(resource.note).map(item => string(object(item).text)).filter(Boolean);
      addReport(resource, title, [string(resource.conclusion), string(resource.description), plainNarrative(object(resource.text).div), ...details, ...studyText, ...seriesText, ...notes].filter(Boolean).join('\n'), attachments, related, imaging);
    }

    if (type === 'Immunization') {
      const date = fhirDate(resource.occurrenceDateTime, resource.recorded);
      if (date) vaccinations.push({ date, vaccine: concept(resource.vaccineCode) || '疫苗', location: referenceLabel(resource.location, resource) || getFacility(resource), origins: origins(resource) });
      else addReport(resource, concept(resource.vaccineCode) || '疫苗紀錄（日期未提供）', string(resource.status));
    }

    if (['MedicationRequest', 'MedicationStatement', 'MedicationDispense'].includes(type)) {
      const medication = resolve(resource.medicationReference, resource);
      const name = concept(resource.medicationCodeableConcept) || (medication ? concept(medication.code) : '') || referenceLabel(resource.medicationReference, resource) || '未命名藥品';
      const dosages = array(resource.dosageInstruction ?? resource.dosage).map(object);
      const dosage = dosages.map(item => string(item.text) || [concept(item.route), ...array(item.doseAndRate).map(rate => quantityText(object(rate).doseQuantity)),
        item.timing ? canonicalJson(item.timing) : ''].filter(Boolean).join('；')).filter(Boolean).join('；');
      medications.push({ id: id(resource), date: fhirDate(resource.authoredOn, resource.effectiveDateTime, object(resource.effectivePeriod).start, resource.whenHandedOver, resource.whenPrepared, resource.dateAsserted),
        hospital: getFacility(resource), name, dosage, status: string(resource.status), source: type,
        category: type === 'MedicationRequest' ? '處方' : type === 'MedicationDispense' ? '領藥' : '用藥紀錄', rawResource: resource, origins: origins(resource) });
    }
  }
  return { visits, hospitalizations, vaccinations, labResults, textLabResults, checkupReports: [], medicalReports, medications };
}
