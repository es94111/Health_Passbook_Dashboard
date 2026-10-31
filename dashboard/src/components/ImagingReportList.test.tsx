import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MedicalReport } from '../parsers/types';
import ImagingReportList from './ImagingReportList';

const report = (overrides: Partial<MedicalReport> = {}): MedicalReport => ({
  id: 'imaging-1', date: new Date('2026-10-04T00:00:00Z'), hospital: '甲醫院', title: '胸部電腦斷層', text: '無明顯異常',
  attachments: [], relatedResources: [], externalAttachmentCount: 0, kind: 'imaging',
  imaging: {
    modalities: ['CT'], bodySites: ['胸部'],
    series: [{ number: 1, modality: 'CT', description: '軸位', bodySite: '胸部', instances: 120 }],
    instanceCount: 120, status: 'final', studyDescription: '胸部電腦斷層',
  },
  rawResource: { resourceType: 'ImagingStudy', id: 'imaging-1' },
  origins: [{ format: 'FHIR', resourceType: 'ImagingStudy', id: 'imaging-1' }],
  ...overrides,
});

afterEach(cleanup);

describe('ImagingReportList', () => {
  it('shows exam metadata and series details', () => {
    render(<ImagingReportList reports={[report()]} />);
    const section = screen.getByRole('region', { name: '影像報告' });
    expect(within(section).getByRole('heading', { name: '胸部電腦斷層' })).toBeTruthy();
    expect(within(section).getByText('已定稿')).toBeTruthy();
    expect(within(section).getAllByText('胸部').length).toBeGreaterThan(0);
    expect(within(section).getByText('1 系列 · 120 張')).toBeTruthy();
    expect(within(section).getByText('軸位')).toBeTruthy();
    expect(within(section).getByText('顯示 1 / 1 份影像報告')).toBeTruthy();
  });

  it('filters by search text and imaging modality', () => {
    const mri = report({
      id: 'imaging-2', title: '腦部磁振造影', text: '',
      imaging: { modalities: ['MR'], bodySites: ['腦部'], series: [], instanceCount: 0, status: 'preliminary', studyDescription: '' },
    });
    render(<ImagingReportList reports={[report(), mri]} />);
    const section = screen.getByRole('region', { name: '影像報告' });
    fireEvent.change(within(section).getByLabelText('搜尋影像報告'), { target: { value: '磁振' } });
    expect(within(section).queryByRole('heading', { name: '胸部電腦斷層' })).toBeNull();
    expect(within(section).getByRole('heading', { name: '腦部磁振造影' })).toBeTruthy();
    expect(within(section).getByText('初步報告')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'CT' }));
    expect(within(section).getByText('沒有符合條件的影像報告')).toBeTruthy();
    fireEvent.change(within(section).getByLabelText('搜尋影像報告'), { target: { value: '' } });
    expect(within(section).getByRole('heading', { name: '胸部電腦斷層' })).toBeTruthy();
    expect(within(section).queryByRole('heading', { name: '腦部磁振造影' })).toBeNull();
  });

  it('renders attachments and warns about external attachments', () => {
    render(<ImagingReportList reports={[report({
      externalAttachmentCount: 2,
      attachments: [{ title: '影像報告', contentType: 'application/pdf', data: 'JVBERi0xLjQ=' }],
    })]} />);
    expect(screen.getByText('報告與影像附件（1）')).toBeTruthy();
    expect(screen.getByRole('button', { name: '影像報告：下載 PDF' })).toBeTruthy();
    expect(screen.getByText('另有 2 個外部附件，未取得且不會自動下載。')).toBeTruthy();
  });

  it('distinguishes an empty tab from an empty filter result', () => {
    const { rerender } = render(<ImagingReportList reports={[]} />);
    expect(screen.getByText('尚無影像報告')).toBeTruthy();
    rerender(<ImagingReportList reports={[report()]} />);
    fireEvent.change(screen.getByLabelText('搜尋影像報告'), { target: { value: '不存在' } });
    expect(screen.getByText('沒有符合條件的影像報告')).toBeTruthy();
  });
});
