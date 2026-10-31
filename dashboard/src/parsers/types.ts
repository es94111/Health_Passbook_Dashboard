export interface RecordOrigin {
  format: 'NHI' | 'FHIR';
  resourceType?: string;
  id?: string;
  source?: string;
}

export interface SourcedRecord {
  origins?: RecordOrigin[];
}

export interface Visit extends SourcedRecord {
  date: Date;
  hospital: string;
  diagnoses: { code: string; name: string }[];
  procedures: { code: string; name: string; qty: number }[];
}

export interface Hospitalization extends SourcedRecord {
  admitDate: Date;
  dischargeDate: Date;
  hospital: string;
  diagnoses: { code: string; name: string }[];
}

export interface Vaccination extends SourcedRecord {
  date: Date;
  vaccine: string;
  location: string;
}

export interface LabResult extends SourcedRecord {
  date: Date;
  hospital: string;
  testGroup: string;
  subItem: string;
  value: number;
  refLow: number | null;
  refHigh: number | null;
  unit?: string;
  code?: string;
  source?: string;
  refText?: string;
}

export interface TextLabResult extends SourcedRecord {
  date: Date | null;
  hospital: string;
  testGroup: string;
  subItem: string;
  text: string;
  unit?: string;
  refText?: string;
  source?: string;
}

export interface CheckupReport extends SourcedRecord {
  date: Date;
  hospital: string;
  examName: string;
  report: string;
}

export interface DentalVisit extends SourcedRecord {
  date: Date;
  hospital: string;
  diagnoses: { code: string; name: string }[];
  procedures: { code: string; name: string; qty: number; toothCode: string; toothName: string }[];
}

export interface MedicalAttachment {
  id?: string;
  title: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  data?: string;
  size?: number;
}

export interface MedicalReport extends SourcedRecord {
  id: string;
  date: Date | null;
  hospital: string;
  title: string;
  text: string;
  attachments: MedicalAttachment[];
  relatedResources: string[];
  externalAttachmentCount: number;
  rawResource: Record<string, unknown>;
}

export interface MedicationRecord extends SourcedRecord {
  id: string;
  date: Date | null;
  hospital: string;
  name: string;
  dosage: string;
  status: string;
  source: string;
  category: '處方' | '領藥' | '用藥紀錄';
  rawResource: Record<string, unknown>;
}

export interface ImportSummary {
  id: string;
  sourceId: string;
  format: 'NHI' | 'FHIR';
  importedAt: string;
  added: number;
  updated: number;
  skipped: number;
  warnings: string[];
  identityConfirmed: boolean;
}

export interface NHIData {
  visits: Visit[];
  hospitalizations: Hospitalization[];
  vaccinations: Vaccination[];
  labResults: LabResult[];
  checkupReports: CheckupReport[];
  dentalVisits: DentalVisit[];
  medicalReports: MedicalReport[];
  medications: MedicationRecord[];
  textLabResults: TextLabResult[];
  importHistory: ImportSummary[];
  duplicateCandidateCount: number;
  loadAttachment?: (attachment: MedicalAttachment) => Promise<Blob>;
  downloadSource?: (sourceId: string) => Promise<void>;
}
