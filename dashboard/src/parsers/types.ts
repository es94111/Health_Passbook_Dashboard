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

export interface NHIData {
  visits: Visit[];
  hospitalizations: Hospitalization[];
  vaccinations: Vaccination[];
  labResults: LabResult[];
  checkupReports: CheckupReport[];
  dentalVisits: DentalVisit[];
}
