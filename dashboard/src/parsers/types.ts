export interface Visit {
  date: Date;
  hospital: string;
  diagnoses: { code: string; name: string }[];
  procedures: { code: string; name: string; qty: number }[];
}

export interface Hospitalization {
  admitDate: Date;
  dischargeDate: Date;
  hospital: string;
  diagnoses: { code: string; name: string }[];
}

export interface Vaccination {
  date: Date;
  vaccine: string;
  location: string;
}

export interface LabResult {
  date: Date;
  hospital: string;
  testGroup: string;
  subItem: string;
  value: number;
  refLow: number | null;
  refHigh: number | null;
  unit?: string;
}

export interface CheckupReport {
  date: Date;
  hospital: string;
  examName: string;
  report: string;
}

export interface DentalVisit {
  date: Date;
  hospital: string;
  diagnoses: { code: string; name: string }[];
  procedures: { code: string; name: string; qty: number; toothCode: string; toothName: string }[];
}

export interface MedicalAttachment {
  title: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  data: string; // FHIR Attachment.data, retained only inside the encrypted vault
}

export interface MedicalReport {
  date: Date;
  hospital: string;
  title: string;
  text: string;
  attachments: MedicalAttachment[];
}

export interface MedicationRecord {
  date: Date;
  hospital: string;
  name: string;
  dosage: string;
  status: string;
  source: string;
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
}
